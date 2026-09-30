// The checks behind `bun run site:redeploy` (scripts/redeploy-website.ts): redeploying ONLY the website of a
// running stack. Everything here is pure or reads plain files, so scripts/tests/unit/website-redeploy.test.ts
// can prove each one without Docker.
//
// WHY THIS IS A SEPARATE TOOL. The site is served by `website-server`, a stock nginx image that carries only
// nginx.conf. The pages are NOT in the image: docker-compose.yml bind-mounts the checkout's `_static/` into it
// read-only (`./_static:/srv/frontend:ro`). So shipping a new site is a change to the files in one directory,
// and no container needs to restart. A full cutover (docs/runbooks/v0-5-2-rollout.md) stops the driver, takes
// the api down and boots a new stack; none of that is needed for a change that lives in `frontend/public`.
//
// WHY NOT JUST `bun run --cwd frontend assemble` ON THE LIVE CHECKOUT. scripts/static-assembly.sh empties
// `_static/` in place and rebuilds it, prerendering every route. For that whole time the live site is empty, and
// it would also move the live checkout under the running host driver. So the tool builds somewhere else, checks
// the result, and only then swaps the files in (rsync --delay-updates: every changed file is written to a
// holding name and renamed into place at the end, so the window is the renames).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface ContainerState {
  name: string;
  id: string;
  startedAt: string;
}

/** The `<loc>` routes of a sitemap.xml, as paths ("/" for the home page). */
export function parseSitemapRoutes(xml: string, origin = "https://robotmoney.network"): string[] {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: string[] = [];
  // The path must start with "/" (or be absent): without that, an origin that is a prefix of another one
  // (robotmoney.net inside robotmoney.network) matches and captures "work/..." as a route.
  for (const m of xml.matchAll(new RegExp(`<loc>${escaped}(/[^<]*)?</loc>`, "g"))) out.push(m[1] || "/");
  return out;
}

/** Where the assembler writes a route: "/" is index.html, "/regime" is regime/index.html. */
export function routeFile(route: string): string {
  const clean = route.replace(/^\/+|\/+$/g, "");
  return clean === "" ? "index.html" : `${clean}/index.html`;
}

/**
 * Stylesheet links in index.html must carry `?v=<first 8 of the file's sha256>`: the edge caches static assets for
 * hours, so a stale stamp serves new markup against an old stylesheet (frontend/test/browser/spa.spec.ts holds the
 * same rule in the browser tier). `read` returns the file's bytes, or null when it does not exist.
 */
