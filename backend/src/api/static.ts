import { join, normalize } from "node:path";

const VIEW_MOUNT = '<main id="view"></main>';
const SHELL_CACHE_CONTROL = "no-cache";
const ASSET_CACHE_CONTROL = "public, max-age=300";

function shellResponse(body: BodyInit, contentType?: string): Response {
  const headers: Record<string, string> = { "Cache-Control": SHELL_CACHE_CONTROL };
  if (contentType) headers["Content-Type"] = contentType;
  return new Response(body, { headers });
}

// Docs are authored as SPA fragments, but they are also a published entrypoint
// for non-browser clients. Keep the shell (and its crawler metadata) while
// putting the matching docs fragment in its otherwise-empty initial view.
async function docsShell(staticDir: string, safePath: string): Promise<Response | null> {
  if (!safePath.startsWith("/docs") || safePath.split("/").pop()!.includes(".")) return null;

  const relativePath = safePath.replace(/^[/\\]+/, "");
  const fragment = Bun.file(join(staticDir, "views", `${relativePath}.html`));
  if (!(await fragment.exists())) return null;

  const shell = Bun.file(join(staticDir, "index.html"));
  if (!(await shell.exists())) return null;

  const html = await shell.text();
  const mount = `${VIEW_MOUNT.slice(0, -7)}${await fragment.text()}</main>`;
  return shellResponse(html.replace(VIEW_MOUNT, mount), "text/html; charset=utf-8");
}

// Serve a file from staticDir; fall back to index.html for client routes so SPA
// deep links and refreshes work. Documentation routes receive their fragment
// inside that shell so non-JS clients can read the same canonical prose.
export async function serveStatic(pathname: string, staticDir: string | null): Promise<Response | null> {
  if (!staticDir) return null;
  const safe = normalize(decodeURIComponent(pathname)).replace(/^((\.\.)(\/|\\|$))+/, "");
  let filePath = join(staticDir, safe);
  if (pathname.endsWith("/")) filePath = join(filePath, "index.html");

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return filePath.endsWith(".html")
      ? shellResponse(file)
      : new Response(file, { headers: { "Cache-Control": ASSET_CACHE_CONTROL } });
  }

  // No file extension → treat as a client route, serve the shell. Docs retain
  // the same shell but expose their static fragment before JS ever runs.
  if (!safe.split("/").pop()!.includes(".")) {
    return await docsShell(staticDir, safe) ?? shellResponse(Bun.file(join(staticDir, "index.html")));
  }
  return null;
}
