import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./markdown.js";
import type { ArtifactKind } from "./types.js";
import { utf8Bytes } from "./tokens.js";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "_next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
]);

const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_FIXTURE_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_SOURCE_BYTES = 512 * 1024;

export interface DiscoveredArtifact {
  relPath: string;
  absPath: string;
  kind: ArtifactKind;
  alwaysLoaded: boolean;
  isRootLevel: boolean;
  content: string;
  bytes: number;
}

export interface ProjectContext {
  rootDir: string;
  artifacts: DiscoveredArtifact[];
  mcpFixtures: Array<{ relPath: string; absPath: string; parsed: unknown; rawText: string }>;
  promptSourceFiles: Array<{ relPath: string; absPath: string; content: string }>;
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
 * Normalize paths to forward slashes for deterministic cross-platform reporting.
 */
export function toPosixRel(rootDir: string, targetPath: string): string {
  const rel = path.relative(rootDir, targetPath);
  return rel.split(path.sep).join("/");
}

function loadGitignoreMatchers(rootDir: string): string[] {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  try {
    const raw = fs.readFileSync(gitignorePath, "utf8");
    return raw
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

function matchesSimplePattern(relPosix: string, baseName: string, pattern: string): boolean {
  const cleaned = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) return false;
  if (cleaned === baseName || cleaned === relPosix) return true;
  if (cleaned.includes("*")) {
    const escaped = cleaned
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DOUBLE_STAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DOUBLE_STAR::/g, ".*");
    return new RegExp(`^${escaped}$`).test(relPosix) || new RegExp(`^${escaped}$`).test(baseName);
  }
  return relPosix.startsWith(`${cleaned}/`);
}

function isIgnored(
  relPosix: string,
  baseName: string,
  extraIgnorePaths: string[],
  gitignorePatterns: string[],
): boolean {
  if (DEFAULT_IGNORED_DIRS.has(baseName)) return true;
  for (const pat of extraIgnorePaths) {
    if (matchesSimplePattern(relPosix, baseName, pat)) return true;
  }
  for (const pat of gitignorePatterns) {
    if (matchesSimplePattern(relPosix, baseName, pat)) return true;
  }
  return false;
}

function classifyArtifact(
  relPosix: string,
  content: string,
): { kind: ArtifactKind; alwaysLoaded: boolean; isRootLevel: boolean } | null {
  const base = path.posix.basename(relPosix);
  const dir = path.posix.dirname(relPosix);
  const isRootLevel = dir === ".";

  if (base === "CLAUDE.md" || base === "CLAUDE.local.md") {
    const isRootOrDotClaude = isRootLevel || relPosix === ".claude/CLAUDE.md";
    return { kind: "claude-md", alwaysLoaded: isRootOrDotClaude, isRootLevel: isRootOrDotClaude };
  }
  if (base === "AGENTS.md" || base === "AGENTS.override.md") {
    return { kind: "agents-md", alwaysLoaded: isRootLevel, isRootLevel };
  }
  if (base === "GEMINI.md") {
    return { kind: "gemini-md", alwaysLoaded: isRootLevel, isRootLevel };
  }
  if (relPosix === ".github/copilot-instructions.md") {
    return { kind: "copilot-instructions", alwaysLoaded: true, isRootLevel: true };
  }
  if (/^\.github\/instructions\/.+\.instructions\.md$/.test(relPosix)) {
    const fm = parseFrontmatter(content);
    return {
      kind: "copilot-instructions",
      alwaysLoaded: !fm.fields["applyTo"],
      isRootLevel: false,
    };
  }
  if (base === ".cursorrules") {
    return { kind: "cursor-rule", alwaysLoaded: true, isRootLevel: true };
  }
  if (/^\.cursor\/rules\/.+\.(?:md|mdc)$/.test(relPosix)) {
    const fm = parseFrontmatter(content);
    const alwaysApply = fm.fields["alwaysApply"] === true;
    return { kind: "cursor-rule", alwaysLoaded: alwaysApply, isRootLevel: false };
  }
  if (base === "SKILL.md") {
    return { kind: "skill-md", alwaysLoaded: false, isRootLevel: false };
  }
  if (/^\.claude\/(?:commands|agents)\/.+\.md$/.test(relPosix)) {
    return { kind: "claude-command", alwaysLoaded: false, isRootLevel: false };
  }
  if (
    relPosix === ".mcp.json" ||
    relPosix === "mcp.json" ||
    relPosix === ".cursor/mcp.json" ||
    relPosix === ".vscode/mcp.json"
  ) {
    return { kind: "mcp-config", alwaysLoaded: true, isRootLevel: true };
  }
  if (relPosix === ".claude/settings.json" || relPosix === ".claude/settings.local.json") {
    return { kind: "claude-settings", alwaysLoaded: false, isRootLevel: true };
  }
  return null;
}

function isCandidateMcpFixturePath(relPosix: string): boolean {
  if (!relPosix.endsWith(".json")) return false;
  const base = path.posix.basename(relPosix).toLowerCase();
  if (base === "package.json" || base === "package-lock.json" || base === "tsconfig.json") {
    return false;
  }
  return (
    /(?:^|\/)(?:fixtures?|examples?|testdata|\.mcp)\//.test(relPosix) ||
    /(?:mcp|tools?-list|tool-result|call-tool)/.test(base)
  );
}

function hasMcpToolShape(items: unknown[]): boolean {
  if (items.length === 0) return false;
  let sawMcpInputSchema = false;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    // OpenAI ChatCompletions tool definitions use { type: "function", function: { ... } }, not MCP.
    if (rec["type"] === "function" && typeof rec["function"] === "object") {
      return false;
    }
    if ("inputSchema" in rec) {
      sawMcpInputSchema = true;
    }
  }
  return sawMcpInputSchema;
}

