import fs from "node:fs";
import path from "node:path";
import type { DiscoveredArtifact, ProjectContext } from "../discovery.js";
import {
  extractInlineCodeSpans,
  extractMarkdownLinks,
  scanMarkdownLines,
  type MarkdownLine,
} from "../markdown.js";
import type { Finding } from "../types.js";

const KNOWN_FILE_EXT_PATTERN =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rs|go|java|rb|sh|bash|zsh|json|yaml|yml|toml|md|mdx|mdc|txt|sql|env|css|html|svg|lock)$/i;

const EXAMPLE_LINE_HINT =
  /\b(?:e\.g\.|for example|example:|creates?:|outputs?:|writes? to|generates?|fixture|sample|template|hypothetical)\b/i;

const IGNORED_GENERATED_PREFIXES = [
  "dist/",
  "build/",
  "coverage/",
  "node_modules/",
  ".next/",
  ".turbo/",
  ".venv/",
  ".harnesscheck/",
  "target/",
];

function isExternalOrSpecialLink(target: string): boolean {
  const lower = target.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("data:") ||
    lower.startsWith("#") ||
    target.includes("{") ||
    target.includes("<")
  );
}

const SUBPROJECT_MARKERS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", ".mcp.json"];

function resolveLocalTarget(rootDir: string, fromFileAbs: string, target: string): boolean {
  const cleanTarget = target.split("#")[0]?.split("?")[0]?.trim() ?? "";
  if (!cleanTarget) return true;

  if (cleanTarget.startsWith("/")) {
    const repoAbs = path.resolve(rootDir, cleanTarget.slice(1));
    return fs.existsSync(repoAbs);
  }

  const fromDir = path.dirname(fromFileAbs);
  const relToFile = path.resolve(fromDir, cleanTarget);
  if (fs.existsSync(relToFile)) return true;

  const relToRoot = path.resolve(rootDir, cleanTarget);
  if (fs.existsSync(relToRoot)) return true;

  // Walk upward to resolve paths relative to a subpackage manifest or .claude/.agents base dir.
  const resolvedRoot = path.resolve(rootDir);
  let cursor = path.dirname(fromDir);
  while (cursor.startsWith(resolvedRoot) && cursor !== resolvedRoot) {
    const baseName = path.basename(cursor);
    if (baseName === ".claude" || baseName === ".agents") {
      const parentDir = path.dirname(cursor);
      if (fs.existsSync(path.resolve(parentDir, cleanTarget))) {
        return true;
      }
    }
    if (SUBPROJECT_MARKERS.some((marker) => fs.existsSync(path.join(cursor, marker)))) {
      if (fs.existsSync(path.resolve(cursor, cleanTarget))) {
        return true;
      }
    }
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }

  return false;
}

