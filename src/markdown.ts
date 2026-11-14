export interface MarkdownLine {
  lineNumber: number;
  raw: string;
  inCodeFence: boolean;
}

export interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  bodyStartLine: number;
  body: string;
  fields: Record<string, string | boolean | string[]>;
  error?: string;
}

export interface MarkdownLink {
  label: string;
  target: string;
  line: number;
  column: number;
}

export interface InlineCodeSpan {
  text: string;
  line: number;
  column: number;
  lineText: string;
}

/**
 * Annotate lines with code-fence state while respecting both ``` and ~~~ fences.
 */
export function scanMarkdownLines(content: string): MarkdownLine[] {
  const rawLines = content.split(/\r\n|\r|\n/);
  const result: MarkdownLine[] = [];
  let activeFence: { char: string; len: number } | null = null;

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
      } else if (
        activeFence.char === ch &&
        marker.length >= activeFence.len &&
        trimmed === marker
      ) {
        activeFence = null;
        inFence = true;
      }
    }

    result.push({
      lineNumber: idx + 1,
      raw,
      inCodeFence: inFence,
    });
  }
  return result;
}

/**
 * Parse simple YAML frontmatter (scalars, booleans, folded/literal blocks, inline & dashed lists)
 * without runtime dependencies.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== "---") {
    return {
      hasFrontmatter: false,
      bodyStartLine: 1,
      body: content,
      fields: {},
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
      error: "Unclosed YAML frontmatter delimiter '---'",
    };
  }

  const fields: Record<string, string | boolean | string[]> = {};
  let currentKey: string | null = null;
  let blockMode: "|" | ">" | null = null;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (currentKey && blockMode) {
      fields[currentKey] =
        blockMode === ">" ? blockLines.join(" ").trim() : blockLines.join("\n").trim();
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
      fields[key] = inner
        ? inner
            .split(",")
            .map((part) => unquoteYamlScalar(part.trim()))
            .filter(Boolean)
        : [];
    } else {
      fields[key] = unquoteYamlScalar(rawVal);
    }
  }
  flushBlock();

  return {
    hasFrontmatter: true,
    bodyStartLine: endIdx + 2,
    body: lines.slice(endIdx + 1).join("\n"),
    fields,
  };
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract Markdown links outside fenced code blocks (skips image links `![...](...)` too cleanly).
 */
export function extractMarkdownLinks(lines: MarkdownLine[]): MarkdownLink[] {
  const links: MarkdownLink[] = [];
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
        column: (match.index ?? 0) + 1,
      });
    }
  }
  return links;
}

/**
 * Extract single-backtick inline code spans outside fenced code blocks.
 */
export function extractInlineCodeSpans(lines: MarkdownLine[]): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
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
        lineText: entry.raw,
      });
    }
  }
  return spans;
}

function stripInlineCode(line: string): string {
  return line.replace(/(?<!`)`[^`\n]*`(?!`)/g, (m) => " ".repeat(m.length));
}