function hasMcpContentShape(items: unknown[]): boolean {
  if (items.length === 0) return false;
  return items.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const rec = item as Record<string, unknown>;
    return (
      rec["type"] === "text" ||
      rec["type"] === "image" ||
      rec["type"] === "audio" ||
      rec["type"] === "resource"
    );
  });
}

function looksLikeMcpPayloadOrToolsList(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj["tools"]) && hasMcpToolShape(obj["tools"])) return true;
  if ("structuredContent" in obj) return true;
  if (Array.isArray(obj["content"]) && hasMcpContentShape(obj["content"])) return true;
  const result = obj["result"];
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const resObj = result as Record<string, unknown>;
    if (Array.isArray(resObj["tools"]) && hasMcpToolShape(resObj["tools"])) return true;
    if ("structuredContent" in resObj) return true;
    if (Array.isArray(resObj["content"]) && hasMcpContentShape(resObj["content"])) return true;
  }
  return false;
}

function parseMakefileTargets(content: string): string[] {
  const targets: string[] = [];
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (!line || /^\s/.test(line) || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (match && match[1] && !match[1].startsWith(".")) {
      targets.push(match[1]);
    }
  }
  return targets;
}

function parseJustRecipes(content: string): string[] {
  const recipes: string[] = [];
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (!line || /^\s/.test(line) || line.startsWith("#")) continue;
    if (/^(?:alias|set|export|import)\b/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:]*)?:(?!=)/.exec(line);
    if (match && match[1]) recipes.push(match[1]);
  }
  return recipes;
}

function parsePyprojectScripts(content: string): string[] {
  const scripts: string[] = [];
  let inScripts = false;
  for (const line of content.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inScripts =
        trimmed === "[project.scripts]" ||
        trimmed === "[tool.poetry.scripts]" ||
        trimmed === "[tool.uv.scripts]";
      continue;
    }
    if (!inScripts || !trimmed || trimmed.startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=/.exec(trimmed);
    if (kv && kv[1]) scripts.push(kv[1]);
  }
  return scripts;
}

/**
 * Discover all agent context files, configs, MCP fixtures, scripts, and lockfiles in a repository.
 */
