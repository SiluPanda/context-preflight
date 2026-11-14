const UTF8_ENCODER = new TextEncoder();

/**
 * Compute exact UTF-8 byte length of a string.
 */
export function utf8Bytes(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

/**
 * Deterministic token heuristic aligned with common BPE/Claude averages (~4 UTF-8 bytes/token).
 * Documented explicitly as an offline approximation rather than a provider-specific tokenizer.
 */
export function estimateTokens(text: string): number {
  const bytes = utf8Bytes(text);
  if (bytes === 0) return 0;
  return Math.ceil(bytes / 4);
}

/**
 * Deterministic token estimate directly from a precomputed byte count.
 */
export function estimateTokensFromBytes(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

/**
 * Count logical lines cleanly across LF/CRLF inputs.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

/**
 * Canonicalize JSON values by sorting object keys recursively for stable hashing and byte sizing.
 */
export function canonicalizeJson(value: unknown, depth = 0): unknown {
  if (depth > 64) {
    throw new Error("JSON nesting exceeds maximum depth of 64");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== undefined) {
      sorted[key] = canonicalizeJson(child, depth + 1);
    }
  }
  return sorted;
}

/**
 * Serialize a JSON value compactly with sorted object keys and return both string and UTF-8 bytes.
 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function compactJsonBytes(value: unknown): number {
  return utf8Bytes(canonicalJsonString(value));
}
