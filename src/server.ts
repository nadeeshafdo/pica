import { McpServer } from "@modelcontextprotocol/server";
import {
  AnimateSchema,
  CreateSchema,
  ExportSchema,
  InspectSchema,
  PatchSchema,
  ReadSchema,
  handleAnimate,
  handleCreate,
  handleExport,
  handleInspect,
  handlePatch,
  handleRead,
} from "./tools.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "pica", version: "0.1.0" });

  server.registerTool(
    "pica_create",
    {
      title: "Create canvas",
      description: "Initialize a .pica.svg canvas with metadata, defs, style, background, and root. Notifies live preview.",
      inputSchema: CreateSchema,
    },
    async (args) => handleCreate(args),
  );

  server.registerTool(
    "pica_read",
    {
      title: "Read canvas",
      description: "Parse .pica.svg and return canvas dims, metadata, animations, and node list with bboxes. Set bboxMode exact for Chromium getBBox().",
      inputSchema: ReadSchema,
    },
    async (args) => handleRead(args),
  );

  server.registerTool(
    "pica_patch",
    {
      title: "Patch canvas",
      description: "Apply batch DOM mutations (add, update, remove, reorder, setDefs) atomically by #id. Rejects <script>.",
      inputSchema: PatchSchema,
    },
    async (args) => handlePatch(args),
  );

  server.registerTool(
    "pica_animate",
    {
      title: "Animate canvas",
      description: "Add, update, or remove @keyframes and #id animation rules in <style id='pica-anim'>. Auto-extends durationMs.",
      inputSchema: AnimateSchema,
    },
    async (args) => handleAnimate(args),
  );

  server.registerTool(
    "pica_inspect",
    {
      title: "Inspect preview",
      description: "Render a preview PNG. Static designs at timeMs=0 use resvg; animated designs (and any timeMs>0) capture via headless Chromium CDP when available, else static resvg fallback at timeMs=0. Optional grid/id overlays.",
      inputSchema: InspectSchema,
    },
    async (args) => handleInspect(args),
  );

  server.registerTool(
    "pica_export",
    {
      title: "Export asset",
      description: "Export svg, png, jpg/jpeg, static webp, mp4, or animated webp. Video uses Chromium frames piped to ffmpeg.",
      inputSchema: ExportSchema,
    },
    async (args) => handleExport(args),
  );

  return server;
}
