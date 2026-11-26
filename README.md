# pica

Headless-first 2D vector design and animation MCP server for local coding agents.

`pica` gives AI coding agents (OpenCode, Claude Code, Cursor, and any MCP client) a lightweight, local blackboard to create, inspect, animate, and export 2D graphics without paid cloud APIs, rate limits, or heavy GUI suites.

Every canvas is a standard, standalone `.pica.svg` file. Agents mutate it cleanly by element `#id`, verify layouts visually through PNG snapshots with optional coordinate grids and bounding-box labels, and export to static or animated formats locally.

## Why pica

| Capability | pica | Cloud Design MCPs | Whiteboard MCPs | Video-in-React Frameworks |
| :--- | :--- | :--- | :--- | :--- |
| Cost and rate limits | Free, local, unlimited | Paid plans, rate limited | Free | Free |
| Runtime dependencies | 5 packages (Bun only) | Cloud account required | Moderate | Heavy (`node_modules` bloat) |
| Precision 2D vectors | Native SVG + `<defs>` | Yes | Rough diagrams only | DOM/Canvas |
| Keyframe animations | CSS `@keyframes` + WAAPI | Limited | No | Code-heavy |
| Vision feedback loop | Built-in `pica_inspect` with grid and `#id` overlay | Limited | No | Manual |
| Exports | SVG, PNG, JPG, WebP, animated WebP, MP4 | Cloud exports | PNG/SVG | MP4/WebM |

## Architecture

```text
Coding Agent (OpenCode / Claude Code / MCP Client)
        │  JSON-RPC over stdio (MCP SDK v2)
        ▼
  pica MCP Server (Bun + TypeScript)
        ├── File Engine (.pica.svg atomic read/patch/animate + fast bbox math)
        ├── Static Renderer (@resvg/resvg-js for fast PNG snapshots & exports)
        ├── Media Engine (lazy system Chromium CDP + ffmpeg stdin pipes)
        └── Live Preview (optional Hono HTTP + WebSocket viewer on :4173)
```

- **Zero heavy JS media deps:** No Playwright, Puppeteer, Sharp, Canvas, React, or Vite.
- **Pure stdio protocol:** All logs route to `stderr` so `stdout` stays clean JSON-RPC.
- **Deterministic animation capture:** Headless Chromium pauses `document.getAnimations()`, steps exact integer frame timestamps, and pipes raw PNG frames straight into `ffmpeg` stdin.

## Prerequisites

- [Bun](https://bun.sh/) (v1.2+)
- **Optional:** System `chromium` (or `google-chrome`) in `PATH` for `bboxMode: "exact"`, animated `pica_inspect`, and MP4 / animated WebP export.
- **Optional:** System `ffmpeg` in `PATH` for JPG, WebP, and MP4 export.

If `chromium` or `ffmpeg` is missing, static SVG and PNG workflows still work and media-dependent tools return actionable error messages.

## Quick Start

```bash
git clone [https://github.com/nadeeshafdo/pica.git](https://github.com/nadeeshafdo/pica.git)
cd pica
bun install
```

### Add to OpenCode

Add `pica` to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "pica": {
        "type": "local",
        "command": ["bun", "/absolute/path/to/pica/src/index.ts"],
        "environment": {}
      }
    }
  }
}
```

### Add to Claude Code

```bash
claude mcp add pica -- bun /absolute/path/to/pica/src/index.ts
```

### Test with MCP Inspector

```bash
bunx @modelcontextprotocol/inspector bun src/index.ts
```

### Example Prompt

Open `http://127.0.0.1:4173` in your browser to watch live updates, then ask your agent:

> Design an animated minimalist logo reveal for pica in 1280x720, inspect it at 0ms and 1200ms with the debug grid on, and export it as an MP4.

## MCP Tools

### `pica_create`
Initializes a `.pica.svg` canvas and broadcasts it to live preview clients.

- `path` (string, required): Output `.pica.svg` file path.
- `width` (int, default `800`, max `8192`): Canvas width in pixels.
- `height` (int, default `600`, max `8192`): Canvas height in pixels.
- `background` (string, default `"#ffffff"`): Canvas background CSS color.
- `fps` (number, default `30`, max `120`): Default frames per second for animated exports.
- `durationMs` (int, default `2000`, max `600000`): Timeline duration in milliseconds.

### `pica_read`
Parses a `.pica.svg` file and returns canvas dimensions, metadata, animations, and element nodes with bounding boxes `{ x, y, w, h }`.

- `path` (string, required): Input `.pica.svg` file path.
- `bboxMode` (`"fast" | "exact"`, default `"fast"`): `"fast"` computes geometry bboxes locally (shapes, full SVG path commands, group unions, `text-anchor` alignment); `"exact"` queries Chromium `getBBox()`.
- `tree` (boolean, default `false`): Include nested node hierarchy alongside the flat list.
- `includeRaw` (boolean, default `false`): Include raw SVG XML in the response.