function looksLikeRepoFileRef(span: string): boolean {
  if (span.length < 3 || /\s/.test(span)) return false;
  if (span.includes("://") || span.includes("*")) return false;
  if (span.includes("<") || span.includes(">") || span.includes("{") || span.includes("$")) {
    return false;
  }
  if (span.startsWith("/.well-known/") || span.startsWith("/api/") || /^\/v\d+\//.test(span)) {
    return false;
  }
  if (span.startsWith("@")) return false;
  if (
    span.startsWith("~") ||
    span.startsWith("/etc/") ||
    span.startsWith("/tmp/") ||
    span.startsWith("/usr/")
  ) {
    return false;
  }

  const normalized = span.replace(/^\.\//, "");
  if (IGNORED_GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (normalized.startsWith(".") && normalized.includes("/") === false) {
    return false;
  }

  // Require either explicit relative prefix or directory separator + recognized file extension
  // so CLI flags, branch names (`feat/foo`), or MIME types (`application/json`) are never flagged.
  if (span.startsWith("./") || span.startsWith("../")) {
    return KNOWN_FILE_EXT_PATTERN.test(normalized) || normalized.endsWith("/");
  }
  if (!normalized.includes("/")) return false;
  return KNOWN_FILE_EXT_PATTERN.test(normalized);
}

/**
 * Parse Claude Code `@path/to/file` import lines safely while skipping scoped npm names like `@org/pkg`.
 */
export function extractClaudeImports(
  lines: MarkdownLine[],
): Array<{ target: string; line: number }> {
  const imports: Array<{ target: string; line: number }> = [];
  for (const entry of lines) {
    if (entry.inCodeFence) continue;
    const trimmed = entry.raw.trim();
    if (!trimmed.startsWith("@")) continue;
    const match = /^@([^\s,;()]+)$/.exec(trimmed);
    if (!match || !match[1]) continue;
    const target = match[1];
    // Require either relative prefix or recognizable file extension to distinguish from @scope/pkg or @user.
    if (
      target.startsWith("./") ||
      target.startsWith("../") ||
      KNOWN_FILE_EXT_PATTERN.test(target)
    ) {
      imports.push({ target, line: entry.lineNumber });
    }
  }
  return imports;
}

function checkImportsAndLinks(
  artifact: DiscoveredArtifact,
  lines: MarkdownLine[],
  rootDir: string,
): Finding[] {
  const findings: Finding[] = [];

  for (const imp of extractClaudeImports(lines)) {
    if (!resolveLocalTarget(rootDir, artifact.absPath, imp.target)) {
      findings.push({
        ruleId: "broken-import",
        category: "references",
        severity: "error",
        file: artifact.relPath,
        line: imp.line,
        column: 1,
        message: `Claude @import target '${imp.target}' does not exist in the repository`,
        suggestion: `Update or remove '@${imp.target}' so Claude Code does not fail to load missing context.`,
      });
    }
  }

  for (const link of extractMarkdownLinks(lines)) {
    if (isExternalOrSpecialLink(link.target)) continue;
    if (!resolveLocalTarget(rootDir, artifact.absPath, link.target)) {
      findings.push({
        ruleId: "broken-markdown-link",
        category: "references",
        severity: "error",
        file: artifact.relPath,
        line: link.line,
        column: link.column,
        message: `Broken local link '${link.target}' in ${artifact.relPath}`,
        suggestion: "Fix the relative file path or update the link target.",
      });
    }
  }

  return findings;
}

function checkBacktickFileRefs(
  artifact: DiscoveredArtifact,
  lines: MarkdownLine[],
  rootDir: string,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const span of extractInlineCodeSpans(lines)) {
    if (EXAMPLE_LINE_HINT.test(span.lineText)) continue;
    const contextWindow = lines
      .slice(Math.max(0, span.line - 4), span.line)
      .map((l) => l.raw)
      .join("\n");
    if (/(?:e\.g\.|site-packages|__file__|SDK's|\bSDK\b)/i.test(contextWindow)) {
      continue;
    }
    if (!looksLikeRepoFileRef(span.text)) continue;
    const dedupKey = `${span.line}:${span.text}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (!resolveLocalTarget(rootDir, artifact.absPath, span.text)) {
      findings.push({
        ruleId: "broken-file-ref",
        category: "references",
        severity: "warning",
        file: artifact.relPath,
        line: span.line,
        column: span.column,
        message: `Referenced path '${span.text}' was not found in the repository`,
        suggestion: "Verify if this file was renamed, moved, or deleted.",
      });
    }
  }
  return findings;
}

function checkScriptAndLockfileRefs(
  artifact: DiscoveredArtifact,
  lines: MarkdownLine[],
  ctx: ProjectContext,
): Finding[] {
  const findings: Finding[] = [];
  if (!ctx.hasPackageJson && ctx.makeTargets.size === 0) return findings;

  const pkgRunPattern = /\b(?:npm|pnpm|yarn|bun)\s+run\s+([A-Za-z0-9:._-]+)/g;
  const makePattern = /\bmake\s+([A-Za-z0-9_.-]+)/g;
  const usesNpmCmd = /\bnpm\s+(?:install|ci|run|test)\b/;
  const usesPnpmCmd = /\bpnpm\s+(?:install|run|test)\b/;
  const usesYarnCmd = /\byarn\s+(?:install|run|test)\b/;
  const usesPipCmd = /\bpip\s+install\b/;
  const usesUvCmd = /\buv\s+(?:sync|run|pip)\b/;
  const negativeAdvice = /\b(?:never|do\s+not|don't|avoid|instead\s+of|rather\s+than)\b/i;

  let mentionsNpm = false;
  let mentionsPnpm = false;
  let mentionsYarn = false;
  let mentionsPip = false;
  let mentionsUv = false;
  let firstNpmLine: number | undefined;
  let firstPipLine: number | undefined;

  const codeSegments: Array<{ text: string; line: number; column: number }> = [];
  for (const span of extractInlineCodeSpans(lines)) {
    codeSegments.push({ text: span.text, line: span.line, column: span.column });
  }
  for (const entry of lines) {
    if (entry.inCodeFence) {
      codeSegments.push({ text: entry.raw, line: entry.lineNumber, column: 1 });
    }
  }

  for (const seg of codeSegments) {
    if (ctx.scripts.size > 0) {
      pkgRunPattern.lastIndex = 0;
      for (const match of seg.text.matchAll(pkgRunPattern)) {
        const script = match[1];
        if (script && !ctx.scripts.has(script)) {
          findings.push({
            ruleId: "missing-script",
            category: "references",
            severity: "error",
            file: artifact.relPath,
            line: seg.line,
            column: seg.column + (match.index ?? 0),
            message: `Script '${script}' does not exist in any discovered package.json`,
            suggestion: `Available scripts include: ${Array.from(ctx.scripts).slice(0, 8).join(", ")}`,
          });
        }
      }
    }

    if (ctx.makeTargets.size > 0) {
      makePattern.lastIndex = 0;
      for (const match of seg.text.matchAll(makePattern)) {
        const target = match[1];
        if (target && !target.startsWith("-") && !ctx.makeTargets.has(target)) {
          findings.push({
            ruleId: "missing-script",
            category: "references",
            severity: "warning",
            file: artifact.relPath,
            line: seg.line,
            column: seg.column + (match.index ?? 0),
            message: `Make target '${target}' was not found in Makefile`,
          });
        }
      }
    }
  }

  for (const entry of lines) {
    if (negativeAdvice.test(entry.raw)) continue;
    if (usesNpmCmd.test(entry.raw)) {
      mentionsNpm = true;
      firstNpmLine ??= entry.lineNumber;
    }
    if (usesPnpmCmd.test(entry.raw)) mentionsPnpm = true;
    if (usesYarnCmd.test(entry.raw)) mentionsYarn = true;
    if (usesPipCmd.test(entry.raw)) {
      mentionsPip = true;
      firstPipLine ??= entry.lineNumber;
    }
    if (usesUvCmd.test(entry.raw)) mentionsUv = true;
  }

  if (ctx.lockfiles.pnpm && !ctx.lockfiles.npm && mentionsNpm && !mentionsPnpm) {
    findings.push({
      ruleId: "package-manager-drift",
      category: "references",
      severity: "warning",
      file: artifact.relPath,
      line: firstNpmLine,
      message: "Instructions invoke 'npm', but repository lockfile is pnpm-lock.yaml",
      suggestion:
        "Update commands to 'pnpm' so coding agents do not create stray package-lock.json files.",
    });
  } else if (ctx.lockfiles.yarn && !ctx.lockfiles.npm && mentionsNpm && !mentionsYarn) {
    findings.push({
      ruleId: "package-manager-drift",
      category: "references",
      severity: "warning",
      file: artifact.relPath,
      line: firstNpmLine,
      message: "Instructions invoke 'npm', but repository lockfile is yarn.lock",
      suggestion: "Update commands to 'yarn' to match the repository lockfile.",
    });
  }

  if (ctx.lockfiles.uv && mentionsPip && !mentionsUv) {
    findings.push({
      ruleId: "package-manager-drift",
      category: "references",
      severity: "warning",
      file: artifact.relPath,
      line: firstPipLine,
      message: "Instructions invoke 'pip install', but repository uses uv.lock",
      suggestion: "Consider recommending 'uv sync' or 'uv run' to match the repository setup.",
    });
  }

  return findings;
}

/**
 * Verify all local imports, file paths, Markdown links, scripts, and lockfile consistency.
 */
export function runReferenceRules(ctx: ProjectContext): Finding[] {
  const findings: Finding[] = [];

  for (const artifact of ctx.artifacts) {
    if (artifact.kind === "mcp-config" || artifact.kind === "claude-settings") continue;
    const lines = scanMarkdownLines(artifact.content);
    findings.push(...checkImportsAndLinks(artifact, lines, ctx.rootDir));
    findings.push(...checkBacktickFileRefs(artifact, lines, ctx.rootDir));
    findings.push(...checkScriptAndLockfileRefs(artifact, lines, ctx));
  }

  return findings;
}
