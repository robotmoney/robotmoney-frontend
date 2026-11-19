// v0.9.0's runbook and version checks Q38 to Q44 (C26 to C32) (scripts/release/version-checks/v0.9.0/,
// tracking issue 1647): the runbook's shape, and each check's decision with a passing case and a red
// control. The checks' reads (docker, the database, HTTP) are thin; the decisions are pure and tested here.
import { describe, expect, test } from "bun:test";
import { loadReleaseRunbook, stepNameOf, type RunbookStep } from "../../release/runbook.ts";
import { WEBSITE_HTML_CACHE, WEBSITE_ASSET_CACHE, WEBSITE_SECURITY_HEADERS, WEBSITE_IMAGE_LABELS } from "../../lib/website-image.ts";
import { webImageProblems, type WebImageRead } from "../../release/version-checks/v0.9.0/web-image.ts";
import type { WebsiteInspect } from "../../release/version-checks/v0.9.0/_web.ts";
import { serverImageProblems, signerLines, type ServerImageRead } from "../../release/version-checks/v0.9.0/server-image.ts";
import { PROBE_SLUG, routeProblems, routeRows, sitemapPaths, type Answer } from "../../release/version-checks/v0.9.0/web-routes.ts";
import { servedBundleProblems, webTagOf } from "../../release/version-checks/v0.9.0/web-bundle.ts";
import { apiCacheProblems, probePath, type CacheAnswer } from "../../release/version-checks/v0.9.0/api-cache.ts";
import { daysBetween, selectPublished, type ArtifactMeta, type Point } from "../../release/version-checks/v0.9.0/_regime.ts";
import { pinnedProblems, publishedProblems } from "../../release/version-checks/v0.9.0/regime-published.ts";
import { frozenProblems } from "../../release/version-checks/v0.9.0/regime-frozen.ts";
import { servingVersionProblem } from "../../release/web-release-lib.ts";
import { deployArgv, productionBundleProblems, type StageDeploy } from "../../release/platform-bundle.ts";
import { identityProblems } from "../../release/identity-check.ts";
import { readFileSync } from "node:fs";

describe("the v0.9.0 runbook", () => {
  const rb = loadReleaseRunbook("v0.9.0");
  const added = rb.steps.filter((s) => (s as RunbookStep).added === "v0.9.0");

  test("is kitchen-sink plus its own steps, every added step with a production twin of the same name", () => {
    expect(rb.template).toBe("kitchen-sink");
    expect(rb.breaking).toBeUndefined();
    const qa = added.filter((s) => s.phase === "qa").map((s) => stepNameOf(s.id));
    const prod = added.filter((s) => s.phase !== "qa").map((s) => stepNameOf(s.id));
    expect(qa.filter((n) => n !== "site-rollback-rehearsal")).toEqual(["site-bundle", "server-image-build", "site-bundle-deploy", "web-routes", "server-image", "web-image", "web-bundle", "api-cache", "regime-published", "regime-frozen"]);
    expect(prod).toEqual(qa.filter((n) => n !== "site-rollback-rehearsal"));
    expect(qa).toContain("site-rollback-rehearsal");
    for (const s of added) expect(s.irreversible).toBe(false);
  });

  test("every version check runs a v0.9.0 check file that exists, and reads only (no stageOnly write)", () => {
    for (const s of added.filter((x) => !/-build$|^site-/.test(stepNameOf(x.id)))) {
      const argv = s.cmds[0]!;
      expect(argv.slice(0, 2)).toEqual(["bun", "scripts/release/version-check.ts"]);
      const name = argv[argv.indexOf("--check") + 1]!;
      expect(name).toBe(stepNameOf(s.id));
      expect(Bun.file(`${import.meta.dir}/../../release/version-checks/v0.9.0/${name}.ts`).size).toBeGreaterThan(0);
      expect((s as RunbookStep & { stageOnly?: boolean }).stageOnly).toBeUndefined();
    }
  });

  test("its scope lists exactly the 15 PRs of v0.8.0..af3ec970, each version check naming a step of this runbook", () => {
    expect(rb.scope.map((e) => e.pr).sort((a, b) => a - b)).toEqual([1417, 1620, 1633, 1634, 1635, 1636, 1637, 1638, 1639, 1640, 1641, 1642, 1643, 1645, 1646]);
    const ids = new Set(rb.steps.map((s) => s.id));
    for (const e of rb.scope) if (e.check !== undefined) expect(ids.has(e.check)).toBe(true);
    expect(rb.scope.find((e) => e.pr === 1646)?.check).toBe("Q43-regime-published");
    expect(rb.scope.find((e) => e.pr === 1635)?.check).toBe("Q42-api-cache");
  });

  test("its recovery names the web rollback and the first-rollout fallback", () => {
    expect(rb.recovery).toContain("--rollback");
    expect(rb.recovery).toContain("first-rollout");
  });
});

