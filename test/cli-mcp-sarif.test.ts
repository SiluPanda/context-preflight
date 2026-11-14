import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeRepository,
  formatMarkdownReport,
  formatSarifReport,
  formatTerminalReport,
  handleMcpRequest,
  PR_COMMENT_MARKER,
} from "../src/index.js";

const tempDirs: string[] = [];

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-cli-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("reporters, SARIF, and MCP JSON-RPC handler", () => {
  it("formats SARIF 2.1.0, Markdown PR comments, and plain terminal output", async () => {
    const rootDir = makeTempRepo({
      "CLAUDE.md": "See `src/missing.ts` before committing.\n",
    });

    const report = await analyzeRepository({ rootDir });

    const sarifRaw = formatSarifReport(report);
    const sarif = JSON.parse(sarifRaw) as {
      version: string;
      runs: Array<{ tool: { driver: { name: string } }; results: Array<{ ruleId: string }> }>;
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.tool.driver.name).toBe("context-preflight");
    expect(sarif.runs[0]?.results.some((r) => r.ruleId === "broken-file-ref")).toBe(true);

    const md = formatMarkdownReport(report, { includeStickyMarker: true });
    expect(md).toContain(PR_COMMENT_MARKER);
    expect(md).toContain("broken-file-ref");

    const term = formatTerminalReport(report, { color: false });
    expect(term).toContain("context-preflight");
    expect(term).toContain("broken-file-ref");
  });

  it("handles MCP initialize, ping, tools/list, preflight_scan, and error cases", async () => {
    const rootDir = makeTempRepo({
      "CLAUDE.md": "# Clean guide\n",
    });

    const initRes = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(initRes?.result).toMatchObject({
      serverInfo: { name: "context-preflight" },
    });

    const pingRes = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(pingRes?.result).toEqual({});

    const listRes = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (listRes?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["preflight_scan", "preflight_compare"]);

    const callRes = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "preflight_scan", arguments: { rootDir } },
    });
    const callPayload = callRes?.result as {
      isError?: boolean;
      structuredContent: { summary: { grade: string } };
    };
    expect(callPayload.isError).toBeUndefined();
    expect(callPayload.structuredContent.summary.grade).toBe("A");

    const notifRes = await handleMcpRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifRes).toBeNull();

    const missingToolRes = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    expect(missingToolRes?.error?.code).toBe(-32601);
  });

  it("probes a stdio MCP server config end-to-end", async () => {
    const mockServerScript = [
      "const rl = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      "  if (msg.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } } }) + '\\n');",
      "  } else if (msg.method === 'tools/list') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping_tool', description: 'Checks health.', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');",
      "  }",
      "});",
    ].join("\n");

    const rootDir = makeTempRepo({
      "mock-server.cjs": mockServerScript,
      ".mcp.json": JSON.stringify({
        mcpServers: {
          mockLocal: {
            command: process.execPath,
            args: ["./mock-server.cjs"],
          },
        },
      }),
    });

    const report = await analyzeRepository({
      rootDir,
      probeMcp: true,
      probeTimeoutMs: 4000,
    });

    expect(report.mcpTools.some((t) => t.name === "ping_tool" && t.server === "mockLocal")).toBe(
      true,
    );
    expect(report.findings.some((f) => f.ruleId === "mcp-probe-failed")).toBe(false);
  });
});

describe("CLI subcommands and exit codes", () => {
  it("runs scan, compare, init, and exits cleanly with expected codes", () => {
    const cleanDir = makeTempRepo({
      "CLAUDE.md": "# Clean project\n",
    });
    const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
    const cliEntry = path.resolve(process.cwd(), "src/cli.ts");

    const passRun = spawnSync(tsxBin, [cliEntry, cleanDir, "--format", "json"], {
      encoding: "utf8",
    });
    expect(passRun.status).toBe(0);
    const parsedPass = JSON.parse(passRun.stdout) as { summary: { passed: boolean } };
    expect(parsedPass.summary.passed).toBe(true);

    const brokenDir = makeTempRepo({
      "CLAUDE.md": "Check [Guide](docs/missing.md) and `src/does-not-exist.ts`.\n",
    });
    const failRun = spawnSync(tsxBin, [cliEntry, brokenDir, "--no-color"], {
      encoding: "utf8",
    });
    expect(failRun.status).toBe(1);
    expect(failRun.stdout).toContain("broken-markdown-link");
    expect(failRun.stdout).toContain("broken-file-ref");

    const warnOnlyDir = makeTempRepo({
      "CLAUDE.md": "Check `src/does-not-exist.ts`.\n",
    });
    const warnFailRun = spawnSync(
      tsxBin,
      [cliEntry, warnOnlyDir, "--fail-on", "warning", "--no-color"],
      { encoding: "utf8" },
    );
    expect(warnFailRun.status).toBe(1);

    const baselinePath = path.join(brokenDir, "baseline.json");
    fs.writeFileSync(baselinePath, passRun.stdout, "utf8");
    const compareRun = spawnSync(
      tsxBin,
      [cliEntry, "compare", baselinePath, brokenDir, "--format", "markdown", "--fail-on", "never"],
      { encoding: "utf8" },
    );
    expect(compareRun.status).toBe(0);
    expect(compareRun.stdout).toContain("## Context Preflight:");
    expect(compareRun.stdout).toContain("Baseline Delta");

    const initRun = spawnSync(tsxBin, [cliEntry, "init", cleanDir], { encoding: "utf8" });
    expect(initRun.status).toBe(0);
    expect(fs.existsSync(path.join(cleanDir, ".github/workflows/context-preflight.yml"))).toBe(
      true,
    );

    const badFlagRun = spawnSync(tsxBin, [cliEntry, "--bad-flag"], { encoding: "utf8" });
    expect(badFlagRun.status).toBe(2);
  });
});
