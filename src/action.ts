import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyzeRepository } from "./analyzer.js";
import { formatMarkdownReport, PR_COMMENT_MARKER } from "./reporters/markdown.js";
import { formatSarifReport } from "./reporters/sarif.js";
import { formatTerminalReport } from "./reporters/terminal.js";
import type { FailOnThreshold, PreflightReport } from "./types.js";

function getInput(name: string, fallback = ""): string {
  const upper = name.toUpperCase();
  const hyphen = `INPUT_${upper}`;
  const underscore = `INPUT_${upper.replace(/-/g, "_")}`;
  return (process.env[hyphen] ?? process.env[underscore] ?? fallback).trim();
}

function getBoolInput(name: string, fallback = false): boolean {
  const val = getInput(name, "");
  if (!val) return fallback;
  return val.toLowerCase() === "true" || val === "1";
}

function getIntInput(name: string, fallback: number): number {
  const raw = getInput(name, "");
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function appendOutputs(outputs: Record<string, string | number | boolean>): void {
  const outFile = process.env["GITHUB_OUTPUT"];
  if (!outFile) return;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v)}`);
  fs.appendFileSync(outFile, `${lines.join("\n")}\n`, "utf8");
}

function writeStepSummary(markdown: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (!summaryFile) return;
  fs.appendFileSync(summaryFile, `${markdown}\n`, "utf8");
}

function tryAnalyzeBaseBranch(
  repoRoot: string,
  baseRef: string,
  options: { maxTurn0Tokens: number; maxFileTokens: number; maxSkillLines: number },
): Promise<PreflightReport | undefined> {
  if (!baseRef) return Promise.resolve(undefined);
  const worktreeDir = path.join(path.dirname(repoRoot), `.preflight-base-${Date.now()}`);
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreeDir, `origin/${baseRef}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return analyzeRepository({
      rootDir: worktreeDir,
      maxTurn0Tokens: options.maxTurn0Tokens,
      maxFileTokens: options.maxFileTokens,
      maxSkillLines: options.maxSkillLines,
      failOn: "never",
    }).finally(() => {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
          cwd: repoRoot,
          stdio: "ignore",
        });
      } catch {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  } catch {
    return Promise.resolve(undefined);
  }
}

async function upsertPrComment(token: string, body: string): Promise<void> {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const repoFull = process.env["GITHUB_REPOSITORY"];
  if (!eventPath || !repoFull || !token || !fs.existsSync(eventPath)) return;

  let prNumber: number | undefined;
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as {
      pull_request?: { number?: number };
    };
    prNumber = event.pull_request?.number;
  } catch {
    return;
  }
  if (!prNumber) return;

  const apiBase = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "context-preflight-action",
  };

  const listUrl = `${apiBase}/repos/${repoFull}/issues/${prNumber}/comments?per_page=100`;
  const listResp = await fetch(listUrl, { headers });
  if (!listResp.ok) return;
  const comments = (await listResp.json()) as Array<{ id: number; body?: string }>;
  const existing = comments.find((c) => c.body?.includes(PR_COMMENT_MARKER));

  if (existing) {
    await fetch(`${apiBase}/repos/${repoFull}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
  } else {
    await fetch(`${apiBase}/repos/${repoFull}/issues/${prNumber}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
  }
}

async function runAction(): Promise<void> {
  const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  const targetRel = getInput("path", ".");
  const rootDir = path.resolve(workspace, targetRel);
  const maxTurn0Tokens = getIntInput("max-turn0-tokens", 8000);
  const maxFileTokens = getIntInput("max-file-tokens", 4000);
  const maxSkillLines = getIntInput("max-skill-lines", 500);
  const failOnRaw = getInput("fail-on", "error");
  const failOn: FailOnThreshold =
    failOnRaw === "warning" || failOnRaw === "never" ? failOnRaw : "error";
  const ignoreRulesRaw = getInput("ignore-rules", "");
  const ignoreRules = ignoreRulesRaw
    ? ignoreRulesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const ignorePathsRaw = getInput("ignore-paths", "");
  const ignorePaths = ignorePathsRaw
    ? ignorePathsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const sarifFile = getInput("sarif-file", "");
  const commentPr = getBoolInput("comment-pr", true);
  const githubToken = getInput("github-token", process.env["GITHUB_TOKEN"] ?? "");
  const baseRef = process.env["GITHUB_BASE_REF"] ?? "";

  const baselineReport = await tryAnalyzeBaseBranch(rootDir, baseRef, {
    maxTurn0Tokens,
    maxFileTokens,
    maxSkillLines,
  });

  const report = await analyzeRepository({
    rootDir,
    maxTurn0Tokens,
    maxFileTokens,
    maxSkillLines,
    failOn,
    ignoreRules,
    ignorePaths,
    baselineReport,
  });

  console.log(formatTerminalReport(report, { color: false, maxTurn0Tokens }));
  const markdown = formatMarkdownReport(report, { includeStickyMarker: true });
  writeStepSummary(markdown);

  let sarifOut = "";
  if (sarifFile) {
    const absSarif = path.resolve(workspace, sarifFile);
    fs.mkdirSync(path.dirname(absSarif), { recursive: true });
    fs.writeFileSync(absSarif, formatSarifReport(report), "utf8");
    sarifOut = sarifFile;
  }

  if (commentPr && githubToken) {
    try {
      await upsertPrComment(githubToken, markdown);
    } catch (err) {
      console.warn(
        `Unable to post PR comment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  appendOutputs({
    score: report.summary.score,
    grade: report.summary.grade,
    passed: report.summary.passed,
    "turn0-tokens": report.summary.turn0Tokens,
    "error-count": report.summary.errorCount,
    "warning-count": report.summary.warningCount,
    "sarif-file": sarifOut,
  });

  if (!report.summary.passed) {
    process.exitCode = 1;
  }
}

void runAction();
