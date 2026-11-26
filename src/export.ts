import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicWriteFile, stripDebugOverlay } from "./pica-file.js";
import { renderPngBuffer } from "./render.js";
import { captureFrames } from "./chromium.js";

async function readSvgClean(path: string): Promise<string> {
  const raw = await Bun.file(path).text();
  return stripDebugOverlay(raw);
}

async function ensureParentDir(outPath: string): Promise<void> {
  const dir = dirname(outPath);
  if (dir && dir !== "." && dir !== "") {
    await mkdir(dir, { recursive: true });
  }
}

function ffmpegQualityForJpg(quality: number): string {
  const q = Math.min(100, Math.max(0, quality));
  // map 100 -> 2 (best), 0 -> 31 (worst)
  return String(Math.round(31 - (q / 100) * 29));
}

function crfForQuality(quality: number): string {
  const q = Math.min(100, Math.max(0, quality));
  // map 100 -> 18 (high quality), 0 -> 51 (lowest)
  return String(Math.round(51 - (q / 100) * 33));
}

async function drainStderr(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  try {
    const s = proc.stderr;
    if (!s || typeof s === "number") return "";
    return await new Response(s as ReadableStream).text();
  } catch {
    return "";
  }
}

async function runFfmpegWithPngInput(args: string[], png: Buffer, outPath: string): Promise<void> {
  await ensureParentDir(outPath);
  const proc = Bun.spawn(["ffmpeg", "-loglevel", "error", ...args], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  // Drain stderr concurrently so a full pipe never blocks ffmpeg.
  const stderrPromise = drainStderr(proc);
  try {
    const writer = proc.stdin;
    if (!writer || typeof writer === "number") {
      throw new Error("Failed to open ffmpeg stdin pipe.");
    }
    const sink = writer as unknown as {
      write(c: Uint8Array): void | Promise<void>;
      flush(): void;
      end(): void;
    };
    await sink.write(png);
    sink.flush();
    sink.end();
    const exit = await proc.exited;
    const errText = await stderrPromise;
    if (exit !== 0) {
      throw new Error(`ffmpeg exited with code ${exit}: ${errText.slice(0, 500)}`);
    }
  } finally {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }
}

export async function exportSvgClean(srcPath: string, outPath: string): Promise<void> {
  const clean = await readSvgClean(srcPath);
  await atomicWriteFile(outPath, clean);
}

export async function exportPng(srcPath: string, outPath: string, scale = 1): Promise<void> {
  const clean = await readSvgClean(srcPath);
  const png = renderPngBuffer(clean, scale);
  await atomicWriteFile(outPath, png);
}

export async function exportStaticRaster(
  srcPath: string,
  outPath: string,
  format: "jpg" | "jpeg" | "webp",
  quality = 90,
  scale = 1,
): Promise<void> {
  const clean = await readSvgClean(srcPath);
  const png = renderPngBuffer(clean, scale);
  if (format === "jpg" || format === "jpeg") {
    await runFfmpegWithPngInput(
      ["-y", "-f", "image2pipe", "-i", "-", "-q:v", ffmpegQualityForJpg(quality), outPath],
      png,
      outPath,
    );
  } else {
    const q = Math.round(Math.min(100, Math.max(0, quality)));
    await runFfmpegWithPngInput(
      ["-y", "-f", "image2pipe", "-i", "-", "-quality", String(q), outPath],
      png,
      outPath,
    );
  }
}

export async function exportAnimated(
  svgText: string,
  width: number,
  height: number,
  outPath: string,
  kind: "mp4" | "webp",
  fps: number,
  durationMs: number,
  scale: number,
  quality: number,
): Promise<void> {
  await ensureParentDir(outPath);
  const q = Math.round(Math.min(100, Math.max(0, quality)));
  const args =
    kind === "mp4"
      ? [
          "-y",
          "-f",
          "image2pipe",
          "-framerate",
          String(fps),
          "-i",
          "-",
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          crfForQuality(q),
          "-movflags",
          "+faststart",
          "-r",
          String(fps),
          outPath,
        ]
      : [
          "-y",
          "-f",
          "image2pipe",
          "-framerate",
          String(fps),
          "-i",
          "-",
          "-c:v",
          "libwebp",
          "-quality",
          String(q),
          "-loop",
          "0",
          "-r",
          String(fps),
          outPath,
        ];
  const proc = Bun.spawn(["ffmpeg", "-loglevel", "error", ...args], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  // Drain stderr concurrently while frames stream to stdin.
  const stderrPromise = drainStderr(proc);
  const writer = proc.stdin as unknown as {
    write(c: Uint8Array): void | Promise<void>;
    flush(): void;
    end(): void;
  } | null;
  if (!writer) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    await stderrPromise;
    throw new Error("Failed to open ffmpeg stdin pipe.");
  }
  try {
    await captureFrames(svgText, width, height, durationMs, fps, scale, async (png) => {
      await writer.write(png);
      writer.flush();
    });
    writer.end();
    const exit = await proc.exited;
    const errText = await stderrPromise;
    if (exit !== 0) {
      throw new Error(`ffmpeg exited with code ${exit}: ${errText.slice(0, 800)}`);
    }
  } catch (e) {
    try {
      writer.end();
    } catch {
      // ignore
    }
    try {
      proc.kill();
    } catch {
      // ignore
    }
    await stderrPromise;
    throw e;
  }
}
