import { spawn } from "node:child_process";
import type { ProjectContext } from "./discovery.js";
import type { RawMcpTool } from "./rules/mcp.js";

export interface ProbedMcpResult {
  server: string;
  sourceFile: string;
  tools: RawMcpTool[];
  error?: string;
}

function sendJsonRpc(stdin: NodeJS.WritableStream, payload: Record<string, unknown>): void {
  stdin.write(`${JSON.stringify(payload)}\n`);
}

function parseJsonLines(buffer: string): Array<Record<string, unknown>> {
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj: unknown = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed.push(obj as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON log lines written to stdout by noisy servers.
    }
  }
  return parsed;
}

/**
 * Probe a single stdio MCP server via JSON-RPC `initialize` -> `tools/list` within a strict timeout.
 */
export async function probeStdioMcpServer(
  serverName: string,
  sourceFile: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<ProbedMcpResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdoutBuf = "";
    let initDone = false;

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (res: ProbedMcpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
      resolve(res);
    };

    const timer = setTimeout(() => {
      finish({
        server: serverName,
        sourceFile,
        tools: [],
        error: `Timed out after ${timeoutMs}ms waiting for tools/list from '${serverName}'`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      finish({
        server: serverName,
        sourceFile,
        tools: [],
        error: `Failed to spawn '${serverName}': ${err.message}`,
      });
    });

    child.on("exit", (code) => {
      if (!settled) {
        finish({
          server: serverName,
          sourceFile,
          tools: [],
          error: `Server '${serverName}' exited (code ${String(code)}) before responding to tools/list`,
        });
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
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
            params: {},
          });
        } else if (msg["id"] === 2) {
          const result = msg["result"];
          const tools =
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            Array.isArray((result as Record<string, unknown>)["tools"])
              ? ((result as Record<string, unknown>)["tools"] as RawMcpTool[])
              : [];
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
        clientInfo: { name: "context-preflight", version: "0.1.0" },
      },
    });
  });
}

/**
 * Optionally probe all local stdio MCP servers configured inside `.mcp.json` files.
 */
export async function probeConfiguredMcpServers(
  ctx: ProjectContext,
  timeoutMs: number,
): Promise<ProbedMcpResult[]> {
  const results: ProbedMcpResult[] = [];
  for (const artifact of ctx.artifacts) {
    if (artifact.kind !== "mcp-config") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifact.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const serversRaw =
      (parsed as Record<string, unknown>)["mcpServers"] ??
      (parsed as Record<string, unknown>)["servers"];
    if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) continue;

    for (const [serverName, cfgRaw] of Object.entries(serversRaw as Record<string, unknown>)) {
      if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) continue;
      const cfg = cfgRaw as Record<string, unknown>;
      const command = typeof cfg["command"] === "string" ? cfg["command"].trim() : "";
      if (!command) continue;
      const args = Array.isArray(cfg["args"])
        ? cfg["args"].filter((a): a is string => typeof a === "string")
        : [];
      const envObj: Record<string, string> = {};
      if (cfg["env"] && typeof cfg["env"] === "object" && !Array.isArray(cfg["env"])) {
        for (const [k, v] of Object.entries(cfg["env"] as Record<string, unknown>)) {
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
        envObj,
      );
      results.push(res);
    }
  }
  return results;
}
