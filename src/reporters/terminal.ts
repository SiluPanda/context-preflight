import type { Finding, PreflightReport } from "../types.js";

function severityTag(sev: Finding["severity"], useColor: boolean): string {
  const upper = sev.toUpperCase().padEnd(7);
  if (!useColor) return upper;
  if (sev === "error") return `\x1b[31m${upper}\x1b[0m`;
  if (sev === "warning") return `\x1b[33m${upper}\x1b[0m`;
  return `\x1b[36m${upper}\x1b[0m`;
}

function progressBar(value: number, max: number, width = 20): string {
  const ratio = max <= 0 ? 0 : Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

/**
 * Render a readable terminal summary with turn-0 budget breakdown, deltas, and line-level findings.
 */
export function formatTerminalReport(
  report: PreflightReport,
  options: { color?: boolean; maxTurn0Tokens?: number } = {},
): string {
  const useColor = options.color ?? (process.stdout.isTTY && !process.env["NO_COLOR"]);
  const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const green = (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);

  const lines: string[] = [];
  const { summary } = report;
  const maxBudget = options.maxTurn0Tokens ?? 8000;
  const statusStr = summary.passed ? green("PASS") : red("FAIL");

  lines.push(
    `${bold("context-preflight")} v${report.toolVersion}  ${statusStr}  Score: ${bold(`${summary.score}/100 (${summary.grade})`)}`,
  );
  lines.push(dim(`Root: ${report.rootDir}`));
  lines.push("");

  const pct = maxBudget > 0 ? Math.round((summary.turn0Tokens / maxBudget) * 100) : 0;
  lines.push(
    `Turn-0 Context: ${progressBar(summary.turn0Tokens, maxBudget)} ~${summary.turn0Tokens.toLocaleString()} / ${maxBudget.toLocaleString()} tokens (${pct}%)`,
  );
  if (summary.onDemandTokens > 0 || summary.mcpSchemaTokens > 0) {
    lines.push(
      dim(
        `On-demand skills/docs: ~${summary.onDemandTokens.toLocaleString()} tokens | MCP tool schemas: ~${summary.mcpSchemaTokens.toLocaleString()} tokens`,
      ),
    );
  }

  if (report.diff) {
    const sign = report.diff.turn0TokensDelta >= 0 ? "+" : "";
    lines.push(
      dim(
        `Baseline Delta: ${sign}${report.diff.turn0TokensDelta} turn-0 tokens | +${report.diff.addedFindings.length} added / -${report.diff.resolvedFindings.length} resolved findings`,
      ),
    );
  }

  lines.push("");
  if (
    report.artifacts.length === 0 &&
    report.mcpPayloads.length === 0 &&
    report.mcpTools.length === 0
  ) {
    lines.push(
      dim(
        "No agent context files (CLAUDE.md, AGENTS.md, SKILL.md, .mcp.json) or MCP fixtures found.",
      ),
    );
  } else if (report.artifacts.length > 0) {
    lines.push(bold("Artifacts:"));
    for (const art of report.artifacts) {
      const scope = art.alwaysLoaded ? "turn-0" : "on-demand";
      const impSuffix = art.importCount ? `, +${art.importCount} import(s)` : "";
      lines.push(
        `  - ${art.path} (${art.kind}, ${scope}, ~${art.estimatedTokens} tok, ${art.lines} lines${impSuffix})`,
      );
    }
    lines.push("");
  }

  if (report.mcpPayloads.length > 0) {
    lines.push(bold("MCP Tool Result Payloads:"));
    for (const p of report.mcpPayloads) {
      lines.push(
        `  - ${p.file}: ${p.compactBytes.toLocaleString()} bytes (~${p.estimatedTokens} tok), mirrors=${p.mirrorCount}, repeated_subtrees=${p.repeatedSubtreeCount}`,
      );
    }
    lines.push("");
  }

  lines.push(
    bold(
      `Findings (${summary.errorCount} error, ${summary.warningCount} warning, ${summary.infoCount} info):`,
    ),
  );

  if (report.findings.length === 0) {
    lines.push(`  ${green("No issues detected.")}`);
  } else {
    for (const f of report.findings) {
      const loc = f.line ? `${f.file}:${f.line}${f.column ? `:${f.column}` : ""}` : f.file;
      lines.push(`  ${severityTag(f.severity, useColor)} ${bold(f.ruleId)}  ${loc}`);
      lines.push(`    ${f.message}`);
      if (f.suggestion) {
        lines.push(`    ${dim(`Fix: ${f.suggestion}`)}`);
      }
    }
  }

  return lines.join("\n");
}