export function discoverProject(
  rootDir: string,
  options: { ignorePaths?: string[]; scanCodePrompts?: boolean } = {},
): ProjectContext {
  const resolvedRoot = path.resolve(rootDir);
  const gitignorePatterns = loadGitignoreMatchers(resolvedRoot);
  const extraIgnore = options.ignorePaths ?? [];
  const scanCodePrompts = options.scanCodePrompts ?? true;

  const ctx: ProjectContext = {
    rootDir: resolvedRoot,
    artifacts: [],
    mcpFixtures: [],
    promptSourceFiles: [],
    scripts: new Set<string>(),
    binNames: new Set<string>(),
    makeTargets: new Set<string>(),
    justRecipes: new Set<string>(),
    lockfiles: {
      npm: false,
      pnpm: false,
      yarn: false,
      bun: false,
      uv: false,
      poetry: false,
    },
    hasPackageJson: false,
    hasPyproject: false,
    hasCargo: false,
    hasGoMod: false,
    allKnownRelPaths: new Set<string>(),
  };

  const queue: string[] = [resolvedRoot];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absPath = path.join(currentDir, entry.name);
      const relPosix = toPosixRel(resolvedRoot, absPath);

      if (entry.isDirectory()) {
        if (!isIgnored(relPosix, entry.name, extraIgnore, gitignorePatterns)) {
          ctx.allKnownRelPaths.add(relPosix);
          queue.push(absPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      ctx.allKnownRelPaths.add(relPosix);

      // Record package manifests/lockfiles even if root .gitignore excludes a generated manifest,
      // while skipping ignored artifacts, bundles, and test fixtures.
      if (isManifestOrLockfileName(entry.name)) {
        try {
          const manifestSize = fs.statSync(absPath).size;
          recordLockfileAndManifest(ctx, absPath, relPosix, entry.name, manifestSize);
        } catch {
          // Ignore unreadable manifests cleanly.
        }
      }

      if (isIgnored(relPosix, entry.name, extraIgnore, gitignorePatterns)) continue;

      inspectDiscoveredFile(ctx, absPath, relPosix, entry.name, scanCodePrompts);
    }
  }

  ctx.artifacts.sort((a, b) => a.relPath.localeCompare(b.relPath));
  ctx.mcpFixtures.sort((a, b) => a.relPath.localeCompare(b.relPath));
  ctx.promptSourceFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return ctx;
}

function inspectDiscoveredFile(
  ctx: ProjectContext,
  absPath: string,
  relPosix: string,
  baseName: string,
  scanCodePrompts: boolean,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }

  if (stat.size <= MAX_TEXT_ARTIFACT_BYTES) {
    const maybeKind = classifyArtifactNameOnly(relPosix, baseName);
    if (maybeKind) {
      try {
        const content = fs.readFileSync(absPath, "utf8");
        const classified = classifyArtifact(relPosix, content);
        if (classified) {
          ctx.artifacts.push({
            relPath: relPosix,
            absPath,
            kind: classified.kind,
            alwaysLoaded: classified.alwaysLoaded,
            isRootLevel: classified.isRootLevel,
            content,
            bytes: utf8Bytes(content),
          });
        }
      } catch {
        return;
      }
      return;
    }
  }

  if (stat.size <= MAX_JSON_FIXTURE_BYTES && isCandidateMcpFixturePath(relPosix)) {
    try {
      const rawText = fs.readFileSync(absPath, "utf8");
      const parsed: unknown = JSON.parse(rawText);
      if (looksLikeMcpPayloadOrToolsList(parsed)) {
        ctx.mcpFixtures.push({ relPath: relPosix, absPath, parsed, rawText });
      }
    } catch {
      // Non-JSON or malformed JSON fixtures should not crash discovery.
    }
    return;
  }

  if (
    scanCodePrompts &&
    stat.size <= MAX_PROMPT_SOURCE_BYTES &&
    /\.(?:ts|tsx|js|jsx|mjs|mts|py)$/.test(baseName) &&
    !baseName.endsWith(".d.ts") &&
    !baseName.includes(".min.") &&
    !/(?:^|\/)(?:tests?|__tests__|spec|fixtures?|static\/chunks|out\/_next)\//.test(relPosix) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(baseName)
  ) {
    try {
      const content = fs.readFileSync(absPath, "utf8");
      const firstNewline = content.indexOf("\n");
      const firstLineLen = firstNewline === -1 ? content.length : firstNewline;
      if (firstLineLen > 800) {
        return;
      }
      if (
        content.includes("cache_control") ||
        content.includes("systemPrompt") ||
        content.includes("system_prompt") ||
        content.includes("anthropic") ||
        content.includes("messages.create")
      ) {
        ctx.promptSourceFiles.push({ relPath: relPosix, absPath, content });
      }
    } catch {
      // Ignore unreadable files cleanly.
    }
  }
}