### `pica_patch`
Applies atomic batch DOM mutations by `#id`. Rejects `<script>` elements, `on*` event handlers, `javascript:` URLs, invalid XML, and cyclic group reorders.

- `path` (string, required): Target `.pica.svg` file path.
- `ops` (array, min 1, required): Operations applied in order:
  - `add`: `{ op: "add", id, tag, attrs?, textContent?, parentId?, position? }`
  - `update`: `{ op: "update", id, attrs?, textContent? }` (pass `null` as an attribute value to remove it)
  - `remove`: `{ op: "remove", id }`
  - `reorder`: `{ op: "reorder", id, parentId?, newIndex?, beforeId? }`
  - `setDefs`: `{ op: "setDefs", defsSvg }`

### `pica_animate`
Adds, updates, or removes `@keyframes` and `#id` animation rules inside `<style id="pica-anim">`. Automatically emits `transform-box: fill-box` and `transform-origin` so rotations and scales anchor to the element instead of `(0, 0)`, and extends metadata `durationMs` when animations run longer than the current timeline.

- `path` (string, required): Target `.pica.svg` file path.
- `name` (string, required): Keyframes identifier (e.g. `fadeUp`, `spin`).
- `keyframes` (string, optional): CSS keyframe body (e.g. `"0%{opacity:0}100%{opacity:1}"`). Required when creating a new animation.
- `animations` (array, optional): Target bindings `{ id, durationMs?, delayMs?, easing?, iterations?, direction?, fill?, transformOrigin? }`.
- `remove` (boolean, default `false`): Delete the `@keyframes` block and matching `#id` rules safely by exact token match.

### `pica_inspect`
Renders a PNG preview and returns an MCP image block plus a short text summary for visual verification.

- `path` (string, required): Input `.pica.svg` file path.
- `timeMs` (number, default `0`): Timestamp in milliseconds. Static designs at `timeMs = 0` render via `resvg`. Animated designs (and any `timeMs > 0`) render via headless Chromium CDP when available, falling back to static `resvg` at `timeMs = 0` if Chromium is absent.
- `showGrid` (boolean, default `false`): Overlay a temporary 100px coordinate grid (never saved to disk).
- `showIds` (boolean, default `false`): Overlay temporary `#id` bounding boxes and labels (never saved to disk).
- `scale` (number, default `1`, max `4`): Render scale factor.
- `maxWidth` (int, default `1024`, max `8192`): Caps output PNG width so large canvases do not flood agent context windows.

### `pica_export`
Exports clean assets (debug overlays are always stripped).

- `path` (string, required): Input `.pica.svg` file path.
- `format` (`"svg" | "png" | "jpg" | "jpeg" | "webp" | "mp4"`, required): Output format.
- `outPath` (string, required): Destination file path (parent directories are created automatically).
- `scale` (number, default `1`, max `4`): Output scale multiplier.
- `quality` (number, default `90`, `0-100`): Compression quality for JPG, WebP, and MP4 (`-crf` mapped, with `+faststart`).
- `fps` (number, optional): Override document FPS for animated exports.
- `animated` (boolean, default `false`): Set `true` for animated WebP; MP4 is always animated.

## File Format (`.pica.svg`)

Every file is valid standalone SVG with five reserved skeleton elements:

```xml
<svg xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)" width="800" height="600" viewBox="0 0 800 600">
  <metadata id="pica-meta">{"version":1,"fps":30,"durationMs":2000,"background":"#ffffff"}</metadata>
  <defs id="pica-defs"></defs>
  <style id="pica-anim"></style>
  <rect id="pica-bg" width="100%" height="100%" fill="#ffffff"/>
  <g id="pica-root"></g>
</svg>
```

All disk writes are atomic (`.tmp` write followed by rename). Because the source of truth is plain SVG and CSS, any browser, vector editor, or git diff tool works with it natively.

## Live Preview

When the MCP server starts, it opens an optional local preview server at `http://127.0.0.1:4173` (port failures log to `stderr` and never crash the MCP transport).

- Checkerboard artboard with wheel zoom, drag pan, and fit-to-screen.
- Live WebSocket reload on every `pica_create`, `pica_patch`, and `pica_animate` while preserving your current zoom and pan across patches.
- Bottom timeline scrubber (Play/Pause + time slider) synced with `document.getAnimations()`.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PICA_PORT` | `4173` | Port for the local Hono live preview server (`127.0.0.1`). |
| `CHROME_PATH` / `CHROMIUM_PATH` | Auto-detected | Explicit path to a Chromium or Google Chrome executable. |

## Development

```bash
bun run typecheck   # Strict TypeScript check (noEmit)
bun test            # Integration tests (skips Chromium/FFmpeg cases if absent)
bun run build       # Bundle CLI to ./dist
```
