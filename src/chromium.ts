import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
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
  timer: ReturnType<typeof setTimeout>;
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
        clearTimeout(p.timer);
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
          for (const fn of [...arr]) {
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
        clearTimeout(p.timer);
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

  off(method: string, fn: (params: unknown) => void): void {
    const arr = this.listeners.get(method);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.listeners.delete(method);
  }

  once(method: string, fn: (params: unknown) => void): void {
    const wrap = (p: unknown) => {
      this.off(method, wrap);
      fn(p);
    };
    this.on(method, wrap);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload["sessionId"] = sessionId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout waiting for ${method}.`));
        }
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
        }
        reject(e instanceof Error ? e : new Error(String(e)));
      }
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
let browserUserDir: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let starting: Promise<void> | null = null;
let sigHooked = false;

// Serialize all CDP page work so concurrent tool calls (e.g.
// Promise.all([inspect(t=100), inspect(t=400)])) never race on the
// shared pageSessionId.
let cdpQueue: Promise<void> = Promise.resolve();

function withCdpLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = cdpQueue.then(fn, fn);
  // Keep the chain alive even if this unit rejects.
  cdpQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function removeUserDirSync(dir: string | null): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

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
    removeUserDirSync(browserUserDir);
    browserUserDir = null;
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
  if (browserUserDir) {
    const dir = browserUserDir;
    browserUserDir = null;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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
      const timeoutMs = Math.max(0, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutP = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeoutP]);
        if (timer) clearTimeout(timer);
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
      } catch {
        if (timer) clearTimeout(timer);
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  throw new Error("Timed out waiting for Chromium DevTools endpoint. Is chromium installed and runnable? If the sandbox is restricted, set PICA_CHROME_NO_SANDBOX=1.");
}

const SAFE_DATA_PREFIXES = [
  "data:image/png",
  "data:image/jpeg",
  "data:image/webp",
  "data:image/gif",
  "data:font/",
  "data:application/font-woff",
  "data:application/font-woff2",
];

export function isAllowedRequestUrl(url: string): boolean {
  if (url === "about:blank") return true;
  const lower = url.toLowerCase().replace(/[\x00-\x20\x7F]+/g, "");
  if (lower.startsWith("data:")) {
    return SAFE_DATA_PREFIXES.some((p) => lower.startsWith(p));
  }
  return false;
}

async function enableFetchBlocking(): Promise<void> {
  if (!browserConn || !pageSessionId) return;
  const conn = browserConn;
  const session = pageSessionId;
  try {
    await conn.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
  } catch {
    return;
  }
  conn.on("Fetch.requestPaused", (params: unknown) => {
    void (async () => {
      try {
        const p = params as { requestId?: string; request?: { url?: string } };
        const requestId = p.requestId;
        const url = p.request?.url ?? "";
        if (!requestId) return;
        if (isAllowedRequestUrl(url)) {
          await conn.send("Fetch.continueRequest", { requestId }, session).catch(() => undefined);
        } else {
          await conn
            .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, session)
            .catch(() => undefined);
        }
      } catch {
        // ignore
      }
    })();
  });
}

async function startBrowser(): Promise<void> {
  if (browserConn && !browserConn.closed && pageSessionId) {
    touchIdle();
    return;
  }
  // Stale connection (crashed socket): clean up before relaunch.
  if (browserConn?.closed) {
    await closeBrowser().catch(() => undefined);
  }
  if (starting) {
    await starting;
    return;
  }
  starting = (async () => {
    const bin = findChromeBinary();
    if (!bin) throw new Error(chromeMissingMessage());
    const userDir = await mkdtemp(join(tmpdir(), "pica-chrome-"));
    browserUserDir = userDir;
    const baseArgs = [
      "--headless",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDir}`,
      "about:blank",
    ];
    const envNoSandbox = process.env["PICA_CHROME_NO_SANDBOX"] === "1";
    const withSandboxArgs = baseArgs;
    const noSandboxArgs = ["--headless", "--no-sandbox", ...baseArgs.slice(1)];
    const attempts = envNoSandbox ? [noSandboxArgs] : [withSandboxArgs, noSandboxArgs];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const args = attempts[attempt] as string[];
      browserProc = Bun.spawn([bin, ...args], {
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
      });
      try {
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
        await enableFetchBlocking();
        touchIdle();
        return;
      } catch (e) {
        lastError = e;
        // Clean up this attempt before retrying.
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
        if (attempt === 0 && !envNoSandbox) {
          console.error(`[pica] Chromium launch failed, retrying with --no-sandbox: ${String(e)}`);
          continue;
        }
        await closeBrowser().catch(() => undefined);
        throw e;
      }
    }
    await closeBrowser().catch(() => undefined);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    `html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}` +
    `</style></head><body>${svgText}</body></html>`
  );
}

