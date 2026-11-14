import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeRepository,
  auditToolDefinitions,
  diffReports,
  resolveOptions,
} from "../src/index.js";

const tempDirs: string[] = [];

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-budget-"));
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

describe("token budgets, skills, overlap, and cache risks", () => {
  it("validates SKILL.md frontmatter and flags oversized skill bodies", async () => {
    const longBody = Array.from({ length: 520 }, (_, i) => `Step ${i + 1}: verify output.`).join(
      "\n",
    );
    const rootDir = makeTempRepo({
      ".claude/skills/bad-skill/SKILL.md": "# No Frontmatter\nDo things.\n",
      ".claude/skills/huge-skill/SKILL.md": [
        "---",
        "name: huge-skill",
        "description: Handles release automation safely.",
        "---",
        longBody,
        "",
      ].join("\n"),
    });

    const report = await analyzeRepository({ rootDir, maxSkillLines: 500 });
    expect(report.findings.some((f) => f.ruleId === "skill-frontmatter-invalid")).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "skill-bloat")).toBe(true);
  });

  it("deduplicates cyclic @imports when computing turn-0 tokens", async () => {
    const chunk = "Always run regression tests before merging.\n".repeat(40);
    const rootDir = makeTempRepo({
      "CLAUDE.md": "@docs/a.md\n@docs/b.md\n",
      "docs/a.md": `@docs/b.md\n${chunk}`,
      "docs/b.md": `@docs/a.md\n${chunk}`,
    });

    const report = await analyzeRepository({ rootDir, maxTurn0Tokens: 50000 });
    expect(report.findings.filter((f) => f.ruleId === "broken-import")).toHaveLength(0);
    expect(report.summary.turn0Tokens).toBeGreaterThan(200);
    expect(report.summary.turn0Tokens).toBeLessThan(1200);
  });

  it("flags instruction overlap between root CLAUDE.md and AGENTS.md", async () => {
    const sharedText = Array.from(
      { length: 30 },
      (_, i) =>
        `Rule ${i + 1}: Run unit tests, build artifacts, verify schema compatibility, and inspect diffs cleanly.`,
    ).join("\n");

    const rootDir = makeTempRepo({
      "CLAUDE.md": sharedText,
      "AGENTS.md": sharedText,
    });

    const report = await analyzeRepository({ rootDir });
    expect(report.findings.some((f) => f.ruleId === "duplicate-instruction-overlap")).toBe(true);
  });

  it("detects turn-0 budget errors and warnings", async () => {
    const mediumText = "instruction token filler line ".repeat(60);
    const rootDir = makeTempRepo({
      "CLAUDE.md": mediumText,
    });

    const warnReport = await analyzeRepository({ rootDir, maxTurn0Tokens: 500 });
    expect(warnReport.findings.some((f) => f.ruleId === "turn0-budget-warning")).toBe(true);

    const errReport = await analyzeRepository({ rootDir, maxTurn0Tokens: 300 });
    expect(errReport.findings.some((f) => f.ruleId === "turn0-budget-exceeded")).toBe(true);
    expect(errReport.summary.passed).toBe(false);
  });

  it("detects dynamic cache-breaker expressions near system prompt prefixes", async () => {
    const rootDir = makeTempRepo({
      "src/agent.ts": [
        "export function buildRequest() {",
        "  const systemPrompt = {",
        "    type: 'text',",
        "    text: `Current timestamp is ${new Date().toISOString()}`,",
        "    cache_control: { type: 'ephemeral' },",
        "  };",
        "  return { systemPrompt };",
        "}",
        "",
      ].join("\n"),
    });

    const report = await analyzeRepository({ rootDir });
    const cacheFinding = report.findings.find((f) => f.ruleId === "cache-breaker-risk");
    expect(cacheFinding).toBeDefined();
    expect(cacheFinding?.severity).toBe("warning");
  });
});

describe("MCP schema auditing, payload waste, and report diffs", () => {
  it("audits MCP tool definitions for duplicates, missing descriptions, and schema bugs", () => {
    const opts = resolveOptions({ rootDir: ".", maxToolDescTokens: 50 });
    const { metrics, findings } = auditToolDefinitions(
      [
        {
          name: "search_docs",
          description: "Search internal docs.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query", "ghostField"],
          },
        },
        {
          name: "search_docs",
          description: "",
          inputSchema: { type: "string" },
        },
      ],
      "docs-mcp",
      "fixtures/tools.json",
      opts,
    );

    expect(metrics).toHaveLength(2);
    expect(findings.some((f) => f.ruleId === "duplicate-tool-name")).toBe(true);
    expect(findings.some((f) => f.ruleId === "missing-tool-description")).toBe(true);
    expect(findings.some((f) => f.ruleId === "invalid-tool-schema")).toBe(true);
  });

  it("detects mirror payloads, repeated subtrees, and payload byte budgets in MCP fixtures", async () => {
    const mirroredItem = {
      id: "doc-1",
      title: "Architecture Overview and Request Flow",
      tags: ["mcp", "context", "preflight", "audit"],
    };
    const repeatedMeta = {
      owner: "platform-team",
      environment: "production-us-west-2",
      retentionPolicy: "30-days-immutable-audit-trail",
    };

    const payload = {
      content: [{ type: "text", text: JSON.stringify(mirroredItem) }],
      structuredContent: {
        tags: ["mcp", "context", "preflight", "audit"],
        title: "Architecture Overview and Request Flow",
        id: "doc-1",
      },
      records: [
        { name: "first", meta: { ...repeatedMeta } },
        { name: "second", meta: { ...repeatedMeta } },
      ],
    };

    const rootDir = makeTempRepo({
      "fixtures/mcp-result.json": JSON.stringify(payload),
    });

    const report = await analyzeRepository({ rootDir, maxMcpBytes: 250 });
    expect(report.mcpPayloads).toHaveLength(1);
    expect(report.findings.some((f) => f.ruleId === "mirror-payload-bloat")).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "repeated-payload-subtrees")).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "mcp-payload-budget-exceeded")).toBe(true);
  });

  it("computes PR diff deltas and removed tool breaking changes", async () => {
    const baselineDir = makeTempRepo({
      "CLAUDE.md": "Always verify schemas.\n",
      "fixtures/mcp-tools.json": JSON.stringify({
        tools: [
          {
            name: "read_item",
            description: "Reads one item.",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
          {
            name: "delete_item",
            description: "Deletes one item.",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
      }),
    });

    const currentDir = makeTempRepo({
      "CLAUDE.md": "Always verify schemas and also check `missing/file.ts`.\n",
      "fixtures/mcp-tools.json": JSON.stringify({
        tools: [
          {
            name: "read_item",
            description: "Reads one item.",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
          {
            name: "list_items",
            description: "Lists items.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    });

    const baseline = await analyzeRepository({ rootDir: baselineDir });
    const current = await analyzeRepository({ rootDir: currentDir, baselineReport: baseline });
    const diff = current.diff ?? diffReports(baseline, current);

    expect(diff.turn0TokensDelta).toBeGreaterThan(0);
    expect(diff.addedFindings.some((f) => f.ruleId === "broken-file-ref")).toBe(true);
    expect(diff.removedTools).toEqual(["delete_item"]);
    expect(diff.addedTools).toEqual(["list_items"]);
    expect(diff.breakingSchemaChanges).toContain("Tool removed: 'delete_item'");
  });
});
