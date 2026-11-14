// src/diff.ts
function findingFingerprint(f) {
  return `${f.ruleId}::${f.file}::${f.message}`;
}
function diffReports(baseline, current) {
  const baseKeys = new Set(baseline.findings.map(findingFingerprint));
  const currKeys = new Set(current.findings.map(findingFingerprint));
  const addedFindings = current.findings.filter((f) => !baseKeys.has(findingFingerprint(f)));
  const resolvedFindings = baseline.findings.filter((f) => !currKeys.has(findingFingerprint(f)));
  const baseTools = new Map(baseline.mcpTools.map((t) => [t.name, t]));
  const currTools = new Map(current.mcpTools.map((t) => [t.name, t]));
  const removedTools = [];
  const addedTools = [];
  const breakingSchemaChanges = [];
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
    breakingSchemaChanges
  };
}

// src/tokens.ts
var UTF8_ENCODER = new TextEncoder();
function utf8Bytes(text) {
  return UTF8_ENCODER.encode(text).length;
}
function estimateTokens(text) {
  const bytes = utf8Bytes(text);
  if (bytes === 0) return 0;
  return Math.ceil(bytes / 4);
}
function estimateTokensFromBytes(bytes) {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}
function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}
function canonicalizeJson(value, depth = 0) {
  if (depth > 64) {
    throw new Error("JSON nesting exceeds maximum depth of 64");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item, depth + 1));
  }
  const record = value;
  const sorted = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== void 0) {
      sorted[key] = canonicalizeJson(child, depth + 1);
    }
  }
  return sorted;
}
function canonicalJsonString(value) {
  return JSON.stringify(canonicalizeJson(value));
}
function compactJsonBytes(value) {
  return utf8Bytes(canonicalJsonString(value));
}

// src/discovery.ts
import fs from "fs";
import path from "path";

// src/markdown.ts
function scanMarkdownLines(content) {
  const rawLines = content.split(/\r\n|\r|\n/);
  const result = [];
  let activeFence = null;
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const raw = rawLines[idx] ?? "";
    const trimmed = raw.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    let inFence = activeFence !== null;
    if (fenceMatch && fenceMatch[1]) {
      const marker = fenceMatch[1];
      const ch = marker[0] ?? "`";
      if (!activeFence) {
        activeFence = { char: ch, len: marker.length };
        inFence = true;
      } else if (activeFence.char === ch && marker.length >= activeFence.len && trimmed === marker) {
        activeFence = null;
        inFence = true;
      }
    }
    result.push({
      lineNumber: idx + 1,
      raw,
      inCodeFence: inFence
    });
  }
  return result;
}
function parseFrontmatter(content) {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== "---") {
    return {
      hasFrontmatter: false,
      bodyStartLine: 1,
      body: content,
      fields: {}
    };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return {
      hasFrontmatter: true,
      bodyStartLine: 1,
      body: content,
      fields: {},
      error: "Unclosed YAML frontmatter delimiter '---'"
    };
  }
  const fields = {};
  let currentKey = null;
  let blockMode = null;
  let blockLines = [];
  const flushBlock = () => {
    if (currentKey && blockMode) {
      fields[currentKey] = blockMode === ">" ? blockLines.join(" ").trim() : blockLines.join("\n").trim();
    }
    blockMode = null;
    blockLines = [];
  };
  for (let i = 1; i < endIdx; i += 1) {
    const line = lines[i] ?? "";
    if (blockMode && (/^\s+/.test(line) || line.trim() === "")) {
      blockLines.push(line.trim());
      continue;
    }
    if (blockMode) {
      flushBlock();
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ") && currentKey) {
      const item = unquoteYamlScalar(trimmed.slice(2).trim());
      const prev = fields[currentKey];
      if (Array.isArray(prev)) {
        prev.push(item);
      } else {
        fields[currentKey] = [item];
      }
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (!kvMatch || !kvMatch[1]) continue;
    const key = kvMatch[1];
    const rawVal = (kvMatch[2] ?? "").trim();
    currentKey = key;
    if (rawVal === "|" || rawVal === ">") {
      blockMode = rawVal;
      blockLines = [];
      continue;
    }
    if (rawVal === "") {
      fields[key] = "";
      continue;
    }
    if (rawVal === "true") {
      fields[key] = true;
    } else if (rawVal === "false") {
      fields[key] = false;
    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      const inner = rawVal.slice(1, -1).trim();
      fields[key] = inner ? inner.split(",").map((part) => unquoteYamlScalar(part.trim())).filter(Boolean) : [];
    } else {
      fields[key] = unquoteYamlScalar(rawVal);
    }
  }
  flushBlock();
  return {
    hasFrontmatter: true,
    bodyStartLine: endIdx + 2,
    body: lines.slice(endIdx + 1).join("\n"),
    fields
  };
}
function unquoteYamlScalar(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
function extractMarkdownLinks(lines) {
  const links = [];
  const pattern = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const entry of lines) {
    if (entry.inCodeFence) continue;
    const masked = stripInlineCode(entry.raw);
    for (const match of masked.matchAll(pattern)) {
      const target = match[2];
      if (!target) continue;
      links.push({
        label: match[1] ?? "",
        target,
        line: entry.lineNumber,
        column: (match.index ?? 0) + 1
      });
    }
  }
  return links;
}
function extractInlineCodeSpans(lines) {
  const spans = [];
  const pattern = /(?<!`)`([^`\n]{1,240})`(?!`)/g;
  for (const entry of lines) {
    if (entry.inCodeFence) continue;
    for (const match of entry.raw.matchAll(pattern)) {
      const text = match[1]?.trim();
      if (!text) continue;
      spans.push({
        text,
        line: entry.lineNumber,
        column: (match.index ?? 0) + 1,
        lineText: entry.raw
      });
    }
  }
  return spans;
}
function stripInlineCode(line) {
  return line.replace(/(?<!`)`[^`\n]*`(?!`)/g, (m) => " ".repeat(m.length));
}

