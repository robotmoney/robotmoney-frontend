// Serve the ASSEMBLED site (`_static`, from `bun run --cwd frontend assemble`)
// with website-server/nginx.conf's fallback rule and nothing else: no api, no
// Docker. `/api/*` answers 404 so a spec that forgets to mock a call fails
// loudly instead of reaching a backend that is not there.
//
// This is what lets the browser specs that stub `/api/**` themselves run in
// web-client.yml (D45) instead of only inside the e2e smoke boot. Prints the
// URL on stdout, the same line preview-server.ts prints.
//   PORT=<n> overrides the port (default: a random free one).
import { join, posix } from "node:path";

const root = join(import.meta.dir, "..", "..", process.env.STATIC_ASSEMBLY_DIR ?? "_static");

/** nginx `try_files $uri $uri/index.html /_shell.html /index.html`. */
async function resolve(path: string): Promise<ReturnType<typeof Bun.file> | null> {
  const clean = posix.normalize(path);
  const candidates = [clean, posix.join(clean, "index.html"), "/_shell.html", "/index.html"];
  for (const c of candidates) {
    const file = Bun.file(join(root, c));
    // A directory is `exists()` for Bun.file only after the index.html join; guard on size.
    if ((await file.exists()) && file.size > 0) return file;
  }
  return null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.startsWith("/api/") || path === "/health" || path === "/version") {
      return new Response("no api in the static site server", { status: 404 });
    }
    // A path with a file extension is an asset: it 404s rather than falling back to the shell.
    if (/\.(?!html$)[a-z0-9]+$/i.test(path)) {
      const file = Bun.file(join(root, posix.normalize(path)));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    const file = await resolve(path);
    return file ? new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404 });
  },
});

console.log(`Serving the assembled site at: http://127.0.0.1:${server.port}/`);
