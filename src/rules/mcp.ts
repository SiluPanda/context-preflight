import type { ProjectContext } from "../discovery.js";
import {
  canonicalJsonString,
  compactJsonBytes,
  estimateTokensFromBytes,
  utf8Bytes,
} from "../tokens.js";
import type {
  Finding,
  McpPayloadStats,
  McpToolMetric,
  ResolvedPreflightOptions,
} from "../types.js";
import { scanTextForHiddenUnicode, scanTextForPromptInjection } from "./security.js";

const DEFAULT_MIN_DUPLICATE_BYTES = 64;

export interface RawMcpTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

function escapePointer(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function validateInputSchema(schema: unknown): string[] {
  const issues: string[] = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    issues.push("missing or non-object inputSchema");
    return issues;
  }
  const obj = schema as Record<string, unknown>;
  if (obj["type"] !== "object" && !Array.isArray(obj["anyOf"]) && !Array.isArray(obj["oneOf"])) {
    const rawType = obj["type"] === undefined ? "none" : JSON.stringify(obj["type"]);
    issues.push(`inputSchema root should have type="object" (got ${rawType})`);
  }

  const props =
    obj["properties"] && typeof obj["properties"] === "object" && !Array.isArray(obj["properties"])
      ? (obj["properties"] as Record<string, unknown>)
      : null;

  const required = obj["required"];
  if (Array.isArray(required)) {
    for (const reqKey of required) {
      if (typeof reqKey !== "string") {
        issues.push("required array contains a non-string entry");
      } else if (!props || !(reqKey in props)) {
        issues.push(`required property '${reqKey}' is not defined in properties`);
      }
    }
  }

  if (props) {
    for (const [propName, propDef] of Object.entries(props)) {
      if (!propDef || typeof propDef !== "object" || Array.isArray(propDef)) continue;
      const propObj = propDef as Record<string, unknown>;
      if (!("description" in propObj) || !propObj["description"]) {
        issues.push(`property '${propName}' is missing a description`);
      }
    }
  }

  return issues;
}

/**
 * Audit a list of MCP tools (`tools/list` output or fixture) for schema errors, token bloat, and poisoning.
 */
export function auditToolDefinitions(
  tools: RawMcpTool[],
  serverName: string,
  sourceFile: string,
  options: ResolvedPreflightOptions,
): { metrics: McpToolMetric[]; findings: Finding[] } {
  const metrics: McpToolMetric[] = [];
  const findings: Finding[] = [];
  const seenNames = new Map<string, number>();

  for (let idx = 0; idx < tools.length; idx += 1) {
    const tool = tools[idx];
    if (!tool || typeof tool !== "object") continue;

    const name = typeof tool.name === "string" ? tool.name.trim() : `<unnamed-${idx}>`;
    const prevCount = seenNames.get(name) ?? 0;
    seenNames.set(name, prevCount + 1);
    if (prevCount === 1) {
      findings.push({
        ruleId: "duplicate-tool-name",
        category: "mcp",
        severity: "error",
        file: sourceFile,
        message: `Duplicate MCP tool name '${name}' in '${serverName}'`,
        suggestion: "Give every exposed MCP tool a unique, unambiguous identifier.",
      });
    }

    const description = typeof tool.description === "string" ? tool.description.trim() : "";
    const hasDescription = description.length > 0;
    if (!hasDescription) {
      findings.push({
        ruleId: "missing-tool-description",
        category: "mcp",
        severity: "warning",
        file: sourceFile,
        message: `MCP tool '${name}' has no description; LLMs rely on descriptions to choose tools accurately`,
      });
    } else {
      findings.push(...scanTextForHiddenUnicode(description, sourceFile, "mcp"));
      findings.push(...scanTextForPromptInjection(description, sourceFile, "mcp"));
    }

    const descTokens = estimateTokensFromBytes(utf8Bytes(description));
    const schemaBytes = compactJsonBytes(tool);
    const totalTokens = estimateTokensFromBytes(schemaBytes);
    const schemaTokens = Math.max(0, totalTokens - descTokens);
    const schemaIssues = validateInputSchema(tool.inputSchema);

    if (descTokens > options.maxToolDescTokens) {
      findings.push({
        ruleId: "oversized-tool-schema",
        category: "mcp",
        severity: "warning",
        file: sourceFile,
        message: `MCP tool '${name}' description alone uses ~${descTokens} tokens (threshold: ${options.maxToolDescTokens})`,
        suggestion:
          "Move long usage manuals to MCP resources/prompts rather than turn-0 tool schemas.",
      });
    }

    if (schemaIssues.length > 0) {
      findings.push({
        ruleId: "invalid-tool-schema",
        category: "mcp",
        severity: schemaIssues.some(
          (s) => s.startsWith("required") || s.startsWith("missing or non-object"),
        )
          ? "error"
          : "info",
        file: sourceFile,
        message: `Tool '${name}' schema issues: ${schemaIssues.join("; ")}`,
      });
    }

    metrics.push({
      server: serverName,
      sourceFile,
      name,
      descriptionTokens: descTokens,
      schemaTokens,
      totalTokens,
      hasDescription,
      schemaIssues,
    });
  }

  return { metrics, findings };
}