// src/discovery.ts
var DEFAULT_IGNORED_DIRS = /* @__PURE__ */ new Set([
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
  ".mypy_cache"
]);
var MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
var MAX_JSON_FIXTURE_BYTES = 4 * 1024 * 1024;
var MAX_PROMPT_SOURCE_BYTES = 512 * 1024;
function toPosixRel(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath);
  return rel.split(path.sep).join("/");
}
function loadGitignoreMatchers(rootDir) {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  try {
    const raw = fs.readFileSync(gitignorePath, "utf8");
    return raw.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}
function matchesSimplePattern(relPosix, baseName, pattern) {
  const cleaned = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) return false;
  if (cleaned === baseName || cleaned === relPosix) return true;
  if (cleaned.includes("*")) {
    const escaped = cleaned.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "::DOUBLE_STAR::").replace(/\*/g, "[^/]*").replace(/::DOUBLE_STAR::/g, ".*");
    return new RegExp(`^${escaped}$`).test(relPosix) || new RegExp(`^${escaped}$`).test(baseName);
  }
  return relPosix.startsWith(`${cleaned}/`);
}
function isIgnored(relPosix, baseName, extraIgnorePaths, gitignorePatterns) {
  if (DEFAULT_IGNORED_DIRS.has(baseName)) return true;
  for (const pat of extraIgnorePaths) {
    if (matchesSimplePattern(relPosix, baseName, pat)) return true;
  }
  for (const pat of gitignorePatterns) {
    if (matchesSimplePattern(relPosix, baseName, pat)) return true;
  }
  return false;
}
function classifyArtifact(relPosix, content) {
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
      isRootLevel: false
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
  if (relPosix === ".mcp.json" || relPosix === "mcp.json" || relPosix === ".cursor/mcp.json" || relPosix === ".vscode/mcp.json") {
    return { kind: "mcp-config", alwaysLoaded: true, isRootLevel: true };
  }
  if (relPosix === ".claude/settings.json" || relPosix === ".claude/settings.local.json") {
    return { kind: "claude-settings", alwaysLoaded: false, isRootLevel: true };
  }
  return null;
}
function isCandidateMcpFixturePath(relPosix) {
  if (!relPosix.endsWith(".json")) return false;
  const base = path.posix.basename(relPosix).toLowerCase();
  if (base === "package.json" || base === "package-lock.json" || base === "tsconfig.json") {
    return false;
  }
  return /(?:^|\/)(?:fixtures?|examples?|testdata|\.mcp)\//.test(relPosix) || /(?:mcp|tools?-list|tool-result|call-tool)/.test(base);
}
function hasMcpToolShape(items) {
  if (items.length === 0) return false;
  let sawMcpInputSchema = false;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item;
    if (rec["type"] === "function" && typeof rec["function"] === "object") {
      return false;
    }
    if ("inputSchema" in rec) {
      sawMcpInputSchema = true;
    }
  }
  return sawMcpInputSchema;
}
function hasMcpContentShape(items) {
  if (items.length === 0) return false;
  return items.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const rec = item;
    return rec["type"] === "text" || rec["type"] === "image" || rec["type"] === "audio" || rec["type"] === "resource";
  });
}
function looksLikeMcpPayloadOrToolsList(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed;
  if (Array.isArray(obj["tools"]) && hasMcpToolShape(obj["tools"])) return true;
  if ("structuredContent" in obj) return true;
  if (Array.isArray(obj["content"]) && hasMcpContentShape(obj["content"])) return true;
  const result = obj["result"];
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const resObj = result;
    if (Array.isArray(resObj["tools"]) && hasMcpToolShape(resObj["tools"])) return true;
    if ("structuredContent" in resObj) return true;
    if (Array.isArray(resObj["content"]) && hasMcpContentShape(resObj["content"])) return true;
  }
  return false;
}
function parseMakefileTargets(content) {
  const targets = [];
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (!line || /^\s/.test(line) || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (match && match[1] && !match[1].startsWith(".")) {
      targets.push(match[1]);
    }
  }
  return targets;
}
function parseJustRecipes(content) {
  const recipes = [];
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (!line || /^\s/.test(line) || line.startsWith("#")) continue;
    if (/^(?:alias|set|export|import)\b/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:]*)?:(?!=)/.exec(line);
    if (match && match[1]) recipes.push(match[1]);
  }
  return recipes;
}
function parsePyprojectScripts(content) {
  const scripts = [];
  let inScripts = false;
  for (const line of content.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inScripts = trimmed === "[project.scripts]" || trimmed === "[tool.poetry.scripts]" || trimmed === "[tool.uv.scripts]";
      continue;
    }
    if (!inScripts || !trimmed || trimmed.startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=/.exec(trimmed);
    if (kv && kv[1]) scripts.push(kv[1]);
  }
  return scripts;
}
function discoverProject(rootDir, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const gitignorePatterns = loadGitignoreMatchers(resolvedRoot);
  const extraIgnore = options.ignorePaths ?? [];
  const scanCodePrompts = options.scanCodePrompts ?? true;
  const ctx = {
    rootDir: resolvedRoot,
    artifacts: [],
    mcpFixtures: [],
    promptSourceFiles: [],
    scripts: /* @__PURE__ */ new Set(),
    binNames: /* @__PURE__ */ new Set(),
    makeTargets: /* @__PURE__ */ new Set(),
    justRecipes: /* @__PURE__ */ new Set(),
    lockfiles: {
      npm: false,
      pnpm: false,
      yarn: false,
      bun: false,
      uv: false,
      poetry: false
    },
    hasPackageJson: false,
    hasPyproject: false,
    hasCargo: false,
    hasGoMod: false,
    allKnownRelPaths: /* @__PURE__ */ new Set()
  };
  const queue = [resolvedRoot];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) break;
    let entries;
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
      if (isManifestOrLockfileName(entry.name)) {
        try {
          const manifestSize = fs.statSync(absPath).size;
          recordLockfileAndManifest(ctx, absPath, relPosix, entry.name, manifestSize);
        } catch {
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
function inspectDiscoveredFile(ctx, absPath, relPosix, baseName, scanCodePrompts) {
  let stat;
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
            bytes: utf8Bytes(content)
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
      const parsed = JSON.parse(rawText);
      if (looksLikeMcpPayloadOrToolsList(parsed)) {
        ctx.mcpFixtures.push({ relPath: relPosix, absPath, parsed, rawText });
      }
    } catch {
    }
    return;
  }
  if (scanCodePrompts && stat.size <= MAX_PROMPT_SOURCE_BYTES && /\.(?:ts|tsx|js|jsx|mjs|mts|py)$/.test(baseName) && !baseName.endsWith(".d.ts") && !baseName.includes(".min.") && !/(?:^|\/)(?:tests?|__tests__|spec|fixtures?|static\/chunks|out\/_next)\//.test(relPosix) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(baseName)) {
    try {
      const content = fs.readFileSync(absPath, "utf8");
      const firstNewline = content.indexOf("\n");
      const firstLineLen = firstNewline === -1 ? content.length : firstNewline;
      if (firstLineLen > 800) {
        return;
      }
      if (content.includes("cache_control") || content.includes("systemPrompt") || content.includes("system_prompt") || content.includes("anthropic") || content.includes("messages.create")) {
        ctx.promptSourceFiles.push({ relPath: relPosix, absPath, content });
      }
    } catch {
    }
  }
}
function classifyArtifactNameOnly(relPosix, baseName) {
  return baseName === "CLAUDE.md" || baseName === "CLAUDE.local.md" || baseName === "AGENTS.md" || baseName === "AGENTS.override.md" || baseName === "GEMINI.md" || baseName === "SKILL.md" || baseName === ".cursorrules" || relPosix === ".github/copilot-instructions.md" || relPosix === ".mcp.json" || relPosix === "mcp.json" || relPosix === ".cursor/mcp.json" || relPosix === ".vscode/mcp.json" || relPosix === ".claude/settings.json" || relPosix === ".claude/settings.local.json" || /^\.github\/instructions\/.+\.instructions\.md$/.test(relPosix) || /^\.cursor\/rules\/.+\.(?:md|mdc)$/.test(relPosix) || /^\.claude\/(?:commands|agents)\/.+\.md$/.test(relPosix);
}
function isManifestOrLockfileName(baseName) {
  return baseName === "package.json" || baseName === "package-lock.json" || baseName === "pnpm-lock.yaml" || baseName === "yarn.lock" || baseName === "bun.lock" || baseName === "bun.lockb" || baseName === "uv.lock" || baseName === "poetry.lock" || baseName === "Cargo.toml" || baseName === "go.mod" || baseName === "Makefile" || baseName === "GNUmakefile" || baseName === "Justfile" || baseName === "justfile" || baseName === "pyproject.toml";
}
function recordLockfileAndManifest(ctx, absPath, relPosix, baseName, size) {
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
      const pkg = JSON.parse(fs.readFileSync(absPath, "utf8"));
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
    }
  } else if (baseName === "Makefile" || baseName === "GNUmakefile") {
    try {
      for (const t of parseMakefileTargets(fs.readFileSync(absPath, "utf8"))) {
        ctx.makeTargets.add(t);
      }
    } catch {
    }
  } else if (baseName === "Justfile" || baseName === "justfile") {
    try {
      for (const r of parseJustRecipes(fs.readFileSync(absPath, "utf8"))) {
        ctx.justRecipes.add(r);
      }
    } catch {
    }
  } else if (relPosix === "pyproject.toml" || baseName === "pyproject.toml") {
    ctx.hasPyproject = true;
    try {
      for (const s of parsePyprojectScripts(fs.readFileSync(absPath, "utf8"))) {
        ctx.binNames.add(s);
      }
    } catch {
    }
  }
}