function classifyArtifactNameOnly(relPosix: string, baseName: string): boolean {
  return (
    baseName === "CLAUDE.md" ||
    baseName === "CLAUDE.local.md" ||
    baseName === "AGENTS.md" ||
    baseName === "AGENTS.override.md" ||
    baseName === "GEMINI.md" ||
    baseName === "SKILL.md" ||
    baseName === ".cursorrules" ||
    relPosix === ".github/copilot-instructions.md" ||
    relPosix === ".mcp.json" ||
    relPosix === "mcp.json" ||
    relPosix === ".cursor/mcp.json" ||
    relPosix === ".vscode/mcp.json" ||
    relPosix === ".claude/settings.json" ||
    relPosix === ".claude/settings.local.json" ||
    /^\.github\/instructions\/.+\.instructions\.md$/.test(relPosix) ||
    /^\.cursor\/rules\/.+\.(?:md|mdc)$/.test(relPosix) ||
    /^\.claude\/(?:commands|agents)\/.+\.md$/.test(relPosix)
  );
}

function isManifestOrLockfileName(baseName: string): boolean {
  return (
    baseName === "package.json" ||
    baseName === "package-lock.json" ||
    baseName === "pnpm-lock.yaml" ||
    baseName === "yarn.lock" ||
    baseName === "bun.lock" ||
    baseName === "bun.lockb" ||
    baseName === "uv.lock" ||
    baseName === "poetry.lock" ||
    baseName === "Cargo.toml" ||
    baseName === "go.mod" ||
    baseName === "Makefile" ||
    baseName === "GNUmakefile" ||
    baseName === "Justfile" ||
    baseName === "justfile" ||
    baseName === "pyproject.toml"
  );
}

function recordLockfileAndManifest(
  ctx: ProjectContext,
  absPath: string,
  relPosix: string,
  baseName: string,
  size: number,
): void {
  if (baseName === "package-lock.json") ctx.lockfiles.npm = true;
  if (baseName === "pnpm-lock.yaml") ctx.lockfiles.pnpm = true;
  if (baseName === "yarn.lock") ctx.lockfiles.yarn = true;
  if (baseName === "bun.lock" || baseName === "bun.lockb") ctx.lockfiles.bun = true;
  if (baseName === "uv.lock") ctx.lockfiles.uv = true;
  if (baseName === "poetry.lock") ctx.lockfiles.poetry = true;
  if (baseName === "Cargo.toml") ctx.hasCargo = true;
  if (baseName === "go.mod") ctx.hasGoMod = true;

  if (size > MAX_TEXT_ARTIFACT_BYTES) return;

  if (baseName === "package.json") {
    ctx.hasPackageJson = true;
    try {
      const pkg = JSON.parse(fs.readFileSync(absPath, "utf8")) as Record<string, unknown>;
      const scripts = pkg["scripts"];
      if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
        for (const name of Object.keys(scripts)) {
          ctx.scripts.add(name);
        }
      }
      const bin = pkg["bin"];
      if (typeof bin === "string" && typeof pkg["name"] === "string") {
        ctx.binNames.add(pkg["name"]);
      } else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
        for (const name of Object.keys(bin)) {
          ctx.binNames.add(name);
        }
      }
    } catch {
      // Ignore invalid JSON.
    }
  } else if (baseName === "Makefile" || baseName === "GNUmakefile") {
    try {
      for (const t of parseMakefileTargets(fs.readFileSync(absPath, "utf8"))) {
        ctx.makeTargets.add(t);
      }
    } catch {
      // Ignore read errors.
    }
  } else if (baseName === "Justfile" || baseName === "justfile") {
    try {
      for (const r of parseJustRecipes(fs.readFileSync(absPath, "utf8"))) {
        ctx.justRecipes.add(r);
      }
    } catch {
      // Ignore read errors.
    }
  } else if (relPosix === "pyproject.toml" || baseName === "pyproject.toml") {
    ctx.hasPyproject = true;
    try {
      for (const s of parsePyprojectScripts(fs.readFileSync(absPath, "utf8"))) {
        ctx.binNames.add(s);
      }
    } catch {
      // Ignore read errors.
    }
  }
}
