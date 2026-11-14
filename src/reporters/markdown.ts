import type { PreflightReport } from "../types.js";

export const PR_COMMENT_MARKER = "<!-- context-preflight -->";

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Format a compact Markdown report suitable for GitHub PR sticky comments and Step Summaries.
 */
export function formatMarkdownReport(
  report: PreflightReport,
  options: { includeStickyMarker?: boolean } = {},
): string {
  const { summary } = report;
  const lines: string[] = [];

  if (options.includeStickyMarker) {
    lines.push(PR_COMMENT_MARKER);
  }

  const badge = summary.passed ? "PASS" : "FAIL";
  lines.push(`## Context Preflight: ${badge} (${summary.score}/100, Grade ${summary.grade})`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| :--- | :--- |");
  lines.push(
    `| Turn-0 Context | ~${summary.turn0Tokens.toLocaleString()} tokens (${summary.turn0Bytes.toLocaleString()} bytes) |`,
  );
  lines.push(`| On-Demand Skills/Docs | ~${summary.onDemandTokens.toLocaleString()} tokens |`);
  lines.push(
    `| MCP Tool Schemas | ~${summary.mcpSchemaTokens.toLocaleString()} tokens (${report.mcpTools.length} tools) |`,
  );
  lines.push(`| Artifacts Scanned | ${summary.totalArtifacts} files |`);
  lines.push(
    `| Findings | ${summary.errorCount} errors, ${summary.warningCount} warnings, ${summary.infoCount} info |`,
  );

  if (report.diff) {
    const sign = report.diff.turn0TokensDelta >= 0 ? "+" : "";
    lines.push(
      `| Baseline Delta | ${sign}${report.diff.turn0TokensDelta} turn-0 tokens, ${report.diff.addedFindings.length} new / ${report.diff.resolvedFindings.length} resolved findings |`,
    );
  }

  if (report.artifacts.length > 0) {
    lines.push("");
    lines.push("### Context Breakdown");
    lines.push("");
    lines.push("| File | Type | Scope | Tokens | Lines |");
    lines.push("| :--- | :--- | :--- | ---: | ---: |");
    for (const art of report.artifacts.slice(0, 25)) {
      lines.push(
        `| \`${escapeMdCell(art.path)}\` | ${art.kind} | ${art.alwaysLoaded ? "turn-0" : "on-demand"} | ${art.estimatedTokens.toLocaleString()} | ${art.lines.toLocaleString()} |`,
      );
    }
  }

  if (report.findings.length > 0) {
    lines.push("");
    lines.push("### Findings");
    lines.push("");
    lines.push("| Severity | Rule | Location | Message |");
    lines.push("| :--- | :--- | :--- | :--- |");
    for (const f of report.findings.slice(0, 40)) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(
        `| **${f.severity.toUpperCase()}** | \`${f.ruleId}\` | ${loc} | ${escapeMdCell(f.message)} |`,
      );
    }
    if (report.findings.length > 40) {
      lines.push("");
      lines.push(`_Showing first 40 of ${report.findings.length} findings._`);
    }
  }

  return lines.join("\n");
}
