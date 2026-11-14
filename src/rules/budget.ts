import fs from "node:fs";
import path from "node:path";
import type { DiscoveredArtifact, ProjectContext } from "../discovery.js";
import { parseFrontmatter, scanMarkdownLines } from "../markdown.js";
import { countLines, estimateTokens, utf8Bytes } from "../tokens.js";
import type { ArtifactMetrics, Finding, ResolvedPreflightOptions } from "../types.js";
import { extractClaudeImports } from "./references.js";

const DYNAMIC_PROMPT_CALLS =
  /\b(?:new\s+Date\s*\(|Date\.now\s*\(|Math\.random\s*\(|crypto\.randomUUID\s*\(|datetime\.(?:now|utcnow)\s*\(|time\.time\s*\(|uuid\.uuid4\s*\()/;

const PROMPT_CONTEXT_HINT =
  /(?:(?<![A-Za-z0-9_])(?:systemPrompt|system_prompt)\s*[:=]|cache_control[^\n]{0,40}ephemeral|ephemeral[^\n]{0,40}cache_control)/i;

const HTTP_CACHE_OR_TIMING_NOISE =
  /(?:max-age=|s-maxage=|Expires=|total_time|elapsed|duration|start_time|\bend\s*=)/i;

function resolveImportTree(
  startAbs: string,
  rootDir: string,
  visited: Set<string>,
  depth = 0,
): { extraBytes: number; extraTokens: number; count: number } {
  if (depth > 8) return { extraBytes: 0, extraTokens: 0, count: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(startAbs, "utf8");
  } catch {
    return { extraBytes: 0, extraTokens: 0, count: 0 };
  }

  let extraBytes = 0;
  let extraTokens = 0;
  let count = 0;

  for (const imp of extractClaudeImports(scanMarkdownLines(raw))) {
    const clean = imp.target.split("#")[0]?.trim() ?? "";
    if (!clean) continue;
    const relCandidate = path.resolve(path.dirname(startAbs), clean);
    const rootCandidate = path.resolve(rootDir, clean);
    const targetAbs = fs.existsSync(relCandidate)
      ? relCandidate
      : fs.existsSync(rootCandidate)
        ? rootCandidate
        : null;
    if (!targetAbs || visited.has(targetAbs)) continue;

    visited.add(targetAbs);
    try {
      const targetText = fs.readFileSync(targetAbs, "utf8");
      const bytes = utf8Bytes(targetText);
      extraBytes += bytes;
      extraTokens += estimateTokens(targetText);
      count += 1;
      const nested = resolveImportTree(targetAbs, rootDir, visited, depth + 1);
      extraBytes += nested.extraBytes;
      extraTokens += nested.extraTokens;
      count += nested.count;
    } catch {
      continue;
    }
  }
  return { extraBytes, extraTokens, count };
}

function validateSkillArtifact(
  artifact: DiscoveredArtifact,
  maxSkillLines: number,
): { findings: Finding[]; metadataTokens: number } {
  const findings: Finding[] = [];
  const fm = parseFrontmatter(artifact.content);
  const name = fm.fields["name"];
  const description = fm.fields["description"];

  if (!fm.hasFrontmatter || fm.error) {
    findings.push({
      ruleId: "skill-frontmatter-invalid",
      category: "skill",
      severity: "error",
      file: artifact.relPath,
      line: 1,
      message: fm.error ?? "SKILL.md is missing required YAML frontmatter ('---')",
      suggestion:
        "Add YAML frontmatter with 'name' and 'description' so agents can progressively load the skill.",
    });
  } else {
    if (typeof name !== "string" || name.trim().length === 0) {
      findings.push({
        ruleId: "skill-frontmatter-invalid",
        category: "skill",
        severity: "error",
        file: artifact.relPath,
        line: 1,
        message: "SKILL.md frontmatter is missing required 'name' field",
      });
    } else if (name.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      findings.push({
        ruleId: "skill-frontmatter-invalid",
        category: "skill",
        severity: "warning",
        file: artifact.relPath,
        line: 2,
        message: `Skill name '${name}' should be lowercase kebab-case and at most 64 characters`,
      });
    }

    if (typeof description !== "string" || description.trim().length === 0) {
      findings.push({
        ruleId: "skill-frontmatter-invalid",
        category: "skill",
        severity: "error",
        file: artifact.relPath,
        line: 1,
        message: "SKILL.md frontmatter is missing required 'description' field",
      });
    } else if (description.length > 1024) {
      findings.push({
        ruleId: "skill-bloat",
        category: "skill",
        severity: "warning",
        file: artifact.relPath,
        line: 1,
        message: `SKILL.md description is ${description.length} characters (limit: 1024)`,
      });
    }
  }

  const bodyLines = countLines(fm.body);
  if (bodyLines > maxSkillLines) {
    findings.push({
      ruleId: "skill-bloat",
      category: "skill",
      severity: "warning",
      file: artifact.relPath,
      line: fm.bodyStartLine,
      message: `SKILL.md body has ${bodyLines} lines (recommended maximum: ${maxSkillLines})`,
      suggestion: "Move detailed examples or schemas into references/ files linked from SKILL.md.",
    });
  }

  const metaText = `${typeof name === "string" ? name : ""}\n${typeof description === "string" ? description : ""}`;
  return {
    findings,
    metadataTokens: fm.hasFrontmatter ? estimateTokens(metaText) : 0,
  };
}

function tokenShingles(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - 4; i += 1) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]}`);
  }
  return shingles;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scanPromptCacheBreakers(ctx: ProjectContext): Finding[] {
  const findings: Finding[] = [];
  for (const src of ctx.promptSourceFiles) {
    const lines = src.content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(lines.length, i + 3);
      const windowText = lines.slice(windowStart, windowEnd).join("\n");
      const line = lines[i] ?? "";

      if (
        DYNAMIC_PROMPT_CALLS.test(line) &&
        PROMPT_CONTEXT_HINT.test(windowText) &&
        !HTTP_CACHE_OR_TIMING_NOISE.test(windowText)
      ) {
        findings.push({
          ruleId: "cache-breaker-risk",
          category: "budget",
          severity: "warning",
          file: src.relPath,
          line: i + 1,
          message:
            "Volatile runtime value (timestamp/random/UUID) appears near system prompt or cache_control prefix",
          suggestion:
            "Move dynamic timestamps/UUIDs to the end of user messages so Claude/LLM prompt cache prefixes stay warm.",
          snippet: line.trim().slice(0, 140),
        });
      }
    }
  }
  return findings;
}

/**
 * Compute per-artifact token budgets, skill frontmatter checks, instruction overlap, and cache-breaker warnings.
 */
export function runBudgetRules(
  ctx: ProjectContext,
  options: ResolvedPreflightOptions,
): {
  artifacts: ArtifactMetrics[];
  findings: Finding[];
  turn0Tokens: number;
  turn0Bytes: number;
  onDemandTokens: number;
} {
  const artifacts: ArtifactMetrics[] = [];
  const findings: Finding[] = [];
  const importVisited = new Set<string>();

  let turn0Tokens = 0;
  let turn0Bytes = 0;
  let onDemandTokens = 0;

  let rootClaude: DiscoveredArtifact | undefined;
  let rootAgents: DiscoveredArtifact | undefined;

  for (const artifact of ctx.artifacts) {
    const lines = countLines(artifact.content);
    let tokens = estimateTokens(artifact.content);
    let bytes = artifact.bytes;
    let importCount = 0;

    if (artifact.kind === "claude-md" && artifact.alwaysLoaded) {
      rootClaude = artifact;
      importVisited.add(artifact.absPath);
      const imp = resolveImportTree(artifact.absPath, ctx.rootDir, importVisited);
      importCount = imp.count;
      bytes += imp.extraBytes;
      tokens += imp.extraTokens;
    } else if (artifact.kind === "agents-md" && artifact.alwaysLoaded) {
      rootAgents = artifact;
    }

    if (artifact.kind === "skill-md") {
      const skillCheck = validateSkillArtifact(artifact, options.maxSkillLines);
      findings.push(...skillCheck.findings);
      turn0Tokens += skillCheck.metadataTokens;
      onDemandTokens += Math.max(0, tokens - skillCheck.metadataTokens);
    } else if (artifact.alwaysLoaded) {
      turn0Tokens += tokens;
      turn0Bytes += bytes;
    } else {
      onDemandTokens += tokens;
    }

    if (artifact.alwaysLoaded && tokens > options.maxFileTokens) {
      findings.push({
        ruleId: "instruction-file-bloat",
        category: "budget",
        severity: "warning",
        file: artifact.relPath,
        line: 1,
        message: `${artifact.relPath} consumes ~${tokens} turn-0 tokens (threshold: ${options.maxFileTokens})`,
        suggestion:
          "Split domain-specific guides into on-demand SKILL.md files or referenced docs.",
      });
    }

    artifacts.push({
      path: artifact.relPath,
      kind: artifact.kind,
      alwaysLoaded: artifact.alwaysLoaded,
      bytes,
      lines,
      estimatedTokens: tokens,
      ...(importCount > 0 ? { importCount } : {}),
    });
  }

  if (rootClaude && rootAgents) {
    const claudeLinksToAgents = /@(?:\.\/)?AGENTS\.md\b/i.test(rootClaude.content);
    const agentsLinksToClaude = /@(?:\.\/)?CLAUDE\.md\b/i.test(rootAgents.content);
    if (!claudeLinksToAgents && !agentsLinksToClaude) {
      const sim = jaccardSimilarity(
        tokenShingles(rootClaude.content),
        tokenShingles(rootAgents.content),
      );
      if (sim >= 0.75) {
        findings.push({
          ruleId: "duplicate-instruction-overlap",
          category: "budget",
          severity: "info",
          file: rootClaude.relPath,
          line: 1,
          message: `CLAUDE.md and AGENTS.md share ${(sim * 100).toFixed(0)}% content overlap`,
          suggestion:
            "Keep a single canonical AGENTS.md and reference '@AGENTS.md' from CLAUDE.md to prevent instruction drift.",
        });
      }
    }
  }

  if (turn0Tokens > options.maxTurn0Tokens) {
    findings.push({
      ruleId: "turn0-budget-exceeded",
      category: "budget",
      severity: "error",
      file: artifacts.find((a) => a.alwaysLoaded)?.path ?? ".",
      message: `Total turn-0 context (~${turn0Tokens} tokens) exceeds budget (${options.maxTurn0Tokens} tokens)`,
      suggestion:
        "Trim always-loaded instructions or move specialized workflows into progressive skills.",
    });
  } else if (turn0Tokens > Math.floor(options.maxTurn0Tokens * 0.8)) {
    findings.push({
      ruleId: "turn0-budget-warning",
      category: "budget",
      severity: "warning",
      file: artifacts.find((a) => a.alwaysLoaded)?.path ?? ".",
      message: `Total turn-0 context (~${turn0Tokens} tokens) is above 80% of budget (${options.maxTurn0Tokens} tokens)`,
    });
  }

  findings.push(...scanPromptCacheBreakers(ctx));

  return { artifacts, findings, turn0Tokens, turn0Bytes, onDemandTokens };
}