// ── Q40-web-image ────────────────────────────────────────────────────────────

const SHA = "a".repeat(64);
const siteContainer = (over: Partial<WebsiteInspect> = {}, hc: Partial<WebsiteInspect["HostConfig"]> = {}): WebsiteInspect => ({
  Id: "c1", Name: "/rm_smoke_stack_x-website-server-1", Image: "sha256:img",
  State: { Running: true, Health: { Status: "healthy" } },
  Config: { Image: "robotmoney-website:rm_prod-current", User: "65534:65534", Labels: { [WEBSITE_IMAGE_LABELS.tag]: "web-v0.9.0", [WEBSITE_IMAGE_LABELS.commit]: "0123456789ab", [WEBSITE_IMAGE_LABELS.bundleSha256]: SHA, [WEBSITE_IMAGE_LABELS.serverCommit]: "fedcba987654" } },
  HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/config": "", "/data": "", "/srv/maintenance": "" }, Binds: [], ...hc },
  Mounts: [],
  ...over,
});
const nginx: WebsiteInspect = {
  Id: "n1", Name: "/rm_smoke_stack_x-website-server-1", Image: "sha256:nginx", State: { Running: true, Health: { Status: "healthy" } },
  Config: { Image: "rm_smoke_stack_x-website-server", User: "", Labels: { "com.docker.compose.service": "website-server" } },
  HostConfig: { ReadonlyRootfs: false, Binds: ["/root/.local/state/robotmoney-smoke/rm_prod/web:/srv/web:ro"] },
  Mounts: [{ Type: "bind", Source: "/root/.local/state/robotmoney-smoke/rm_prod/web", Destination: "/srv/web" }],
};
const read = (over: Partial<WebImageRead> = {}): WebImageRead => {
  const c = siteContainer();
  return { running: [c], all: [c], currentImage: "sha256:img", previousImage: "sha256:prev", diff: "", ...over };
};

