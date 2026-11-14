type Severity = "error" | "warning" | "info";
type RuleCategory = "references" | "budget" | "security" | "mcp" | "skill";
type FailOnThreshold = "error" | "warning" | "never";
type ArtifactKind = "claude-md" | "agents-md" | "gemini-md" | "copilot-instructions" | "cursor-rule" | "skill-md" | "mcp-config" | "claude-settings" | "claude-command" | "mcp-fixture";
interface Finding {
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
interface ArtifactMetrics {
    path: string;
    kind: ArtifactKind;
    alwaysLoaded: boolean;
    bytes: number;
    lines: number;
    estimatedTokens: number;
    importCount?: number;
}
interface McpToolMetric {
    server: string;
    sourceFile: string;
    name: string;
    descriptionTokens: number;
    schemaTokens: number;
    totalTokens: number;
    hasDescription: boolean;
    schemaIssues: string[];
}
interface McpPayloadStats {
    file: string;
    compactBytes: number;
    estimatedTokens: number;
    mirrorCount: number;
    repeatedSubtreeCount: number;
    largestLeafPointer?: string;
    largestLeafBytes?: number;
    isError: boolean;
}
interface PreflightDiff {
    turn0TokensDelta: number;
    turn0BytesDelta: number;
    scoreDelta: number;
    addedFindings: Finding[];
    resolvedFindings: Finding[];
    removedTools: string[];
    addedTools: string[];
    breakingSchemaChanges: string[];
}
interface PreflightSummary {
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
interface PreflightReport {
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
interface PreflightOptions {
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
interface ResolvedPreflightOptions {
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

declare const TOOL_VERSION = "0.1.0";
declare function resolveOptions(options: PreflightOptions): ResolvedPreflightOptions;
/**
 * Analyze a repository's coding-agent context files, skills, MCP schemas, and prompt-cache hygiene.
 */
declare function analyzeRepository(options: PreflightOptions): Promise<PreflightReport>;

/**
 * Compare a baseline preflight report against a candidate report for PR CI gates and deltas.
 */
declare function diffReports(baseline: PreflightReport, current: PreflightReport): PreflightDiff;

interface DiscoveredArtifact {
    relPath: string;
    absPath: string;
    kind: ArtifactKind;
    alwaysLoaded: boolean;
    isRootLevel: boolean;
    content: string;
    bytes: number;
}
interface ProjectContext {
    rootDir: string;
    artifacts: DiscoveredArtifact[];
    mcpFixtures: Array<{
        relPath: string;
        absPath: string;
        parsed: unknown;
        rawText: string;
    }>;
    promptSourceFiles: Array<{
        relPath: string;
        absPath: string;
        content: string;
    }>;
    scripts: Set<string>;
    binNames: Set<string>;
    makeTargets: Set<string>;
    justRecipes: Set<string>;
    lockfiles: {
        npm: boolean;
        pnpm: boolean;
        yarn: boolean;
        bun: boolean;
        uv: boolean;
        poetry: boolean;
    };
    hasPackageJson: boolean;
    hasPyproject: boolean;
    hasCargo: boolean;
    hasGoMod: boolean;
    allKnownRelPaths: Set<string>;
}
/**
 * Discover all agent context files, configs, MCP fixtures, scripts, and lockfiles in a repository.
 */
declare function discoverProject(rootDir: string, options?: {
    ignorePaths?: string[];
    scanCodePrompts?: boolean;
}): ProjectContext;

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}
/**
 * Handle a single JSON-RPC message for `context-preflight mcp` (exported for deterministic unit testing).
 */
declare function handleMcpRequest(msg: JsonRpcRequest): Promise<{
    id: string | number | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
} | null>;

interface RawMcpTool {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    outputSchema?: unknown;
}
/**
 * Audit a list of MCP tools (`tools/list` output or fixture) for schema errors, token bloat, and poisoning.
 */
declare function auditToolDefinitions(tools: RawMcpTool[], serverName: string, sourceFile: string, options: ResolvedPreflightOptions): {
    metrics: McpToolMetric[];
    findings: Finding[];
};

declare const PR_COMMENT_MARKER = "<!-- context-preflight -->";
/**
 * Format a compact Markdown report suitable for GitHub PR sticky comments and Step Summaries.
 */
declare function formatMarkdownReport(report: PreflightReport, options?: {
    includeStickyMarker?: boolean;
}): string;

/**
 * Generate a SARIF 2.1.0 document compatible with GitHub Code Scanning uploads.
 */
declare function formatSarifReport(report: PreflightReport): string;

/**
 * Render a readable terminal summary with turn-0 budget breakdown, deltas, and line-level findings.
 */
declare function formatTerminalReport(report: PreflightReport, options?: {
    color?: boolean;
    maxTurn0Tokens?: number;
}): string;

/**
 * Compute exact UTF-8 byte length of a string.
 */
declare function utf8Bytes(text: string): number;
/**
 * Deterministic token heuristic aligned with common BPE/Claude averages (~4 UTF-8 bytes/token).
 * Documented explicitly as an offline approximation rather than a provider-specific tokenizer.
 */
declare function estimateTokens(text: string): number;
/**
 * Serialize a JSON value compactly with sorted object keys and return both string and UTF-8 bytes.
 */
declare function canonicalJsonString(value: unknown): string;
declare function compactJsonBytes(value: unknown): number;

export { type ArtifactKind, type ArtifactMetrics, type DiscoveredArtifact, type FailOnThreshold, type Finding, type McpPayloadStats, type McpToolMetric, PR_COMMENT_MARKER, type PreflightDiff, type PreflightOptions, type PreflightReport, type PreflightSummary, type ProjectContext, type RawMcpTool, type RuleCategory, type Severity, TOOL_VERSION, analyzeRepository, auditToolDefinitions, canonicalJsonString, compactJsonBytes, diffReports, discoverProject, estimateTokens, formatMarkdownReport, formatSarifReport, formatTerminalReport, handleMcpRequest, resolveOptions, utf8Bytes };
