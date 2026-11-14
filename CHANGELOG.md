# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-11-14

### Added

- Zero-runtime-dependency repository scanner across `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.cursorrules`, `.cursor/rules/*`, `SKILL.md`, `.claude/settings.json`, `.mcp.json`, MCP payloads/tool schemas, and LLM prompt source files.
- Five rule engines covering security & hidden Unicode/injection checks, dead `@import`/link/file/script/lockfile references, turn-0 token budgets & skill frontmatter validation, prompt-cache prefix breakers, and MCP tool schema + duplicate payload waste detection.
- CLI (`scan`, `compare`, `init`, `mcp`) with terminal, JSON, Markdown PR comment, and SARIF 2.1.0 outputs.
- Live stdio MCP probing mode (`--probe-mcp`) and built-in stdio MCP server (`context-preflight mcp`) exposing `preflight_scan` and `preflight_compare`.
- Bundled `node20` GitHub Action (`action.yml` -> `dist/action.js`) with PR sticky comment upsert, base-branch delta diffing, Job Summary output, and SARIF export.
