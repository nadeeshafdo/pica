import { Hono } from "hono";

let lastSvgPath: string | null = null;
let lastSvgText: string | null = null;
const clients = new Set<{ send: (data: string) => void }>();

export function setCurrentSvg(path: string, text: string): void {
  lastSvgPath = path;
  lastSvgText = text;
  const msg = JSON.stringify({ type: "reload", path });
  for (const c of clients) {
    try {
      c.send(msg);
    } catch {
      // drop broken client lazily on close
    }
  }
}

export async function notifyPreview(path: string): Promise<void> {
  try {
    const text = await Bun.file(path).text();
    setCurrentSvg(path, stripOverlaySafe(text));
  } catch (e) {
    console.error(`[pica] preview notify failed for ${path}: ${String(e)}`);
  }
}

function stripOverlaySafe(svg: string): string {
  return svg.replace(/<g\s[^>]*id=["']pica-debug-overlay["'][\s\S]*?<\/g\s*>/gi, "");
}

async function loadViewerHtml(): Promise<string> {
  const candidates = [
    new URL("./viewer.html", import.meta.url),
    new URL("../src/viewer.html", import.meta.url),
  ];
  for (const u of candidates) {
    try {
      const f = Bun.file(u);
      if (await f.exists()) return await f.text();
    } catch {
      continue;
    }
  }
  return "<!doctype html><html><body><p>pica preview: viewer.html missing</p></body></html>";
}

export function startPreviewServer(): null | ReturnType<typeof Bun.serve> {
  const portRaw = process.env["PICA_PORT"] ?? "4173";
  const port = Number.parseInt(portRaw, 10);
  const safePort = Number.isFinite(port) ? port : 4173;
  const app = new Hono();

  app.get("/", async (c) => {
    const html = await loadViewerHtml();
    return c.html(html);
  });
  app.get("/svg", (c) => {
    if (!lastSvgText) {
      return c.text("No .pica.svg written yet in this session.", 404);
    }
    c.header("X-Pica-Path", lastSvgPath ?? "");
    c.header("Cache-Control", "no-store");
    return c.text(lastSvgText, 200, { "Content-Type": "image/svg+xml" });
  });

  try {
    const server = Bun.serve({
      port: safePort,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const ok = srv.upgrade(req);
          if (!ok) return new Response("WebSocket upgrade failed.", { status: 426 });
          return undefined as unknown as Response;
        }
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          clients.add(ws as unknown as { send: (data: string) => void });
          try {
            (ws as unknown as { send: (d: string) => void }).send(
              JSON.stringify({ type: "hello", path: lastSvgPath }),
            );
          } catch {
            // ignore
          }
        },
        message(_ws, _msg) {
          // no-op: viewer is read-only
        },
        close(ws) {
          clients.delete(ws as unknown as { send: (data: string) => void });
        },
      },
    });
    console.error(`[pica] preview at http://127.0.0.1:${server.port}/`);
    return server;
  } catch (e) {
    console.error(`[pica] preview server failed to start (port busy?): ${String(e)}`);
    return null;
  }
}
