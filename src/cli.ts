#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzeRepository, TOOL_VERSION } from "./analyzer.js";
import { startMcpStdioServer } from "./mcp-server.js";
import { formatMarkdownReport } from "./reporters/markdown.js";
import { formatSarifReport } from "./reporters/sarif.js";
import { formatTerminalReport } from "./reporters/terminal.js";
import type { FailOnThreshold, PreflightOptions, PreflightReport } from "./types.js";

type OutputFormat = "text" | "json" | "markdown" | "sarif";

const WORKFLOW_TEMPLATE = `name: Context Preflight

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: SiluPanda/context-preflight@v1
        with:
          fail-on: error
          max-turn0-tokens: "8000"
          comment-pr: "true"
          sarif-file: context-preflight.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: context-preflight.sarif
`;

function printHelp(): void {
  console.log(`context-preflight v${TOOL_VERSION}

Preflight CI linter for AI coding-agent context layers
(CLAUDE.md, AGENTS.md, SKILL.md, .mcp.json, MCP schemas, and prompt caches).

Usage:
  context-preflight [scan] [path] [options]
  context-preflight compare <baseline.json> [path] [options]
  context-preflight init [path]
  context-preflight mcp

Options:
  --format <text|json|markdown|sarif>  Output format (default: text)
  --output <file>                      Write formatted output to a file
  --baseline <file.json>               Compare against a saved baseline JSON report
  --max-turn0-tokens <n>               Turn-0 context budget threshold (default: 8000)
  --max-file-tokens <n>                Per-file always-loaded token threshold (default: 4000)
  --max-skill-lines <n>                Max lines per SKILL.md body (default: 500)
  --max-mcp-bytes <n>                  Max compact bytes for saved MCP payloads (default: 65536)
  --max-tool-desc-tokens <n>           Max tokens per MCP tool description (default: 300)
  --fail-on <error|warning|never>      Exit non-zero threshold (default: error)
  --ignore-rule <ruleId>               Ignore a rule ID (repeatable)
  --ignore-path <glob>                 Ignore matching files/directories (repeatable)
  --probe-mcp                          Spawn local stdio servers from .mcp.json to audit tools/list
  --probe-timeout <ms>                 Timeout per live MCP probe in ms (default: 5000)
  --no-code-prompts                    Skip scanning TS/JS/PY source files for prompt cache risks
  --no-color                           Disable ANSI terminal colors
  -h, --help                           Show this help message
  -v, --version                        Show version`);
}

