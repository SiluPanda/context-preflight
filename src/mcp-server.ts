import fs from "node:fs";
import path from "node:path";
import { analyzeRepository, TOOL_VERSION } from "./analyzer.js";
import { formatMarkdownReport } from "./reporters/markdown.js";
import type { PreflightReport } from "./types.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const SERVER_TOOLS = [
  {
    name: "preflight_scan",
    description:
      "Audit a repository's AI coding-agent context layer (CLAUDE.md, AGENTS.md, SKILL.md, .mcp.json, MCP fixtures, prompt-cache risks) and return score, turn-0 token breakdown, and findings.",
    inputSchema: {
      type: "object",
      properties: {
        rootDir: {
          type: "string",
          description:
            "Repository root directory path to audit (defaults to current working directory).",
        },
        maxTurn0Tokens: {
          type: "number",
          description: "Maximum allowed turn-0 context token budget (default: 8000).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preflight_compare",
    description:
      "Compare current repository context health against a previously exported PreflightReport JSON file.",
    inputSchema: {
      type: "object",
      properties: {
        baselinePath: {
          type: "string",
          description: "Path to the baseline JSON report written by context-preflight.",
        },
        rootDir: {
          type: "string",
          description: "Repository root directory path to evaluate.",
        },
      },
      required: ["baselinePath"],
      additionalProperties: false,
    },
  },
];

function writeResponse(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

/**
 * Handle a single JSON-RPC message for `context-preflight mcp` (exported for deterministic unit testing).
 */
export async function handleMcpRequest(msg: JsonRpcRequest): Promise<{
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
} | null> {
  if (msg.id === undefined) {
    return null;
  }

  switch (msg.method) {
    case "initialize":
      return {
        id: msg.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "context-preflight", version: TOOL_VERSION },
        },
      };

    case "ping":
      return { id: msg.id, result: {} };

    case "tools/list":
      return { id: msg.id, result: { tools: SERVER_TOOLS } };

    case "tools/call": {
      const params = msg.params ?? {};
      const name = typeof params["name"] === "string" ? params["name"] : "";
      const args =
        params["arguments"] &&
        typeof params["arguments"] === "object" &&
        !Array.isArray(params["arguments"])
          ? (params["arguments"] as Record<string, unknown>)
          : {};

      const rootDir =
        typeof args["rootDir"] === "string" && args["rootDir"].trim()
          ? path.resolve(args["rootDir"])
          : process.cwd();

      if (name === "preflight_scan") {
        const maxTurn0Tokens =
          typeof args["maxTurn0Tokens"] === "number" && Number.isFinite(args["maxTurn0Tokens"])
            ? args["maxTurn0Tokens"]
            : undefined;
        const report = await analyzeRepository({ rootDir, maxTurn0Tokens });
        return {
          id: msg.id,
          result: {
            content: [{ type: "text", text: formatMarkdownReport(report) }],
            structuredContent: report,
          },
        };
      }

      if (name === "preflight_compare") {
        const baselineArg = typeof args["baselinePath"] === "string" ? args["baselinePath"] : "";
        if (!baselineArg) {
          return {
            id: msg.id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Missing required argument: baselinePath" }],
            },
          };
        }
        const baselineRaw = fs.readFileSync(path.resolve(rootDir, baselineArg), "utf8");
        const baselineReport = JSON.parse(baselineRaw) as PreflightReport;
        const report = await analyzeRepository({ rootDir, baselineReport });
        return {
          id: msg.id,
          result: {
            content: [{ type: "text", text: formatMarkdownReport(report) }],
            structuredContent: report,
          },
        };
      }

      return { id: msg.id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }

    default:
      return { id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

/**
 * Start a line-delimited JSON-RPC stdio MCP server exposing preflight analysis tools.
 */
export function startMcpStdioServer(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void processLine(trimmed);
    }
  });
}

async function processLine(trimmed: string): Promise<void> {
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }

  try {
    const response = await handleMcpRequest(parsed);
    if (!response) return;
    if (response.error) {
      writeError(response.id, response.error.code, response.error.message);
    } else {
      writeResponse(response.id, response.result);
    }
  } catch (err) {
    const id = parsed.id ?? null;
    writeError(id, -32603, err instanceof Error ? err.message : "Internal error");
  }
}