async function applyViewport(w: number, h: number, session: string): Promise<void> {
  if (!browserConn) throw new Error("Browser not started.");
  await browserConn.send(
    "Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    session,
  );
  // Transparent default so SVGs without an opaque background keep alpha.
  try {
    await browserConn.send(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
      session,
    );
  } catch {
    // Older builds may not support this; capture proceeds with default.
  }
}

async function setDocumentHtml(html: string): Promise<void> {
  if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
  const conn = browserConn;
  const session = pageSessionId;
  const tree = (await conn.send("Page.getFrameTree", {}, session)) as {
    frameTree?: { frame?: { id?: string } };
  };
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) throw new Error("Chromium Page.getFrameTree did not return a frame id.");
  await conn.send("Page.setDocumentContent", { frameId, html }, session);
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
  return withCdpLock(async () => {
    await ensureBrowser();
    if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
    const { w, h } = scaledSize(width, height, 1);
    await applyViewport(w, h, pageSessionId);
    await setDocumentHtml(htmlWrapper(svgText, w, h));
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
  });
}

export async function getRenderedBboxesAtTime(
  svgText: string,
  width: number,
  height: number,
  timeMs: number,
): Promise<Array<{ id: string; bbox: Bbox }>> {
  return withCdpLock(async () => {
    await ensureBrowser();
    if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
    const { w, h } = scaledSize(width, height, 1);
    await applyViewport(w, h, pageSessionId);
    await setDocumentHtml(htmlWrapper(svgText, w, h));
    await runtimeEval(
      `(async () => {
        document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${Math.max(0, timeMs)}; } catch (e) {} });
        await new Promise((r) => requestAnimationFrame(() => r(1)));
        document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${Math.max(0, timeMs)}; } catch (e) {} });
        return 'ok';
      })()`,
      true,
    );
    const out = await runtimeEval<Array<{ id: string; bbox: Bbox }>>(
      `(() => {
        const svg = document.querySelector('svg');
        if (!svg) return [];
        const svgRect = svg.getBoundingClientRect();
        const root = document.querySelector('#pica-root');
        if (!root) return [];
        const els = Array.from(root.querySelectorAll('[id]'));
        return els.map((el) => {
          try {
            const r = el.getBoundingClientRect();
            return { id: el.id, bbox: { x: r.left - svgRect.left, y: r.top - svgRect.top, w: r.width, h: r.height } };
          } catch (e) {
            return { id: el.id, bbox: { x: 0, y: 0, w: 0, h: 0 } };
          }
        });
      })()`,
    );
    touchIdle();
    return Array.isArray(out) ? out : [];
  });
}

export async function screenshotAtTime(
  svgText: string,
  width: number,
  height: number,
  timeMs: number,
  scale: number,
): Promise<Buffer> {
  return withCdpLock(async () => {
    await ensureBrowser();
    if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
    const { w, h } = scaledSize(width, height, scale);
    await applyViewport(w, h, pageSessionId);
    await setDocumentHtml(htmlWrapper(svgText, w, h));
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
  });
}

