import path from "node:path";
import { diffReports } from "./diff.js";
import { discoverProject } from "./discovery.js";
import { probeConfiguredMcpServers } from "./mcp-probe.js";
import { runBudgetRules } from "./rules/budget.js";
import { runMcpRules, type RawMcpTool } from "./rules/mcp.js";
import { runReferenceRules } from "./rules/references.js";
import { runSecurityRules } from "./rules/security.js";
import type {
  Finding,
  PreflightOptions,
  PreflightReport,
  PreflightSummary,
  ResolvedPreflightOptions,
} from "./types.js";

export const TOOL_VERSION = "0.1.0";

export function resolveOptions(options: PreflightOptions): ResolvedPreflightOptions {
  return {
    rootDir: path.resolve(options.rootDir),
    maxTurn0Tokens: options.maxTurn0Tokens ?? 8000,
    maxFileTokens: options.maxFileTokens ?? 4000,
    maxSkillLines: options.maxSkillLines ?? 500,
    maxMcpBytes: options.maxMcpBytes ?? 65536,
    maxToolDescTokens: options.maxToolDescTokens ?? 300,
    failOn: options.failOn ?? "error",
    ignoreRules: new Set(options.ignoreRules ?? []),
    ignorePaths: options.ignorePaths ?? [],
    probeMcp: options.probeMcp ?? false,
    probeTimeoutMs: options.probeTimeoutMs ?? 5000,
    scanCodePrompts: options.scanCodePrompts ?? true,
    baselineReport: options.baselineReport,
  };
}

function computeScore(findings: Finding[]): { score: number; grade: PreflightSummary["grade"] } {
  const penaltyByRule = new Map<string, number>();
  let totalPenalty = 0;

  for (const f of findings) {
    const rawDelta = f.severity === "error" ? 18 : f.severity === "warning" ? 7 : 1;
    const ruleCap = f.severity === "error" ? 54 : f.severity === "warning" ? 28 : 10;
    const key = `${f.severity}:${f.ruleId}`;
    const used = penaltyByRule.get(key) ?? 0;
    const applied = Math.min(rawDelta, Math.max(0, ruleCap - used));
    penaltyByRule.set(key, used + applied);
    totalPenalty += applied;
  }

  const bounded = Math.max(0, Math.min(100, 100 - totalPenalty));
  const grade: PreflightSummary["grade"] =
    bounded >= 90 ? "A" : bounded >= 80 ? "B" : bounded >= 70 ? "C" : bounded >= 60 ? "D" : "F";
  return { score: bounded, grade };
}

function severityRank(sev: Finding["severity"]): number {
  return sev === "error" ? 0 : sev === "warning" ? 1 : 2;
}

/**
 * Analyze a repository's coding-agent context files, skills, MCP schemas, and prompt-cache hygiene.
 */
export async function analyzeRepository(options: PreflightOptions): Promise<PreflightReport> {
  const resolved = resolveOptions(options);
  const ctx = discoverProject(resolved.rootDir, {
    ignorePaths: resolved.ignorePaths,
    scanCodePrompts: resolved.scanCodePrompts,
  });

  const liveProbedTools: Array<{ server: string; sourceFile: string; tools: RawMcpTool[] }> = [];
  const probeFindings: Finding[] = [];

  if (resolved.probeMcp) {
    const probed = await probeConfiguredMcpServers(ctx, resolved.probeTimeoutMs);
    for (const entry of probed) {
      if (entry.error) {
        probeFindings.push({
          ruleId: "mcp-probe-failed",
          category: "mcp",
          severity: "warning",
          file: entry.sourceFile,
          message: entry.error,
        });
      } else {
        liveProbedTools.push({
          server: entry.server,
          sourceFile: entry.sourceFile,
          tools: entry.tools,
        });
      }
    }
  }

  const securityFindings = runSecurityRules(ctx);
  const referenceFindings = runReferenceRules(ctx);
  const budgetResult = runBudgetRules(ctx, resolved);
  const mcpResult = runMcpRules(ctx, resolved, liveProbedTools);

  const rawFindings = [
    ...securityFindings,
    ...referenceFindings,
    ...budgetResult.findings,
    ...mcpResult.findings,
    ...probeFindings,
  ];

  const findings = rawFindings
    .filter((f) => !resolved.ignoreRules.has(f.ruleId))
    .sort((a, b) => {
      const rankDiff = severityRank(a.severity) - severityRank(b.severity);
      if (rankDiff !== 0) return rankDiff;
      const fileDiff = a.file.localeCompare(b.file);
      if (fileDiff !== 0) return fileDiff;
      return (a.line ?? 0) - (b.line ?? 0);
    });

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;

  const passed =
    resolved.failOn === "never"
      ? true
      : resolved.failOn === "warning"
        ? errorCount === 0 && warningCount === 0
        : errorCount === 0;

  const { score, grade } = computeScore(findings);
  const turn0Tokens = budgetResult.turn0Tokens + mcpResult.mcpSchemaTokens;

  const report: PreflightReport = {
    schemaVersion: "1.0.0",
    toolVersion: TOOL_VERSION,
    rootDir: resolved.rootDir,
    generatedAt: new Date().toISOString(),
    summary: {
      score,
      grade,
      turn0Tokens,
      turn0Bytes: budgetResult.turn0Bytes,
      onDemandTokens: budgetResult.onDemandTokens,
      mcpSchemaTokens: mcpResult.mcpSchemaTokens,
      totalArtifacts: ctx.artifacts.length,
      errorCount,
      warningCount,
      infoCount,
      passed,
    },
    artifacts: budgetResult.artifacts,
    mcpTools: mcpResult.mcpTools,
    mcpPayloads: mcpResult.mcpPayloads,
    findings,
  };

  if (resolved.baselineReport) {
    report.diff = diffReports(resolved.baselineReport, report);
  }

  return report;
}