// src/rules/security.ts
import fs2 from "fs";
import path2 from "path";
var BIDI_OR_INVISIBLE_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\u061C\uFEFF]|[\u{E0001}-\u{E007F}]/gu;
var SECRET_RULES = [
  { label: "Anthropic API key", regex: /\bsk-ant-(?:api|admin)\d*-[A-Za-z0-9_-]{16,}\b/g },
  { label: "OpenAI API key", regex: /\bsk-(?:proj|svcacct|live)-[A-Za-z0-9_-]{16,}\b/g },
  { label: "GitHub personal access token", regex: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g },
  { label: "GitHub fine-grained token", regex: /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g },
  { label: "AWS access key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g },
  { label: "GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{16,}\b/g }
];
var INJECTION_PATTERNS = [
  {
    label: "override directive ('ignore previous instructions')",
    severity: "error",
    regex: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i
  },
  {
    label: "concealment directive ('do not tell the user')",
    severity: "error",
    regex: /\b(?:do\s+not|never)\s+(?:tell|inform|show|mention\s+to)\s+the\s+user\b/i
  },
  {
    label: "remote curl-to-shell execution pipe",
    severity: "warning",
    regex: /\b(?:curl|wget)\b[^\n|]{0,180}\|\s*(?:sh|bash|zsh)\b/i
  },
  {
    label: "credential/key exfiltration pattern (~/.ssh, ~/.aws, .env)",
    severity: "warning",
    regex: /(?:~\/\.ssh\/|~\/\.aws\/credentials|process\.env\.[A-Z0-9_]+).{0,80}\b(?:curl|wget|fetch|axios|nc|POST)\b/i
  }
];
var PROHIBITION_CONTEXT = /\b(?:never|do\s+not|don't|avoid|forbid|prohibit)\b/i;
var KNOWN_INSTALLER_URLS = /https:\/\/(?:astral\.sh\/uv\/install\.sh|sh\.rustup\.rs|get\.pnpm\.io\/|bun\.sh\/install|raw\.githubusercontent\.com\/(?:Homebrew|nvm-sh)\/)/i;
var DANGEROUS_PERMISSION_PATTERNS = [
  /^Bash\(\s*\*\s*\)$/,
  /^Bash\(\s*rm\s+-rf/i,
  /^Bash\(\s*curl\b/i,
  /^Bash\(\s*wget\b/i,
  /^Bash\(\s*sudo\b/i
];
function formatCodepoint(char) {
  const cp = char.codePointAt(0);
  if (cp === void 0) return "U+????";
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}
function isPlaceholderLike(value) {
  const lower = value.toLowerCase();
  return lower.includes("${") || lower.includes("example") || lower.includes("dummy") || lower.includes("placeholder") || lower.includes("xxxxxx") || lower.includes("000000") || lower.includes("<your");
}
function scanTextForHiddenUnicode(text, file, category) {
  const findings = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const matches = Array.from(line.matchAll(BIDI_OR_INVISIBLE_PATTERN));
    for (const match of matches) {
      const ch = match[0];
      const index = match.index ?? 0;
      if (ch === "\uFEFF" && i === 0 && index === 0) continue;
      findings.push({
        ruleId: "hidden-unicode",
        category,
        severity: "error",
        file,
        line: i + 1,
        column: index + 1,
        message: `Hidden or bidirectional control Unicode character detected (${formatCodepoint(ch)})`,
        suggestion: "Remove invisible zero-width, bidi override, or Unicode tag characters."
      });
      break;
    }
  }
  return findings;
}
function scanTextForPromptInjection(text, file, category) {
  const findings = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const pat of INJECTION_PATTERNS) {
      const match = pat.regex.exec(line);
      if (!match) continue;
      if (pat.label.startsWith("remote curl-to-shell")) {
        if (PROHIBITION_CONTEXT.test(line) || line.includes("...") || KNOWN_INSTALLER_URLS.test(line)) {
          continue;
        }
      }
      findings.push({
        ruleId: "prompt-injection-pattern",
        category,
        severity: pat.severity,
        file,
        line: i + 1,
        column: (match.index ?? 0) + 1,
        message: `Suspicious ${pat.label} found in agent-visible text`,
        suggestion: "Audit this line carefully and remove hidden directives or remote pipe execution commands.",
        snippet: line.trim().slice(0, 140)
      });
      break;
    }
  }
  return findings;
}
function scanSecretsInArtifact(artifact) {
  const findings = [];
  const lines = artifact.content.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const rule of SECRET_RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(line)) !== null) {
        const idx = match.index ?? 0;
        const windowAroundMatch = line.slice(Math.max(0, idx - 12), idx + match[0].length + 12);
        if (isPlaceholderLike(match[0]) || isPlaceholderLike(windowAroundMatch)) {
          continue;
        }
        findings.push({
          ruleId: "plaintext-secret",
          category: "security",
          severity: "error",
          file: artifact.relPath,
          line: i + 1,
          column: idx + 1,
          message: `Possible plaintext ${rule.label} detected in ${artifact.relPath}`,
          suggestion: "Replace hardcoded credentials with environment variable placeholders like ${API_KEY}."
        });
        break;
      }
      if (findings.some((f) => f.line === i + 1 && f.ruleId === "plaintext-secret")) {
        break;
      }
    }
  }
  return findings;
}
function isLocalCommandEntrypoint(arg) {
  return (arg.startsWith("./") || arg.startsWith("../")) && /\.(?:js|mjs|cjs|ts|py|sh)$/.test(arg);
}
function inspectMcpConfig(artifact, ctx) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(artifact.content);
  } catch (err) {
    findings.push({
      ruleId: "invalid-json-config",
      category: "security",
      severity: "error",
      file: artifact.relPath,
      line: 1,
      message: `Invalid JSON in ${artifact.relPath}: ${err instanceof Error ? err.message : "parse error"}`
    });
    return findings;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return findings;
  const root = parsed;
  const serversRaw = root["mcpServers"] ?? root["servers"];
  if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
    return findings;
  }
  const servers = serversRaw;
  for (const [serverName, cfgRaw] of Object.entries(servers)) {
    if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) continue;
    const cfg = cfgRaw;
    const command = typeof cfg["command"] === "string" ? cfg["command"].trim() : "";
    const args = Array.isArray(cfg["args"]) ? cfg["args"].filter((a) => typeof a === "string") : [];
    if (command === "npx" && args.includes("-y")) {
      const pkgArg = args.find((a) => !a.startsWith("-"));
      if (pkgArg && !isPinnedPackageSpec(pkgArg)) {
        findings.push({
          ruleId: "unsafe-mcp-config",
          category: "security",
          severity: "warning",
          file: artifact.relPath,
          message: `MCP server '${serverName}' runs unpinned '${pkgArg}' via 'npx -y'`,
          suggestion: `Pin an explicit package version (e.g. '${pkgArg}@1.2.3') to prevent silent supply-chain changes.`
        });
      }
    }
    for (const arg of args) {
      if (isLocalCommandEntrypoint(arg)) {
        const candidate = path2.resolve(path2.dirname(artifact.absPath), arg);
        if (!fs2.existsSync(candidate)) {
          findings.push({
            ruleId: "broken-mcp-entrypoint",
            category: "references",
            severity: "error",
            file: artifact.relPath,
            message: `MCP server '${serverName}' references missing local script '${arg}'`,
            suggestion: "Update the relative path in args or verify build output before starting MCP clients."
          });
        }
      }
    }
  }
  void ctx;
  return findings;
}
function isPinnedPackageSpec(spec) {
  const withoutScope = spec.startsWith("@") ? spec.slice(spec.indexOf("/") + 1) : spec;
  const atIdx = withoutScope.indexOf("@");
  if (atIdx === -1) return false;
  const tag = withoutScope.slice(atIdx + 1);
  return tag !== "latest" && tag.length > 0;
}
function inspectClaudeSettings(artifact) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(artifact.content);
  } catch (err) {
    findings.push({
      ruleId: "invalid-json-config",
      category: "security",
      severity: "error",
      file: artifact.relPath,
      line: 1,
      message: `Invalid JSON in ${artifact.relPath}: ${err instanceof Error ? err.message : "parse error"}`
    });
    return findings;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return findings;
  const root = parsed;
  const perms = root["permissions"];
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    const allow = perms["allow"];
    if (Array.isArray(allow)) {
      for (const rule of allow) {
        if (typeof rule !== "string") continue;
        if (DANGEROUS_PERMISSION_PATTERNS.some((pat) => pat.test(rule.trim()))) {
          findings.push({
            ruleId: "unsafe-permission-rule",
            category: "security",
            severity: "warning",
            file: artifact.relPath,
            message: `Overly broad Claude Code allow rule '${rule}' found in ${artifact.relPath}`,
            suggestion: "Scope Bash permissions to narrow commands (e.g. 'Bash(npm test)') instead of wildcards."
          });
        }
      }
    }
  }
  return findings;
}
function runSecurityRules(ctx) {
  const findings = [];
  for (const artifact of ctx.artifacts) {
    findings.push(...scanTextForHiddenUnicode(artifact.content, artifact.relPath, "security"));
    findings.push(...scanSecretsInArtifact(artifact));
    if (artifact.kind === "claude-md" || artifact.kind === "agents-md" || artifact.kind === "skill-md" || artifact.kind === "claude-command" || artifact.kind === "cursor-rule") {
      findings.push(...scanTextForPromptInjection(artifact.content, artifact.relPath, "security"));
    }
    if (artifact.kind === "mcp-config") {
      findings.push(...inspectMcpConfig(artifact, ctx));
    } else if (artifact.kind === "claude-settings") {
      findings.push(...inspectClaudeSettings(artifact));
    }
  }
  return findings;
}