describe("Q40-web-image/C28-web-image (P4 1639, P5 1640, P8 1643, P9 1642)", () => {
  test("passes: a site image, -current, read-only, no mount, hardened, healthy, unchanged, with a previous image", () => {
    expect(webImageProblems(read())).toEqual([]);
  });
  test("passes on a first rollout: the stopped <name>-first-rollout container is the rollback target", () => {
    const kept = { ...nginx, Name: "/rm_smoke_stack_x-website-server-1-first-rollout", State: { Running: false } };
    expect(webImageProblems(read({ previousImage: null, all: [siteContainer(), kept] }))).toEqual([]);
  });
  test("red: nginx serving (the first rollout has not happened) fails, naming the bind mount", () => {
    const p = webImageProblems(read({ running: [nginx], all: [nginx] }));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("first rollout");
  });
  test("red: each hardening the spec names, the -current tag, the served root and the rollback target", () => {
    const one = (r: WebImageRead) => webImageProblems(r).join("\n");
    expect(one(read({ running: [siteContainer({}, { ReadonlyRootfs: false })] }))).toContain("writable");
    expect(one(read({ running: [siteContainer({ Mounts: [{ Type: "bind", Source: "/x/web", Destination: "/srv/web" }] })] }))).toContain("bind");
    expect(one(read({ running: [siteContainer({}, { Tmpfs: { "/config": "" } })] }))).toContain("/data, /srv/maintenance");
    expect(one(read({ running: [siteContainer({ Config: { ...siteContainer().Config, User: "" } })] }))).toContain("not 65534:65534");
    expect(one(read({ running: [siteContainer({}, { CapDrop: [] })] }))).toContain("CapDrop");
    expect(one(read({ running: [siteContainer({}, { SecurityOpt: [] })] }))).toContain("no-new-privileges");
    expect(one(read({ running: [siteContainer({ State: { Running: true, Health: { Status: "unhealthy" } } })] }))).toContain("unhealthy");
    expect(one(read({ currentImage: "sha256:other" }))).toContain("-current names");
    expect(one(read({ currentImage: null }))).toContain("-current tag");
    expect(one(read({ diff: "C /srv/web/current/index.html\nA /tmp/x" }))).toContain("/srv/web/current/index.html");
    expect(one(read({ diff: null }))).toContain("docker diff");
    expect(one(read({ previousImage: null }))).toContain("no rollback target");
    expect(one(read({ running: [] }))).toContain("0 website-server");
    expect(one(read({ running: [siteContainer({ Config: { ...siteContainer().Config, Labels: { [WEBSITE_IMAGE_LABELS.tag]: "v1" } } })] }))).toContain("not a web-vA.B.C tag");
  });
});

// ── Q39-server-image ─────────────────────────────────────────────────────────

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SIGNERS = '# comment\n\nweb-bundle@robotmoney namespaces="robotmoney-web-bundle@v1" ssh-ed25519 AAAAkey\n';
const serverRead = (over: Partial<ServerImageRead> = {}): ServerImageRead => ({ id: "sha256:srv", labels: { [WEBSITE_IMAGE_LABELS.serverCommit]: COMMIT }, user: "65534:65534", signers: SIGNERS, runtimes: "", ...over });

describe("Q39-server-image/C27-server-image (P2 1637, P4 1639)", () => {
  test("passes: built at the release commit, the release's signers, non-root, no runtime", () => {
    expect(serverImageProblems("robotmoney-website-server:rm_prod", serverRead(), COMMIT, SIGNERS)).toEqual([]);
    expect(signerLines(SIGNERS)).toHaveLength(1);
  });
  test("red: no image, another commit, other signers, an unscoped key, root, a JavaScript runtime", () => {
    const one = (r: ServerImageRead, committed = SIGNERS) => serverImageProblems("img", r, COMMIT, committed).join("\n");
    expect(one(serverRead({ id: null }))).toContain("server-image-build");
    expect(one(serverRead({ labels: { [WEBSITE_IMAGE_LABELS.serverCommit]: "deadbeef" } }))).toContain("not the release commit");
    expect(one(serverRead(), `${SIGNERS}other namespaces="robotmoney-web-bundle@v1" ssh-ed25519 BBBB\n`)).toContain("differ");
    expect(one(serverRead({ signers: "k ssh-ed25519 AAAA\n" }), "k ssh-ed25519 AAAA\n")).toContain("not scoped");
    expect(one(serverRead({ signers: null }))).toContain("no readable");
    expect(one(serverRead({ user: "" }))).toContain("not 65534:65534");
    expect(one(serverRead({ runtimes: "/usr/local/bin/bun\n" }))).toContain("JavaScript runtime");
  });
});

// ── Q38-web-routes ───────────────────────────────────────────────────────────