function analyzeCallToolResultPayload(
  resultObj: Record<string, unknown>,
  file: string,
  maxMcpBytes: number,
): { stats: McpPayloadStats; findings: Finding[] } {
  const findings: Finding[] = [];
  const compactBytes = compactJsonBytes(resultObj);
  const estimatedTokens = estimateTokensFromBytes(compactBytes);
  const isError = resultObj["isError"] === true;

  // Detect exact text vs structuredContent mirrors (even when object keys differ in order).
  const textBlocks: string[] = [];
  if (Array.isArray(resultObj["content"])) {
    for (const block of resultObj["content"]) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const rec = block as Record<string, unknown>;
        if (rec["type"] === "text" && typeof rec["text"] === "string") {
          textBlocks.push(rec["text"]);
        }
      }
    }
  }

  let mirrorCount = 0;
  if ("structuredContent" in resultObj && resultObj["structuredContent"] !== undefined) {
    let structuredCanon: string | null = null;
    try {
      structuredCanon = canonicalJsonString(resultObj["structuredContent"]);
    } catch {
      structuredCanon = null;
    }
    if (structuredCanon) {
      for (const txt of textBlocks) {
        try {
          const parsedTxt: unknown = JSON.parse(txt);
          if (canonicalJsonString(parsedTxt) === structuredCanon) {
            mirrorCount += 1;
          }
        } catch {
          // Plain text block (not JSON mirror).
        }
      }
    }
  }

  // Detect repeated structured subtrees and largest leaf values.
  const subtreeCounts = new Map<string, { bytes: number; count: number }>();
  let largestLeafPointer: string | undefined;
  let largestLeafBytes = 0;

  const visit = (node: unknown, ptr: string, depth: number) => {
    if (depth > 64 || node === null) return;
    if (typeof node !== "object") {
      const leafBytes = compactJsonBytes(node);
      if (leafBytes > largestLeafBytes) {
        largestLeafBytes = leafBytes;
        largestLeafPointer = ptr || "/";
      }
      return;
    }

    if (depth > 0) {
      const serialized = canonicalJsonString(node);
      const byteSize = utf8Bytes(serialized);
      if (byteSize >= DEFAULT_MIN_DUPLICATE_BYTES) {
        const prev = subtreeCounts.get(serialized);
        if (prev) {
          prev.count += 1;
        } else {
          subtreeCounts.set(serialized, { bytes: byteSize, count: 1 });
        }
      }
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], `${ptr}/${escapePointer(i)}`, depth + 1);
      }
    } else {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, `${ptr}/${escapePointer(k)}`, depth + 1);
      }
    }
  };
  visit(resultObj, "", 0);

  let repeatedSubtreeCount = 0;
  for (const entry of subtreeCounts.values()) {
    if (entry.count > 1) repeatedSubtreeCount += 1;
  }

  if (compactBytes > maxMcpBytes) {
    findings.push({
      ruleId: "mcp-payload-budget-exceeded",
      category: "mcp",
      severity: "error",
      file,
      message: `MCP tool result compact size (${compactBytes} bytes / ~${estimatedTokens} tokens) exceeds ceiling (${maxMcpBytes} bytes)`,
      suggestion: "Paginate rows, truncate oversized fields, or move large blobs to MCP resources.",
    });
  }

  if (mirrorCount > 0) {
    findings.push({
      ruleId: "mirror-payload-bloat",
      category: "mcp",
      severity: "info",
      file,
      message: `Detected ${mirrorCount} text block(s) mirroring structuredContent verbatim (doubles payload bytes)`,
      suggestion:
        "Consider keeping concise text summaries alongside structuredContent when clients support both.",
    });
  }

  if (repeatedSubtreeCount > 0) {
    findings.push({
      ruleId: "repeated-payload-subtrees",
      category: "mcp",
      severity: "info",
      file,
      message: `Detected ${repeatedSubtreeCount} duplicated structured subtree(s) >= ${DEFAULT_MIN_DUPLICATE_BYTES} bytes`,
    });
  }

  return {
    stats: {
      file,
      compactBytes,
      estimatedTokens,
      mirrorCount,
      repeatedSubtreeCount,
      ...(largestLeafPointer ? { largestLeafPointer, largestLeafBytes } : {}),
      isError,
    },
    findings,
  };
}

/**
 * Audit MCP server fixtures (`tools/list` and `CallToolResult` shapes) and optional live probed schemas.
 */
export function runMcpRules(
  ctx: ProjectContext,
  options: ResolvedPreflightOptions,
  liveProbedTools: Array<{ server: string; sourceFile: string; tools: RawMcpTool[] }> = [],
): {
  mcpTools: McpToolMetric[];
  mcpPayloads: McpPayloadStats[];
  mcpSchemaTokens: number;
  findings: Finding[];
} {
  const mcpTools: McpToolMetric[] = [];
  const mcpPayloads: McpPayloadStats[] = [];
  const findings: Finding[] = [];

  for (const probed of liveProbedTools) {
    const res = auditToolDefinitions(probed.tools, probed.server, probed.sourceFile, options);
    mcpTools.push(...res.metrics);
    findings.push(...res.findings);
  }

  for (const fixture of ctx.mcpFixtures) {
    const obj = fixture.parsed as Record<string, unknown>;
    const unwrapped =
      obj["result"] && typeof obj["result"] === "object" && !Array.isArray(obj["result"])
        ? (obj["result"] as Record<string, unknown>)
        : obj;

    if (Array.isArray(unwrapped["tools"])) {
      const serverName = fixture.relPath;
      const res = auditToolDefinitions(
        unwrapped["tools"] as RawMcpTool[],
        serverName,
        fixture.relPath,
        options,
      );
      mcpTools.push(...res.metrics);
      findings.push(...res.findings);
    } else if (Array.isArray(unwrapped["content"]) || "structuredContent" in unwrapped) {
      const res = analyzeCallToolResultPayload(unwrapped, fixture.relPath, options.maxMcpBytes);
      mcpPayloads.push(res.stats);
      findings.push(...res.findings);
    }
  }

  const mcpSchemaTokens = mcpTools.reduce((acc, tool) => acc + tool.totalTokens, 0);
  return { mcpTools, mcpPayloads, mcpSchemaTokens, findings };
}