export async function screenshotInspectSinglePass(
  svgText: string,
  width: number,
  height: number,
  timeMs: number,
  scale: number,
  showGrid: boolean,
  showIds: boolean,
): Promise<Buffer> {
  return withCdpLock(async () => {
    await ensureBrowser();
    if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
    const { w, h } = scaledSize(width, height, scale);
    await applyViewport(w, h, pageSessionId);
    await setDocumentHtml(htmlWrapper(svgText, w, h));
    const t = Math.max(0, timeMs);
    await runtimeEval(
      `(async () => {
        document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${t}; } catch (e) {} });
        await new Promise((r) => requestAnimationFrame(() => r(1)));
        document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = ${t}; } catch (e) {} });
        return 'ok';
      })()`,
      true,
    );
    await runtimeEval(
      `(() => {
        const svg = document.querySelector('svg');
        if (!svg) return 'no-svg';
        const W = ${width};
        const H = ${height};
        const showGrid = ${showGrid ? "true" : "false"};
        const showIds = ${showIds ? "true" : "false"};
        const NS = 'http://www.w3.org/2000/svg';
        let overlay = document.getElementById('pica-debug-overlay');
        if (overlay) overlay.remove();
        overlay = document.createElementNS(NS, 'g');
        overlay.setAttribute('id', 'pica-debug-overlay');
        overlay.setAttribute('pointer-events', 'none');
        if (showGrid) {
          for (let x = 100; x < W; x += 100) {
            const ln = document.createElementNS(NS, 'line');
            ln.setAttribute('x1', String(x));
            ln.setAttribute('y1', '0');
            ln.setAttribute('x2', String(x));
            ln.setAttribute('y2', String(H));
            ln.setAttribute('stroke', '#d4d4d8');
            ln.setAttribute('stroke-width', '1');
            ln.setAttribute('opacity', '0.7');
            overlay.appendChild(ln);
          }
          for (let y = 100; y < H; y += 100) {
            const ln = document.createElementNS(NS, 'line');
            ln.setAttribute('x1', '0');
            ln.setAttribute('y1', String(y));
            ln.setAttribute('x2', String(W));
            ln.setAttribute('y2', String(y));
            ln.setAttribute('stroke', '#d4d4d8');
            ln.setAttribute('stroke-width', '1');
            ln.setAttribute('opacity', '0.7');
            overlay.appendChild(ln);
          }
          const frame = document.createElementNS(NS, 'rect');
          frame.setAttribute('x', '0.5');
          frame.setAttribute('y', '0.5');
          frame.setAttribute('width', String(W - 1));
          frame.setAttribute('height', String(H - 1));
          frame.setAttribute('fill', 'none');
          frame.setAttribute('stroke', '#a1a1aa');
          frame.setAttribute('stroke-width', '1');
          overlay.appendChild(frame);
        }
        if (showIds) {
          const svgRect = svg.getBoundingClientRect();
          const root = document.querySelector('#pica-root');
          const els = root ? Array.from(root.querySelectorAll('[id]')) : [];
          for (const el of els) {
            try {
              const r = el.getBoundingClientRect();
              const bx = r.left - svgRect.left;
              const by = r.top - svgRect.top;
              const bw = r.width;
              const bh = r.height;
              if (!(bw > 0 && bh > 0)) continue;
              const id = el.id || '';
              // Scale page px back to SVG units.
              const sx = svgRect.width > 0 ? W / svgRect.width : 1;
              const sy = svgRect.height > 0 ? H / svgRect.height : 1;
              const ux = bx * sx;
              const uy = by * sy;
              const uw = bw * sx;
              const uh = bh * sy;
              const box = document.createElementNS(NS, 'rect');
              box.setAttribute('x', String(ux));
              box.setAttribute('y', String(uy));
              box.setAttribute('width', String(uw));
              box.setAttribute('height', String(uh));
              box.setAttribute('fill', 'none');
              box.setAttribute('stroke', '#2563eb');
              box.setAttribute('stroke-width', '1.5');
              overlay.appendChild(box);
              const label = document.createElementNS(NS, 'text');
              label.setAttribute('x', String(ux + 2));
              label.setAttribute('y', String(Math.max(10, uy - 4)));
              label.setAttribute('font-size', '11');
              label.setAttribute('font-family', 'monospace');
              label.setAttribute('fill', '#1d4ed8');
              label.textContent = '#' + id;
              overlay.appendChild(label);
            } catch (e) {}
          }
        }
        svg.appendChild(overlay);
        return 'ok';
      })()`,
    );
    const res = (await browserConn.send("Page.captureScreenshot", { format: "png", fromSurface: true }, pageSessionId)) as {
      data?: string;
    };
    touchIdle();
    if (!res?.data) throw new Error("Chromium Page.captureScreenshot returned no data.");
    return Buffer.from(res.data, "base64");
  });
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
  return withCdpLock(async () => {
    await ensureBrowser();
    if (!browserConn || !pageSessionId) throw new Error("Browser not started.");
    const { w, h } = scaledSize(width, height, scale);
    await applyViewport(w, h, pageSessionId);
    await setDocumentHtml(htmlWrapper(svgText, w, h));
    const safeFps = Math.max(1, fps);
    const totalFrames = Math.max(1, Math.round((durationMs / 1000) * safeFps));
    for (let i = 0; i < totalFrames; i++) {
      const t = (i * 1000) / safeFps;
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
  });
}