// src/rules/mcp.ts
var DEFAULT_MIN_DUPLICATE_BYTES = 64;
function escapePointer(segment) {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}
function validateInputSchema(schema) {
  const issues = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    issues.push("missing or non-object inputSchema");
    return issues;
  }
  const obj = schema;
  if (obj["type"] !== "object" && !Array.isArray(obj["anyOf"]) && !Array.isArray(obj["oneOf"])) {
    const rawType = obj["type"] === void 0 ? "none" : JSON.stringify(obj["type"]);
    issues.push(`inputSchema root should have type="object" (got ${rawType})`);
  }
  const props = obj["properties"] && typeof obj["properties"] === "object" && !Array.isArray(obj["properties"]) ? obj["properties"] : null;
  const required = obj["required"];
  if (Array.isArray(required)) {
    for (const reqKey of required) {
      if (typeof reqKey !== "string") {
        issues.push("required array contains a non-string entry");
      } else if (!props || !(reqKey in props)) {
        issues.push(`required property '${reqKey}' is not defined in properties`);
      }
    }
  }
  if (props) {
    for (const [propName, propDef] of Object.entries(props)) {
      if (!propDef || typeof propDef !== "object" || Array.isArray(propDef)) continue;
      const propObj = propDef;
      if (!("description" in propObj) || !propObj["description"]) {
        issues.push(`property '${propName}' is missing a description`);
      }
    }
  }
  return issues;
}
function auditToolDefinitions(tools, serverName, sourceFile, options) {
  const metrics = [];
  const findings = [];
  const seenNames = /* @__PURE__ */ new Map();
  for (let idx = 0; idx < tools.length; idx += 1) {
    const tool = tools[idx];
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.name === "string" ? tool.name.trim() : `<unnamed-${idx}>`;
    const prevCount = seenNames.get(name) ?? 0;
    seenNames.set(name, prevCount + 1);
    if (prevCount === 1) {
      findings.push({
        ruleId: "duplicate-tool-name",
        category: "mcp",
        severity: "error",
        file: sourceFile,
        message: `Duplicate MCP tool name '${name}' in '${serverName}'`,
        suggestion: "Give every exposed MCP tool a unique, unambiguous identifier."
      });
    }
    const description = typeof tool.description === "string" ? tool.description.trim() : "";
    const hasDescription = description.length > 0;
    if (!hasDescription) {
      findings.push({
        ruleId: "missing-tool-description",
        category: "mcp",
        severity: "warning",
        file: sourceFile,
        message: `MCP tool '${name}' has no description; LLMs rely on descriptions to choose tools accurately`
      });
    } else {
      findings.push(...scanTextForHiddenUnicode(description, sourceFile, "mcp"));
      findings.push(...scanTextForPromptInjection(description, sourceFile, "mcp"));
    }
    const descTokens = estimateTokensFromBytes(utf8Bytes(description));
    const schemaBytes = compactJsonBytes(tool);
    const totalTokens = estimateTokensFromBytes(schemaBytes);
    const schemaTokens = Math.max(0, totalTokens - descTokens);
    const schemaIssues = validateInputSchema(tool.inputSchema);
    if (descTokens > options.maxToolDescTokens) {
      findings.push({
        ruleId: "oversized-tool-schema",
        category: "mcp",
        severity: "warning",
        file: sourceFile,
        message: `MCP tool '${name}' description alone uses ~${descTokens} tokens (threshold: ${options.maxToolDescTokens})`,
        suggestion: "Move long usage manuals to MCP resources/prompts rather than turn-0 tool schemas."
      });
    }
    if (schemaIssues.length > 0) {
      findings.push({
        ruleId: "invalid-tool-schema",
        category: "mcp",
        severity: schemaIssues.some(
          (s) => s.startsWith("required") || s.startsWith("missing or non-object")
        ) ? "error" : "info",
        file: sourceFile,
        message: `Tool '${name}' schema issues: ${schemaIssues.join("; ")}`
      });
    }
    metrics.push({
      server: serverName,
      sourceFile,
      name,
      descriptionTokens: descTokens,
      schemaTokens,
      totalTokens,
      hasDescription,
      schemaIssues
    });
  }
  return { metrics, findings };
}
function analyzeCallToolResultPayload(resultObj, file, maxMcpBytes) {
  const findings = [];
  const compactBytes = compactJsonBytes(resultObj);
  const estimatedTokens = estimateTokensFromBytes(compactBytes);
  const isError = resultObj["isError"] === true;
  const textBlocks = [];
  if (Array.isArray(resultObj["content"])) {
    for (const block of resultObj["content"]) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const rec = block;
        if (rec["type"] === "text" && typeof rec["text"] === "string") {
          textBlocks.push(rec["text"]);
        }
      }
    }
  }
  let mirrorCount = 0;
  if ("structuredContent" in resultObj && resultObj["structuredContent"] !== void 0) {
    let structuredCanon = null;
    try {
      structuredCanon = canonicalJsonString(resultObj["structuredContent"]);
    } catch {
      structuredCanon = null;
    }
    if (structuredCanon) {
      for (const txt of textBlocks) {
        try {
          const parsedTxt = JSON.parse(txt);
          if (canonicalJsonString(parsedTxt) === structuredCanon) {
            mirrorCount += 1;
          }
        } catch {
        }
      }
    }
  }
  const subtreeCounts = /* @__PURE__ */ new Map();
  let largestLeafPointer;
  let largestLeafBytes = 0;
  const visit = (node, ptr, depth) => {
    if (depth > 64 || node === null) return;
    if (typeof node !== "object") {
      const leafBytes = compactJsonBytes(node);
      if (leafBytes > largestLeafBytes) {
        largestLeafBytes = leafBytes;
        largestLeafPointer = ptr || "/";
      }
      return;
    }
    if (depth > 0) {
      const serialized = canonicalJsonString(node);
      const byteSize = utf8Bytes(serialized);
      if (byteSize >= DEFAULT_MIN_DUPLICATE_BYTES) {
        const prev = subtreeCounts.get(serialized);
        if (prev) {
          prev.count += 1;
        } else {
          subtreeCounts.set(serialized, { bytes: byteSize, count: 1 });
        }
      }
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], `${ptr}/${escapePointer(i)}`, depth + 1);
      }
    } else {
      for (const [k, v] of Object.entries(node)) {
        visit(v, `${ptr}/${escapePointer(k)}`, depth + 1);
      }
    }
  };
  visit(resultObj, "", 0);
  let repeatedSubtreeCount = 0;
  for (const entry of subtreeCounts.values()) {
    if (entry.count > 1) repeatedSubtreeCount += 1;
  }
  if (compactBytes > maxMcpBytes) {
    findings.push({
      ruleId: "mcp-payload-budget-exceeded",
      category: "mcp",
      severity: "error",
      file,
      message: `MCP tool result compact size (${compactBytes} bytes / ~${estimatedTokens} tokens) exceeds ceiling (${maxMcpBytes} bytes)`,
      suggestion: "Paginate rows, truncate oversized fields, or move large blobs to MCP resources."
    });
  }
  if (mirrorCount > 0) {
    findings.push({
      ruleId: "mirror-payload-bloat",
      category: "mcp",
      severity: "info",
      file,
      message: `Detected ${mirrorCount} text block(s) mirroring structuredContent verbatim (doubles payload bytes)`,
      suggestion: "Consider keeping concise text summaries alongside structuredContent when clients support both."
    });
  }
  if (repeatedSubtreeCount > 0) {
    findings.push({
      ruleId: "repeated-payload-subtrees",
      category: "mcp",
      severity: "info",
      file,
      message: `Detected ${repeatedSubtreeCount} duplicated structured subtree(s) >= ${DEFAULT_MIN_DUPLICATE_BYTES} bytes`
    });
  }
  return {
    stats: {
      file,
      compactBytes,
      estimatedTokens,
      mirrorCount,
      repeatedSubtreeCount,
      ...largestLeafPointer ? { largestLeafPointer, largestLeafBytes } : {},
      isError
    },
    findings
  };
}
function runMcpRules(ctx, options, liveProbedTools = []) {
  const mcpTools = [];
  const mcpPayloads = [];
  const findings = [];
  for (const probed of liveProbedTools) {
    const res = auditToolDefinitions(probed.tools, probed.server, probed.sourceFile, options);
    mcpTools.push(...res.metrics);
    findings.push(...res.findings);
  }
  for (const fixture of ctx.mcpFixtures) {
    const obj = fixture.parsed;
    const unwrapped = obj["result"] && typeof obj["result"] === "object" && !Array.isArray(obj["result"]) ? obj["result"] : obj;
    if (Array.isArray(unwrapped["tools"])) {
      const serverName = fixture.relPath;
      const res = auditToolDefinitions(
        unwrapped["tools"],
        serverName,
        fixture.relPath,
        options
      );
      mcpTools.push(...res.metrics);
      findings.push(...res.findings);
    } else if (Array.isArray(unwrapped["content"]) || "structuredContent" in unwrapped) {
      const res = analyzeCallToolResultPayload(unwrapped, fixture.relPath, options.maxMcpBytes);
      mcpPayloads.push(res.stats);
      findings.push(...res.findings);
    }
  }
  const mcpSchemaTokens = mcpTools.reduce((acc, tool) => acc + tool.totalTokens, 0);
  return { mcpTools, mcpPayloads, mcpSchemaTokens, findings };
}

// src/analyzer.ts
import path5 from "path";