export function stylesheetStampProblems(indexHtml: string, read: (rel: string) => Buffer | null): string[] {
  const problems: string[] = [];
  const links = [...indexHtml.matchAll(/href="(\/assets\/css\/[^"?]+\.css)(\?v=([0-9a-f]+))?"/g)];
  if (links.length === 0) problems.push("index.html links no stylesheet");
  for (const [, href, , stamped] of links) {
    const bytes = read(href!.slice(1));
    if (bytes === null) {
      problems.push(`${href} is linked but missing from the build`);
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    if (stamped !== actual) problems.push(`${href} is stamped ?v=${stamped ?? "(none)"} but hashes to ${actual}`);
  }
  return problems;
}

export interface BuildCheckInput {
  /** The assembled site. */
  dir: string;
  /** The commit this tool's tree is at: version.json must name it. */
  headSha: string;
  /** frontend/public/sitemap.xml. */
  sitemapXml: string;
  /** Entries in the live `_static/`, to catch a build that is implausibly small. */
  liveEntryCount?: number;
}

/** Problems with an assembled site; empty means it is fit to swap in. */
export function checkBuild(input: BuildCheckInput): string[] {
  const { dir } = input;
  const problems: string[] = [];
  if (!existsSync(join(dir, "index.html"))) return [`${dir} has no index.html: the assembly did not run`];

  let version: { name?: string; commit?: string } = {};
  try {
    version = JSON.parse(readFileSync(join(dir, "version.json"), "utf8"));
  } catch {
    problems.push("version.json is missing or not JSON");
  }
  if (version.name !== undefined && version.name !== "@robotmoney/web-client") problems.push(`version.json names ${version.name}, not the web client`);
  if (version.commit !== undefined && !input.headSha.startsWith(version.commit)) {
    problems.push(`version.json says commit ${version.commit} but this tree is at ${input.headSha.slice(0, 8)}`);
  }

  const routes = parseSitemapRoutes(input.sitemapXml);
  if (routes.length === 0) problems.push("the sitemap lists no routes");
  const missing = routes.filter((r) => !existsSync(join(dir, routeFile(r))));
  if (missing.length > 0) problems.push(`${missing.length} sitemap route(s) were not prerendered: ${missing.slice(0, 8).join(", ")}`);

  problems.push(
    ...stylesheetStampProblems(readFileSync(join(dir, "index.html"), "utf8"), (rel) => {
      const p = join(dir, rel);
      return existsSync(p) ? readFileSync(p) : null;
    }),
  );

  const symlinks = walk(dir).filter((f) => lstatSync(join(dir, f)).isSymbolicLink());
  if (symlinks.length > 0) problems.push(`the build contains symlinks (${symlinks.slice(0, 3).join(", ")}): a bind-mounted site must not`);

  if (input.liveEntryCount !== undefined && input.liveEntryCount > 10) {
    const n = readdirSync(dir).length;
    if (n < input.liveEntryCount / 2) problems.push(`the build has ${n} top-level entries against ${input.liveEntryCount} live: too small to be the whole site`);
  }
  return problems;
}

/**
 * Whether the commit a site reports is the commit we expect. `version.json` carries git's ABBREVIATED hash, and git
 * abbreviates to 7 or 8 or more characters depending on the repository (a shallow clone of the release printed 7
 * where the workstation printed 8, and an exact-length comparison rejected a correct deploy). Either may be the full
 * hash, so one being a prefix of the other is a match; anything shorter than 7 characters is not evidence of anything.
 */
export function commitMatches(served: string | undefined | null, expected: string | undefined | null): boolean {
  if (!served || !expected || served.length < 7 || expected.length < 7) return false;
  return expected.startsWith(served) || served.startsWith(expected);
}

/** Every regular file under `dir`, as sorted relative paths. rsync's holding directories are not part of the site. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".~tmp~")) continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.sort();
}

/** relative path -> sha256 of every file. */
export function manifestOf(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of walk(dir)) m.set(f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"));
  return m;
}

export interface ManifestDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** What swapping `next` over `live` does. */
export function diffManifests(live: Map<string, string>, next: Map<string, string>): ManifestDiff {
  const added = [...next.keys()].filter((f) => !live.has(f));
  const removed = [...live.keys()].filter((f) => !next.has(f));
  const changed = [...next.keys()].filter((f) => live.has(f) && live.get(f) !== next.get(f));
  return { added, changed, removed };
}

/** True when two manifests hold exactly the same files with the same bytes. */
export function sameManifest(a: Map<string, string>, b: Map<string, string>): boolean {
  const d = diffManifests(a, b);
  return d.added.length + d.changed.length + d.removed.length === 0;
}

/**
 * A website-only redeploy claims that no container was touched. This is the proof: every service container that
 * was running before must still be running with the same id and the same start time, and none may have appeared.
 */
export function diffContainers(before: ContainerState[], after: ContainerState[]): string[] {
  const problems: string[] = [];
  const afterByName = new Map(after.map((c) => [c.name, c]));
  for (const b of before) {
    const a = afterByName.get(b.name);
    if (!a) problems.push(`${b.name} was running and is gone`);
    else if (a.id !== b.id) problems.push(`${b.name} was recreated (id ${b.id.slice(0, 12)} -> ${a.id.slice(0, 12)})`);
    else if (a.startedAt !== b.startedAt) problems.push(`${b.name} was restarted (${b.startedAt} -> ${a.startedAt})`);
  }
  const beforeNames = new Set(before.map((c) => c.name));
  for (const a of after) if (!beforeNames.has(a.name)) problems.push(`${a.name} is new`);
  return problems;
}

/**
 * Files that differ between the live commit and this tree. The site alone can be swapped in place. A change to the
 * nginx image (website-server/) needs the container recreated, which this tool does not do; a change to a compose
 * file only takes effect at the next full boot, which is worth saying but does not block.
 */
export function guardChangedFiles(files: string[]): { blockers: string[]; warnings: string[] } {
  const blockers = files.filter((f) => f.startsWith("website-server/"));
  const warnings = files.filter((f) => /^docker-compose(\.[a-z]+)?\.yml$/.test(f));
  return { blockers, warnings };
}

/**
 * The swap. `--checksum` leaves unchanged files alone so fewer files move; `--delay-updates` writes each changed
 * file under a holding name and renames them all into place at the end; `--delete-after` drops pages that left the
 * sitemap only once the new ones are in. Nothing here replaces the directory itself: the container's bind mount
 * follows the directory's inode.
 *
 * MODES. A deploy sets directories to 755 and files to 644, whoever built them: nginx in the container is another
 * user and needs to enter every directory. (`D755,F644` and not `Du=rwx,go=rx,Fu=rw,go=r`: in rsync each clause
 * applies to files AND directories unless it is prefixed, so the trailing `go=r` stripped the execute bit from every
 * directory and the site answered 500. scripts/tests/site-redeploy-integration.sh found that.) A ROLLBACK passes
 * `keepModes`: it must put back exactly what the backup holds, not what this tool believes modes should be.
 */
export function rsyncArgs(src: string, dst: string, opts: { keepModes?: boolean } = {}): string[] {
  return [
    "rsync", "-a", "--checksum", "--delay-updates", "--delete-after",
    ...(opts.keepModes ? [] : ["--chmod=D755,F644"]),
    `${src.replace(/\/+$/, "")}/`, `${dst.replace(/\/+$/, "")}/`,
  ];
}
