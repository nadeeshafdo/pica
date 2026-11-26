import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import type { Bbox } from "./pica-file.js";

const CHROME_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

export function findChromeBinary(): string | null {
  const env = process.env["CHROME_PATH"] ?? process.env["CHROMIUM_PATH"];
  if (env) return env;
  const w = (Bun as unknown as { which?: (bin: string) => string | null }).which;
  if (typeof w === "function") {
    for (const c of CHROME_CANDIDATES) {
      try {
        const p = w(c);
        if (p) return p;
      } catch {
        continue;
      }
    }
    return null;
  }
  return null;
}

export function chromeMissingMessage(): string {
  return (
    `Chromium not found in PATH (looked for ${CHROME_CANDIDATES.join(", ")}). ` +
    `Install chromium (e.g. apt install chromium) or set CHROME_PATH to use exact bboxes, timed inspection, and animated export.`
  );
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class CdpConn {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: unknown) => void>>();
  closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (ev: MessageEvent) => {
      let msg: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: unknown;
      };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(`CDP error: ${msg.error.message ?? "unknown"}`));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        const arr = this.listeners.get(msg.method);
        if (arr) {
          for (const fn of arr) {
            try {
              fn(msg.params);
            } catch {
              // ignore listener errors
            }
          }
        }
      }
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error("CDP connection closed."));
      }
      this.pending.clear();
    };
    this.ws.onerror = () => {
      // errors surface via close/reject paths
    };
  }

  static async connect(url: string): Promise<CdpConn> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chromium DevTools.")), 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to Chromium DevTools WebSocket."));
      };
    });
    return new CdpConn(ws);
  }

  on(method: string, fn: (params: unknown) => void): void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(fn);
    this.listeners.set(method, arr);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload["sessionId"] = sessionId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout waiting for ${method}.`));
        }
      }, 20000);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

let browserProc: ReturnType<typeof Bun.spawn> | null = null;
let browserConn: CdpConn | null = null;
let pageSessionId: string | null = null;
let pageTargetId: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let starting: Promise<void> | null = null;
let sigHooked = false;

function hookSignals(): void {
  if (sigHooked) return;
  sigHooked = true;
  const cleanup = () => {
    try {
      if (idleTimer) clearTimeout(idleTimer);
    } catch {
      // ignore
    }
    try {
      browserConn?.close();
    } catch {
      // ignore
    }
    try {
      browserProc?.kill();
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
}

function touchIdle(): void {
  hookSignals();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeBrowser().catch((e) => console.error(`[pica] browser idle cleanup failed: ${String(e)}`));
  }, 30000);
  if (typeof (idleTimer as unknown as { unref?: () => void }).unref === "function") {
    (idleTimer as unknown as { unref: () => void }).unref();
  }
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  try {
    browserConn?.close();
  } catch {
    // ignore
  }
  browserConn = null;
  pageSessionId = null;
  pageTargetId = null;
  if (browserProc) {
    try {
      browserProc.kill();
    } catch {
      // ignore
    }
    browserProc = null;
  }
}

async function readBrowserEndpoint(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stderr = proc.stderr;
  if (!stderr || typeof stderr === "number") {
    throw new Error("Failed to read Chromium stderr for DevTools endpoint.");
  }
  const reader = (stderr as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m?.[1]) {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        return m[1];
      }
      if (done) break;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  throw new Error("Timed out waiting for Chromium DevTools endpoint. Is chromium installed and runnable with --no-sandbox?");
}

async function startBrowser(): Promise<void> {
  if (browserConn && pageSessionId) {
    touchIdle();
    return;
  }
  if (starting) {
    await starting;
    return;
  }
  starting = (async () => {
    const bin = findChromeBinary();
    if (!bin) throw new Error(chromeMissingMessage());
    const userDir = await mkdtemp(join(tmpdir(), "pica-chrome-"));
    const args = [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDir}`,
      "about:blank",
    ];
    browserProc = Bun.spawn([bin, ...args], {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    const endpoint = await readBrowserEndpoint(browserProc);
    browserConn = await CdpConn.connect(endpoint);
    const created = (await browserConn.send("Target.createTarget", { url: "about:blank" })) as {
      targetId?: string;
    };
    if (!created?.targetId) throw new Error("Chromium Target.createTarget did not return a targetId.");
    pageTargetId = created.targetId;
    const attached = (await browserConn.send("Target.attachToTarget", {
      targetId: pageTargetId,
      flatten: true,
    })) as { sessionId?: string };
    if (!attached?.sessionId) throw new Error("Chromium Target.attachToTarget did not return a sessionId.");
    pageSessionId = attached.sessionId;
    await browserConn.send("Page.enable", {}, pageSessionId);
    await browserConn.send("Runtime.enable", {}, pageSessionId);
    touchIdle();
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

export async function ensureBrowser(): Promise<void> {
  await startBrowser();
  touchIdle();
}

function htmlWrapper(svgText: string, w: number, h: number): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:#fff}svg{display:block;width:${w}px;height:${h}px}` +
    `</style></head><body>${svgText}</body></html>`
  );
}