// src/mcp-probe.ts
import { spawn } from "child_process";
function sendJsonRpc(stdin, payload) {
  stdin.write(`${JSON.stringify(payload)}
`);
}
function parseJsonLines(buffer) {
  const parsed = [];
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed.push(obj);
      }
    } catch {
    }
  }
  return parsed;
}
async function probeStdioMcpServer(serverName, sourceFile, command, args, cwd, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    let settled = false;
    let stdoutBuf = "";
    let initDone = false;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve(res);
    };
    const timer = setTimeout(() => {
      finish({
        server: serverName,
        sourceFile,
        tools: [],
        error: `Timed out after ${timeoutMs}ms waiting for tools/list from '${serverName}'`
      });
    }, timeoutMs);
    child.on("error", (err) => {
      finish({
        server: serverName,
        sourceFile,
        tools: [],
        error: `Failed to spawn '${serverName}': ${err.message}`
      });
    });
    child.on("exit", (code) => {
      if (!settled) {
        finish({
          server: serverName,
          sourceFile,
          tools: [],
          error: `Server '${serverName}' exited (code ${String(code)}) before responding to tools/list`
        });
      }
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const messages = parseJsonLines(stdoutBuf);
      for (const msg of messages) {
        if (msg["id"] === 1 && !initDone) {
          initDone = true;
          sendJsonRpc(child.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
          sendJsonRpc(child.stdin, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {}
          });
        } else if (msg["id"] === 2) {
          const result = msg["result"];
          const tools = result && typeof result === "object" && !Array.isArray(result) && Array.isArray(result["tools"]) ? result["tools"] : [];
          finish({ server: serverName, sourceFile, tools });
          return;
        }
      }
    });
    sendJsonRpc(child.stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "context-preflight", version: "0.1.0" }
      }
    });
  });
}
async function probeConfiguredMcpServers(ctx, timeoutMs) {
  const results = [];
  for (const artifact of ctx.artifacts) {
    if (artifact.kind !== "mcp-config") continue;
    let parsed;
    try {
      parsed = JSON.parse(artifact.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const serversRaw = parsed["mcpServers"] ?? parsed["servers"];
    if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) continue;
    for (const [serverName, cfgRaw] of Object.entries(serversRaw)) {
      if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) continue;
      const cfg = cfgRaw;
      const command = typeof cfg["command"] === "string" ? cfg["command"].trim() : "";
      if (!command) continue;
      const args = Array.isArray(cfg["args"]) ? cfg["args"].filter((a) => typeof a === "string") : [];
      const envObj = {};
      if (cfg["env"] && typeof cfg["env"] === "object" && !Array.isArray(cfg["env"])) {
        for (const [k, v] of Object.entries(cfg["env"])) {
          if (typeof v === "string" && !v.startsWith("${")) envObj[k] = v;
        }
      }
      const res = await probeStdioMcpServer(
        serverName,
        artifact.relPath,
        command,
        args,
        ctx.rootDir,
        timeoutMs,
        envObj
      );
      results.push(res);
    }
  }
  return results;
}

// src/rules/budget.ts
import fs4 from "fs";
import path4 from "path";

// src/rules/references.ts
import fs3 from "fs";
import path3 from "path";
var KNOWN_FILE_EXT_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rs|go|java|rb|sh|bash|zsh|json|yaml|yml|toml|md|mdx|mdc|txt|sql|env|css|html|svg|lock)$/i;
var EXAMPLE_LINE_HINT = /\b(?:e\.g\.|for example|example:|creates?:|outputs?:|writes? to|generates?|fixture|sample|template|hypothetical)\b/i;
var IGNORED_GENERATED_PREFIXES = [
  "dist/",
  "build/",
  "coverage/",
  "node_modules/",
  ".next/",
  ".turbo/",
  ".venv/",
  ".harnesscheck/",
  "target/"
];
function isExternalOrSpecialLink(target) {
  const lower = target.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:") || lower.startsWith("tel:") || lower.startsWith("data:") || lower.startsWith("#") || target.includes("{") || target.includes("<");
}
var SUBPROJECT_MARKERS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", ".mcp.json"];
function resolveLocalTarget(rootDir, fromFileAbs, target) {
  const cleanTarget = target.split("#")[0]?.split("?")[0]?.trim() ?? "";
  if (!cleanTarget) return true;
  if (cleanTarget.startsWith("/")) {
    const repoAbs = path3.resolve(rootDir, cleanTarget.slice(1));
    return fs3.existsSync(repoAbs);
  }
  const fromDir = path3.dirname(fromFileAbs);
  const relToFile = path3.resolve(fromDir, cleanTarget);
  if (fs3.existsSync(relToFile)) return true;
  const relToRoot = path3.resolve(rootDir, cleanTarget);
  if (fs3.existsSync(relToRoot)) return true;
  const resolvedRoot = path3.resolve(rootDir);
  let cursor = path3.dirname(fromDir);
  while (cursor.startsWith(resolvedRoot) && cursor !== resolvedRoot) {
    const baseName = path3.basename(cursor);
    if (baseName === ".claude" || baseName === ".agents") {
      const parentDir = path3.dirname(cursor);
      if (fs3.existsSync(path3.resolve(parentDir, cleanTarget))) {
        return true;
      }
    }
    if (SUBPROJECT_MARKERS.some((marker) => fs3.existsSync(path3.join(cursor, marker)))) {
      if (fs3.existsSync(path3.resolve(cursor, cleanTarget))) {
        return true;
      }
    }
    const next = path3.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return false;
}
function looksLikeRepoFileRef(span) {
  if (span.length < 3 || /\s/.test(span)) return false;
  if (span.includes("://") || span.includes("*")) return false;
  if (span.includes("<") || span.includes(">") || span.includes("{") || span.includes("$")) {
    return false;
  }
  if (span.startsWith("/.well-known/") || span.startsWith("/api/") || /^\/v\d+\//.test(span)) {
    return false;
  }
  if (span.startsWith("@")) return false;
  if (span.startsWith("~") || span.startsWith("/etc/") || span.startsWith("/tmp/") || span.startsWith("/usr/")) {
    return false;
  }
  const normalized = span.replace(/^\.\//, "");
  if (IGNORED_GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (normalized.startsWith(".") && normalized.includes("/") === false) {
    return false;
  }
  if (span.startsWith("./") || span.startsWith("../")) {
    return KNOWN_FILE_EXT_PATTERN.test(normalized) || normalized.endsWith("/");
  }
  if (!normalized.includes("/")) return false;
  return KNOWN_FILE_EXT_PATTERN.test(normalized);
}
function extractClaudeImports(lines) {
  const imports = [];
  for (const entry of lines) {
    if (entry.inCodeFence) continue;
    const trimmed = entry.raw.trim();
    if (!trimmed.startsWith("@")) continue;
    const match = /^@([^\s,;()]+)$/.exec(trimmed);
    if (!match || !match[1]) continue;
    const target = match[1];
    if (target.startsWith("./") || target.startsWith("../") || KNOWN_FILE_EXT_PATTERN.test(target)) {
      imports.push({ target, line: entry.lineNumber });
    }
  }
  return imports;
}
function checkImportsAndLinks(artifact, lines, rootDir) {
  const findings = [];
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
        suggestion: `Update or remove '@${imp.target}' so Claude Code does not fail to load missing context.`
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
        suggestion: "Fix the relative file path or update the link target."
      });
    }
  }
  return findings;
}
function checkBacktickFileRefs(artifact, lines, rootDir) {
  const findings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const span of extractInlineCodeSpans(lines)) {
    if (EXAMPLE_LINE_HINT.test(span.lineText)) continue;
    const contextWindow = lines.slice(Math.max(0, span.line - 4), span.line).map((l) => l.raw).join("\n");
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
        suggestion: "Verify if this file was renamed, moved, or deleted."
      });
    }
  }
  return findings;
}
function checkScriptAndLockfileRefs(artifact, lines, ctx) {
  const findings = [];
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
  let firstNpmLine;
  let firstPipLine;
  const codeSegments = [];
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
            suggestion: `Available scripts include: ${Array.from(ctx.scripts).slice(0, 8).join(", ")}`
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
            message: `Make target '${target}' was not found in Makefile`
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
      suggestion: "Update commands to 'pnpm' so coding agents do not create stray package-lock.json files."
    });
  } else if (ctx.lockfiles.yarn && !ctx.lockfiles.npm && mentionsNpm && !mentionsYarn) {
    findings.push({
      ruleId: "package-manager-drift",
      category: "references",
      severity: "warning",
      file: artifact.relPath,
      line: firstNpmLine,
      message: "Instructions invoke 'npm', but repository lockfile is yarn.lock",
      suggestion: "Update commands to 'yarn' to match the repository lockfile."
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
      suggestion: "Consider recommending 'uv sync' or 'uv run' to match the repository setup."
    });
  }
  return findings;
}
function runReferenceRules(ctx) {
  const findings = [];
  for (const artifact of ctx.artifacts) {
    if (artifact.kind === "mcp-config" || artifact.kind === "claude-settings") continue;
    const lines = scanMarkdownLines(artifact.content);
    findings.push(...checkImportsAndLinks(artifact, lines, ctx.rootDir));
    findings.push(...checkBacktickFileRefs(artifact, lines, ctx.rootDir));
    findings.push(...checkScriptAndLockfileRefs(artifact, lines, ctx));
  }
  return findings;
}

