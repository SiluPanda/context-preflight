# context-preflight Development Guide

Zero-runtime-dependency TypeScript CLI, programmatic SDK, MCP stdio server, and Node GitHub Action for preflight auditing of AI agent context layers.

## Verification

Before committing changes, always run the full verification suite:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:package
```

`dist/action.js` must stay built and committed whenever `src/` changes so the standalone `node20` GitHub Action works directly via `uses: SiluPanda/context-preflight@v1`.

## Architecture

- Discovery and ignore handling: `src/discovery.ts`
- Rule engines: `src/rules/security.ts`, `src/rules/references.ts`, `src/rules/budget.ts`, `src/rules/mcp.ts`
- Report aggregation and PR diffing: `src/analyzer.ts`, `src/diff.ts`
- Reporters and integrations: `src/reporters/terminal.ts`, `src/reporters/markdown.ts`, `src/reporters/sarif.ts`, `src/mcp-server.ts`, `src/action.ts`, `src/cli.ts`
