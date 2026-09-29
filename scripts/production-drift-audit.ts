// Production drift audit — an OBSERVER, never a gate.
//
// WHAT THIS IS. A schedule-only auditor (.github/workflows/production-drift-audit.yml)
// that answers THREE questions about things deployed OUTSIDE this repository
// and writes down what it saw. It is the workflow, not a test: it has no pass
// semantics, it is not a required check, and it is deliberately absent from the
// merge-to-main set (see E6 in docs/architecture.md and the single entry this
// repo added to EXEMPT_FROM_MERGE_MIRROR in
// scripts/tests/unit/nightly-mirrors-merge-set.test.ts).
//
// THE CHECK LIST, IN FULL — THERE ARE FOUR AND THIS IS ALL OF THEM:
//   A. Does the rmpc release the onboarding skill PINS still exist, and does
//      robotmoney-core still publish archives whose sha256 match the ones the
//      skill CARRIES? (release integrity)
//   B. Does SWARM_ONBOARDING_SKILL_URL still serve a real, complete procedure
//      rather than a deprecation stub? (reachability + procedure, merged from
//      the merge-gated live test's assertion set)
//   C. Does the SERVED copy carry an unverified `curl … | tar xz` install
//      form? (a security floor, not a content comparison)
//   D. NEGATIVE CONTROL: do B's own discriminators actually fire? A sibling
//      path on the same host that cannot exist is fetched with the same code
//      and the same markers, and the result is reported as its own row —
//      because a check that cannot tell a real procedure from a wrong document
//      is not a check. (see the D section for what each outcome reports)
//
// ── WHAT WAS DELETED FROM THIS AUDITOR, AND WHY ───────────────────────────
// A fourth check used to live here, lettered "A" in the old numbering: "do the
// bytes deployed at the skill URL match the repo-local copy?" — the
// deploy-freshness question, implemented by `describeSkillMismatch` in
// `contract/src/skill-parity.js`. That module and its offline unit test have
// been DELETED along with it. This repository's tooling does not ask the
// deploy-freshness question at all any more — not here, not on any merge gate,
// not offline. That is the repository owner's decision, and this paragraph is
// the record of it, so that the absence reads as a decision on the record
// rather than as a gap nobody has noticed yet.
//
// The consequence, stated plainly so it is never discovered the hard way:
// NOTHING IN CI REPORTS A STALE DEPLOY. If `main` carries a correct skill and
// production is still serving the previous one, no job in this repository — no
// required check, not this auditor, not any unit test — will say so. Deploy
// freshness is now the DEPLOY PIPELINE's job. It is a fact about whether a
// publish ran, and this repository has no deploy workflow, so the only place
// that fact can be observed is the deploy tooling or a human watching it.
// Do not "repair" this by reintroducing a served-vs-repo byte comparison, under
// this name or any other, and do not "repair" it by giving this workflow a
// non-zero exit (see EXIT SEMANTICS below): the first would be the exact check
// the owner declined, the second would re-create required reading whose exit
// is outside the repository.
//
// The question was never a strong one, and check A below is why, stated as fact
// rather than as argument. The skill pins `rmpc-v0.3.4` and CARRIES that
// release's checksums inside its own bytes (RM-148). If robotmoney-core ever
// yanks that release, replaces an archive, or re-uploads it, every NEW member's
// install breaks at the verify step — and a served-vs-repo byte comparison is
// blind to that by construction, because in that scenario the two copies
// continue to match each other perfectly. Deploy freshness was also never the
// same question as "is what production is serving safe to install?"; that one
// is still asked, independently, by check C below.
//
// ── WHAT MOVED OFF THE MERGE GATE, AND WHY ────────────────────────────────
// The deleted live test file used to bundle three unrelated questions in one
// required merge gate, and now bundles none of them: the file and the
// `contract/tests/live/` directory are DELETED, and every assertion it held
// lives here instead. Nothing in this repository's merge gate reaches
// robotmoney.network any more.
//
//   (1) "is the endpoint serving a real, complete procedure?" — check B. It
//       earns its place by answering a MEASURED question: robotmoney-core
//       replaced the path with a 1,951-byte deprecation stub that passed every
//       marker assertion (robotmoney-core #1199 / PR #1200). It also LEFT the
//       gate, and the reason is not a preference for schedules — it is that the
//       question is not a property of the commit under review. Whether
//       robotmoney.network answers is a fact about deploys, DNS, TLS, CDN state
//       and upstream renames in robotmoney-core, none of which any diff in this
//       repository can repair. A required job that reaches the public internet
//       on every pull request makes a contributor with a flaky connection, or an
//       upstream hiccup, hold an unmergeable PR for a reason the diff cannot
//       fix. It was proved during this change: the `contract` job was RED on a
//       pull request with `Received: 502`, caused by nobody in the pull request.
//
//   (2) "is the served copy safe to install?" — the unverified `| tar` floor.
//       Check C, asserted over the served body directly so it fires whatever
//       else is true about the document, with its own status line and its own
//       UNKNOWN-never-a-pass semantics.
//
//   (3) "is the deploy fresh?" — deleted from the repository outright long ago.
//       See the section above.
//
//   (4) the live test's RED CONTROL — the proof that (1)'s discriminators fire
//       at all. It moved with the assertions it was proving, because a control
//       over assertions that no longer exist here would be a control over
//       nothing. It is check D.
//
// THE SPLIT IS BY QUESTION, NOT BY CONVENIENCE, AND THE BOUNDARY IS EXACT: a
// question about production is reported here and never gates; a question about
// THIS REPOSITORY'S CODE is merge-gated. Every assertion left in the deleted
// live file that was a fact about the URL constant rather than about the served
// document — that the URL names a skill directory above SKILL.md, so a derived
// slug is really a slug — is HERMETIC, makes no network call, and is
// merge-gated today at `contract/tests/unit/swarm-onboarding-skill-url.test.ts`.
// That is the whole of what the merge gate keeps about this URL, and it is
// enough to keep the slug meaningful to B and D below.
//
// EXIT SEMANTICS — READ BEFORE "FIXING" A NON-ZERO EXIT. This script ALWAYS
// exits 0. A non-zero exit would turn a question about production into a merge
// verdict, which is precisely what this workflow exists to keep off the merge
// path, so the deliverable here is the REPORT, not a verdict. The report is
// where a bad answer lives: a red report body on a green job is the intended
// outcome, and the report says so at the top so a green job is never read as
// "production is healthy".
//
// LOUD-SKIP-NEVER, IN THE DIRECTION THAT ACTUALLY MATTERS HERE
// (test-coverage-policy invariant 1). A check that could not run — DNS failure,
// timeout, TLS error, HTTP 403 from a rate-limited GitHub, a non-JSON response —
// is reported UNKNOWN, with the reason. It is NEVER omitted and NEVER rendered
// as a pass. A green row and a row nobody can see are different things, and only
// the first one is a claim. This was once the same invariant the deleted live
// test enforced with a RED EXIT, pointed the other way; the live test is gone, so
// the direction is no longer borrowed — nothing here is gating, and a silently
// dropped check is now the one failure nobody would ever notice. It also applies
// to a check that RAN but could not evaluate one of its own discriminators: that
// is UNKNOWN too, never a pass (see B's `evaluable`).
//
// THE ONLY PLACE IN THIS REPOSITORY THAT LOOKS AT THE SERVED DOCUMENT. B, C
// and D were all merge-gated once, in the deleted live test file, and all three
// are here now. Two consequences a reader must not have to infer:
//
//   1. NOTHING IN CI VERIFIES THE ENDPOINT'S LIVENESS OR CONTENT ON A MERGE
//      TRIGGER, and that is intended. A red merge means the code on `main` is
//      broken by a commit; whether robotmoney.network is answering at that
//      moment is not a property of any commit. The merge gate keeps exactly one
//      assertion about this URL — that the constant names a skill directory
//      above SKILL.md — and that assertion is hermetic
//      (contract/tests/unit/swarm-onboarding-skill-url.test.ts). The cost of the
//      choice is real and stated here: a broken URL or a stubbed skill is found
//      by tonight's audit, not on the pull request that introduced it.
//   2. So the assertions below are not a second copy kept "in case" — they are
//      the only implementation, and they have to carry their own evidence that
//      they discriminate at all. That is what check D is for. Do not "simplify"
//      B by dropping an assertion because "D already checks the endpoint", and
//      do not drop D because "B is thorough": B being thorough is exactly the
//      claim D is there to hold to account.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWARM_ONBOARDING_SKILL_URL } from "../contract/src/swarm-application.js";
import { RMPC_REPO } from "./lib/rmpc-fetch.ts";

