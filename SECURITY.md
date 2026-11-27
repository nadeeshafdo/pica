# Security Policy

`pica` runs locally as an MCP server, reads and writes `.pica.svg` files, shells out to optional system `chromium` and `ffmpeg`, and serves a local-only preview. Thanks for helping keep that surface safe.

## Supported versions

| Version | Supported |
| :--- | :--- |
| `0.1.x` (latest `main`) | Yes |
| `< 0.1.0`, forks, pre-releases | Best effort only |

We patch the latest `main` first, then cut a release. If you are pinned to an old tag, please confirm the issue reproduces on latest `main`.

## Report a vulnerability

Do NOT open a public issue, discussion, or PR for suspected vulnerabilities.

Preferred path:

1. Use GitHub: `Security` tab > `Report a vulnerability` (private advisory).
2. Alternative: email `itsme@nadeeshafdo.dev` with subject `[pica security] short summary`.

Include:

- Affected commit or version, OS, Bun version
- Repro steps or PoC (minimal `.pica.svg`, tool call JSON, or script)
- Impact assessment (file overwrite, code execution, SSRF, XSS in preview, DoS, etc.)
- Any relevant `stderr` logs (redact secrets and absolute usernames/paths)

Please do NOT include live credentials, private customer data, or unrelated PII.

What to expect:

- Acknowledgement within 48 hours
- Triage and severity assessment within 7 days
- Fix prioritization by severity: RCE / file-escape / sandbox bypass first, then preview XSS, then DoS / correctness
- Coordinated disclosure: we fix, release, then publish an advisory and credit you (unless you prefer anonymity)

There is no paid bounty program. We offer public credit, a fast fix, and our gratitude.

## Scope and threat notes

In-scope:

- `pica_patch` sanitization bypass: `<script>` injection, `on*` event handlers, `javascript:` URLs, invalid XML acceptance, cyclic group reorder escape
- Path traversal or non-atomic writes in file engine (`pica-file.ts`)
- Command injection via `chromium` / `ffmpeg` spawn arguments or piped media paths (`chromium.ts`, `export.ts`)
- Preview server issues: binding beyond `127.0.0.1`, WebSocket origin bypass, stored XSS via unsanitized SVG in `viewer.html`
- MCP stdio breakage that leaks logs/secrets to `stdout`

Out of scope (but still welcome as regular bugs):

- Missing `chromium` / `ffmpeg` error messages
- Visual rendering differences between `resvg` fast path and Chromium exact path
- Performance tuning without a security boundary

Hardening already in place:

- DOM-based SVG sanitization via `linkedom`: rejects `<script>`, `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, and `<applet>`; `on*` handlers including no-space bypasses; entity-decoded `javascript:`, `vbscript:`, and `data:text/html` URLs; and dangerous `<style>` CSS (`@import`, `javascript:`, `expression(`).
- Skeleton element protection: `pica-meta`, `pica-defs`, `pica-anim`, and `pica-root` are blocked from `update`, `remove`, and `reorder`; `pica-bg` is restricted to `fill`, `opacity`, and `fill-opacity`; `id` mutation is blocked on all elements.
- `pica_animate` CSS injection guards on keyframe names, keyframe bodies (including `url(`), and target properties (`easing`, `transformOrigin`, `direction`, `fill`, string `iterations`).
- Path safety via `resolveSafePath` (null-byte rejection and optional `PICA_ROOT` sandbox jail) plus `ffmpeg` flag (`-...`) and protocol (`://`) rejection on the raw `outPath`.
- Headless Chromium CDP `Fetch.enable` request blocking: external `http://`, `https://`, `file://`, and `ws://` requests are blocked, allowing only `about:blank` and non-HTML `data:` URLs.
- Preview server bound to `127.0.0.1`, `/ws` `Origin` header validation (`403` on cross-origin), strict `DOMParser` SVG parsing with no `innerHTML` fallback, and `Content-Security-Policy` headers on `/` and `/svg`.
- Atomic `.tmp` plus `rename` writes with failed-write `.tmp` cleanup, so interrupted writes never leave partial files.
- Exports strip debug overlays (`showGrid`, `showIds` never persist).
- No cloud calls, no telemetry, no bundled secrets.

## Safe harbor

Good-faith research against your own local install is welcome. Do not access other users' machines, exfiltrate data, degrade shared services, or pivot from a local finding to third-party infrastructure.

## After going public

Once this repo is public, advisories will be published via GitHub Security Advisories and referenced from release notes. Please keep findings embargoed until a fix is released.
