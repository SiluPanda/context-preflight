export type Severity = "error" | "warning" | "info";

export type RuleCategory = "references" | "budget" | "security" | "mcp" | "skill";

export type FailOnThreshold = "error" | "warning" | "never";

export type ArtifactKind =
  | "claude-md"
  | "agents-md"
  | "gemini-md"
  | "copilot-instructions"
  | "cursor-rule"
  | "skill-md"
  | "mcp-config"
  | "claude-settings"
  | "claude-command"
  | "mcp-fixture";

export interface Finding {
  ruleId: string;
  category: RuleCategory;
  severity: Severity;
  file: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  snippet?: string;
}

export interface ArtifactMetrics {
  path: string;
  kind: ArtifactKind;
  alwaysLoaded: boolean;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  importCount?: number;
}

export interface McpToolMetric {
  server: string;
  sourceFile: string;
  name: string;
  descriptionTokens: number;
  schemaTokens: number;
  totalTokens: number;
  hasDescription: boolean;
  schemaIssues: string[];
}

export interface McpSubtreeRepeat {
  occurrences: number;
  bytesEach: number;
  pointers: string[];
}

export interface McpPayloadStats {
  file: string;
  compactBytes: number;
  estimatedTokens: number;
  mirrorCount: number;
  repeatedSubtreeCount: number;
  largestLeafPointer?: string;
  largestLeafBytes?: number;
  isError: boolean;
}

export interface PreflightDiff {
  turn0TokensDelta: number;
  turn0BytesDelta: number;
  scoreDelta: number;
  addedFindings: Finding[];
  resolvedFindings: Finding[];
  removedTools: string[];
  addedTools: string[];
  breakingSchemaChanges: string[];
}

export interface PreflightSummary {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  turn0Tokens: number;
  turn0Bytes: number;
  onDemandTokens: number;
  mcpSchemaTokens: number;
  totalArtifacts: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  passed: boolean;
}

export interface PreflightReport {
  schemaVersion: "1.0.0";
  toolVersion: string;
  rootDir: string;
  generatedAt: string;
  summary: PreflightSummary;
  artifacts: ArtifactMetrics[];
  mcpTools: McpToolMetric[];
  mcpPayloads: McpPayloadStats[];
  findings: Finding[];
  diff?: PreflightDiff;
}

export interface PreflightOptions {
  rootDir: string;
  maxTurn0Tokens?: number;
  maxFileTokens?: number;
  maxSkillLines?: number;
  maxMcpBytes?: number;
  maxToolDescTokens?: number;
  failOn?: FailOnThreshold;
  ignoreRules?: string[];
  ignorePaths?: string[];
  probeMcp?: boolean;
  probeTimeoutMs?: number;
  scanCodePrompts?: boolean;
  baselineReport?: PreflightReport;
}

export interface ResolvedPreflightOptions {
  rootDir: string;
  maxTurn0Tokens: number;
  maxFileTokens: number;
  maxSkillLines: number;
  maxMcpBytes: number;
  maxToolDescTokens: number;
  failOn: FailOnThreshold;
  ignoreRules: Set<string>;
  ignorePaths: string[];
  probeMcp: boolean;
  probeTimeoutMs: number;
  scanCodePrompts: boolean;
  baselineReport?: PreflightReport;
}
