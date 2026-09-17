// Minimal in-place static server for preview mode (`bun run preview`).
// Serves the SAME URL space as the assembled static site
// (scripts/static-assembly.sh) straight from the working tree — no
// copying, so edits show on refresh:
//   /                    → frontend/preview/index.html (the wrapper)
//   /preview/index.html  → frontend/preview/index.html
//   /goldens/*           → goldens/*
//   /version.json        → the web client's identity (frontend/package.json + HEAD)
//   everything else      → frontend/public/* (SPA at the root: /index.html, /assets/*)
//   miss                 → frontend/preview/404.html, status 404 (frame-escape redirect)
// Port: random free port by default; override with PORT=<n>.
//
// The wrapper's `?api=` switch (fixtures | prod | stage | <origin>) is handled
// entirely in the browser; this server never proxies an api.
import { join, posix } from "node:path";
import { webClientVersion } from "./web-client/version.ts";

const root = join(import.meta.dir, "..");
const version = JSON.stringify(await webClientVersion());

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  async fetch(req) {
    const path = posix.normalize(decodeURIComponent(new URL(req.url).pathname));
    if (path === "/version.json") {
      return new Response(version, { headers: { "content-type": "application/json" } });
    }
    let file: ReturnType<typeof Bun.file>;
    if (path === "/" || path === "/preview" || path === "/preview/index.html") {
      file = Bun.file(join(root, "frontend/preview/index.html"));
    } else if (path.startsWith("/goldens/")) {
      file = Bun.file(join(root, path.slice(1)));
    } else {
      file = Bun.file(join(root, "frontend/public", path.slice(1)));
    }
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(join(root, "frontend/preview/404.html")), {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`Serving preview at: http://127.0.0.1:${server.port}/`);
console.log(`(same URL space as the assembled site; edits show on refresh; Ctrl-C to stop)`);
console.log(`(add ?api=prod or ?api=stage to answer /api/* from a live api instead of goldens)`);
