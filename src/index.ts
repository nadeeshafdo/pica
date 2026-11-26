#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { startPreviewServer } from "./preview.js";
import { closeBrowser } from "./chromium.js";

// Optional local human preview. Must never crash stdio MCP (fail to stderr only).
let preview: ReturnType<typeof startPreviewServer> = null;
try {
  preview = startPreviewServer();
} catch (e) {
  console.error(`[pica] preview failed to start: ${String(e)}`);
}

function shutdown(): void {
  try {
    preview?.stop();
  } catch {
    // ignore
  }
  void closeBrowser().catch(() => undefined);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void serveStdio(() => {
  const server = createServer();
  // Release keep-alive handles (preview HTTP + browser) when the MCP
  // connection closes so the process can exit on stdin EOF.
  const inner = server.server as unknown as { onclose?: () => void };
  inner.onclose = () => {
    shutdown();
  };
  return server;
});
console.error("pica MCP server running on stdio");