// The repo's own copy of the onboarding skill, read for what the skill PINS —
// its rmpc release tag and the checksums it carries, which are the whole
// subject of check A. Nothing in this script compares it against what
// production is serving.
const SKILL_REL = "frontend/public/skills/swarm-onboarding/SKILL.md";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoSkillPath = join(repoRoot, SKILL_REL);

const TIMEOUT_MS = 30_000;

// ── Diagnostic overrides ────────────────────────────────────────────────────
// These exist so the UNKNOWN path can be demonstrated on demand (point the
// auditor at an unreachable host and watch every check report UNKNOWN rather
// than pass), and so the negative control and check C can be driven against
// inputs they must catch — a known-404 sibling path, or a body carrying
// `curl … | tar xz`. They are NOT configuration: nothing in CI sets them, and a
// run that has one in effect prints an OVERRIDE IN EFFECT banner at the top of
// its report, so an override run can never be mistaken for a production verdict.
const SKILL_URL = process.env.PRODUCTION_DRIFT_AUDIT_SKILL_URL?.trim() || SWARM_ONBOARDING_SKILL_URL;
const GITHUB_API = process.env.PRODUCTION_DRIFT_AUDIT_GITHUB_API?.trim() || "https://api.github.com";
const CORE_REPO = process.env.PRODUCTION_DRIFT_AUDIT_CORE_REPO?.trim() || RMPC_REPO;
const REPORT_PATH =
  process.env.PRODUCTION_DRIFT_AUDIT_REPORT?.trim() || join(process.cwd(), "production-drift-audit-report.md");

// An installation token for THIS repository is not automatically valid against
// robotmoney-core, so the token is best-effort: used when present, and a 401
// carrying one falls back to unauthenticated rather than being reported as a
// missing release.
const GH_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();

type Status = "pass" | "fail" | "unknown";

interface Check {
  id: string;
  title: string;
  status: Status;
  lines: string[];
}

function check(id: string, title: string, status: Status, ...lines: string[]): Check {
  return { id, title, status, lines };
}

const VERDICT: Record<Status, string> = {
  pass: "✅ OK",
  fail: "❌ DRIFT",
  unknown: "⚠️ UNKNOWN — this check did not run",
};