function parsePositiveInt(raw: string, flag: string): number {
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Flag ${flag} expects a positive integer (received '${raw}')`);
  }
  return num;
}

function parseCliArgs(argv: string[]): {
  mode: "scan" | "compare" | "init" | "mcp" | "help" | "version";
  targetPath: string;
  baselinePath?: string;
  format: OutputFormat;
  outputFile?: string;
  noColor: boolean;
  options: PreflightOptions;
} {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) {
    return {
      mode: "help",
      targetPath: ".",
      format: "text",
      noColor: false,
      options: { rootDir: "." },
    };
  }
  if (args.includes("-v") || args.includes("--version")) {
    return {
      mode: "version",
      targetPath: ".",
      format: "text",
      noColor: false,
      options: { rootDir: "." },
    };
  }

  const firstArg = args[0];
  let mode: "scan" | "compare" | "init" | "mcp" = "scan";
  if (firstArg === "scan" || firstArg === "compare" || firstArg === "init" || firstArg === "mcp") {
    mode = firstArg;
    args.shift();
  }

  let baselinePath: string | undefined;
  const positional: string[] = [];
  const ignoreRules: string[] = [];
  const ignorePaths: string[] = [];
  let format: OutputFormat = "text";
  let outputFile: string | undefined;
  let noColor = false;
  let failOn: FailOnThreshold = "error";
  let maxTurn0Tokens: number | undefined;
  let maxFileTokens: number | undefined;
  let maxSkillLines: number | undefined;
  let maxMcpBytes: number | undefined;
  let maxToolDescTokens: number | undefined;
  let probeMcp = false;
  let probeTimeoutMs: number | undefined;
  let scanCodePrompts = true;

  const takeValue = (flag: string): string => {
    const val = args.shift();
    if (val === undefined) throw new Error(`Missing value for ${flag}`);
    return val;
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) break;
    if (token === "--format") {
      const f = takeValue(token);
      if (f !== "text" && f !== "json" && f !== "markdown" && f !== "sarif") {
        throw new Error(`Invalid format '${f}'. Expected text, json, markdown, or sarif.`);
      }
      format = f;
    } else if (token === "--output") {
      outputFile = takeValue(token);
    } else if (token === "--baseline") {
      baselinePath = takeValue(token);
    } else if (token === "--max-turn0-tokens") {
      maxTurn0Tokens = parsePositiveInt(takeValue(token), token);
    } else if (token === "--max-file-tokens") {
      maxFileTokens = parsePositiveInt(takeValue(token), token);
    } else if (token === "--max-skill-lines") {
      maxSkillLines = parsePositiveInt(takeValue(token), token);
    } else if (token === "--max-mcp-bytes") {
      maxMcpBytes = parsePositiveInt(takeValue(token), token);
    } else if (token === "--max-tool-desc-tokens") {
      maxToolDescTokens = parsePositiveInt(takeValue(token), token);
    } else if (token === "--fail-on") {
      const f = takeValue(token);
      if (f !== "error" && f !== "warning" && f !== "never") {
        throw new Error(`Invalid --fail-on value '${f}'. Expected error, warning, or never.`);
      }
      failOn = f;
    } else if (token === "--ignore-rule") {
      ignoreRules.push(takeValue(token));
    } else if (token === "--ignore-path") {
      ignorePaths.push(takeValue(token));
    } else if (token === "--probe-mcp") {
      probeMcp = true;
    } else if (token === "--probe-timeout") {
      probeTimeoutMs = parsePositiveInt(takeValue(token), token);
    } else if (token === "--no-code-prompts") {
      scanCodePrompts = false;
    } else if (token === "--no-color") {
      noColor = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }

  if (mode === "compare") {
    baselinePath = baselinePath ?? positional.shift();
    if (!baselinePath) {
      throw new Error("compare subcommand requires <baseline.json>");
    }
  }

  const targetPath = positional[0] ?? ".";

  return {
    mode,
    targetPath,
    baselinePath,
    format,
    outputFile,
    noColor,
    options: {
      rootDir: targetPath,
      failOn,
      maxTurn0Tokens,
      maxFileTokens,
      maxSkillLines,
      maxMcpBytes,
      maxToolDescTokens,
      ignoreRules,
      ignorePaths,
      probeMcp,
      probeTimeoutMs,
      scanCodePrompts,
    },
  };
}

function runInit(targetDir: string): number {
  const workflowPath = path.resolve(targetDir, ".github/workflows/context-preflight.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  if (fs.existsSync(workflowPath)) {
    console.error(`Workflow already exists at ${workflowPath}`);
    return 2;
  }
  fs.writeFileSync(workflowPath, WORKFLOW_TEMPLATE, "utf8");
  console.log(`Created GitHub Actions workflow at ${workflowPath}`);
  return 0;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  if (parsed.mode === "help") {
    printHelp();
    return;
  }
  if (parsed.mode === "version") {
    console.log(TOOL_VERSION);
    return;
  }
  if (parsed.mode === "mcp") {
    startMcpStdioServer();
    return;
  }
  if (parsed.mode === "init") {
    process.exitCode = runInit(parsed.targetPath);
    return;
  }

  let baselineReport: PreflightReport | undefined;
  if (parsed.baselinePath) {
    try {
      const raw = fs.readFileSync(path.resolve(parsed.baselinePath), "utf8");
      baselineReport = JSON.parse(raw) as PreflightReport;
    } catch (err) {
      console.error(
        `Error reading baseline report '${parsed.baselinePath}': ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 2;
      return;
    }
  }

  const report = await analyzeRepository({
    ...parsed.options,
    baselineReport,
  });

  let formatted: string;
  if (parsed.format === "json") {
    formatted = JSON.stringify(report, null, 2);
  } else if (parsed.format === "markdown") {
    formatted = formatMarkdownReport(report);
  } else if (parsed.format === "sarif") {
    formatted = formatSarifReport(report);
  } else {
    formatted = formatTerminalReport(report, {
      color: parsed.noColor ? false : undefined,
      maxTurn0Tokens: parsed.options.maxTurn0Tokens,
    });
  }

  if (parsed.outputFile) {
    const outAbs = path.resolve(parsed.outputFile);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, `${formatted}\n`, "utf8");
  }

  if (parsed.format !== "sarif" || !parsed.outputFile) {
    console.log(formatted);
  }

  process.exitCode = report.summary.passed ? 0 : 1;
}

void main();
