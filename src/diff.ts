import type { Finding, PreflightDiff, PreflightReport } from "./types.js";

function findingFingerprint(f: Finding): string {
  return `${f.ruleId}::${f.file}::${f.message}`;
}

/**
 * Compare a baseline preflight report against a candidate report for PR CI gates and deltas.
 */
export function diffReports(baseline: PreflightReport, current: PreflightReport): PreflightDiff {
  const baseKeys = new Set(baseline.findings.map(findingFingerprint));
  const currKeys = new Set(current.findings.map(findingFingerprint));

  const addedFindings = current.findings.filter((f) => !baseKeys.has(findingFingerprint(f)));
  const resolvedFindings = baseline.findings.filter((f) => !currKeys.has(findingFingerprint(f)));

  const baseTools = new Map(baseline.mcpTools.map((t) => [t.name, t]));
  const currTools = new Map(current.mcpTools.map((t) => [t.name, t]));

  const removedTools: string[] = [];
  const addedTools: string[] = [];
  const breakingSchemaChanges: string[] = [];

  for (const name of baseTools.keys()) {
    if (!currTools.has(name)) {
      removedTools.push(name);
      breakingSchemaChanges.push(`Tool removed: '${name}'`);
    }
  }

  for (const name of currTools.keys()) {
    if (!baseTools.has(name)) {
      addedTools.push(name);
    }
  }

  return {
    turn0TokensDelta: current.summary.turn0Tokens - baseline.summary.turn0Tokens,
    turn0BytesDelta: current.summary.turn0Bytes - baseline.summary.turn0Bytes,
    scoreDelta: current.summary.score - baseline.summary.score,
    addedFindings,
    resolvedFindings,
    removedTools: removedTools.sort(),
    addedTools: addedTools.sort(),
    breakingSchemaChanges,
  };
}