async function navigateToHtml(html: string): Promise<void> {
  if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
  const conn = browserConn;
  const session = pageSessionId;
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for page load.")), 15000);
    const handler = () => {
      clearTimeout(timer);
      resolve();
    };
    conn.on("Page.loadEventFired", handler as (p: unknown) => void);
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await conn.send("Page.navigate", { url }, session);
  await loaded;
}

async function runtimeEval<T>(expression: string, awaitPromise = false): Promise<T> {
  if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
  const res = (await browserConn.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true },
    pageSessionId,
  )) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (res?.exceptionDetails) {
    throw new Error(`Page evaluation failed: ${res.exceptionDetails.text ?? "unknown"}`);
  }
  return res?.result?.value as T;
}

function scaledSize(width: number, height: number, scale: number): { w: number; h: number } {
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { w, h };
}

export async function getExactBboxes(
  svgText: string,
  width: number,
  height: number,
): Promise<Array<{ id: string; bbox: Bbox }>> {
  await ensureBrowser();
  if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
  const { w, h } = scaledSize(width, height, 1);
  await browserConn.send(
    "Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    pageSessionId,
  );
  await navigateToHtml(htmlWrapper(svgText, w, h));
  const out = await runtimeEval<Array<{ id: string; bbox: Bbox }>>(
    `(() => {
      const els = Array.from(document.querySelectorAll('[id]'));
      return els.map((el) => {
        try {
          if (typeof el.getBBox === 'function') {
            const b = el.getBBox();
            return { id: el.id, bbox: { x: b.x, y: b.y, w: b.width, h: b.height } };
          }
        } catch (e) {}
        return { id: el.id, bbox: { x: 0, y: 0, w: 0, h: 0 } };
      });
    })()`,
  );
  touchIdle();
  return Array.isArray(out) ? out : [];
}

export async function screenshotAtTime(
  svgText: string,
  width: number,
  height: number,
  timeMs: number,
  scale: number,
): Promise<Buffer> {
  await ensureBrowser();
  if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
  const { w, h } = scaledSize(width, height, scale);
  await browserConn.send(
    "Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    pageSessionId,
  );
  await navigateToHtml(htmlWrapper(svgText, w, h));
  await runtimeEval(
    `(async () => {
      document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${Math.max(0, timeMs)}; } catch (e) {} });
      await new Promise((r) => requestAnimationFrame(() => r(1)));
      document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${Math.max(0, timeMs)}; } catch (e) {} });
      return 'ok';
    })()`,
    true,
  );
  const res = (await browserConn.send("Page.captureScreenshot", { format: "png", fromSurface: true }, pageSessionId)) as {
    data?: string;
  };
  touchIdle();
  if (!res?.data) throw new Error("Chromium Page.captureScreenshot returned no data.");
  return Buffer.from(res.data, "base64");
}

export async function captureFrames(
  svgText: string,
  width: number,
  height: number,
  durationMs: number,
  fps: number,
  scale: number,
  onFrame: (png: Buffer) => Promise<void> | void,
): Promise<void> {
  await ensureBrowser();
  if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
  const { w, h } = scaledSize(width, height, scale);
  await browserConn.send(
    "Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    pageSessionId,
  );
  await navigateToHtml(htmlWrapper(svgText, w, h));
  const step = 1000 / Math.max(1, fps);
  const times: number[] = [];
  for (let t = 0; t < durationMs; t += step) times.push(Math.round(t));
  if (times.length === 0) times.push(0);
  for (const t of times) {
    await runtimeEval(
      `(async () => {
        document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${t}; } catch (e) {} });
        await new Promise((r) => requestAnimationFrame(() => r(1)));
        return 'ok';
      })()`,
      true,
    );
    const res = (await browserConn.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true },
      pageSessionId as string,
    )) as { data?: string };
    if (!res?.data) throw new Error("Chromium Page.captureScreenshot returned no data.");
    await onFrame(Buffer.from(res.data, "base64"));
    touchIdle();
  }
  touchIdle();
}
