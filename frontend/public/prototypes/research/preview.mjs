// Local-only review server. No deployment or backend mutations. Production
// adoption should use the site's existing server rendering and routing paths.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { adapt, stressRecords } from "./data.js";
import { subjectPage, sessionPage, catalogue, subjectPath } from "./pages.js";
import { esc } from "../../assets/js/app/components/research.js";
const productOrigin = new URL(
  process.env.RM_RESEARCH_PRODUCT_ORIGIN || "http://127.0.0.1:32782",
).origin;
const publicRoot = fileURLToPath(new URL("../../", import.meta.url));
const readJSON = async (path) =>
  JSON.parse(await readFile(resolve(publicRoot, path), "utf8"));
const index = await readJSON("data/swarm/sessions/index.json");
const members = Object.fromEntries(
  await Promise.all(
    ["athena", "robotmoney", "woon"].map(async (id) => [
      id,
      await readJSON(`data/swarm/manifests/members/${id}.json`),
    ]),
  ),
);
const archive = await Promise.all(
  index.sessions
    .filter((s) => s.subject_id === "robotmoney-allocation")
    .map(async (s) =>
      adapt(
        await readJSON(`data/swarm/sessions/${s.file}`),
        await readJSON(
          `data/swarm/briefs/${s.date}-robotmoney-allocation.json`,
        ).catch(() => null),
        members,
      ),
    ),
);
archive.sort((a, b) => b.date.localeCompare(a.date));
const stress = stressRecords(archive);
function asJSON(mode, records, record) {
  return {
    schemaVersion: 1,
    subject: {
      id: "robotmoney-allocation",
      name: "Robot Money Allocation",
      kind: "allocation_policy",
      role: "Flagship policy guiding vault allocation; distinct from portfolio assessments",
    },
    provenance: {
      mode: mode === "stress" ? "synthetic-scale-test" : "repository-archive",
      live: false,
      execution: "unreported",
      units: {
        weights: "percent of total allocation",
        withinSleeveWeights: "fraction of sleeve",
        changes: "percentage points",
        conviction: "self-reported fraction",
      },
      sourceIntegrity:
        "Archived prose preserved; stress mode deliberately repeats passages under synthetic identities",
    },
    ...(record ? { session: record } : { sessions: records }),
  };
}
function shell(source, content, title, url) {
  let html = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<title>[\s\S]*?<\/title>/,
      `<title>${esc(title)} · Robot Money</title>`,
    )
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")
    .replace(/<link rel="canonical"[^>]*>/g, "")
    .replace(/<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g, "")
    .replace(
      /<meta name="description"[^>]*>/g,
      '<meta name="description" content="Robot Money Allocation research: published recommendations, analyst reasoning and source records.">',
    )
    .replace(
      /<script type="module" src="\/assets\/js\/app\/main.js"><\/script>/,
      '<script type="module" src="/prototypes/research/client.js"></script>',
    )
    .replace(
      /<script[^>]+(?:p5-1.11.2|chart-4.5.1|simplewebauthn)[^>]*><\/script>/g,
      "",
    )
    .replace(
      '<main id="view"></main>',
      `<a class="rr-skip" href="#research">Skip to research</a><main id="research" tabindex="-1">${content}</main>`,
    )
    .replace(
      "</head>",
      `<link rel="stylesheet" href="/assets/css/components/research.css"><link rel="alternate" type="application/json" href="${esc(url.pathname + "?" + (url.searchParams.get("data") === "stress" ? "data=stress&" : "") + "format=json")}"></head>`,
    );
  return html;
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.RM_RESEARCH_PORT || 0),
  async fetch(req) {
    const url = new URL(req.url),
      pathname = decodeURIComponent(url.pathname),
      mode = url.searchParams.get("data") === "stress" ? "stress" : "archive",
      records = mode === "stress" ? stress : archive;
    if (req.method !== "GET" && req.method !== "HEAD")
      return new Response("Read-only design preview", { status: 405 });
    const dated = pathname.match(
        /^\/swarm\/(\d{4}-\d{2}-\d{2})\/robotmoney-allocation\/?$/,
      ),
      scale = pathname.match(/^\/swarm\/sessions\/(scale-\d+)$/);
    const record = dated
      ? archive.find((r) => r.date === dated[1])
      : scale
        ? stress.find((r) => r.id === scale[1])
        : null;
    if (
      pathname === subjectPath ||
      record ||
      pathname === "/prototypes/research/components"
    ) {
      const usedMode = record?.mode || mode,
        usedRecords = usedMode === "stress" ? stress : archive;
      if (url.searchParams.get("format") === "json")
        return Response.json(asJSON(usedMode, usedRecords, record), {
          headers: { "Cache-Control": "no-store" },
        });
      const content = record
        ? sessionPage(record, usedRecords)
        : pathname.endsWith("/components")
          ? catalogue(archive[0])
          : subjectPage(records, mode);
      const html = shell(
        await readFile(resolve(publicRoot, "index.html"), "utf8"),
        content,
        record ? "Allocation review · " + record.date : "Allocation research",
        url,
      );
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (dated || scale)
      return new Response("Session not found in this review dataset", {
        status: 404,
      });
    const file = resolve(publicRoot, "." + pathname);
    if (!file.startsWith(publicRoot))
      return new Response("Not found", { status: 404 });
    if (extname(file)) {
      const data = Bun.file(file);
      if (await data.exists())
        return new Response(data, { headers: { "Cache-Control": "no-store" } });
    }
    // Other existing product routes stay on the user's original review server.
    if (!extname(pathname))
      return Response.redirect(
        productOrigin + url.pathname + url.search + url.hash,
        302,
      );
    return new Response("Not found", { status: 404 });
  },
});
console.log(
  `Allocation research review: http://127.0.0.1:${server.port}${subjectPath}`,
);
console.log(
  `Session review: http://127.0.0.1:${server.port}/swarm/2026-06-24/robotmoney-allocation`,
);