// src/rules/budget.ts
var DYNAMIC_PROMPT_CALLS = /\b(?:new\s+Date\s*\(|Date\.now\s*\(|Math\.random\s*\(|crypto\.randomUUID\s*\(|datetime\.(?:now|utcnow)\s*\(|time\.time\s*\(|uuid\.uuid4\s*\()/;
var PROMPT_CONTEXT_HINT = /(?:(?<![A-Za-z0-9_])(?:systemPrompt|system_prompt)\s*[:=]|cache_control[^\n]{0,40}ephemeral|ephemeral[^\n]{0,40}cache_control)/i;
var HTTP_CACHE_OR_TIMING_NOISE = /(?:max-age=|s-maxage=|Expires=|total_time|elapsed|duration|start_time|\bend\s*=)/i;
function resolveImportTree(startAbs, rootDir, visited, depth = 0) {
  if (depth > 8) return { extraBytes: 0, extraTokens: 0, count: 0 };
  let raw;
  try {
    raw = fs4.readFileSync(startAbs, "utf8");
  } catch {
    return { extraBytes: 0, extraTokens: 0, count: 0 };
  }
  let extraBytes = 0;
  let extraTokens = 0;
  let count = 0;
  for (const imp of extractClaudeImports(scanMarkdownLines(raw))) {
    const clean = imp.target.split("#")[0]?.trim() ?? "";
    if (!clean) continue;
    const relCandidate = path4.resolve(path4.dirname(startAbs), clean);
    const rootCandidate = path4.resolve(rootDir, clean);
    const targetAbs = fs4.existsSync(relCandidate) ? relCandidate : fs4.existsSync(rootCandidate) ? rootCandidate : null;
    if (!targetAbs || visited.has(targetAbs)) continue;
    visited.add(targetAbs);
    try {
      const targetText = fs4.readFileSync(targetAbs, "utf8");
      const bytes = utf8Bytes(targetText);
      extraBytes += bytes;
      extraTokens += estimateTokens(targetText);
      count += 1;
      const nested = resolveImportTree(targetAbs, rootDir, visited, depth + 1);
      extraBytes += nested.extraBytes;
      extraTokens += nested.extraTokens;
      count += nested.count;
    } catch {
      continue;
    }
  }
  return { extraBytes, extraTokens, count };
}
function validateSkillArtifact(artifact, maxSkillLines) {
  const findings = [];
  const fm = parseFrontmatter(artifact.content);
  const name = fm.fields["name"];
  const description = fm.fields["description"];
  if (!fm.hasFrontmatter || fm.error) {
    findings.push({
      ruleId: "skill-frontmatter-invalid",
      category: "skill",
      severity: "error",
      file: artifact.relPath,
      line: 1,
      message: fm.error ?? "SKILL.md is missing required YAML frontmatter ('---')",
      suggestion: "Add YAML frontmatter with 'name' and 'description' so agents can progressively load the skill."
    });
  } else {
    if (typeof name !== "string" || name.trim().length === 0) {
      findings.push({
        ruleId: "skill-frontmatter-invalid",
        category: "skill",
        severity: "error",
        file: artifact.relPath,
        line: 1,
        message: "SKILL.md frontmatter is missing required 'name' field"
      });
    } else if (name.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      findings.push({
        ruleId: "skill-frontmatter-invalid",
        category: "skill",
        severity: "warning",
        file: artifact.relPath,
        line: 2,
        message: `Skill name '${name}' should be lowercase kebab-case and at most 64 characters`
      });
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      findings.push({
        ruleId: "skill-frontmatter-invalid",
        category: "skill",
        severity: "error",
        file: artifact.relPath,
        line: 1,
        message: "SKILL.md frontmatter is missing required 'description' field"
      });
    } else if (description.length > 1024) {
      findings.push({
        ruleId: "skill-bloat",
        category: "skill",
        severity: "warning",
        file: artifact.relPath,
        line: 1,
        message: `SKILL.md description is ${description.length} characters (limit: 1024)`
      });
    }
  }
  const bodyLines = countLines(fm.body);
  if (bodyLines > maxSkillLines) {
    findings.push({
      ruleId: "skill-bloat",
      category: "skill",
      severity: "warning",
      file: artifact.relPath,
      line: fm.bodyStartLine,
      message: `SKILL.md body has ${bodyLines} lines (recommended maximum: ${maxSkillLines})`,
      suggestion: "Move detailed examples or schemas into references/ files linked from SKILL.md."
    });
  }
  const metaText = `${typeof name === "string" ? name : ""}
${typeof description === "string" ? description : ""}`;
  return {
    findings,
    metadataTokens: fm.hasFrontmatter ? estimateTokens(metaText) : 0
  };
}
function tokenShingles(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const shingles = /* @__PURE__ */ new Set();
  for (let i = 0; i <= words.length - 4; i += 1) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]}`);
  }
  return shingles;
}
function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
function scanPromptCacheBreakers(ctx) {
  const findings = [];
  for (const src of ctx.promptSourceFiles) {
    const lines = src.content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(lines.length, i + 3);
      const windowText = lines.slice(windowStart, windowEnd).join("\n");
      const line = lines[i] ?? "";
      if (DYNAMIC_PROMPT_CALLS.test(line) && PROMPT_CONTEXT_HINT.test(windowText) && !HTTP_CACHE_OR_TIMING_NOISE.test(windowText)) {
        findings.push({
          ruleId: "cache-breaker-risk",
          category: "budget",
          severity: "warning",
          file: src.relPath,
          line: i + 1,
          message: "Volatile runtime value (timestamp/random/UUID) appears near system prompt or cache_control prefix",
          suggestion: "Move dynamic timestamps/UUIDs to the end of user messages so Claude/LLM prompt cache prefixes stay warm.",
          snippet: line.trim().slice(0, 140)
        });
      }
    }
  }
  return findings;
}
function runBudgetRules(ctx, options) {
  const artifacts = [];
  const findings = [];
  const importVisited = /* @__PURE__ */ new Set();
  let turn0Tokens = 0;
  let turn0Bytes = 0;
  let onDemandTokens = 0;
  let rootClaude;
  let rootAgents;
  for (const artifact of ctx.artifacts) {
    const lines = countLines(artifact.content);
    let tokens = estimateTokens(artifact.content);
    let bytes = artifact.bytes;
    let importCount = 0;
    if (artifact.kind === "claude-md" && artifact.alwaysLoaded) {
      rootClaude = artifact;
      importVisited.add(artifact.absPath);
      const imp = resolveImportTree(artifact.absPath, ctx.rootDir, importVisited);
      importCount = imp.count;
      bytes += imp.extraBytes;
      tokens += imp.extraTokens;
    } else if (artifact.kind === "agents-md" && artifact.alwaysLoaded) {
      rootAgents = artifact;
    }
    if (artifact.kind === "skill-md") {
      const skillCheck = validateSkillArtifact(artifact, options.maxSkillLines);
      findings.push(...skillCheck.findings);
      turn0Tokens += skillCheck.metadataTokens;
      onDemandTokens += Math.max(0, tokens - skillCheck.metadataTokens);
    } else if (artifact.alwaysLoaded) {
      turn0Tokens += tokens;
      turn0Bytes += bytes;
    } else {
      onDemandTokens += tokens;
    }
    if (artifact.alwaysLoaded && tokens > options.maxFileTokens) {
      findings.push({
        ruleId: "instruction-file-bloat",
        category: "budget",
        severity: "warning",
        file: artifact.relPath,
        line: 1,
        message: `${artifact.relPath} consumes ~${tokens} turn-0 tokens (threshold: ${options.maxFileTokens})`,
        suggestion: "Split domain-specific guides into on-demand SKILL.md files or referenced docs."
      });
    }
    artifacts.push({
      path: artifact.relPath,
      kind: artifact.kind,
      alwaysLoaded: artifact.alwaysLoaded,
      bytes,
      lines,
      estimatedTokens: tokens,
      ...importCount > 0 ? { importCount } : {}
    });
  }
  if (rootClaude && rootAgents) {
    const claudeLinksToAgents = /@(?:\.\/)?AGENTS\.md\b/i.test(rootClaude.content);
    const agentsLinksToClaude = /@(?:\.\/)?CLAUDE\.md\b/i.test(rootAgents.content);
    if (!claudeLinksToAgents && !agentsLinksToClaude) {
      const sim = jaccardSimilarity(
        tokenShingles(rootClaude.content),
        tokenShingles(rootAgents.content)
      );
      if (sim >= 0.75) {
        findings.push({
          ruleId: "duplicate-instruction-overlap",
          category: "budget",
          severity: "info",
          file: rootClaude.relPath,
          line: 1,
          message: `CLAUDE.md and AGENTS.md share ${(sim * 100).toFixed(0)}% content overlap`,
          suggestion: "Keep a single canonical AGENTS.md and reference '@AGENTS.md' from CLAUDE.md to prevent instruction drift."
        });
      }
    }
  }
  if (turn0Tokens > options.maxTurn0Tokens) {
    findings.push({
      ruleId: "turn0-budget-exceeded",
      category: "budget",
      severity: "error",
      file: artifacts.find((a) => a.alwaysLoaded)?.path ?? ".",
      message: `Total turn-0 context (~${turn0Tokens} tokens) exceeds budget (${options.maxTurn0Tokens} tokens)`,
      suggestion: "Trim always-loaded instructions or move specialized workflows into progressive skills."
    });
  } else if (turn0Tokens > Math.floor(options.maxTurn0Tokens * 0.8)) {
    findings.push({
      ruleId: "turn0-budget-warning",
      category: "budget",
      severity: "warning",
      file: artifacts.find((a) => a.alwaysLoaded)?.path ?? ".",
      message: `Total turn-0 context (~${turn0Tokens} tokens) is above 80% of budget (${options.maxTurn0Tokens} tokens)`
    });
  }
  findings.push(...scanPromptCacheBreakers(ctx));
  return { artifacts, findings, turn0Tokens, turn0Bytes, onDemandTokens };
}

// src/analyzer.ts
var TOOL_VERSION = "0.1.0";
function resolveOptions(options) {
  return {
    rootDir: path5.resolve(options.rootDir),
    maxTurn0Tokens: options.maxTurn0Tokens ?? 8e3,
    maxFileTokens: options.maxFileTokens ?? 4e3,
    maxSkillLines: options.maxSkillLines ?? 500,
    maxMcpBytes: options.maxMcpBytes ?? 65536,
    maxToolDescTokens: options.maxToolDescTokens ?? 300,
    failOn: options.failOn ?? "error",
    ignoreRules: new Set(options.ignoreRules ?? []),
    ignorePaths: options.ignorePaths ?? [],
    probeMcp: options.probeMcp ?? false,
    probeTimeoutMs: options.probeTimeoutMs ?? 5e3,
    scanCodePrompts: options.scanCodePrompts ?? true,
    baselineReport: options.baselineReport
  };
}
function computeScore(findings) {
  const penaltyByRule = /* @__PURE__ */ new Map();
  let totalPenalty = 0;
  for (const f of findings) {
    const rawDelta = f.severity === "error" ? 18 : f.severity === "warning" ? 7 : 1;
    const ruleCap = f.severity === "error" ? 54 : f.severity === "warning" ? 28 : 10;
    const key = `${f.severity}:${f.ruleId}`;
    const used = penaltyByRule.get(key) ?? 0;
    const applied = Math.min(rawDelta, Math.max(0, ruleCap - used));
    penaltyByRule.set(key, used + applied);
    totalPenalty += applied;
  }
  const bounded = Math.max(0, Math.min(100, 100 - totalPenalty));
  const grade = bounded >= 90 ? "A" : bounded >= 80 ? "B" : bounded >= 70 ? "C" : bounded >= 60 ? "D" : "F";
  return { score: bounded, grade };
}
function severityRank(sev) {
  return sev === "error" ? 0 : sev === "warning" ? 1 : 2;
}
async function analyzeRepository(options) {
  const resolved = resolveOptions(options);
  const ctx = discoverProject(resolved.rootDir, {
    ignorePaths: resolved.ignorePaths,
    scanCodePrompts: resolved.scanCodePrompts
  });
  const liveProbedTools = [];
  const probeFindings = [];
  if (resolved.probeMcp) {
    const probed = await probeConfiguredMcpServers(ctx, resolved.probeTimeoutMs);
    for (const entry of probed) {
      if (entry.error) {
        probeFindings.push({
          ruleId: "mcp-probe-failed",
          category: "mcp",
          severity: "warning",
          file: entry.sourceFile,
          message: entry.error
        });
      } else {
        liveProbedTools.push({
          server: entry.server,
          sourceFile: entry.sourceFile,
          tools: entry.tools
        });
      }
    }
  }
  const securityFindings = runSecurityRules(ctx);
  const referenceFindings = runReferenceRules(ctx);
  const budgetResult = runBudgetRules(ctx, resolved);
  const mcpResult = runMcpRules(ctx, resolved, liveProbedTools);
  const rawFindings = [
    ...securityFindings,
    ...referenceFindings,
    ...budgetResult.findings,
    ...mcpResult.findings,
    ...probeFindings
  ];
  const findings = rawFindings.filter((f) => !resolved.ignoreRules.has(f.ruleId)).sort((a, b) => {
    const rankDiff = severityRank(a.severity) - severityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  const passed = resolved.failOn === "never" ? true : resolved.failOn === "warning" ? errorCount === 0 && warningCount === 0 : errorCount === 0;
  const { score, grade } = computeScore(findings);
  const turn0Tokens = budgetResult.turn0Tokens + mcpResult.mcpSchemaTokens;
  const report = {
    schemaVersion: "1.0.0",
    toolVersion: TOOL_VERSION,
    rootDir: resolved.rootDir,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    summary: {
      score,
      grade,
      turn0Tokens,
      turn0Bytes: budgetResult.turn0Bytes,
      onDemandTokens: budgetResult.onDemandTokens,
      mcpSchemaTokens: mcpResult.mcpSchemaTokens,
      totalArtifacts: ctx.artifacts.length,
      errorCount,
      warningCount,
      infoCount,
      passed
    },
    artifacts: budgetResult.artifacts,
    mcpTools: mcpResult.mcpTools,
    mcpPayloads: mcpResult.mcpPayloads,
    findings
  };
  if (resolved.baselineReport) {
    report.diff = diffReports(resolved.baselineReport, report);
  }
  return report;
}

// src/reporters/markdown.ts
var PR_COMMENT_MARKER = "<!-- context-preflight -->";
function escapeMdCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function formatMarkdownReport(report, options = {}) {
  const { summary } = report;
  const lines = [];
  if (options.includeStickyMarker) {
    lines.push(PR_COMMENT_MARKER);
  }
  const badge = summary.passed ? "PASS" : "FAIL";
  lines.push(`## Context Preflight: ${badge} (${summary.score}/100, Grade ${summary.grade})`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| :--- | :--- |");
  lines.push(
    `| Turn-0 Context | ~${summary.turn0Tokens.toLocaleString()} tokens (${summary.turn0Bytes.toLocaleString()} bytes) |`
  );
  lines.push(`| On-Demand Skills/Docs | ~${summary.onDemandTokens.toLocaleString()} tokens |`);
  lines.push(
    `| MCP Tool Schemas | ~${summary.mcpSchemaTokens.toLocaleString()} tokens (${report.mcpTools.length} tools) |`
  );
  lines.push(`| Artifacts Scanned | ${summary.totalArtifacts} files |`);
  lines.push(
    `| Findings | ${summary.errorCount} errors, ${summary.warningCount} warnings, ${summary.infoCount} info |`
  );
  if (report.diff) {
    const sign = report.diff.turn0TokensDelta >= 0 ? "+" : "";
    lines.push(
      `| Baseline Delta | ${sign}${report.diff.turn0TokensDelta} turn-0 tokens, ${report.diff.addedFindings.length} new / ${report.diff.resolvedFindings.length} resolved findings |`
    );
  }
  if (report.artifacts.length > 0) {
    lines.push("");
    lines.push("### Context Breakdown");
    lines.push("");
    lines.push("| File | Type | Scope | Tokens | Lines |");
    lines.push("| :--- | :--- | :--- | ---: | ---: |");
    for (const art of report.artifacts.slice(0, 25)) {
      lines.push(
        `| \`${escapeMdCell(art.path)}\` | ${art.kind} | ${art.alwaysLoaded ? "turn-0" : "on-demand"} | ${art.estimatedTokens.toLocaleString()} | ${art.lines.toLocaleString()} |`
      );
    }
  }
  if (report.findings.length > 0) {
    lines.push("");
    lines.push("### Findings");
    lines.push("");
    lines.push("| Severity | Rule | Location | Message |");
    lines.push("| :--- | :--- | :--- | :--- |");
    for (const f of report.findings.slice(0, 40)) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(
        `| **${f.severity.toUpperCase()}** | \`${f.ruleId}\` | ${loc} | ${escapeMdCell(f.message)} |`
      );
    }
    if (report.findings.length > 40) {
      lines.push("");
      lines.push(`_Showing first 40 of ${report.findings.length} findings._`);
    }
  }
  return lines.join("\n");
}

// src/mcp-server.ts
import fs5 from "fs";
import path6 from "path";
var SERVER_TOOLS = [
  {
    name: "preflight_scan",
    description: "Audit a repository's AI coding-agent context layer (CLAUDE.md, AGENTS.md, SKILL.md, .mcp.json, MCP fixtures, prompt-cache risks) and return score, turn-0 token breakdown, and findings.",
    inputSchema: {
      type: "object",
      properties: {
        rootDir: {
          type: "string",
          description: "Repository root directory path to audit (defaults to current working directory)."
        },
        maxTurn0Tokens: {
          type: "number",
          description: "Maximum allowed turn-0 context token budget (default: 8000)."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "preflight_compare",
    description: "Compare current repository context health against a previously exported PreflightReport JSON file.",
    inputSchema: {
      type: "object",
      properties: {
        baselinePath: {
          type: "string",
          description: "Path to the baseline JSON report written by context-preflight."
        },
        rootDir: {
          type: "string",
          description: "Repository root directory path to evaluate."
        }
      },
      required: ["baselinePath"],
      additionalProperties: false
    }
  }
];
function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}
`);
}
function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}
`);
}
async function handleMcpRequest(msg) {
  if (msg.id === void 0) {
    return null;
  }
  switch (msg.method) {
    case "initialize":
      return {
        id: msg.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "context-preflight", version: TOOL_VERSION }
        }
      };
    case "ping":
      return { id: msg.id, result: {} };
    case "tools/list":
      return { id: msg.id, result: { tools: SERVER_TOOLS } };
    case "tools/call": {
      const params = msg.params ?? {};
      const name = typeof params["name"] === "string" ? params["name"] : "";
      const args = params["arguments"] && typeof params["arguments"] === "object" && !Array.isArray(params["arguments"]) ? params["arguments"] : {};
      const rootDir = typeof args["rootDir"] === "string" && args["rootDir"].trim() ? path6.resolve(args["rootDir"]) : process.cwd();
      if (name === "preflight_scan") {
        const maxTurn0Tokens = typeof args["maxTurn0Tokens"] === "number" && Number.isFinite(args["maxTurn0Tokens"]) ? args["maxTurn0Tokens"] : void 0;
        const report = await analyzeRepository({ rootDir, maxTurn0Tokens });
        return {
          id: msg.id,
          result: {
            content: [{ type: "text", text: formatMarkdownReport(report) }],
            structuredContent: report
          }
        };
      }
      if (name === "preflight_compare") {
        const baselineArg = typeof args["baselinePath"] === "string" ? args["baselinePath"] : "";
        if (!baselineArg) {
          return {
            id: msg.id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Missing required argument: baselinePath" }]
            }
          };
        }
        const baselineRaw = fs5.readFileSync(path6.resolve(rootDir, baselineArg), "utf8");
        const baselineReport = JSON.parse(baselineRaw);
        const report = await analyzeRepository({ rootDir, baselineReport });
        return {
          id: msg.id,
          result: {
            content: [{ type: "text", text: formatMarkdownReport(report) }],
            structuredContent: report
          }
        };
      }
      return { id: msg.id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }
    default:
      return { id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
function startMcpStdioServer() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void processLine(trimmed);
    }
  });
}
async function processLine(trimmed) {
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  try {
    const response = await handleMcpRequest(parsed);
    if (!response) return;
    if (response.error) {
      writeError(response.id, response.error.code, response.error.message);
    } else {
      writeResponse(response.id, response.result);
    }
  } catch (err) {
    const id = parsed.id ?? null;
    writeError(id, -32603, err instanceof Error ? err.message : "Internal error");
  }
}

// src/reporters/sarif.ts
function sarifLevel(sev) {
  if (sev === "error") return "error";
  if (sev === "warning") return "warning";
  return "note";
}
function formatSarifReport(report) {
  const ruleMap = /* @__PURE__ */ new Map();
  for (const f of report.findings) {
    if (!ruleMap.has(f.ruleId)) {
      ruleMap.set(f.ruleId, {
        id: f.ruleId,
        shortDescription: { text: `context-preflight/${f.ruleId}` },
        properties: { category: f.category }
      });
    }
  }
  const results = report.findings.map((f) => ({
    ruleId: f.ruleId,
    level: sarifLevel(f.severity),
    message: {
      text: f.suggestion ? `${f.message} Fix: ${f.suggestion}` : f.message
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: f.file === "." ? "CLAUDE.md" : f.file
          },
          region: {
            startLine: f.line && f.line > 0 ? f.line : 1,
            ...f.column && f.column > 0 ? { startColumn: f.column } : {}
          }
        }
      }
    ]
  }));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "context-preflight",
            version: report.toolVersion,
            informationUri: "https://github.com/SiluPanda/context-preflight",
            rules: Array.from(ruleMap.values())
          }
        },
        results
      }
    ]
  };
  return JSON.stringify(sarif, null, 2);
}