function bullet(text: string): string {
  return `- ${text.replace(/\n/g, "\n  ")}`;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

interface Fetched {
  /** A response arrived, whatever its status. */
  ok: boolean;
  status: number;
  body: string;
  /** Non-null when no usable response arrived at all (DNS, TLS, timeout, abort). */
  error: string | null;
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: true, status: res.status, body: await res.text(), error: null };
  } catch (e) {
    return { ok: false, status: 0, body: "", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

// ── The served-document discriminators, shared by B and D ────────────────────
//
// ONE table, read in both directions, on purpose. B asks "does this body carry
// every marker a real procedure carries?"; D asks "does a body which is NOT a
// procedure carry none of them?". They are the same question with the sign
// flipped, and keeping them in one list is what makes D a control over B rather
// than a second, differently-worded opinion about the endpoint.
//
// Each entry carries `evaluable`, not a boolean, because a discriminator that
// cannot be computed is not a discriminator that passed. Loud-skip-never applies
// to the arithmetic as well as to the fetch: an entry whose `evaluable` is
// `false` drives its check to UNKNOWN, never to a pass. There is exactly one
// such entry today — the front-matter `name:`, which needs a slug derived from
// the URL — and the shape is here so that the next one does not have to invent
// a way to be quietly dropped.

/**
 * The procedure floor, in bytes. The deleted live test asserted two floors, 500
 * and 10 000; only the stronger one is kept here, because a check that lists
 * both is a check whose report has a row that can never be the reason a finding
 * is raised. The 1,951-byte deprecation stub cleared 500 comfortably — it cleared
 * both — and the floor is here for the smaller future stub, not for that one.
 */
const PROCEDURE_BODY_FLOOR_BYTES = 10_000;

interface Marker {
  label: string;
  /** Whether the marker is PRESENT in the body B was handed. */
  holds: boolean;
  /** False when this discriminator could not be computed for the URL in hand. */
  evaluable: boolean;
}

/**
 * The skill slug the URL itself names — the directory immediately above
 * `SKILL.md` — derived rather than hardcoded, so the `name:` discriminator keeps
 * working wherever the constant points. The merge-gated hermetic assertion that
 * the production constant really does end in `<skill>/SKILL.md` and yields such a
 * slug is `contract/tests/unit/swarm-onboarding-skill-url.test.ts`; this
 * derivation is for the override case, which no merge-gated test can reach.
 *
 * `null` when the URL is shaped in a way this derivation does not understand, or
 * when the derived segment does not look like a skill directory. Both are
 * reported as UNKNOWN by the checks below, never treated as "no marker".
 */
const SKILL_SLUG = ((): string | null => {
  let pathname: string;
  try {
    pathname = new URL(SKILL_URL).pathname;
  } catch {
    return null;
  }
  const slug = pathname.split("/").at(-2);
  if (slug === undefined || !/^[a-z0-9-]+-onboarding$/.test(slug)) return null;
  return slug;
})();

/** The strongest form of every marker the deleted live test asserted. */
function servedDocumentMarkers(body: string): Marker[] {
  return [
    {
      label: "front matter names this skill (`name: " + (SKILL_SLUG ?? "<slug not derivable from the URL>") + "`)",
      holds: SKILL_SLUG !== null && body.includes(`name: ${SKILL_SLUG}`),
      evaluable: SKILL_SLUG !== null,
    },
    { label: "mentions the rmpc toolchain the skill exists to install", holds: body.includes("rmpc"), evaluable: true },
    { label: "names the endpoint an application is actually POSTed to (`/api/swarm/apply`)", holds: body.includes("/api/swarm/apply"), evaluable: true },
    { label: "carries the `swarm-token-claim-v1` claim envelope", holds: body.includes("swarm-token-claim-v1"), evaluable: true },
    { label: "carries the `claimed` completion gate", holds: body.includes("claimed"), evaluable: true },
    {
      label: "still points the applicant at their status page (`/swarm/apply/`) — the only way to watch an application move, until approval email is wired",
      holds: body.includes("/swarm/apply/"),
      evaluable: true,
    },
    { label: "is not a deprecation stub (no \"no instructions to follow\")", holds: !body.toLowerCase().includes("no instructions to follow"), evaluable: true },
    { label: `clears the ${PROCEDURE_BODY_FLOOR_BYTES.toLocaleString("en-US")}-byte procedure floor (${body.length} bytes)`, holds: body.length > PROCEDURE_BODY_FLOOR_BYTES, evaluable: true },
  ];
}

/**
 * One report line per marker. `invert` is what makes D a control rather than a
 * second copy of B: for a body that must NOT look like a procedure, a marker
 * being present is the bad outcome, so the glyphs swap. Non-evaluable markers
 * are never green in either direction.
 */
function renderMarkers(markers: Marker[], invert = false): string[] {
  return markers.map((m) => {
    if (!m.evaluable) return bullet(`⚠️ ${m.label} — NOT EVALUATED`);
    return bullet(`${(invert ? !m.holds : m.holds) ? "✅" : "❌"} ${m.label}`);
  });
}

// ── A — pinned rmpc release integrity ───────────────────────────────────────
//
// The highest-value check here, and the one that justifies the workflow. The
// skill pins a release tag and CARRIES that release's checksums in its own
// bytes. Nothing in this repository observes robotmoney-core, so a yanked or
// re-uploaded archive is invisible to every check in the merge set — and it is
// also invisible to any served-vs-repo comparison, since the skill file and the
// copy production serves would keep agreeing with each other perfectly through
// the whole failure. The repo copy's own bytes are the only place the pin
// lives, which is why this check reads them.

const PINNED_TAG_PATTERN = /^[ \t]*PINNED_TAG="([^"]+)"/m;
// The skill's install block names each archive in a `case` arm and closes it
// with a literal `)` BEFORE `PINNED_SHA=`, so the paren is matched outside the
// capture group — folding it in silently names an asset that does not exist on
// the release and reports a healthy release as missing all four archives.
const PINNED_SHA_PATTERN = /^[ \t]*(rmpc-[A-Za-z0-9._-]+\.tar\.gz)\)[ \t]+PINNED_SHA=([0-9a-f]{64})[ \t]*;;/gm;

interface PinnedRelease {
  tag: string;
  checksums: Array<{ asset: string; sha: string }>;
}

function parsePinnedRelease(skill: string): PinnedRelease | { error: string } {
  const tag = PINNED_TAG_PATTERN.exec(skill)?.[1];
  if (!tag) {
    return { error: `no \`PINNED_TAG="…"\` line found in ${SKILL_REL} — the skill no longer pins a release by this shape` };
  }
  const checksums: Array<{ asset: string; sha: string }> = [];
  for (const m of skill.matchAll(PINNED_SHA_PATTERN)) checksums.push({ asset: m[1]!, sha: m[2]! });
  if (checksums.length === 0) {
    return { error: `no carried \`<archive>) PINNED_SHA=<64 hex>;;\` entries found in ${SKILL_REL} — the skill no longer carries its pinned release's checksums` };
  }
  return { tag, checksums };
}

interface GhAsset {
  name: string;
  size: number;
  state: string;
  digest: string | null;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: GhAsset[];
}

function rateLimitLine(headers: Headers): string {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === null && reset === null) return "no x-ratelimit-* response headers were present";
  const resetIso = reset && /^\d+$/.test(reset) ? ` (resets ${new Date(Number(reset) * 1000).toISOString()})` : "";
  return `x-ratelimit-remaining=${remaining ?? "?"}, limit=${headers.get("x-ratelimit-limit") ?? "?"}${resetIso}`;
}

/** GitHub's unauthenticated core budget is 60/hour per IP, and hosted runners share IPs. */
function looksRateLimited(status: number, headers: Headers, body: string): boolean {
  if (status !== 403 && status !== 429) return false;
  if (headers.get("x-ratelimit-remaining") === "0") return true;
  return /rate limit|secondary rate/i.test(body);
}

async function githubRelease(tag: string): Promise<
  { kind: "ok"; release: GhRelease } | { kind: "missing"; status: number } | { kind: "unavailable"; reason: string }
