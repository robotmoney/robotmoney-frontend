// Minimal in-place static server for preview mode (`bun run preview`).
// Serves the SAME URL space as the hosted Cloudflare Pages deploy
// (scripts/cloudflare-statics.sh) straight from the working tree — no
// copying, so edits show on refresh:
//   /                    → frontend/preview/index.html (the wrapper)
//   /preview/index.html  → frontend/preview/index.html
//   /goldens/*           → goldens/*
//   everything else      → frontend/public/* (SPA at the root: /index.html, /assets/*)
//   miss                 → frontend/preview/404.html, status 404 (frame-escape redirect)
// Port: random free port by default; override with PORT=<n>.
import { join, posix } from "node:path";

const root = join(import.meta.dir, "..");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  async fetch(req) {
    const path = posix.normalize(decodeURIComponent(new URL(req.url).pathname));
    let file: ReturnType<typeof Bun.file>;
    if (path === "/" || path === "/preview" || path === "/preview/index.html") {
      file = Bun.file(join(root, "frontend/preview/index.html"));
    } else if (path.startsWith("/goldens/")) {
      file = Bun.file(join(root, path.slice(1)));
    } else {
      file = Bun.file(join(root, "frontend/public", path.slice(1)));
    }
    if (await file.exists()) return new Response(file);

    // Fallback for nested SPA routes (e.g., /swarm/apply)
    // Cloudflare Pages uses _redirects (`/* /index.html 200`) for this.
    // The preview environment wrapper is frontend/preview/index.html.
    if (!path.includes(".") && !path.startsWith("/api/")) {
      return new Response(Bun.file(join(root, "frontend/preview/index.html")));
    }

    return new Response(Bun.file(join(root, "frontend/preview/404.html")), {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`Serving preview at: http://127.0.0.1:${server.port}/`);
console.log(`(same URL space as the hosted preview; edits show on refresh; Ctrl-C to stop)`);