// src/reporters/terminal.ts
function severityTag(sev, useColor) {
  const upper = sev.toUpperCase().padEnd(7);
  if (!useColor) return upper;
  if (sev === "error") return `\x1B[31m${upper}\x1B[0m`;
  if (sev === "warning") return `\x1B[33m${upper}\x1B[0m`;
  return `\x1B[36m${upper}\x1B[0m`;
}
function progressBar(value, max, width = 20) {
  const ratio = max <= 0 ? 0 : Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}
function formatTerminalReport(report, options = {}) {
  const useColor = options.color ?? (process.stdout.isTTY && !process.env["NO_COLOR"]);
  const bold = (s) => useColor ? `\x1B[1m${s}\x1B[0m` : s;
  const dim = (s) => useColor ? `\x1B[2m${s}\x1B[0m` : s;
  const green = (s) => useColor ? `\x1B[32m${s}\x1B[0m` : s;
  const red = (s) => useColor ? `\x1B[31m${s}\x1B[0m` : s;
  const lines = [];
  const { summary } = report;
  const maxBudget = options.maxTurn0Tokens ?? 8e3;
  const statusStr = summary.passed ? green("PASS") : red("FAIL");
  lines.push(
    `${bold("context-preflight")} v${report.toolVersion}  ${statusStr}  Score: ${bold(`${summary.score}/100 (${summary.grade})`)}`
  );
  lines.push(dim(`Root: ${report.rootDir}`));
  lines.push("");
  const pct = maxBudget > 0 ? Math.round(summary.turn0Tokens / maxBudget * 100) : 0;
  lines.push(
    `Turn-0 Context: ${progressBar(summary.turn0Tokens, maxBudget)} ~${summary.turn0Tokens.toLocaleString()} / ${maxBudget.toLocaleString()} tokens (${pct}%)`
  );
  if (summary.onDemandTokens > 0 || summary.mcpSchemaTokens > 0) {
    lines.push(
      dim(
        `On-demand skills/docs: ~${summary.onDemandTokens.toLocaleString()} tokens | MCP tool schemas: ~${summary.mcpSchemaTokens.toLocaleString()} tokens`
      )
    );
  }
  if (report.diff) {
    const sign = report.diff.turn0TokensDelta >= 0 ? "+" : "";
    lines.push(
      dim(
        `Baseline Delta: ${sign}${report.diff.turn0TokensDelta} turn-0 tokens | +${report.diff.addedFindings.length} added / -${report.diff.resolvedFindings.length} resolved findings`
      )
    );
  }
  lines.push("");
  if (report.artifacts.length === 0 && report.mcpPayloads.length === 0 && report.mcpTools.length === 0) {
    lines.push(
      dim(
        "No agent context files (CLAUDE.md, AGENTS.md, SKILL.md, .mcp.json) or MCP fixtures found."
      )
    );
  } else if (report.artifacts.length > 0) {
    lines.push(bold("Artifacts:"));
    for (const art of report.artifacts) {
      const scope = art.alwaysLoaded ? "turn-0" : "on-demand";
      const impSuffix = art.importCount ? `, +${art.importCount} import(s)` : "";
      lines.push(
        `  - ${art.path} (${art.kind}, ${scope}, ~${art.estimatedTokens} tok, ${art.lines} lines${impSuffix})`
      );
    }
    lines.push("");
  }
  if (report.mcpPayloads.length > 0) {
    lines.push(bold("MCP Tool Result Payloads:"));
    for (const p of report.mcpPayloads) {
      lines.push(
        `  - ${p.file}: ${p.compactBytes.toLocaleString()} bytes (~${p.estimatedTokens} tok), mirrors=${p.mirrorCount}, repeated_subtrees=${p.repeatedSubtreeCount}`
      );
    }
    lines.push("");
  }
  lines.push(
    bold(
      `Findings (${summary.errorCount} error, ${summary.warningCount} warning, ${summary.infoCount} info):`
    )
  );
  if (report.findings.length === 0) {
    lines.push(`  ${green("No issues detected.")}`);
  } else {
    for (const f of report.findings) {
      const loc = f.line ? `${f.file}:${f.line}${f.column ? `:${f.column}` : ""}` : f.file;
      lines.push(`  ${severityTag(f.severity, useColor)} ${bold(f.ruleId)}  ${loc}`);
      lines.push(`    ${f.message}`);
      if (f.suggestion) {
        lines.push(`    ${dim(`Fix: ${f.suggestion}`)}`);
      }
    }
  }
  return lines.join("\n");
}

export {
  diffReports,
  utf8Bytes,
  estimateTokens,
  canonicalJsonString,
  compactJsonBytes,
  discoverProject,
  auditToolDefinitions,
  TOOL_VERSION,
  resolveOptions,
  analyzeRepository,
  PR_COMMENT_MARKER,
  formatMarkdownReport,
  handleMcpRequest,
  startMcpStdioServer,
  formatSarifReport,
  formatTerminalReport
};
//# sourceMappingURL=chunk-EAU363UF.js.map