> {
  const url = `${GITHUB_API}/repos/${CORE_REPO}/releases/tags/${tag}`;
  const base: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "robotmoney-production-drift-audit",
  };

  let res: Response | null = null;
  let tokenRejected = false;
  if (GH_TOKEN) {
    res = await fetch(url, {
      headers: { ...base, Authorization: `Bearer ${GH_TOKEN}` },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // This repo's GITHUB_TOKEN is an installation token for robotmoney-frontend
    // and is generally NOT valid against robotmoney-core. Retry bare rather
    // than report a perfectly healthy release as missing.
    if (res.status === 401) {
      tokenRejected = true;
      res = null;
    }
  }
  if (res === null) {
    try {
      res = await fetch(url, { headers: base, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      return { kind: "unavailable", reason: `GET ${url} did not complete — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` };
    }
  }

  if (res.status === 404) return { kind: "missing", status: 404 };
  if (tokenRejected) return { kind: "missing", status: 401 };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (looksRateLimited(res.status, res.headers, body)) {
      return { kind: "unavailable", reason: `GET ${url} → HTTP ${res.status} (GitHub API rate limit — ${rateLimitLine(res.headers)})` };
    }
    return { kind: "unavailable", reason: `GET ${url} → HTTP ${res.status} ${res.statusText}` };
  }
  try {
    return { kind: "ok", release: (await res.json()) as GhRelease };
  } catch (e) {
    return { kind: "unavailable", reason: `GET ${url} → HTTP ${res.status} with a non-JSON body (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * Fallback for an asset published without a `digest`: read the `.sha256`
 * sidecar the release publishes beside the archive — the same file the skill's
 * own `RMPC_TAG` branch downloads — and compare the hex it carries. Parsed with
 * the skill's own paranoia: the sidecar must name THIS archive, because
 * `sha256sum -c` happily reports OK over a file named in it.
 */
async function sidecarSha(archive: string, url: string): Promise<{ sha: string } | { error: string }> {
  const res = await fetchText(url);
  if (res.error !== null) return { error: `could not fetch ${url} — ${res.error}` };
  if (res.status !== 200) return { error: `GET ${url} → HTTP ${res.status}` };
  const m = /^([0-9a-f]{64})[ \t]+\*?(.+)$/m.exec(res.body.trim());
  if (!m) return { error: `${url} does not carry a parseable \`<64 hex>  <file>\` line` };
  if (m[2]!.trim() !== archive) return { error: `${url} names ${JSON.stringify(m[2]!.trim())}, not ${archive}` };
  return { sha: m[1]! };
}

async function checkPinnedRelease(repo: string): Promise<Check> {
  const title = "Pinned rmpc release still exists and still publishes the carried checksums";
  const parsed = parsePinnedRelease(repo);
  if ("error" in parsed) {
    return check("A", title, "unknown", bullet(parsed.error), bullet("Nothing was verified against robotmoney-core."));
  }
  const { tag, checksums } = parsed;
  const release = await githubRelease(tag);

  if (release.kind === "missing") {
    return check(
      "A",
      title,
      "fail",
      bullet(
        release.status === 404
          ? `\`${CORE_REPO}\` publishes no release tagged \`${tag}\`. The skill pins that tag, so a new member's install now ends at a 404.`
          : `\`${CORE_REPO}\` rejected the release lookup for \`${tag}\` with HTTP ${release.status}.`,
      ),
      bullet(
        `A new member following the skill is told to download from https://github.com/${CORE_REPO}/releases/download/${tag}/ — that is a hard break in the onboarding flow, and the merge set cannot see it: the served skill and the repo skill still match each other byte-for-byte.`,
      ),
    );
  }
  if (release.kind === "unavailable") {
    return check(
      "A",
      title,
      "unknown",
      bullet(release.reason),
      bullet(
        "**This check measured nothing.** It is UNKNOWN, not a pass: the release may be perfectly intact. Authenticated runs (GITHUB_TOKEN present and valid for the core repo) get a 5,000/hour core budget instead of the 60/hour unauthenticated one.",
      ),
    );
  }

  const { assets, draft, prerelease, html_url } = release.release;
  const lines: string[] = [
    bullet(`\`${tag}\` resolves: ${html_url} (draft=${draft}, prerelease=${prerelease}).`),
  ];
  if (draft) lines.push(bullet("⚠️ The release is a DRAFT — it is not publicly installable, which the skill's download URL requires."));
  if (prerelease) lines.push(bullet("ℹ️ The release is marked pre-release."));

  let failures = 0;
  let unknowns = 0;
  for (const { asset: assetName, sha } of checksums) {
    const asset = assets.find((a) => a.name === assetName);
    if (!asset) {
      failures += 1;
      lines.push(bullet(`❌ \`${assetName}\` is **not published** on \`${tag}\` — the skill's checksum for it names an archive the release does not hold.`));
      continue;
    }
    if (asset.digest) {
      const digest = asset.digest.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : null;
      if (digest === null) {
        unknowns += 1;
        lines.push(bullet(`⚠️ \`${assetName}\` is published but its digest uses an algorithm this audit does not check (\`${asset.digest}\`) — UNKNOWN, not a match.`));
        continue;
      }
      if (digest === sha) {
        lines.push(bullet(`✅ \`${assetName}\` (${asset.size} bytes) — GitHub's asset digest matches the checksum the skill carries.`));
      } else {
        failures += 1;
        lines.push(
          bullet(
            `❌ \`${assetName}\` — the release now serves sha256 \`${digest}\`, but the skill carries \`${sha}\`. **The archive was replaced after the skill pinned it**: the skill's own verify step will refuse to install it, so every new member's install breaks.`,
          ),
        );
      }
      continue;
    }
    // No digest on the asset: fall back to the sidecar the release publishes.
    const sidecarUrl =
      assets.find((a) => a.name === `${assetName}.sha256`)?.browser_download_url ??
      `${asset.browser_download_url}.sha256`;
    const sidecar = await sidecarSha(assetName, sidecarUrl);
    if ("error" in sidecar) {
      unknowns += 1;
      lines.push(bullet(`⚠️ \`${assetName}\` is published but carries no digest and its sidecar could not be read (${sidecar.error}) — UNKNOWN, not a match.`));
    } else if (sidecar.sha === sha) {
      lines.push(bullet(`✅ \`${assetName}\` (${asset.size} bytes) — the release's \`.sha256\` sidecar matches the checksum the skill carries.`));
    } else {
      failures += 1;
      lines.push(
        bullet(
          `❌ \`${assetName}\` — the release's sidecar says sha256 \`${sidecar.sha}\`, but the skill carries \`${sha}\`. **The archive was replaced after the skill pinned it.**`,
        ),
      );
    }
  }

  // Informational only. A new archive on the release is NOT drift: the skill's
  // `*)` case arm leaves PINNED_SHA empty and the install block then refuses
  // that platform outright ("no <tag> build for <os>-<arch>"), which is the
  // correct outcome — an unverified install is not offered.
  const carried = new Set(checksums.map((c) => c.asset));
  const uncovered = assets.map((a) => a.name).filter((n) => !n.endsWith(".sha256") && !carried.has(n));
  if (uncovered.length > 0) {
    lines.push(
      bullet(
        `ℹ️ The release also publishes archive(s) the skill carries no checksum for: ${uncovered.map((n) => `\`${n}\``).join(", ")}. Not drift — the skill refuses to install an OS/arch it has no carried checksum for. Add a checksum here only alongside a real verified install on that platform.`,
      ),
    );
  }

  const status: Status = failures > 0 ? "fail" : unknowns > 0 ? "unknown" : "pass";
  return check("A", title, status, ...lines);
}

// ── B — the endpoint still serves a procedure ───────────────────────────────
//
// WHAT B IS. The reachability and procedure question, asked of the SERVED
// document. It is the union of every assertion the deleted live test file used
// to assert,
// merged rather than copied: the 200, the front-matter `name:` that must agree
// with the slug the URL itself names, the `rmpc` marker, the full procedure set
// and the procedure floor. Where the live test and the old B disagreed, the
// STRONGER form won and the weaker one was dropped — the live test's 500-byte
// floor is gone because the 10 000-byte floor subsumes it, and dropping a
// row that can never be the reason a finding is raised is what keeps the report
// readable.
//
// IT IS NOT A MERGE GATE, AND NOTHING ELSE IS EITHER. A red B means production
// is serving something wrong, not that the code on `main` is broken: whether
// robotmoney.network answers at all is a fact about deploys, DNS, TLS, CDN state
// and upstream renames in robotmoney-core, none of which a diff here can repair.
// See the file header for the measured version of that claim.
//
// WHY THE PROCEDURE ASSERTIONS AT ALL, rather than "is it 200?". Measured, not
// hypothetical: when robotmoney-core landed #1199 it served a 1,951-byte
// deprecation stub that passed every marker assertion — right `name:` in the
// front matter, `rmpc` mentioned (only to say it had not changed), comfortably
// over the size floor — while reading, verbatim, "This file is a compatibility
// stub. It contains no instructions to follow." Agents were handed a signpost
// instead of a procedure, and CI stayed green for two days. So assert the
// PROCEDURE, not the label.

function checkEndpointServesProcedure(served: Fetched): Check {
  const title = "The endpoint still serves a real procedure, not a deprecation stub";
  if (served.error !== null) {
    return check(
      "B",
      title,
      "unknown",
      bullet(`GET ${SKILL_URL} did not complete — ${served.error}.`),
      bullet(
        "**This check measured nothing.** It is UNKNOWN, not a pass. The document was never fetched, so its content is unknown rather than good.",
      ),
      bullet(
        "Nothing else in this repository will notice tonight's outage: no merge gate reaches the public internet, so there is no `contract` red for anyone to triage, and no nightly mirror of one either. That is the intended consequence of the merge gate no longer depending on a host outside the repository (see the file header) — and it is why the UNKNOWN verdict is stated here rather than folded into a pass.",
      ),
    );
  }
  const markers = servedDocumentMarkers(served.body);
  const notEvaluable = markers.filter((m) => !m.evaluable);
  const broken = markers.filter((m) => m.evaluable && !m.holds);
  const rendered = renderMarkers(markers);
  if (served.status !== 200 || broken.length > 0 || notEvaluable.length > 0) {
    return check(
      "B",
      title,
      notEvaluable.length > 0 && broken.length === 0 && served.status === 200 ? "unknown" : "fail",
      bullet(`HTTP ${served.status}${served.status !== 200 ? ` (expected 200; ${served.body.length} bytes returned)` : ""}.`),
      ...rendered,
      ...(notEvaluable.length > 0
        ? [
            bullet(
              `**At least one discriminator could not be evaluated, so this row is UNKNOWN rather than a verdict:** ${notEvaluable.map((m) => m.label).join("; ")}. Check D below reports the same condition independently, and the merge-gated hermetic assertion on the URL constant is what keeps this one evaluable in a real run.`,
            ),
          ]
        : []),
      ...(served.status === 200 && broken.length > 0
        ? [bullet("A 200 with the right markers is not sufficient on its own — a deprecation stub carried this file's name, mentioned rmpc, and cleared every size floor in production for two days.")]
        : []),
      ...(served.status === 200 && broken.length === 0 && notEvaluable.length === 0
        ? [bullet("Every discriminator held, which is the claim check D exists to hold to account — read D before treating this row as evidence.")]
        : []),
    );
  }
  return check(
    "B",
    title,
    "pass",
    bullet(`HTTP ${served.status}, ${served.body.length} bytes.`),
    ...rendered,
    bullet("Every discriminator held. Check D is the evidence that these discriminators can tell this document from a wrong one; a green B with a red or UNKNOWN D is not a healthy endpoint."),
  );
}

// ── C — the served copy never carries the unverified pipe-into-tar form ───────
//
// THE FLOOR, AND IT IS NOT GOING ANYWHERE WITH THE DELETION ABOVE. This was
// issue #759 deliverable 1's explicit assertion, and it was INDEPENDENT of the
// byte comparison that used to sit beside it: the live test's own comment said
// why — "even if repoSkill itself somehow regressed, the served copy must never
// carry the unverified pipe-into-tar form." It outlived that comparison by being
// a separate assertion over `body`, not a consequence of it, and the comparison
// is now gone from the repository entirely. Nothing about this check weakened
// on the way out: it is asserted over the served body directly, which is now
// the ONLY place in CI that looks at what the deployed document actually says.
//
// It has its own reported line item, its own OK/DRIFT/UNKNOWN status, and its
// own UNKNOWN-never-a-pass semantics, and that independence is deliberate and
// load-bearing. The reason the floor existed at all is the case in which a
// comparison passes: the repo copy itself regressing. A byte comparison that
// returns "no difference" PROVES nothing about the install form, so anything
// that made this check conditional on such a comparison would be reporting
// nothing at exactly the moment it was written for. Do not fold it into check
// B, and do not make it contingent on anything else in this file.
//
// Why it matters on its own: the unverified `curl … | tar xz` form pipes a
// downloaded archive straight into a root-privileged extractor with no checksum
// check, and issue #748 closed it in the repo copy
// (scripts/tests/unit/onboarding-skill-rmpc-install-verified.test.ts). A stale
// deploy can serve the pre-#748 block to a genuinely NEW member while every
// offline check stays green, because the offline checks read the repo file.
// The removal of the deploy-freshness check does NOT close this door — a stale
// deploy is still exactly how this reaches a member, which is why a check that
// watches the SERVED document survives while the one that watched the DIFF
// does not.
//
// It moved OFF the merge gate for one reason: whether production currently
// serves this form is a question about production, and its only exit is a human
// deploying the site. B moved for the same reason, and the two are still NOT the
// same check: this one asks about the install FORM of whatever is being served,
// and reports DRIFT even when every marker in B holds.

/**
 * The pattern is stated literally here, with no shared module behind it. There
 * used to be a `contract/src/skill-parity.js` carrying its own unexported copy
 * that this check could have imported; that module is deleted along with the
 * deploy-freshness question it existed to serve, and this check is what
 * survives it. Writing the pattern out keeps the floor self-contained, so
 * nothing this auditor does can take it down. It is checked against the served
 * body alone, and the check below reports the offending line verbatim so a
 * disagreement about what counts as this form is visible in the report rather
 * than silent.
 */
const UNVERIFIED_INSTALL_PATTERN = /\|\s*tar\b/;

function checkServedInstallForm(served: Fetched): Check {
  const title = "The served copy never carries an unverified `| tar` install form";
  if (served.error !== null) {
    // UNKNOWN, never pass. The floor is about what the SERVED document says, so
    // with no document in hand it has nothing to say — and a floor that
    // silently reads as satisfied when nobody looked is worse than no floor.
    return check(
      "C",
      title,
      "unknown",
      bullet(`GET ${SKILL_URL} did not complete — ${served.error}.`),
      bullet(
        "**This is not a pass.** No document was fetched, so the served copy was never examined. Loud-skip-never forbids rendering an unexecuted check as green.",
      ),
    );
  }
  if (served.status !== 200) {
    // The same reasoning as the unreachable case, one step along, and it is the
    // reason this row is worth reading: a non-200 means the body is an ERROR
    // PAGE, not the document. Grepping a CDN's 502 page for `| tar` and
    // reporting "the floor holds" measures the CDN, and prints a green row
    // beside a red B on the very same response. The floor is about the document
    // a new member would be handed; when no document was handed out, what the
    // floor did is UNKNOWN, and the absence of a procedure is already B's
    // finding to raise.
    return check(
      "C",
      title,
      "unknown",
      bullet(`GET ${SKILL_URL} → HTTP ${served.status} (${served.body.length} bytes). The body is an error response, not the served document.`),
      bullet(
        "**This is not a pass.** The `| tar` scan below was NOT applied to the document, because the document was not served — only to whatever the origin answered with. Loud-skip-never forbids rendering an unexamined check as green, and a floor that reports itself satisfied off a 502 page is the exact shape of that failure. Check B reports the missing document itself.",
      ),
    );
  }
  const match = UNVERIFIED_INSTALL_PATTERN.exec(served.body);
  if (match === null) {
    return check(
      "C",
      title,
      "pass",
      bullet(`HTTP ${served.status}; the served copy (${served.body.length} bytes) contains no \`| tar\` pipe.`),
      bullet("Checked against the served body directly. Nothing in this repository compares the served document against the repo copy, so this row is the only place CI looks at the install form of what production is actually serving."),
    );
  }
  // Name the offending LINE, not just the offset: a `| tar` match in a prose
  // sentence explaining why the form is forbidden is not the same finding as
  // one in the install block, and only the line tells them apart.
  const lineNumber = served.body.slice(0, match.index).split("\n").length;
  const line = served.body.split("\n")[lineNumber - 1] ?? "<end of document>";
  return check(
    "C",
    title,
    "fail",
    bullet(
      `The served copy at \`${SKILL_URL}\` contains a \`| tar\` pipe at line ${lineNumber}: \`${line.trim()}\``,
    ),
    bullet(
      "**Asserted over the served body alone, and the only check in this repository that looks at it.** The repo copy forbids this form (scripts/tests/unit/onboarding-skill-rmpc-install-verified.test.ts, issue #748); a served copy that carries it hands a genuinely new member an unverified `curl … | tar xz` install, which pipes a downloaded archive into a root-privileged extractor with no checksum verification.",
    ),
    bullet(
      "The only exit is re-deploying robotmoney.network from a `main` that does not carry the form — there is no deploy workflow in this repository.",
    ),
  );
}

// ── D — NEGATIVE CONTROL: do B's discriminators fire at all? ──────────────────
//
// THE PROBLEM THIS SOLVES. Every marker in B is a positive assertion over a
// body that is supposed to be good, and a positive assertion over a good input
// cannot tell you whether it would have gone red on a bad one. If the origin
// answers 200 with an SPA shell or a proxy error page for everything, B's HTTP
// 200 is satisfied by garbage; if an error page happens to contain the string
// `rmpc`, B's `rmpc` marker is satisfied by garbage. Both would render as a
// green B, and a green B is the exact thing a reader of this report is about to
// trust. The deleted live test carried this control for the same reason, as a
// second test in the same file; there is no second test in a reporter, so it is
// its own row here and it reports on itself.
//
// WHAT IT DOES. It fetches a sibling path in the SAME directory, on the SAME
// host, that cannot exist, and runs the SAME marker table over the answer.
//
// THE DEAD PATH KEEPS A `.md` EXTENSION, AND THAT IS LOAD-BEARING. The site
// server (website-server/nginx.conf, #954) answers a path ending in a file
// extension with the file or a plain 404, and every OTHER path with the SPA
// shell at 200. A dead path with no extension would therefore draw the shell's
// 200 and this control would correctly — but uselessly — report DRIFT against a
// perfectly healthy site. A missing SKILL.md meets the `.md` rule, so a sibling
// `.md` that cannot exist is the failure this control stands for.
//
// WHICH DIRECTION EACH OUTCOME REPORTS, AND WHY. This is the part that is easy
// to get backwards, so each branch is named:
//
//   CONFIRMED (a 404 whose body carries none of the markers) — reports OK. This
//   is the only outcome that is evidence. It means the origin really does
//   distinguish a document that exists from one that does not, so B's green is a
//   statement about the document and not about a catch-all.
//
//   NOT CONFIRMED, and this is NOT reported as OK — reports DRIFT, for two
//   distinct shapes that mean different things, both spelled out in the report:
//     (a) the dead path answered 200. The origin is serving its shell (or a
//         proxy is answering 200 for everything), so a wrong document at the
//         skill URL would satisfy B's status check. B is then measuring the
//         origin's indiscrimination, not the document.
//     (b) the dead path answered 404 but its body carried a marker. That marker
//         is not a discriminator: any 404 page mentioning `rmpc` satisfies it.
//   In both cases B's result must not be read at face value, and saying so
//   here — out loud, in a row of its own — is the whole point. It is worth a red
//   report body on a green job: the report is the deliverable.
//
//   MEASURED SOMETHING ELSE (any status that is not 200 and not 404, or a body
//   so small the status is ambiguous) — reports UNKNOWN, never OK. A 502 from
//   the dead path says the ORIGIN is down, not that the path is missing, and an
//   origin that is down says nothing about whether a wrong document would be
//   caught. This branch is not a nicety: it is the branch a real outage lands
//   in, and the tempting reading — "non-200 and no markers, so the control
//   fired" — is exactly the false green this row exists to prevent. UNKNOWN is
//   also what an unreachable host produces (no response at all), and
//   loud-skip-never forbids calling that a pass.
//
// THE CONTROL DOES NOT GATE ANYTHING, and neither does its verdict: this
// workflow always exits 0 (see EXIT SEMANTICS in the file header). A DRIFT here
// is a finding to read, not a merge to block — and the finding it raises is
// about production's shape, which is the only kind of finding this repository
// can now make about the skill endpoint at all.

/** Statuses that mean "the origin answered, and the answer was: not here". */
const NOT_FOUND_STATUSES = [404, 410];

/** Kept as a `.md` basename so the site's file-serving rule applies — see above. */
const DEAD_PATH_BASENAME = "this-path-cannot-exist.md";

/**
 * The control path: a sibling of the skill URL, in the same directory, on the
 * same host, that cannot exist. `null` when the URL in hand has no directory
 * component to put a sibling in — which is UNKNOWN above, never a pass, because
 * a control that quietly compared the live path with itself would confirm
 * nothing at all.
 */
function deadSiblingPath(url: string): string | null {
  try {
    const u = new URL(url);
    const lastSlash = u.pathname.lastIndexOf("/");
    if (lastSlash < 0) return null;
    return `${u.origin}${u.pathname.slice(0, lastSlash + 1)}${DEAD_PATH_BASENAME}`;
  } catch {
    return null;
  }
}

function checkDiscriminatorsFire(controlUrl: string | null, dead: Fetched | null): Check {
  const title = "Negative control: a known-404 sibling path on the same host is seen as non-200, with none of the skill's markers";
  if (controlUrl === null || dead === null) {
    return check(
      "D",
      title,
      "unknown",
      bullet(`No control path could be derived from \`${SKILL_URL}\` — it has no directory to place a sibling in.`),
      bullet(
        "**This is not a pass.** Nothing was measured about whether this auditor's own discriminators can fail, so nothing in check B should be read as evidence of anything. Loud-skip-never forbids rendering an unexecuted check as green, and a control that reports OK because it never ran is the worst possible version of that failure.",
      ),
    );
  }
  if (dead.error !== null) {
    return check(
      "D",
      title,
      "unknown",
      bullet(`GET ${controlUrl} did not complete — ${dead.error}.`),
      bullet(
        "**This is not a pass.** The control fetch never returned, so the discriminators were never exercised. Check B may be a true statement about the document or an accident of an unreachable host; this row is what tells you which.",
      ),
    );
  }
  if (!NOT_FOUND_STATUSES.includes(dead.status)) {
    return check(
      "D",
      title,
      "unknown",
      bullet(`GET ${controlUrl} → HTTP ${dead.status} (${dead.body.length} bytes), which is not a "this path does not exist" answer.`),
      bullet(
        "**This is not a pass, and it is deliberately not a DRIFT either.** A non-404 failure status measures the ORIGIN, not the discriminator: a 5xx from a site-wide outage is exactly what this control would be handed tonight, and reading it as \"the control fired\" — non-200, no markers, therefore confirmed — is the false green this row exists to prevent. The origin answered a question about its own health; the question this row asks is still unanswered.",
      ),
      bullet(
        "The only two statuses that make this a control are 404 and 410, because only those are the origin's own answer to \"that file is not here\" rather than to \"I am broken\" or \"you are not allowed\".",
      ),
    );
  }
  // A genuine not-found. Now: does the 404 body carry any of the markers B relies on?
  const markers = servedDocumentMarkers(dead.body);
  const notEvaluable = markers.filter((m) => !m.evaluable);
  const leaked = markers.filter((m) => m.evaluable && m.holds);
  const legend = bullet("Inverted polarity — a ✅ here means the marker is ABSENT from a body that must not contain it, which is what makes it a discriminator.");
  const seen = bullet(`GET ${controlUrl} → HTTP ${dead.status} (${dead.body.length} bytes), as expected for a path that cannot exist.`);
  if (leaked.length > 0) {
    return check(
      "D",
      title,
      "fail",
      seen,
      legend,
      ...renderMarkers(markers, true),
      bullet(
        `**The control did NOT fire, and that is a finding rather than a passing control.** ${leaked.length} of B's discriminators are satisfied by a 404 page for a path that does not exist, so a green B would be a statement about the origin's error page rather than about the document: ${leaked.map((m) => m.label).join("; ")}.`,
      ),
      bullet(
        "Read check B with that in hand. Nothing here is merge-blocking, and the fix is a question about the site's file-serving layer (website-server/nginx.conf), not about this repository.",
      ),
    );
  }
  if (notEvaluable.length > 0) {
    return check(
      "D",
      title,
      "unknown",
      seen,
      legend,
      ...renderMarkers(markers, true),
      bullet(
        `**The dead path behaved correctly, but this row is UNKNOWN rather than OK** because ${notEvaluable.map((m) => m.label).join("; ")} could not be evaluated at all. A control that cannot check every discriminator is not a control over the whole of B.`,
      ),
    );
  }
  return check(
    "D",
    title,
    "pass",
    seen,
    legend,
    ...renderMarkers(markers, true),
    bullet(
      "**The control fired.** The origin answered a non-existent `.md` path with a not-found status and a body carrying none of B's markers, so every discriminator in B can fail — which is what makes a green B a statement about the document. Read this row before B's.",
    ),
    bullet(
      "This is the property the deleted live test proved with a second test in the same file (`red control: a known-404 path on the same host …`). A reporter that always exits 0 cannot assert it with an exit code, so it reports it as a row — and the row is only worth anything if somebody reads it.",
    ),
  );
}

// ── Report ─────────────────────────────────────────────────────────────────

function render(checks: Check[], startedAt: string): string {
  const overrides: string[] = [];
  if (process.env.PRODUCTION_DRIFT_AUDIT_SKILL_URL) overrides.push(`\`PRODUCTION_DRIFT_AUDIT_SKILL_URL=${SKILL_URL}\` (checks B, C and D — D's control path is derived from it)`);
  if (process.env.PRODUCTION_DRIFT_AUDIT_GITHUB_API) overrides.push(`\`PRODUCTION_DRIFT_AUDIT_GITHUB_API=${GITHUB_API}\` (check A)`);
  if (process.env.PRODUCTION_DRIFT_AUDIT_CORE_REPO) overrides.push(`\`PRODUCTION_DRIFT_AUDIT_CORE_REPO=${CORE_REPO}\` (check A)`);

  const worst = checks.some((c) => c.status === "fail")
    ? "DRIFT DETECTED"
    : checks.some((c) => c.status === "unknown")
      ? "INCOMPLETE — at least one check did not run"
      : "NO DRIFT OBSERVED";

  const lines: string[] = [
    "## Production drift audit",
    "",
    "> **A green job on this workflow means the AUDIT RAN. It does not mean production is healthy.**",
    "> This workflow is an observer, not a gate: it always exits 0, it is not a required check, and it",
    "> runs on no trigger but its own schedule. Read the table below for what it saw. A `DRIFT` row here is",
    "> a real finding; a `UNKNOWN` row means the question was not answered, which is not the same as an",
    "> answer of \"fine\". Nothing on this page blocks a merge — by design, because the questions it asks",
    "> (is the served install form verified? does the endpoint still serve a procedure? do this audit's own",
    "> discriminators fire? does an external release still exist?) cannot be fixed by any change to this",
    "> repository.",
    ">",
    "> **This audit does not check deploy freshness, and nothing else in CI does either.** A former",
    "> fourth check compared the served skill against the repo copy; it was removed by decision, along with",
    "> `contract/src/skill-parity.js`. If `main` carries a correct skill and production is still serving the",
    "> previous one, no job in this repository will say so — that is the deploy pipeline's job. See the",
    "> header of `scripts/production-drift-audit.ts` for the full record.",
    "",
  ];
  if (overrides.length > 0) {
    lines.push(
      "> 🚨 **OVERRIDE IN EFFECT — this run did not audit production.**",
      ">",
      ...overrides.map((o) => `> - ${o}`),
      "",
    );
  }
  lines.push(
    `**Outcome: ${worst}**`,
    "",
    `- Skill URL: \`${SKILL_URL}\``,
    `- Derived skill slug: \`${SKILL_SLUG ?? "<not derivable — every \`name:\` discriminator is UNKNOWN, never a pass>"}\``,
    `- Skill pin source (read from this checkout, not fetched): \`${SKILL_REL}\``,
    `- rmpc release repo: \`${CORE_REPO}\` (via \`${GITHUB_API}\`, ${GH_TOKEN ? "token supplied" : "unauthenticated — 60 req/hour"})`,
    `- Started: \`${startedAt}\``,
    "",
    "| # | Check | Result |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${c.title} | ${VERDICT[c.status]} |`),
    "",
    "### Detail",
    "",
  );
  for (const c of checks) {
    lines.push(`#### ${c.id}. ${c.title}`, "", `**${VERDICT[c.status]}**`, "", ...c.lines, "");
  }
  lines.push(
    "---",
    "",
    "_Produced by `scripts/production-drift-audit.ts`, run by `.github/workflows/production-drift-audit.yml`._",
    "_Checks B, C and D are code that MOVED off the merge gate, out of the deleted",
    "live test file. NO REACHABILITY OR PROCEDURE ASSERTION ABOUT",
    "THE SERVED DOCUMENT IS MERGE-GATED ANYWHERE IN THIS REPOSITORY, and that is the intended state: whether",
    "robotmoney.network answers is not a property of the commit under review. Read these rows for the",
    "endpoint; read `contract/tests/unit/swarm-onboarding-skill-url.test.ts` (hermetic, merge-gated) for the URL",
    "constant. Read D before B: a green B means the document is real only if D says the discriminators can fail._",
    "",
    "_No check here compares the served skill against the repo copy. Deploy freshness is not watched by",
    "anything in this repository; catching a stale deploy is the deploy pipeline's job._",
    "",
  );
  return lines.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  let checks: Check[];

  try {
    const repo = readFileSync(repoSkillPath, "utf8");
    // ONE fetch backs checks B and C. A failure is therefore reported against
    // both, with the same reason — a check that could not run is named, not
    // quietly dropped, and not charged a second identical request either.
    const served = await fetchText(SKILL_URL);
    // A SECOND, SEPARATE fetch backs D, because a control that shared B's
    // response could not control anything: it would be reading the very body it
    // is supposed to hold to account. The two run in sequence, and neither
    // failing hides the other — that is what the four UNKNOWN branches are for.
    const controlUrl = deadSiblingPath(SKILL_URL);
    const control = controlUrl === null ? null : await fetchText(controlUrl);
    checks = [
      await checkPinnedRelease(repo),
      checkEndpointServesProcedure(served),
      checkServedInstallForm(served),
      checkDiscriminatorsFire(controlUrl, control),
    ];
  } catch (e) {
    // The auditor itself broke — a renamed repo path, an unreadable file, a bug
    // in this script. That is still not a merge-gate verdict: report it loudly
    // and exit 0, because a non-zero exit here would put "the auditor has a
    // bug" on the merge gate, which is not a question about production.
    checks = [
      check("A", "Pinned rmpc release still exists and still publishes the carried checksums", "unknown", bullet("The audit aborted before this check.")),
      check("B", "The endpoint still serves a real procedure, not a deprecation stub", "unknown", bullet("The audit aborted before this check.")),
      // C is named here for the same reason every row is: an omitted row is a
      // row nobody can see, and this one is a FLOOR. It reads as UNKNOWN, never
      // as a pass — an abort must not be the way an unverified-install guard
      // silently stops being reported.
      check("C", "The served copy never carries an unverified `| tar` install form", "unknown", bullet("The audit aborted before this check.")),
      // …and D for the same reason plus one: an auditor that aborts before it
      // could prove its own assertions are not vacuous must say so. Dropping the
      // control silently would leave every B verdict unaccompanied, which is the
      // exact state this row exists to prevent.
      check("D", "Negative control: a known-404 sibling path on the same host is seen as non-200, with none of the skill's markers", "unknown", bullet("The audit aborted before this check.")),
    ];
  }

  const report = render(checks, startedAt);
  console.log(report);
  try {
    writeFileSync(REPORT_PATH, report);
    console.log(`[production-drift-audit] report written to ${REPORT_PATH}`);
  } catch (e) {
    console.error(`[production-drift-audit] could not write ${REPORT_PATH}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (summary) {
    try {
      appendFileSync(summary, report);
    } catch (e) {
      console.error(`[production-drift-audit] could not append to $GITHUB_STEP_SUMMARY: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ALWAYS 0. See the file header: the deliverable is the report, not a verdict,
  // and a non-zero exit would re-gate a question no change to this repository
  // can answer. Read the report for the finding.
  return 0;
}

process.exitCode = await main();
