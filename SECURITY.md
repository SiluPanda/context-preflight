# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `context-preflight` (for example a command-execution issue in `--probe-mcp`, path traversal during file discovery, or a SARIF/PR comment injection bug), please **do not open a public issue** with exploit details.

Instead, report it privately via GitHub Security Advisories on `https://github.com/SiluPanda/context-preflight/security/advisories/new` or email `pandasilu428@gmail.com` with:

- Steps to reproduce or a minimal proof of concept
- Affected version and Node.js version
- Potential impact

We aim to acknowledge reports within 48 hours and release a fix promptly once verified.

## Security Model Notes

- Static scanning (`context-preflight scan`) reads workspace files read-only without executing repository code.
- Live MCP probing (`--probe-mcp`) spawns local stdio commands declared in `.mcp.json` explicitly opted into by the user. Do not pass `--probe-mcp` on untrusted pull requests without reviewing `.mcp.json` diffs first.
