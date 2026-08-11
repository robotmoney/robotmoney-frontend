import { join, normalize } from "node:path";

const VIEW_MOUNT = '<main id="view"></main>';
const SHELL_CACHE_CONTROL = "no-cache";
const ASSET_CACHE_CONTROL = "public, max-age=300";
// The SPA needs Alpine's expression evaluator, but all executable code is
// shipped from this origin. In particular, this closes the privileged-admin
// supply-chain boundary: a page that can read rm_admin_token never imports a
// WebAuthn client from a third-party host.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  // The design system has long loaded its non-executable font stylesheet from
  // Google Fonts. Keep that existing presentation dependency explicit so the
  // CSP neither emits a browser error on every route nor changes all visual
  // baselines; executable assets remain same-origin only.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

function shellResponse(body: BodyInit, contentType?: string): Response {
  const headers: Record<string, string> = {
    "Cache-Control": SHELL_CACHE_CONTROL,
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Permissions-Policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "X-Content-Type-Options": "nosniff",
  };
  if (contentType) headers["Content-Type"] = contentType;
  return new Response(body, { headers });
}

// The shell to answer a client route with. A deployed STATIC_DIR is an
// ASSEMBLED directory (scripts/static-assembly.sh), so it carries a prerendered
// `<route>/index.html` for every route in sitemap.xml — same shell, but with
// that route's own <title>/description/canonical/og:*/twitter:* already
// substituted from seo.js's table by scripts/prerender.ts. Serving it is the
// entire point: link unfurlers (Slack, X, LinkedIn, iMessage, WhatsApp,
// Telegram, Discord) read the RAW response and never run seo.js, so answering
// them with the home-page shell made every shared link unfurl as the home page
// — with og:url pointing at https://robotmoney.net/ rather than the page
// (issue #480). The home-page shell stays the fallback for client routes that
// are not in the sitemap and for an un-assembled STATIC_DIR, so nothing 404s
// that used to resolve.
function routeShell(staticDir: string, safePath: string): Promise<ReturnType<typeof Bun.file>> {
  const prerendered = Bun.file(join(staticDir, safePath, "index.html"));
  return prerendered.exists().then((ok) => (ok ? prerendered : Bun.file(join(staticDir, "index.html"))));
}

// Docs are authored as SPA fragments, but they are also a published entrypoint
// for non-browser clients. Keep the shell (and its crawler metadata) while
// putting the matching docs fragment in its otherwise-empty initial view.
async function docsShell(staticDir: string, safePath: string): Promise<Response | null> {
  if (!safePath.startsWith("/docs") || safePath.split("/").pop()!.includes(".")) return null;

  const relativePath = safePath.replace(/^[/\\]+/, "");
  const fragment = Bun.file(join(staticDir, "views", `${relativePath}.html`));
  if (!(await fragment.exists())) return null;

  // The route's PRERENDERED shell when the deploy has one, so a docs page keeps
  // its own crawler metadata AND gets its fragment inlined — the two halves are
  // independent and a docs route needs both.
  const shell = await routeShell(staticDir, safePath);
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

  // No file extension → treat as a client route, serve the shell: the route's
  // own prerendered one when the deploy assembled it, else the home-page shell
  // (routeShell). Docs retain the same shell but expose their static fragment
  // before JS ever runs.
  if (!safe.split("/").pop()!.includes(".")) {
    return await docsShell(staticDir, safe) ?? shellResponse(await routeShell(staticDir, safe));
  }
  return null;
}
