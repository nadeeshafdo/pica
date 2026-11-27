import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFrames, closeBrowser, findChromeBinary, getRenderedBboxesAtTime, screenshotAtTime } from "../src/chromium.js";
import { extractKeyframesBody, resolveSafePath } from "../src/pica-file.js";
import { normalizeFontAliases, renderPixels, renderPngBuffer } from "../src/render.js";
import { handleAnimate, handleCreate, handleExport, handleInspect, handlePatch, handleRead } from "../src/tools.js";
import { isAllowedOrigin, setCurrentSvg, startPreviewServer } from "../src/preview.js";

function ffmpegAvailable(): boolean {
  const w = (Bun as unknown as { which?: (b: string) => string | null }).which;
  if (typeof w === "function") {
    try {
      return !!w("ffmpeg");
    } catch {
      return false;
    }
  }
  return true;
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return (first as { text: string }).text;
}

describe("pica end-to-end", () => {
  test("create -> patch -> animate -> read -> inspect -> exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-test-"));
    try {
      const path = join(dir, "canvas.pica.svg");

      // create
      const created = await handleCreate({
        path,
        width: 800,
        height: 600,
        background: "#ffffff",
        fps: 30,
        durationMs: 2000,
      });
      expect(created.isError).toBeFalsy();
      const createdJson = JSON.parse(textOf(created as never)) as { ok: boolean; path: string };
      expect(createdJson.ok).toBe(true);
      const raw0 = await Bun.file(path).text();
      expect(raw0).toContain('id="pica-meta"');
      expect(raw0).toContain('id="pica-defs"');
      expect(raw0).toContain('id="pica-anim"');
      expect(raw0).toContain('id="pica-bg"');
      expect(raw0).toContain('id="pica-root"');

      // patch: add shapes
      const patched = await handlePatch({
        path,
        ops: [
          { op: "add", id: "r1", tag: "rect", attrs: { x: 10, y: 20, width: 100, height: 50, fill: "red" } },
          { op: "add", id: "c1", tag: "circle", attrs: { cx: 200, cy: 150, r: 40, fill: "blue" } },
          { op: "add", id: "t1", tag: "text", attrs: { x: 10, y: 300, "font-size": 20 }, textContent: "hello" },
        ],
      });
      expect(patched.isError).toBeFalsy();

      // patch: update + setDefs
      const patched2 = await handlePatch({
        path,
        ops: [
          { op: "update", id: "r1", attrs: { fill: "green" } },
          { op: "setDefs", defsSvg: `<linearGradient id="g1"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>` },
        ],
      });
      expect(patched2.isError).toBeFalsy();

      // patch: reorder + remove error case
      const reordered = await handlePatch({
        path,
        ops: [{ op: "reorder", id: "c1", newIndex: 0 }],
      });
      expect(reordered.isError).toBeFalsy();

      const missing = await handlePatch({
        path,
        ops: [{ op: "update", id: "nope-missing", attrs: { fill: "red" } }],
      });
      expect(missing.isError).toBe(true);
      expect(textOf(missing as never)).toMatch(/not found/i);

      // patch: reject script
      const evil = await handlePatch({
        path,
        ops: [{ op: "add", id: "evil", tag: "script", attrs: {} }],
      });
      expect(evil.isError).toBe(true);

      // animate
      const animated = await handleAnimate({
        path,
        name: "fadeUp",
        keyframes: "0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:translateY(0)}",
        animations: [{ id: "r1", durationMs: 1200, easing: "ease-out" }],
        remove: false,
      });
      expect(animated.isError).toBeFalsy();

      // read fast
      const read = await handleRead({ path, includeRaw: false, bboxMode: "fast", tree: true });
      expect(read.isError).toBeFalsy();
      const readJson = JSON.parse(textOf(read as never)) as {
        width: number;
        height: number;
        nodes: Array<{ id: string; tag: string; bbox: { x: number; y: number; w: number; h: number } }>;
        animations: Array<{ name: string }>;
      };
      expect(readJson.width).toBe(800);
      expect(readJson.height).toBe(600);
      const r1 = readJson.nodes.find((n) => n.id === "r1");
      expect(r1).toBeDefined();
      expect(r1?.bbox).toEqual({ x: 10, y: 20, w: 100, h: 50 });
      const c1 = readJson.nodes.find((n) => n.id === "c1");
      expect(c1?.bbox).toEqual({ x: 160, y: 110, w: 80, h: 80 });
      expect(readJson.animations.some((a) => a.name === "fadeUp")).toBe(true);

      // read exact (chromium) - graceful if missing
      if (findChromeBinary()) {
        const exact = await handleRead({ path, includeRaw: false, bboxMode: "exact", tree: false });
        expect(exact.isError).toBeFalsy();
        const ej = JSON.parse(textOf(exact as never)) as { nodes: Array<{ id: string }> };
        expect(ej.nodes.length).toBeGreaterThan(0);
      } else {
        console.error("skip exact bbox: chromium missing");
      }

      // inspect static with overlays
      const inspected = await handleInspect({ path, timeMs: 0, showGrid: true, showIds: true, scale: 1 });
      expect(inspected.isError).toBeFalsy();
      const imgBlock = inspected.content[0] as { type: string; data: string; mimeType: string };
      expect(imgBlock.type).toBe("image");
      expect(imgBlock.mimeType).toBe("image/png");
      expect(imgBlock.data.length).toBeGreaterThan(1000);

      // static exports
      const svgOut = join(dir, "out.svg");
      const pngOut = join(dir, "out.png");
      const jpgOut = join(dir, "out.jpg");
      const e1 = await handleExport({ path, format: "svg", outPath: svgOut, scale: 1, quality: 90, animated: false });
      expect(e1.isError).toBeFalsy();
      expect(await Bun.file(svgOut).exists()).toBe(true);
      expect((await Bun.file(svgOut).text()).includes("pica-debug-overlay")).toBe(false);

      const e2 = await handleExport({ path, format: "png", outPath: pngOut, scale: 2, quality: 90, animated: false });
      expect(e2.isError).toBeFalsy();
      expect((await Bun.file(pngOut).arrayBuffer()).byteLength).toBeGreaterThan(1000);

      if (ffmpegAvailable()) {
        const e3 = await handleExport({ path, format: "jpg", outPath: jpgOut, scale: 1, quality: 85, animated: false });
        expect(e3.isError).toBeFalsy();
        expect((await Bun.file(jpgOut).arrayBuffer()).byteLength).toBeGreaterThan(500);
      } else {
        console.error("skip jpg: ffmpeg missing");
      }

      // animated mp4 (skip gracefully if deps missing)
      if (findChromeBinary() && ffmpegAvailable()) {
        const mp4Out = join(dir, "out.mp4");
        const e4 = await handleExport({
          path,
          format: "mp4",
          outPath: mp4Out,
          scale: 1,
          quality: 90,
          fps: 10,
          animated: false,
        });
        expect(e4.isError).toBeFalsy();
        expect((await Bun.file(mp4Out).arrayBuffer()).byteLength).toBeGreaterThan(1000);
      } else {
        console.error("skip animated mp4: chromium or ffmpeg missing");
      }

      // animate remove
      const removed = await handleAnimate({ path, name: "fadeUp", remove: true });
      expect(removed.isError).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe("fast geometry", () => {
  test("path commands, group union, text-anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-geo-"));
    try {
      const path = join(dir, "geo.pica.svg");
      expect((await handleCreate({ path, width: 800, height: 600 })).isError).toBeFalsy();

      const addRes = await handlePatch({
        path,
        ops: [
          { op: "add", id: "p1", tag: "path", attrs: { d: "M10 10 H50 V40 L60 60 Z" } },
          { op: "add", id: "p2", tag: "path", attrs: { d: "m10 10 l20 0 l0 20 z" } },
          { op: "add", id: "p3", tag: "path", attrs: { d: "M0 0 C10 0 10 20 20 20 S30 30 40 20 Q45 25 50 20 T60 20" } },
          { op: "add", id: "p4", tag: "path", attrs: { d: "M0 0 A10 10 0 0 1 20 0" } },
          { op: "add", id: "grp", tag: "g", attrs: {} },
          { op: "add", id: "ga", tag: "rect", attrs: { x: 5, y: 5, width: 10, height: 10 }, parentId: "grp" },
          { op: "add", id: "gb", tag: "rect", attrs: { x: 100, y: 200, width: 30, height: 40 }, parentId: "grp" },
          { op: "add", id: "tc", tag: "text", attrs: { x: 100, y: 100, "font-size": 20, "text-anchor": "middle" }, textContent: "hi" },
          { op: "add", id: "te", tag: "text", attrs: { x: 100, y: 100, "font-size": 20, "text-anchor": "end" }, textContent: "hi" },
        ],
      });
      expect(addRes.isError).toBeFalsy();

      const read = await handleRead({ path, bboxMode: "fast" });
      expect(read.isError).toBeFalsy();
      const j = JSON.parse(textOf(read as never)) as {
        nodes: Array<{ id: string; tag: string; bbox: { x: number; y: number; w: number; h: number } }>;
      };
      const byId = new Map(j.nodes.map((n) => [n.id, n]));
      // M/H/V/L path
      expect(byId.get("p1")?.bbox).toEqual({ x: 10, y: 10, w: 50, h: 50 });
      // relative moveto/lineto
      expect(byId.get("p2")?.bbox).toEqual({ x: 10, y: 10, w: 20, h: 20 });
      // cubic/smooth quad chain incl. control points: min 0,0 max 60,30
      expect(byId.get("p3")?.bbox).toEqual({ x: 0, y: 0, w: 60, h: 30 });
      // arc endpoints
      expect(byId.get("p4")?.bbox).toEqual({ x: 0, y: 0, w: 20, h: 0 });
      // group union of children
      expect(byId.get("grp")?.bbox).toEqual({ x: 5, y: 5, w: 125, h: 235 });
      // centered text: w = 0.6*20*2 = 24
      expect(byId.get("tc")?.bbox).toEqual({ x: 88, y: 80, w: 24, h: 24 });
      expect(byId.get("te")?.bbox).toEqual({ x: 76, y: 80, w: 24, h: 24 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("patch safety", () => {
  test("attr null removal, id validation, reorder cycle, defs sanitize", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-safe-"));
    try {
      const path = join(dir, "safe.pica.svg");
      expect((await handleCreate({ path, width: 400, height: 300 })).isError).toBeFalsy();
      expect(
        (
          await handlePatch({
            path,
            ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 1, y: 2, width: 10, height: 10, fill: "red", stroke: "blue" } }],
          })
        ).isError,
      ).toBeFalsy();

      // null removes the attribute
      expect(
        (await handlePatch({ path, ops: [{ op: "update", id: "r1", attrs: { fill: null } }] })).isError,
      ).toBeFalsy();
      const read = await handleRead({ path, bboxMode: "fast" });
      const j = JSON.parse(textOf(read as never)) as { nodes: Array<{ id: string; attrs: Record<string, string> }> };
      const r1 = j.nodes.find((n) => n.id === "r1");
      expect(r1).toBeDefined();
      expect("fill" in (r1?.attrs ?? {})).toBe(false);
      expect(r1?.attrs["stroke"]).toBe("blue");

      // invalid id rejected
      const badId = await handlePatch({ path, ops: [{ op: "add", id: "1bad", tag: "rect", attrs: {} }] });
      expect(badId.isError).toBe(true);
      expect(textOf(badId as never)).toMatch(/invalid id/i);

      // reorder cycle: g1 -> child c1, moving g1 under c1 must fail
      expect(
        (
          await handlePatch({
            path,
            ops: [
              { op: "add", id: "g1", tag: "g", attrs: {} },
              { op: "add", id: "c1", tag: "rect", attrs: { x: 0, y: 0, width: 5, height: 5 }, parentId: "g1" },
            ],
          })
        ).isError,
      ).toBeFalsy();
      const cycle = await handlePatch({ path, ops: [{ op: "reorder", id: "g1", parentId: "c1" }] });
      expect(cycle.isError).toBe(true);
      expect(textOf(cycle as never)).toMatch(/descendant|itself/i);

      // defs: event handlers and javascript: URLs rejected
      const evilDefs = await handlePatch({ path, ops: [{ op: "setDefs", defsSvg: `<rect onload="evil()" />` }] });
      expect(evilDefs.isError).toBe(true);
      const jsDefs = await handlePatch({ path, ops: [{ op: "setDefs", defsSvg: `<a href="javascript:alert(1)" />` }] });
      expect(jsDefs.isError).toBe(true);
      const scriptDefs = await handlePatch({ path, ops: [{ op: "setDefs", defsSvg: `<svg:script>alert(1)</svg:script>` }] });
      expect(scriptDefs.isError).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("animation exactness", () => {
  test("substring-safe removal and transform-box", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-anim-"));
    try {
      const path = join(dir, "a.pica.svg");
      expect((await handleCreate({ path, width: 400, height: 300 })).isError).toBeFalsy();
      expect(
        (
          await handlePatch({
            path,
            ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 0, y: 0, width: 10, height: 10 } }],
          })
        ).isError,
      ).toBeFalsy();

      expect(
        (
          await handleAnimate({
            path,
            name: "fadeUp",
            keyframes: "0%{opacity:0}100%{opacity:1}",
            animations: [{ id: "r1" }],
          })
        ).isError,
      ).toBeFalsy();
      expect(
        (
          await handleAnimate({
            path,
            name: "fade",
            keyframes: "0%{opacity:0}100%{opacity:0.5}",
          })
        ).isError,
      ).toBeFalsy();

      // removing "fade" must not delete "fadeUp" rules/targets
      expect((await handleAnimate({ path, name: "fade", remove: true })).isError).toBeFalsy();
      const raw = await Bun.file(path).text();
      expect(/@keyframes\s+fadeUp/.test(raw)).toBe(true);
      expect(/@keyframes\s+fade(?![A-Za-z0-9_-])/.test(raw)).toBe(false);
      expect(raw).toMatch(/transform-box:\s*fill-box/);
      expect(raw).toMatch(/transform-origin:\s*center/);

      const read = await handleRead({ path, bboxMode: "fast" });
      const j = JSON.parse(textOf(read as never)) as { animations: Array<{ name: string; targets: string[] }> };
      const names = j.animations.map((a) => a.name);
      expect(names).toContain("fadeUp");
      expect(names).not.toContain("fade");
      expect(j.animations.find((a) => a.name === "fadeUp")?.targets).toContain("r1");

      // custom origin is emitted verbatim
      expect(
        (
          await handleAnimate({
            path,
            name: "spin",
            keyframes: "0%{transform:rotate(0)}100%{transform:rotate(360deg)}",
            animations: [{ id: "r1", transformOrigin: "left top" }],
          })
        ).isError,
      ).toBeFalsy();
      const raw2 = await Bun.file(path).text();
      expect(raw2).toMatch(/transform-origin:\s*left top/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("inspect maxWidth caps preview scale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-wide-"));
    try {
      const path = join(dir, "wide.pica.svg");
      expect((await handleCreate({ path, width: 2000, height: 500 })).isError).toBeFalsy();
      const res = await handleInspect({ path, timeMs: 0, scale: 1 });
      expect(res.isError).toBeFalsy();
      const summary = (res.content.find((c) => c.type === "text") as { text: string } | undefined)?.text ?? "";
      const m = summary.match(/scale ([0-9.]+)/);
      expect(m?.[1]).toBeDefined();
      expect(Number.parseFloat(m?.[1] as string)).toBeLessThan(1);
      expect(Number.parseFloat(m?.[1] as string)).toBeCloseTo(1024 / 2000, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("chromium", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("extractKeyframesBody with fadeUp before fade", () => {
    const css =
      "@keyframes fadeUp { 0%{opacity:0}100%{opacity:1} } " +
      "#r1 { animation: fadeUp 1s ease 0ms 1 normal both; } " +
      "@keyframes fade { 0%{opacity:0}100%{opacity:0.5} }";
    expect(extractKeyframesBody(css, "fade")).toBe("0%{opacity:0}100%{opacity:0.5}");
    expect(extractKeyframesBody(css, "fadeUp")).toBe("0%{opacity:0}100%{opacity:1}");
    expect(extractKeyframesBody(css, "missing")).toBe("");
  });

  test("renderPngBuffer draws text with Inter/system-ui stack", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">` +
      `<rect width="200" height="100" fill="#111113"/>` +
      `<text x="100" y="65" font-size="40" text-anchor="middle" fill="#f5f5f0" font-family="Inter, system-ui, sans-serif">pica</text>` +
      `</svg>`;
    const { pixels, width, height } = renderPixels(svg, 1);
    expect(width).toBe(200);
    expect(height).toBe(100);
    void renderPngBuffer(svg, 1);
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i] as number;
      if (r > 150) bright++;
    }
    // "pica" at 40px must produce hundreds of near-white pixels, not a flat bg.
    expect(bright).toBeGreaterThan(200);
  }, 30000);

  test("exact bbox, timed inspect, animated mp4/webp", async () => {
    if (!findChromeBinary()) {
      console.error("skip chromium tests: chromium missing");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pica-chrome-"));
    try {
      const path = join(dir, "chrome.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 150, fps: 5, durationMs: 500 })).isError).toBeFalsy();
      expect(
        (
          await handlePatch({
            path,
            ops: [
              { op: "add", id: "r1", tag: "rect", attrs: { x: 10, y: 20, width: 100, height: 50, fill: "red" } },
            ],
          })
        ).isError,
      ).toBeFalsy();
      expect(
        (
          await handleAnimate({
            path,
            name: "slide",
            keyframes: "0%{transform:translateX(0)}100%{transform:translateX(40px)}",
            animations: [{ id: "r1", durationMs: 500 }],
          })
        ).isError,
      ).toBeFalsy();

      // exact bbox matches geometry for a plain rect
      const exact = await handleRead({ path, bboxMode: "exact" });
      expect(exact.isError).toBeFalsy();
      const ej = JSON.parse(textOf(exact as never)) as {
        nodes: Array<{ id: string; bbox: { x: number; y: number; w: number; h: number } }>;
      };
      const r1 = ej.nodes.find((n) => n.id === "r1");
      expect(r1).toBeDefined();
      expect(r1?.bbox.x).toBeCloseTo(10, 0);
      expect(r1?.bbox.y).toBeCloseTo(20, 0);
      expect(r1?.bbox.w).toBeCloseTo(100, 0);
      expect(r1?.bbox.h).toBeCloseTo(50, 0);

      // timed capture returns a real PNG frame
      const timed = await handleInspect({ path, timeMs: 250, scale: 1, maxWidth: 1024 });
      expect(timed.isError).toBeFalsy();
      const frame = timed.content[0] as { type: string; data: string; mimeType: string };
      expect(frame.type).toBe("image");
      expect(frame.mimeType).toBe("image/png");
      expect(frame.data.length).toBeGreaterThan(500);

      if (!ffmpegAvailable()) {
        console.error("skip animated exports: ffmpeg missing");
        return;
      }
      const mp4Out = join(dir, "anim.mp4");
      const mp4 = await handleExport({ path, format: "mp4", outPath: mp4Out, scale: 1, quality: 80, fps: 5 });
      expect(mp4.isError).toBeFalsy();
      const mp4Bytes = (await Bun.file(mp4Out).arrayBuffer()).byteLength;
      expect(mp4Bytes).toBeGreaterThan(1000);

      const webpOut = join(dir, "anim.webp");
      const webp = await handleExport({ path, format: "webp", outPath: webpOut, scale: 1, quality: 80, animated: true, fps: 5 });
      expect(webp.isError).toBeFalsy();
      const webpBytes = (await Bun.file(webpOut).arrayBuffer()).byteLength;
      expect(webpBytes).toBeGreaterThan(500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180000);

  test("normalizeFontAliases only touches font-family declarations", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">` +
      `<style>.a{font-family: Inter, system-ui, sans-serif}</style>` +
      `<text x="10" y="50" font-family="Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif">Use system-ui font</text>` +
      `</svg>`;
    const out = normalizeFontAliases(svg);
    expect(out).toContain(`font-family="Inter, sans-serif, sans-serif, sans-serif, sans-serif"`);
    expect(out).toContain(`font-family: Inter, sans-serif, sans-serif`);
    expect(out).toContain(`>Use system-ui font</text>`);
  });

  test("captureFrames produces exact integer frame counts", async () => {
    if (!findChromeBinary()) {
      console.error("skip frame-count test: chromium missing");
      return;
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" fill="#111113"/>` +
      `<circle id="c" cx="32" cy="32" r="10" fill="#ffb224"/>` +
      `</svg>`;
    let n5 = 0;
    await captureFrames(svg, 64, 64, 500, 10, 1, () => {
      n5++;
    });
    expect(n5).toBe(5);
    let n72 = 0;
    await captureFrames(svg, 64, 64, 2400, 30, 1, () => {
      n72++;
    });
    expect(n72).toBe(72);
  }, 180000);

  test("parallel timed inspects serialize through the CDP lock", async () => {
    if (!findChromeBinary()) {
      console.error("skip parallel inspect test: chromium missing");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pica-par-"));
    try {
      const path = join(dir, "par.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 150, durationMs: 1000 })).isError).toBeFalsy();
      expect(
        (
          await handlePatch({
            path,
            ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 10, y: 10, width: 40, height: 40, fill: "red" } }],
          })
        ).isError,
      ).toBeFalsy();
      expect(
        (
          await handleAnimate({
            path,
            name: "fadeUp",
            keyframes: "0%{opacity:0}100%{opacity:1}",
            animations: [{ id: "r1", durationMs: 1000 }],
          })
        ).isError,
      ).toBeFalsy();
      const [a, b] = await Promise.all([
        handleInspect({ path, timeMs: 100, maxWidth: 1024 }),
        handleInspect({ path, timeMs: 400, maxWidth: 1024 }),
      ]);
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();
      expect((a.content[0] as { type: string }).type).toBe("image");
      expect((b.content[0] as { type: string }).type).toBe("image");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180000);
});

describe("hardening", () => {
  test("setDefs rejects event-handler, encoded js, foreignObject, style import", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-hard-"));
    try {
      const path = join(dir, "h.pica.svg");
      expect((await handleCreate({ path, width: 400, height: 300 })).isError).toBeFalsy();
      const cases: Array<{ name: string; defs: string }> = [
        { name: "nospace-onload", defs: `<rect/onload=alert(1) />` },
        { name: "encoded-js", defs: `<a href="&#106;avascript:alert(1)" />` },
        { name: "foreign", defs: `<foreignObject><div>hi</div></foreignObject>` },
        { name: "style-import", defs: `<style>@import url(http://evil)</style>` },
      ];
      for (const c of cases) {
        const res = await handlePatch({ path, ops: [{ op: "setDefs", defsSvg: c.defs }] });
        expect(res.isError).toBe(true);
        expect(textOf(res as never)).toMatch(/Rejected|not allowed|dangerous/i);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("patch update rejects skeleton mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-skel-"));
    try {
      const path = join(dir, "s.pica.svg");
      expect((await handleCreate({ path, width: 400, height: 300 })).isError).toBeFalsy();
      for (const id of ["pica-meta", "pica-defs", "pica-anim", "pica-root"]) {
        const res = await handlePatch({ path, ops: [{ op: "update", id, attrs: { fill: "red" } }] });
        expect(res.isError).toBe(true);
        expect(textOf(res as never)).toMatch(/protected/i);
      }
      const bgBadAttr = await handlePatch({ path, ops: [{ op: "update", id: "pica-bg", attrs: { width: 5 } }] });
      expect(bgBadAttr.isError).toBe(true);
      const bgBadText = await handlePatch({ path, ops: [{ op: "update", id: "pica-bg", textContent: "hi" }] });
      expect(bgBadText.isError).toBe(true);
      const bgBadId = await handlePatch({ path, ops: [{ op: "update", id: "pica-bg", attrs: { id: "x" } }] });
      expect(bgBadId.isError).toBe(true);
      const bgOk = await handlePatch({ path, ops: [{ op: "update", id: "pica-bg", attrs: { fill: "#000000" } }] });
      expect(bgOk.isError).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("PICA_ROOT traversal and ffmpeg outPath guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-root-"));
    const old = process.env["PICA_ROOT"];
    try {
      const path = join(dir, "c.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 200 })).isError).toBeFalsy();
      process.env["PICA_ROOT"] = dir;
      const escape = join(dir, "..", "escape.pica.svg");
      const trav = await handleCreate({ path: escape, width: 100, height: 100 });
      expect(trav.isError).toBe(true);
      expect(textOf(trav as never)).toMatch(/escapes PICA_ROOT/i);
      expect(() => resolveSafePath(`${dir}/a\0b.svg`)).toThrow();
      // Flag/protocol checks must run with PICA_ROOT unset so the raw
      // outPath guard (not the jail) is what rejects them.
      if (old === undefined) delete process.env["PICA_ROOT"];
      else process.env["PICA_ROOT"] = old;
      const flag = await handleExport({ path, format: "png", outPath: "-evil.png", scale: 1, quality: 90, animated: false });
      expect(flag.isError).toBe(true);
      expect(textOf(flag as never)).toMatch(/ffmpeg flag/i);
      const proto = await handleExport({ path, format: "png", outPath: "http://evil/x.png", scale: 1, quality: 90, animated: false });
      expect(proto.isError).toBe(true);
      expect(textOf(proto as never)).toMatch(/protocol/i);
    } finally {
      if (old === undefined) delete process.env["PICA_ROOT"];
      else process.env["PICA_ROOT"] = old;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("websocket origin check", () => {
    expect(isAllowedOrigin(null, 4173)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4173", 4173)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4173", 4173)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", 4173)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:9999", 4173)).toBe(false);
  });

  test("preview rejects cross-origin ws and accepts same-origin", async () => {
    const oldPort = process.env["PICA_PORT"];
    process.env["PICA_PORT"] = "0";
    const srv = startPreviewServer();
    try {
      if (!srv) {
        console.error("skip ws origin test: preview failed to start");
        return;
      }
      const port = srv.port;
      const evil = await fetch(`http://127.0.0.1:${port}/ws`, { headers: { Origin: "https://evil.example" } });
      expect(evil.status).toBe(403);
      await evil.text().catch(() => undefined);
      const okRes = await fetch(`http://127.0.0.1:${port}/ws`);
      expect([403, 426]).toContain(okRes.status);
      expect(okRes.status).not.toBe(403);
      await okRes.text().catch(() => undefined);
    } finally {
      try {
        (srv as { stop?: () => void })?.stop?.();
      } catch {
        // ignore
      }
      if (oldPort === undefined) delete process.env["PICA_PORT"];
      else process.env["PICA_PORT"] = oldPort;
    }
  }, 60000);

  test("preview falls back to ephemeral port when busy", async () => {
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    const busyPort = blocker.port;
    const oldPort = process.env["PICA_PORT"];
    process.env["PICA_PORT"] = String(busyPort);
    try {
      const srv = startPreviewServer();
      expect(srv).not.toBeNull();
      expect(srv!.port).not.toBe(busyPort);
      const res = await fetch(`http://127.0.0.1:${srv!.port}/`);
      expect(res.status).toBe(200);
      await res.text().catch(() => undefined);
      try {
        (srv as { stop?: () => void })?.stop?.();
      } catch {
        // ignore
      }
    } finally {
      try {
        blocker.stop();
      } catch {
        // ignore
      }
      if (oldPort === undefined) delete process.env["PICA_PORT"];
      else process.env["PICA_PORT"] = oldPort;
    }
  }, 60000);
});

describe("animation stacking and duration", () => {
  test("stacks, updates one, removes one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-stack-"));
    try {
      const path = join(dir, "s.pica.svg");
      expect((await handleCreate({ path, width: 400, height: 300 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 0, y: 0, width: 10, height: 10 } }] })).isError,
      ).toBeFalsy();
      expect(
        (await handleAnimate({ path, name: "fadeUp", keyframes: "0%{opacity:0}100%{opacity:1}", animations: [{ id: "r1", durationMs: 1000 }] })).isError,
      ).toBeFalsy();
      expect(
        (await handleAnimate({ path, name: "float", keyframes: "0%{transform:translateY(0)}100%{transform:translateY(5px)}", animations: [{ id: "r1", durationMs: 800 }] })).isError,
      ).toBeFalsy();
      let raw = await Bun.file(path).text();
      expect(raw).toMatch(/fadeUp/);
      expect(raw).toMatch(/float/);
      expect(raw).toMatch(/animation:[^;]*fadeUp[^;]*,\s*[^;]*float|animation:[^;]*float[^;]*,\s*[^;]*fadeUp|animation:[^;]*fadeUp[^;]*float/);
      // update fadeUp duration without clobbering float
      expect(
        (await handleAnimate({ path, name: "fadeUp", animations: [{ id: "r1", durationMs: 2000 }] })).isError,
      ).toBeFalsy();
      raw = await Bun.file(path).text();
      expect(raw).toMatch(/fadeUp 2000ms/);
      expect(raw).toMatch(/float/);
      // remove fadeUp keeps float
      expect((await handleAnimate({ path, name: "fadeUp", remove: true })).isError).toBeFalsy();
      raw = await Bun.file(path).text();
      expect(raw).not.toMatch(/@keyframes\s+fadeUp(?![A-Za-z0-9_-])/);
      expect(raw).toMatch(/float/);
      expect(raw).toMatch(/#r1\s*\{[^}]*animation:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("durationMs grows and shrinks to base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-dur-"));
    try {
      const path = join(dir, "d.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 200, durationMs: 2000 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 0, y: 0, width: 5, height: 5 } }] })).isError,
      ).toBeFalsy();
      expect(
        (await handleAnimate({ path, name: "long", keyframes: "0%{opacity:0}100%{opacity:1}", animations: [{ id: "r1", durationMs: 5000 }] })).isError,
      ).toBeFalsy();
      let read = await handleRead({ path, bboxMode: "fast" });
      let j = JSON.parse(textOf(read as never)) as { meta: { durationMs: number; baseDurationMs?: number } };
      expect(j.meta.durationMs).toBe(5000);
      expect(j.meta.baseDurationMs).toBe(2000);
      expect((await handleAnimate({ path, name: "long", remove: true })).isError).toBeFalsy();
      read = await handleRead({ path, bboxMode: "fast" });
      j = JSON.parse(textOf(read as never)) as { meta: { durationMs: number } };
      expect(j.meta.durationMs).toBe(2000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("chromium hardening and timed export", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("blocks external http from svg image", async () => {
    if (!findChromeBinary()) {
      console.error("skip block test: chromium missing");
      return;
    }
    let hits = 0;
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        hits++;
        return new Response("evil", { headers: { "Content-Type": "text/plain" } });
      },
    });
    try {
      const evilUrl = `http://127.0.0.1:${srv.port}/evil.png`;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150">` +
        `<rect width="200" height="150" fill="#ffffff"/>` +
        `<image href="${evilUrl}" x="0" y="0" width="50" height="50"/>` +
        `</svg>`;
      await screenshotAtTime(svg, 200, 150, 0, 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(hits).toBe(0);
    } finally {
      try {
        srv.stop();
      } catch {
        // ignore
      }
    }
  }, 120000);

  test("exact bboxes at time reflect motion", async () => {
    if (!findChromeBinary()) {
      console.error("skip exact bbox time test: chromium missing");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pica-bbox-t-"));
    try {
      const path = join(dir, "b.pica.svg");
      expect((await handleCreate({ path, width: 300, height: 200 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 10, y: 20, width: 40, height: 30, fill: "red" } }] })).isError,
      ).toBeFalsy();
      expect(
        (await handleAnimate({ path, name: "slide", keyframes: "0%{transform:translateX(0)}100%{transform:translateX(80px)}", animations: [{ id: "r1", durationMs: 1000 }] })).isError,
      ).toBeFalsy();
      const raw = await Bun.file(path).text();
      const { parsePica, stripDebugOverlay } = await import("../src/pica-file.js");
      const parsed = parsePica(stripDebugOverlay(raw));
      void parsed;
      const b0 = await getRenderedBboxesAtTime(stripDebugOverlay(raw), 300, 200, 0);
      const b1 = await getRenderedBboxesAtTime(stripDebugOverlay(raw), 300, 200, 1000);
      const r0 = b0.find((b) => b.id === "r1");
      const r1 = b1.find((b) => b.id === "r1");
      expect(r0).toBeDefined();
      expect(r1).toBeDefined();
      expect(Math.abs((r1!.bbox.x - r0!.bbox.x) - 80)).toBeLessThan(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120000);

  test("static export timeMs uses chromium frame", async () => {
    if (!findChromeBinary()) {
      console.error("skip timed export test: chromium missing");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pica-texp-"));
    try {
      const path = join(dir, "t.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 150 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 10, y: 10, width: 30, height: 30, fill: "red" } }] })).isError,
      ).toBeFalsy();
      expect(
        (await handleAnimate({ path, name: "slide", keyframes: "0%{transform:translateX(0)}100%{transform:translateX(100px)}", animations: [{ id: "r1", durationMs: 1000 }] })).isError,
      ).toBeFalsy();
      const out0 = join(dir, "t0.png");
      const out1 = join(dir, "t1.png");
      const e0 = await handleExport({ path, format: "png", outPath: out0, scale: 1, quality: 90, animated: false, timeMs: 0 });
      expect(e0.isError).toBeFalsy();
      const e1 = await handleExport({ path, format: "png", outPath: out1, scale: 1, quality: 90, animated: false, timeMs: 1000 });
      expect(e1.isError).toBeFalsy();
      const b0 = await Bun.file(out0).arrayBuffer();
      const b1 = await Bun.file(out1).arrayBuffer();
      expect(b0.byteLength).toBeGreaterThan(200);
      expect(b1.byteLength).toBeGreaterThan(200);
      expect(Buffer.from(b0).equals(Buffer.from(b1))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe("audit regressions", () => {
  test("cubic-bezier easing does not corrupt durationMs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-bezier-"));
    try {
      const path = join(dir, "b.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 200 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 0, y: 0, width: 5, height: 5 } }] })).isError,
      ).toBeFalsy();
      const res = await handleAnimate({
        path,
        name: "slide",
        keyframes: "0%{transform:translateX(0)}100%{transform:translateX(10px)}",
        animations: [{ id: "r1", durationMs: 5000, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }],
      });
      expect(res.isError).toBeFalsy();
      const read = await handleRead({ path, bboxMode: "fast" });
      const j = JSON.parse(textOf(read as never)) as { meta: { durationMs: number } };
      expect(j.meta.durationMs).toBe(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("pica_animate rejects CSS injection payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-cssinj-"));
    try {
      const path = join(dir, "i.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 200 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 0, y: 0, width: 5, height: 5 } }] })).isError,
      ).toBeFalsy();
      const badName = await handleAnimate({
        path,
        name: "x; } @import url(http://evil); #x {",
        keyframes: "0%{opacity:0}100%{opacity:1}",
        animations: [{ id: "r1" }],
      });
      expect(badName.isError).toBe(true);
      const badEasing = await handleAnimate({
        path,
        name: "okName",
        keyframes: "0%{opacity:0}100%{opacity:1}",
        animations: [{ id: "r1", easing: "ease; } @import url(http://evil); #x {" }],
      });
      expect(badEasing.isError).toBe(true);
      const badOrigin = await handleAnimate({
        path,
        name: "okName2",
        keyframes: "0%{opacity:0}100%{opacity:1}",
        animations: [{ id: "r1", transformOrigin: "center; } @import url(http://evil); #x {" }],
      });
      expect(badOrigin.isError).toBe(true);
      const badKeyframesUrl = await handleAnimate({
        path,
        name: "evilBg",
        keyframes: "0%{background-image:url(http://evil/x.png)}100%{opacity:1}",
        animations: [{ id: "r1" }],
      });
      expect(badKeyframesUrl.isError).toBe(true);
      expect(textOf(badKeyframesUrl as never)).toMatch(/dangerous CSS/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("pica_patch update rejects changing id on a regular shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pica-idmut-"));
    try {
      const path = join(dir, "m.pica.svg");
      expect((await handleCreate({ path, width: 200, height: 200 })).isError).toBeFalsy();
      expect(
        (await handlePatch({ path, ops: [{ op: "add", id: "r1", tag: "rect", attrs: { x: 0, y: 0, width: 5, height: 5 } }] })).isError,
      ).toBeFalsy();
      const res = await handlePatch({ path, ops: [{ op: "update", id: "r1", attrs: { id: "pica-meta" } }] });
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toMatch(/id/i);
      const rm2 = await handlePatch({ path, ops: [{ op: "update", id: "r1", attrs: { id: null } }] });
      expect(rm2.isError).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("preview sends Content-Security-Policy headers", async () => {
    const oldPort = process.env["PICA_PORT"];
    process.env["PICA_PORT"] = "0";
    setCurrentSvg("test.pica.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const srv = startPreviewServer();
    try {
      if (!srv) {
        console.error("skip csp test: preview failed to start");
        return;
      }
      const res = await fetch(`http://127.0.0.1:${srv.port}/`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
      await res.text().catch(() => undefined);
      const svgRes = await fetch(`http://127.0.0.1:${srv.port}/svg`);
      expect(svgRes.status).toBe(200);
      const svgCsp = svgRes.headers.get("content-security-policy") ?? "";
      expect(svgCsp).toMatch(/default-src 'none'/);
      expect(svgCsp).toMatch(/sandbox/);
      await svgRes.text().catch(() => undefined);
    } finally {
      try {
        (srv as { stop?: () => void })?.stop?.();
      } catch {
        // ignore
      }
      if (oldPort === undefined) delete process.env["PICA_PORT"];
      else process.env["PICA_PORT"] = oldPort;
    }
  }, 60000);
});