const PAGE_HEADERS = { ...WEBSITE_SECURITY_HEADERS, "cache-control": WEBSITE_HTML_CACHE };
const ASSET_HEADERS = { "cache-control": WEBSITE_ASSET_CACHE };
const goodAnswers = (rows: ReturnType<typeof routeRows>): Map<string, Answer> => new Map(rows.map((r) => {
  const headers = r.kind === "asset" ? ASSET_HEADERS : r.kind === "proxy" || r.kind === "missing" ? {} : PAGE_HEADERS;
  return [r.path, { path: r.path, status: r.kind === "missing" ? 404 : 200, headers, body: r.kind === "fallback" ? "<title>shell</title>" : r.kind === "missing" ? "not found" : "ok" }];
}));

describe("Q38-web-routes/C26-web-routes (P1 1636)", () => {
  const rows = routeRows(sitemapPaths("<urlset><url><loc>https://robotmoney.network/</loc></url><url><loc>https://robotmoney.network/regime</loc></url><url><loc>https://robotmoney.network/swarm</loc></url></urlset>"));
  test("the rows: the fixed contract, then each sitemap route once", () => {
    expect(rows.filter((r) => r.kind === "page").map((r) => r.path)).toEqual(["/", "/regime", "/swarm"]);
    expect(rows.some((r) => r.kind === "missing" && r.path.includes(PROBE_SLUG))).toBe(true);
  });
  test("passes when every row holds", () => {
    expect(routeProblems(rows, goodAnswers(rows))).toEqual([]);
  });
  test("red: a missing asset answered by the shell, a page without its headers, a compressed answer, a proxy 502", () => {
    const a = goodAnswers(rows);
    const missing = rows.find((r) => r.kind === "missing")!.path;
    a.set(missing, { path: missing, status: 200, headers: PAGE_HEADERS, body: "<title>shell</title>" });
    a.set("/regime", { path: "/regime", status: 200, headers: { "cache-control": "max-age=60" }, body: "ok" });
    a.set("/swarm", { path: "/swarm", status: 200, headers: { ...PAGE_HEADERS, "content-encoding": "gzip" }, body: "ok" });
    a.set("/api/version", { path: "/api/version", status: 502, headers: {}, body: "" });
    const p = routeProblems(rows, a).join("\n");
    expect(p).toContain(`${missing}: answered 200, not 404`);
    expect(p).toContain("/regime: header content-security-policy");
    expect(p).toContain("/swarm: the server compressed");
    expect(p).toContain("/api/version: answered 502");
    const shellOnMissing = goodAnswers(rows);
    shellOnMissing.set(missing, { path: missing, status: 404, headers: {}, body: "<title>shell</title>" });
    expect(routeProblems(rows, shellOnMissing).join()).toContain("answered with the shell");
    expect(routeProblems(routeRows([]), goodAnswers(routeRows([]))).join()).toContain("no route besides /");
  });
});

// ── Q41-web-bundle ───────────────────────────────────────────────────────────

describe("Q41-web-bundle/C29-web-bundle (P3 1638)", () => {
  test("the web tag of the served /version.json; none when it names no version", () => {
    expect(webTagOf('{"version":"0.9.0","commit":"0123abcd"}')).toEqual({ tag: "web-v0.9.0", version: "0.9.0", commit: "0123abcd" });
    expect("error" in webTagOf(null)).toBe(true);
    expect("error" in webTagOf('{"version":"0.9.0"}')).toBe(true);
  });
  test("passes when every manifest file is served with its sha256; red on a changed, missing or unfetched file", () => {
    const manifest = { format: "robotmoney-web-bundle-manifest@v1" as const, files: [{ path: "index.html", sha256: SHA, size: 1 }, { path: "app.js", sha256: "b".repeat(64), size: 1 }] };
    const ok = [{ path: "index.html", url: "/", status: 200, sha256: SHA }, { path: "app.js", url: "/app.js", status: 200, sha256: "b".repeat(64) }];
    expect(servedBundleProblems(manifest, ok)).toEqual([]);
    expect(servedBundleProblems(manifest, [ok[0]!, { ...ok[1]!, sha256: "c".repeat(64) }]).join()).toContain("not the manifest's app.js");
    expect(servedBundleProblems(manifest, [ok[0]!, { ...ok[1]!, status: 404, sha256: null }]).join()).toContain("answered 404");
    expect(servedBundleProblems(manifest, [ok[0]!]).join()).toContain("app.js: not fetched");
    expect(servedBundleProblems({ ...manifest, files: [] }, []).join()).toContain("lists no file");
  });
});

