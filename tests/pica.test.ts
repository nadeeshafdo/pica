import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromeBinary } from "../src/chromium.js";
import { handleAnimate, handleCreate, handleExport, handleInspect, handlePatch, handleRead } from "../src/tools.js";

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
