// Serve the frozen static distribution (dist/frozen) over HTTP for local
// preview — the exact server-less shape any static host would serve. Includes
// the index.html SPA fallback so client-side deep links (/regime) refresh.
//
//   bun run frozen:serve          # → http://127.0.0.1:4787
//   PORT=8080 bun run frozen:serve
//
// (Equivalent to `python3 -m http.server -d dist/frozen`, minus the SPA
// fallback — this one also serves the app on a deep-link refresh.)
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "frozen");
const PORT = Number(process.env.PORT ?? 4787);

if (!existsSync(join(root, "index.html"))) {
  console.error(`no frozen dist at ${root} — run \`bun run frozen:fixtures\` (or \`bun run frozen\`) first`);
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const file = Bun.file(join(root, p === "/" ? "/index.html" : p));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(join(root, "index.html")), { headers: { "content-type": "text/html" } });
  },
});

console.log(`frozen dist:  http://127.0.0.1:${server.port}/  (Ctrl-C to stop)`);