// ── Q42-api-cache ────────────────────────────────────────────────────────────

describe("Q42-api-cache/C30-api-cache (P6 1635)", () => {
  const good: CacheAnswer[] = [{ via: "api", status: 200, cacheStatus: "MISS" }, { via: "api", status: 200, cacheStatus: "HIT" }, { via: "website-server", status: 200, cacheStatus: "HIT" }];
  const NGINX = "server {\n  location ^~ /api/ {\n    proxy_pass $api_upstream;\n  }\n}\n";
  test("the probe is a public list with a one-off query value", () => {
    expect(probePath("123")).toBe("/api/public/analytics/reports?limit=1&rm-v090-cache=123");
  });
  test("passes: the api's MISS then HIT, the web server passing HIT through, and no web cache", () => {
    expect(apiCacheProblems(good, { kind: "nginx", text: NGINX })).toEqual([]);
    expect(apiCacheProblems(good, { kind: "caddy", text: 'header Cache-Control "no-cache"\n' })).toEqual([]);
  });
  test("red: v0.8.0's api (no header), nginx's own statuses, a stored proxy_cache, an unreadable config", () => {
    const v080 = [{ ...good[0]!, cacheStatus: null }, { ...good[1]!, cacheStatus: null }, { ...good[2]!, cacheStatus: "EXPIRED" }];
    const p = apiCacheProblems(v080, { kind: "nginx", text: `proxy_cache_path /var/cache/nginx/x keys_zone=p:10m;\n${NGINX}` }).join("\n");
    expect(p).toContain("not MISS");
    expect(p).toContain("not HIT");
    expect(p).toContain("EXPIRED is not the api's");
    expect(p).toContain("proxy_cache");
    expect(apiCacheProblems(good, null).join()).toContain("could not be read");
    expect(apiCacheProblems(good.slice(0, 2), null).join()).toContain("2 of the 3");
  });
});

// ── Q43-regime-published and Q44-regime-frozen ───────────────────────────────

// Production's shape (issue 1182, 2026-11-14): the first carrying run's as-of is 2026-09-21; 09-28's only run
// was written on 09-29 (after the outage); no run has as-of 09-29; 09-30 has a run during the day and a
// later one written two days after, which must not publish.
const art = (id: number, runId: number, asof: string, writtenOn: string, carries = true): ArtifactMeta => ({ id, runId, asof, writtenOn, carries });
const LEDGER: ArtifactMeta[] = [
  art(1, 5, "2026-09-20", "2026-09-20", false),
  art(2, 20, "2026-09-21", "2026-09-21"),
  art(3, 21, "2026-09-21", "2026-09-21"),
  art(4, 30, "2026-09-21", "2026-09-23"),
  art(5, 243, "2026-09-28", "2026-09-29"),
  art(6, 264, "2026-09-30", "2026-09-30"),
  art(7, 300, "2026-09-30", "2026-10-02"),
];

