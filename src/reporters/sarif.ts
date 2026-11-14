import type { Finding, PreflightReport } from "../types.js";

function sarifLevel(sev: Finding["severity"]): "error" | "warning" | "note" {
  if (sev === "error") return "error";
  if (sev === "warning") return "warning";
  return "note";
}

/**
 * Generate a SARIF 2.1.0 document compatible with GitHub Code Scanning uploads.
 */
export function formatSarifReport(report: PreflightReport): string {
  const ruleMap = new Map<
    string,
    { id: string; shortDescription: { text: string }; properties: { category: string } }
  >();
  for (const f of report.findings) {
    if (!ruleMap.has(f.ruleId)) {
      ruleMap.set(f.ruleId, {
        id: f.ruleId,
        shortDescription: { text: `context-preflight/${f.ruleId}` },
        properties: { category: f.category },
      });
    }
  }

  const results = report.findings.map((f) => ({
    ruleId: f.ruleId,
    level: sarifLevel(f.severity),
    message: {
      text: f.suggestion ? `${f.message} Fix: ${f.suggestion}` : f.message,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: f.file === "." ? "CLAUDE.md" : f.file,
          },
          region: {
            startLine: f.line && f.line > 0 ? f.line : 1,
            ...(f.column && f.column > 0 ? { startColumn: f.column } : {}),
          },
        },
      },
    ],
  }));

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "context-preflight",
            version: report.toolVersion,
            informationUri: "https://github.com/SiluPanda/context-preflight",
            rules: Array.from(ruleMap.values()),
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
