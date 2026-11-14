# Contributing to context-preflight

Contributions are warmly welcome! `context-preflight` intentionally maintains **zero runtime dependencies** (`dependencies: {}`) so it installs instantaneously in CI and runs standalone as a bundled Node GitHub Action.

## Local Setup

```bash
npm ci
npm run check
```

`npm run check` verifies Prettier formatting, strict ESLint (`--max-warnings 0`), TypeScript typechecking, Vitest suite + coverage, `tsup` bundling, `publint`, and `attw`.

> Important: Because `action.yml` runs `dist/action.js`, please run `npm run build` and include updated `dist/` artifacts if your change modifies runtime source files under `src/`.

## Design Principles

1. **Zero runtime dependencies**: Use only Node.js >=20 built-in modules in `src/`.
2. **Low false positives on real OSS repositories**: Any new rule or heuristic must be validated against real repositories with diverse `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, and `.mcp.json` layouts before enabling `"error"` severity by default.
3. **Deterministic cross-platform paths**: Normalize output paths with `toPosixRel` from `src/discovery.ts`.

## Good Starter Areas

- Additional agent instruction file formats (for example Zed, Windsurf, or Codex custom rule layouts)
- Streamable HTTP / SSE inspection mode in `src/mcp-probe.ts` alongside stdio probing
- Additional monorepo task-runner resolvers (Gradle, Bazel, Taskfile) in `src/discovery.ts` and `src/rules/references.ts`
- Config file discovery (`.context-preflight.json` or `package.json` `"contextPreflight"` overrides)

## Pull Request Checklist

1. Add focused Vitest coverage in `test/` for every rule or reporter change.
2. Document any new rule ID or CLI flag in `README.md` and `src/cli.ts`.
3. Ensure `npm run check` passes cleanly with zero warnings.