describe("the D83 selection (./_regime.ts)", () => {
  test("the last artifact written during the day; else the first after; a day with no run is a gap", () => {
    const sel = selectPublished(LEDGER, "2026-09-30");
    expect(sel.start).toBe("2026-09-21");
    expect(sel.first?.id).toBe(2);
    expect(sel.byDay.get("2026-09-21")?.id).toBe(3);
    expect(sel.byDay.get("2026-09-28")?.id).toBe(5);
    expect(sel.byDay.get("2026-09-30")?.id).toBe(6);
    expect(sel.gaps).toEqual(["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-29"]);
    expect(selectPublished([art(1, 1, "2026-09-20", "2026-09-20", false)], "2026-09-30").start).toBeNull();
    expect(daysBetween("2026-09-30", "2026-10-02")).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

const pt = (date: string, composite: number | null, regime: string | null = "neutral"): Point => ({ date, composite, regime });

describe("Q43-regime-published/C31-regime-published (1646, D83)", () => {
  const sel = selectPublished(LEDGER, "2026-09-30");
  const before = new Map([["2026-09-20", pt("2026-09-20", 0.5)]]);
  const rows = new Map([["2026-09-21", pt("2026-09-21", 0.5759, "risk_on")], ["2026-09-28", pt("2026-09-28", 0.5538)], ["2026-09-30", pt("2026-09-30", 0.5592)]]);
  const served = (history: Point[]) => ({ today: "2026-09-30", source: "ledger", history });
  const good = [pt("2026-09-20", 0.5), pt("2026-09-21", 0.5759, "risk_on"), pt("2026-09-28", 0.5538), pt("2026-09-30", 0.5592)];
  test("passes: exactly the published days, each with its chosen artifact's figure", () => {
    expect(publishedProblems(sel, before, rows, served(good), true)).toEqual([]);
  });
  test("red: the compatibility table's source, a recomputed figure, a gap filled, a published day missing", () => {
    expect(publishedProblems(sel, before, rows, { ...served(good), source: "regime_snapshots" }, true).join()).toContain("not the ledger");
    const moved = good.map((p) => (p.date === "2026-09-21" ? pt(p.date, 0.6258, "neutral") : p));
    expect(publishedProblems(sel, before, rows, served(moved), true).join()).toContain("2026-09-21 served 0.6258 neutral, published 0.5759 risk_on");
    expect(publishedProblems(sel, before, rows, served([...good.slice(0, 3), pt("2026-09-29", 0.55), good[3]!]), true).join()).toContain("no artifact published");
    expect(publishedProblems(sel, before, rows, served(good.filter((p) => p.date !== "2026-09-28")), true).join()).toContain("not served: 2026-09-28");
    expect(publishedProblems(selectPublished([], "2026-09-30"), new Map(), new Map(), served([]), true).join()).toContain("nothing has been published");
  });
  test("today's row is compared only when no artifact landed during the read", () => {
    const todayMoved = good.map((p) => (p.date === "2026-09-30" ? pt(p.date, 0.6) : p));
    expect(publishedProblems(sel, before, rows, served(todayMoved), false)).toEqual([]);
    expect(publishedProblems(sel, before, rows, served(todayMoved), true)).toHaveLength(1);
  });
  test("production's recorded figures, only on a ledger that starts 2026-09-21", () => {
    const prod = [pt("2026-09-21", 0.57591, "risk_on"), pt("2026-09-26", 0.6176, "risk_on"), pt("2026-09-27", 0.5775, "risk_on"), pt("2026-09-28", 0.5538)];
    expect(pinnedProblems("2026-09-21", prod)).toEqual([]);
    expect(pinnedProblems("2026-10-01", [])).toEqual([]);
    const red = pinnedProblems("2026-09-21", [pt("2026-09-21", 0.6258, "risk_on"), pt("2026-09-26", 0.5487, "neutral"), pt("2026-09-29", 0.5)]).join("\n");
    expect(red).toContain("2026-09-21 is served composite 0.6258, published 0.5759");
    expect(red).toContain("2026-09-26 is served neutral, published risk_on");
    expect(red).toContain("2026-09-27 is not served");
    expect(red).toContain("2026-09-29 is served");
  });
});

describe("Q44-regime-frozen/C32-regime-frozen (1646, issue 1182 release evidence)", () => {
  const a = [pt("2026-11-12", 0.51), pt("2026-11-13", 0.52), pt("2026-11-14", 0.53)];
  test("passes: every ended day unchanged; today's row and a new day may move", () => {
    expect(frozenProblems(a, [pt("2026-11-12", 0.51), pt("2026-11-13", 0.52), pt("2026-11-14", 0.6), pt("2026-11-15", 0.61)], "2026-11-14")).toEqual([]);
  });
  test("red: an ended day moved or vanished; nothing ended to compare", () => {
    const p = frozenProblems(a, [pt("2026-11-12", 0.49, "risk_off"), pt("2026-11-14", 0.53)], "2026-11-14").join("\n");
    expect(p).toContain("2026-11-12 moved from 0.51 neutral to 0.49 risk_off");
    expect(p).toContain("2026-11-13 was served 0.52 neutral, now absent");
    expect(frozenProblems([pt("2026-11-14", 0.5)], [pt("2026-11-14", 0.5)], "2026-11-14").join()).toContain("no ended day");
  });
  test("a range-capped history that dropped its oldest day is compared from its own first day", () => {
    expect(frozenProblems(a, [pt("2026-11-13", 0.52), pt("2026-11-14", 0.53)], "2026-11-14")).toEqual([]);
  });
});

// ── The first rollout (owner decision 2026-11-15): platform-bundle.ts and identity-check ─────────────

describe("the first rollout's steps: the bundle is built on stage and production deploys only the stage-passed bytes", () => {
  const rb = loadReleaseRunbook("v0.9.0");
  const ids = rb.steps.map((s) => s.id);
  test("order: build before the backup, the server image before the site, the deploy after the template's site step and inside the probe", () => {
    const at = (id: string) => ids.indexOf(id);
    expect(at("Q13a-site-bundle")).toBeLessThan(at("Q14-backup"));
    expect(at("Q16a-server-image-build")).toBeLessThan(at("Q17-probe-start"));
    expect(at("C03a-server-image-build")).toBeLessThan(at("C04-probe-start"));
    expect(at("Q24b-site-bundle-deploy")).toBeLessThan(at("Q24c-site-rollback-rehearsal"));
    expect(rb.steps.find((s) => s.id === "Q24c-site-rollback-rehearsal")?.cmds[0]).toContain("--rollback");
    expect(at("Q24-site")).toBeLessThan(at("Q24b-site-bundle-deploy"));
    expect(at("Q24b-site-bundle-deploy")).toBeLessThan(at("Q25-probe-grade"));
    expect(at("P08-log-baseline")).toBeLessThan(at("P08a-site-bundle"));
    expect(at("C12-site")).toBeLessThan(at("C12b-site-bundle-deploy"));
    expect(at("C12b-site-bundle-deploy")).toBeLessThan(at("C13-probe-grade"));
    for (const id of ["Q13a-site-bundle", "P08a-site-bundle", "Q24b-site-bundle-deploy", "C12b-site-bundle-deploy"]) expect(rb.steps.find((s) => s.id === id)?.host).toBe("control");
  });

  const deployed: StageDeploy = { release: "v0.9.0", runTs: "20261115T000000Z", commit: "a".repeat(40), sha256: SHA, file: "/x/robotmoney-web-0.1.0-aaaaaaa.tar.gz", at: "t" };
  const passed = { status: "passed" as const, tree: "T", commit: "b".repeat(40), commits: [{ commit: "a".repeat(40), tree: "T0", goSha256: "", fromStep: "", at: "" }, { commit: "b".repeat(40), tree: "T", goSha256: "", fromStep: "", at: "" }] };
  test("production may deploy the bundle a passed stage run of the same tree deployed, with its digest unchanged", () => {
    expect(productionBundleProblems(deployed, passed, "T", SHA)).toEqual([]);
  });
  test("red: no stage deploy, a failed or other-tree run, a bundle from a commit the run never ran, a changed or missing file", () => {
    expect(productionBundleProblems(undefined, passed, "T", SHA).join()).toContain("no stage-deploy.json");
    expect(productionBundleProblems(deployed, { ...passed, status: "failed" }, "T", SHA).join()).toContain("not passed");
    expect(productionBundleProblems(deployed, passed, "OTHER", SHA).join()).toContain("not the production commit's tree");
    expect(productionBundleProblems(deployed, { ...passed, commits: [] }, "T", SHA).join()).toContain("never ran at");
    expect(productionBundleProblems(deployed, passed, "T", "c".repeat(64)).join()).toContain("not the stage-passed digest");
    expect(productionBundleProblems(deployed, passed, "T", null).join()).toContain("gone from the store");
    expect(productionBundleProblems(deployed, undefined, "T", SHA).join()).toContain("no readable run.json");
  });
  test("the deploy is web release W10's smoke:web command, with the bundle file and the instance's server image", () => {
    expect(deployArgv("rm-frontend-prod-1", "rm_prod", "/s/b.tar.gz", "https://robotmoney.network")).toEqual(["bun", "run", "smoke:web", "--host", "rm-frontend-prod-1", "--instance", "rm_prod", "--bundle", "/s/b.tar.gz", "--server-image", "robotmoney-website-server:rm_prod", "--origin", "https://robotmoney.network"]);
  });
  test("the committed allowed-signers holds one key, scoped to the namespace, and no bootstrap entry", () => {
    const lines = readFileSync(`${import.meta.dir}/../../../website-server/allowed-signers`, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("AAAAC3NzaC1lZDI1NTE5AAAAIPNcM9dzbTx");
  });
});

describe("identity-check: a signed bundle built at the QA commit names production's site (Q26/C14)", () => {
  const RC = "b".repeat(40);
  const api = JSON.stringify({ api: "x", commit: RC });
  test("/version.json naming the QA commit passes only when the checkout says its site tree equals the rc's", () => {
    const site = JSON.stringify({ version: "0.1.0", commit: "aaaaaaa" });
    expect(identityProblems(api, null, site, RC, RC, false, (c) => c === "aaaaaaa")).toEqual([]);
    expect(identityProblems(api, null, site, RC, RC, false, () => false).join()).toContain("does not name");
    expect(identityProblems(api, null, site, RC).join()).toContain("does not name");
    expect(identityProblems(api, null, JSON.stringify({ commit: "bbbbbbb" }), RC)).toEqual([]);
  });
});

describe("W01 refuses a web version that would reuse the tag name of a platform-deployed bundle (review finding 1)", () => {
  test("a serving web-v0.1.0 with no git tag reserves 0.1.0 and below; a real tag leaves it to versionProblems", () => {
    const serving = { tag: "web-v0.1.0", digest: SHA };
    expect(servingVersionProblem(serving, "0.1.0", new Map())).toContain("not above it");
    expect(servingVersionProblem(serving, "0.0.9", new Map())).toContain("not above it");
    expect(servingVersionProblem(serving, "0.1.1", new Map())).toBeUndefined();
    expect(servingVersionProblem(serving, "0.1.0", new Map([["web-v0.1.0", "abc"]]))).toBeUndefined();
    expect(servingVersionProblem({}, "0.1.0", new Map())).toBeUndefined();
  });
});

describe("Q44's next regime run is one that holds rows (stage run 20261115T082237Z)", () => {
  test("newestArtifactId skips the empty [] regime artifacts the producer writes after a research tick", async () => {
    const { newestArtifactId, EMPTY_ARTIFACT_BYTES } = await import("../../release/version-checks/v0.9.0/_regime.ts");
    expect(EMPTY_ARTIFACT_BYTES).toBe(Buffer.byteLength("[]"));
    const sql: string[] = [];
    const db = { query: async (q: string) => { sql.push(q); return [{ id: "2329" }]; } };
    expect(await newestArtifactId(db as never)).toBe(2329);
    expect(sql[0]).toContain("artifact_kind = 'regime_snapshots'");
    expect(sql[0]).toContain(`octet_length(payload_bytes) > ${EMPTY_ARTIFACT_BYTES}`);
  });
});
