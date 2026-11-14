import fs from "node:fs";
import path from "node:path";
import type { DiscoveredArtifact, ProjectContext } from "../discovery.js";
import type { Finding, RuleCategory } from "../types.js";

const BIDI_OR_INVISIBLE_PATTERN =
  /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\u061C\uFEFF]|[\u{E0001}-\u{E007F}]/gu;

interface SecretRule {
  label: string;
  regex: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { label: "Anthropic API key", regex: /\bsk-ant-(?:api|admin)\d*-[A-Za-z0-9_-]{16,}\b/g },
  { label: "OpenAI API key", regex: /\bsk-(?:proj|svcacct|live)-[A-Za-z0-9_-]{16,}\b/g },
  { label: "GitHub personal access token", regex: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g },
  { label: "GitHub fine-grained token", regex: /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g },
  { label: "AWS access key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g },
  { label: "GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
];

interface InjectionPattern {
  label: string;
  severity: "error" | "warning";
  regex: RegExp;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    label: "override directive ('ignore previous instructions')",
    severity: "error",
    regex: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
  },
  {
    label: "concealment directive ('do not tell the user')",
    severity: "error",
    regex: /\b(?:do\s+not|never)\s+(?:tell|inform|show|mention\s+to)\s+the\s+user\b/i,
  },
  {
    label: "remote curl-to-shell execution pipe",
    severity: "warning",
    regex: /\b(?:curl|wget)\b[^\n|]{0,180}\|\s*(?:sh|bash|zsh)\b/i,
  },
  {
    label: "credential/key exfiltration pattern (~/.ssh, ~/.aws, .env)",
    severity: "warning",
    regex:
      /(?:~\/\.ssh\/|~\/\.aws\/credentials|process\.env\.[A-Z0-9_]+).{0,80}\b(?:curl|wget|fetch|axios|nc|POST)\b/i,
  },
];

const PROHIBITION_CONTEXT = /\b(?:never|do\s+not|don't|avoid|forbid|prohibit)\b/i;

const KNOWN_INSTALLER_URLS =
  /https:\/\/(?:astral\.sh\/uv\/install\.sh|sh\.rustup\.rs|get\.pnpm\.io\/|bun\.sh\/install|raw\.githubusercontent\.com\/(?:Homebrew|nvm-sh)\/)/i;

const DANGEROUS_PERMISSION_PATTERNS = [
  /^Bash\(\s*\*\s*\)$/,
  /^Bash\(\s*rm\s+-rf/i,
  /^Bash\(\s*curl\b/i,
  /^Bash\(\s*wget\b/i,
  /^Bash\(\s*sudo\b/i,
];

function formatCodepoint(char: string): string {
  const cp = char.codePointAt(0);
  if (cp === undefined) return "U+????";
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function isPlaceholderLike(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("${") ||
    lower.includes("example") ||
    lower.includes("dummy") ||
    lower.includes("placeholder") ||
    lower.includes("xxxxxx") ||
    lower.includes("000000") ||
    lower.includes("<your")
  );
}

/**
 * Scan arbitrary text lines for invisible Unicode bidi controls, zero-width characters, or tag chars.
 */
export function scanTextForHiddenUnicode(
  text: string,
  file: string,
  category: RuleCategory,
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const matches = Array.from(line.matchAll(BIDI_OR_INVISIBLE_PATTERN));
    for (const match of matches) {
      const ch = match[0];
      const index = match.index ?? 0;
      // Allow UTF-8 BOM only at byte 0 of line 1.
      if (ch === "\uFEFF" && i === 0 && index === 0) continue;

      findings.push({
        ruleId: "hidden-unicode",
        category,
        severity: "error",
        file,
        line: i + 1,
        column: index + 1,
        message: `Hidden or bidirectional control Unicode character detected (${formatCodepoint(ch)})`,
        suggestion: "Remove invisible zero-width, bidi override, or Unicode tag characters.",
      });
      break;
    }
  }
  return findings;
}

/**
 * Scan instructions, skills, or MCP descriptions for covert prompt injection or shell pipe exfil.
 */
export function scanTextForPromptInjection(
  text: string,
  file: string,
  category: RuleCategory,
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const pat of INJECTION_PATTERNS) {
      const match = pat.regex.exec(line);
      if (!match) continue;
      if (pat.label.startsWith("remote curl-to-shell")) {
        if (
          PROHIBITION_CONTEXT.test(line) ||
          line.includes("...") ||
          KNOWN_INSTALLER_URLS.test(line)
        ) {
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
        suggestion:
          "Audit this line carefully and remove hidden directives or remote pipe execution commands.",
        snippet: line.trim().slice(0, 140),
      });
      break;
    }
  }
  return findings;
}

function scanSecretsInArtifact(artifact: DiscoveredArtifact): Finding[] {
  const findings: Finding[] = [];
  const lines = artifact.content.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    for (const rule of SECRET_RULES) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
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
          suggestion:
            "Replace hardcoded credentials with environment variable placeholders like ${API_KEY}.",
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

function isLocalCommandEntrypoint(arg: string): boolean {
  return (arg.startsWith("./") || arg.startsWith("../")) && /\.(?:js|mjs|cjs|ts|py|sh)$/.test(arg);
}

function inspectMcpConfig(artifact: DiscoveredArtifact, ctx: ProjectContext): Finding[] {
  const findings: Finding[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content);
  } catch (err) {
    findings.push({
      ruleId: "invalid-json-config",
      category: "security",
      severity: "error",
      file: artifact.relPath,
      line: 1,
      message: `Invalid JSON in ${artifact.relPath}: ${err instanceof Error ? err.message : "parse error"}`,
    });
    return findings;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return findings;
  const root = parsed as Record<string, unknown>;
  const serversRaw = root["mcpServers"] ?? root["servers"];
  if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
    return findings;
  }

  const servers = serversRaw as Record<string, unknown>;
  for (const [serverName, cfgRaw] of Object.entries(servers)) {
    if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) continue;
    const cfg = cfgRaw as Record<string, unknown>;
    const command = typeof cfg["command"] === "string" ? cfg["command"].trim() : "";
    const args = Array.isArray(cfg["args"])
      ? cfg["args"].filter((a): a is string => typeof a === "string")
      : [];

    if (command === "npx" && args.includes("-y")) {
      const pkgArg = args.find((a) => !a.startsWith("-"));
      if (pkgArg && !isPinnedPackageSpec(pkgArg)) {
        findings.push({
          ruleId: "unsafe-mcp-config",
          category: "security",
          severity: "warning",
          file: artifact.relPath,
          message: `MCP server '${serverName}' runs unpinned '${pkgArg}' via 'npx -y'`,
          suggestion: `Pin an explicit package version (e.g. '${pkgArg}@1.2.3') to prevent silent supply-chain changes.`,
        });
      }
    }

    for (const arg of args) {
      if (isLocalCommandEntrypoint(arg)) {
        const candidate = path.resolve(path.dirname(artifact.absPath), arg);
        if (!fs.existsSync(candidate)) {
          findings.push({
            ruleId: "broken-mcp-entrypoint",
            category: "references",
            severity: "error",
            file: artifact.relPath,
            message: `MCP server '${serverName}' references missing local script '${arg}'`,
            suggestion:
              "Update the relative path in args or verify build output before starting MCP clients.",
          });
        }
      }
    }
  }
  void ctx;
  return findings;
}

function isPinnedPackageSpec(spec: string): boolean {
  const withoutScope = spec.startsWith("@") ? spec.slice(spec.indexOf("/") + 1) : spec;
  const atIdx = withoutScope.indexOf("@");
  if (atIdx === -1) return false;
  const tag = withoutScope.slice(atIdx + 1);
  return tag !== "latest" && tag.length > 0;
}

function inspectClaudeSettings(artifact: DiscoveredArtifact): Finding[] {
  const findings: Finding[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content);
  } catch (err) {
    findings.push({
      ruleId: "invalid-json-config",
      category: "security",
      severity: "error",
      file: artifact.relPath,
      line: 1,
      message: `Invalid JSON in ${artifact.relPath}: ${err instanceof Error ? err.message : "parse error"}`,
    });
    return findings;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return findings;
  const root = parsed as Record<string, unknown>;
  const perms = root["permissions"];
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    const allow = (perms as Record<string, unknown>)["allow"];
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
            suggestion:
              "Scope Bash permissions to narrow commands (e.g. 'Bash(npm test)') instead of wildcards.",
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Run all security and configuration safety checks across discovered agent artifacts.
 */
export function runSecurityRules(ctx: ProjectContext): Finding[] {
  const findings: Finding[] = [];

  for (const artifact of ctx.artifacts) {
    findings.push(...scanTextForHiddenUnicode(artifact.content, artifact.relPath, "security"));
    findings.push(...scanSecretsInArtifact(artifact));

    if (
      artifact.kind === "claude-md" ||
      artifact.kind === "agents-md" ||
      artifact.kind === "skill-md" ||
      artifact.kind === "claude-command" ||
      artifact.kind === "cursor-rule"
    ) {
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
