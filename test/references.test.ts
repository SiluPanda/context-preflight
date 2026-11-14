import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRepository } from "../src/index.js";

const tempDirs: string[] = [];

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ref-"));
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

describe("reference and script drift rules", () => {
  it("flags broken @imports while ignoring scoped npm package names", async () => {
    const rootDir = makeTempRepo({
      "docs/existing.md": "# Existing doc\n",
      "CLAUDE.md": [
        "@docs/existing.md",
        "@docs/missing-guide.md",
        "Use `@modelcontextprotocol/sdk` for custom servers.",
        "",
      ].join("\n"),
    });

    const report = await analyzeRepository({ rootDir });
    const imports = report.findings.filter((f) => f.ruleId === "broken-import");
    expect(imports).toHaveLength(1);
    expect(imports[0]?.message).toContain("docs/missing-guide.md");
  });

  it("flags broken relative markdown links and missing backtick file refs, skipping code fences", async () => {
    const rootDir = makeTempRepo({
      "src/real.ts": "export const ok = true;\n",
      "AGENTS.md": [
        "See [Architecture](docs/missing.md) and `src/real.ts`.",
        "Also check `src/nonexistent.ts` before merging.",
        "```bash",
        "# Ignore `src/example-only.ts` inside fenced code blocks",
        "```",
        "",
      ].join("\n"),
    });

    const report = await analyzeRepository({ rootDir });
    const brokenLinks = report.findings.filter((f) => f.ruleId === "broken-markdown-link");
    const brokenRefs = report.findings.filter((f) => f.ruleId === "broken-file-ref");

    expect(brokenLinks).toHaveLength(1);
    expect(brokenLinks[0]?.message).toContain("docs/missing.md");
    expect(brokenRefs).toHaveLength(1);
    expect(brokenRefs[0]?.message).toContain("src/nonexistent.ts");
  });

  it("detects missing package.json scripts and lockfile package-manager drift", async () => {
    const rootDir = makeTempRepo({
      "package.json": JSON.stringify({
        name: "sample-app",
        scripts: { test: "vitest run", build: "tsup" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "CLAUDE.md": [
        "Before submitting a PR, run `npm run lint` and `npm test`.",
        "Use `npm install` when updating packages.",
        "",
      ].join("\n"),
    });

    const report = await analyzeRepository({ rootDir });
    const missingScripts = report.findings.filter((f) => f.ruleId === "missing-script");
    const pmDrift = report.findings.filter((f) => f.ruleId === "package-manager-drift");

    expect(missingScripts).toHaveLength(1);
    expect(missingScripts[0]?.message).toContain("lint");
    expect(pmDrift.length).toBeGreaterThanOrEqual(1);
    expect(pmDrift[0]?.message).toContain("pnpm-lock.yaml");
  });

  it("passes cleanly when references, scripts, and lockfile manager match", async () => {
    const rootDir = makeTempRepo({
      "package.json": JSON.stringify({
        name: "healthy-app",
        scripts: { test: "vitest run", lint: "eslint ." },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "src/app.ts": "export const ready = true;\n",
      "CLAUDE.md": [
        "# Repo Guide",
        "Run `pnpm test` and `pnpm lint` after modifying `src/app.ts`.",
        "",
      ].join("\n"),
    });

    const report = await analyzeRepository({ rootDir });
    expect(report.findings).toHaveLength(0);
    expect(report.summary.passed).toBe(true);
    expect(report.summary.grade).toBe("A");
  });
});
