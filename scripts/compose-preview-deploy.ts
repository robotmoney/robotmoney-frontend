// Compose the preview deploy directory by combining:
// - frontend/public (verbatim)
// - preview/ files (_redirects, _headers, preview.html, 404.html)
// - goldens/api-goldens.json
//
// Usage:
//   bun scripts/compose-preview-deploy.ts [--serve [PORT]]
//
// If --serve is passed (optionally with a PORT), the compose script will also
// start a static file server on a random free port (or the specified PORT) and
// print the URL. This mimics the local preview experience.

import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_PUBLIC = join(repoRoot, "frontend/public");
const PREVIEW_SRC = join(repoRoot, "preview");
const GOLDENS = join(repoRoot, "goldens/api-goldens.json");
const DEPLOY_DIR = join(repoRoot, ".preview-deploy");
const SERVE = process.argv.includes("--serve");
const PORT_ARG = process.argv.indexOf("--serve") + 1;
const EXPLICIT_PORT = PORT_ARG < process.argv.length && !process.argv[PORT_ARG].startsWith("-") ? Number(process.argv[PORT_ARG]) : 0;

// Validate inputs
if (!existsSync(FRONTEND_PUBLIC)) {
  console.error(`frontend/public not found at ${FRONTEND_PUBLIC}`);
  process.exit(1);
}
if (!existsSync(PREVIEW_SRC)) {
  console.error(`preview/ directory not found at ${PREVIEW_SRC}`);
  process.exit(1);
}
if (!existsSync(GOLDENS)) {
  console.error(`goldens/api-goldens.json not found at ${GOLDENS}`);
  console.error(`Generate them with: bun run goldens:update`);
  process.exit(1);
}

// Clean and recreate deploy directory
if (existsSync(DEPLOY_DIR)) {
  rmSync(DEPLOY_DIR, { recursive: true });
}
mkdirSync(DEPLOY_DIR);

// Recursively copy directory
function copyDir(src: string, dst: string) {
  if (!existsSync(dst)) {
    mkdirSync(dst, { recursive: true });
  }
  const files = readdirSync(src);
  for (const file of files) {
    const srcFile = join(src, file);
    const dstFile = join(dst, file);
    const stat = statSync(srcFile);
    if (stat.isDirectory()) {
      copyDir(srcFile, dstFile);
    } else {
      copyFileSync(srcFile, dstFile);
    }
  }
}

// Copy frontend/public
console.log("Composing preview deploy directory...");
copyDir(FRONTEND_PUBLIC, DEPLOY_DIR);

// Copy preview/ files (_redirects, _headers, preview.html, 404.html)
const previewFiles = ["_redirects", "_headers", "preview.html", "404.html"];
for (const file of previewFiles) {
  const src = join(PREVIEW_SRC, file);
  const dst = join(DEPLOY_DIR, file);
  if (existsSync(src)) {
    const content = readFileSync(src, "utf-8");
    writeFileSync(dst, content);
  }
}

// Copy goldens/api-goldens.json to the deploy directory
{
  const content = readFileSync(GOLDENS, "utf-8");
  writeFileSync(join(DEPLOY_DIR, "api-goldens.json"), content);
}

console.log(`✓ Compose complete: ${DEPLOY_DIR}`);
console.log(`  Files: frontend/public + preview/ + goldens/api-goldens.json`);

if (SERVE) {
  // Serve the composed directory as static files
  const PORT = EXPLICIT_PORT || 0;

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);

      // Strip leading slash and handle root specially
      if (path === "/" || path === "") {
        path = "preview.html";
      } else {
        path = path.startsWith("/") ? path.slice(1) : path;
      }

      const file = Bun.file(join(DEPLOY_DIR, path));
      if (await file.exists()) {
        return new Response(file);
      }

      // If file not found, try serving the index.html (SPA fallback)
      // For /api/* we should 404
      if (url.pathname.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      // For other paths, serve index.html (SPA routing)
      const indexFile = Bun.file(join(DEPLOY_DIR, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, { headers: { "content-type": "text/html" } });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`\nServing preview at: http://127.0.0.1:${server.port}/`);
  console.log(`(same experience as hosted preview, goldens loaded client-side)`);
  console.log(`Ctrl-C to stop.`);
}
