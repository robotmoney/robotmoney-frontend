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
// THE CHECK LIST, IN FULL — THERE ARE THREE AND THIS IS ALL OF THEM:
//   A. Does the rmpc release the onboarding skill PINS still exist, and does
//      robotmoney-core still publish archives whose sha256 match the ones the
//      skill CARRIES? (release integrity)
//   B. Does SWARM_ONBOARDING_SKILL_URL still serve a real, complete procedure
//      rather than a deprecation stub? (an observer copy of what the live test
//      merge-gates — the live test is the gate, this is the report)
//   C. Does the SERVED copy carry an unverified `curl … | tar xz` install
//      form? (a security floor, not a content comparison)
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
// `contract/tests/live/swarm-onboarding-skill-url-live.test.ts` used to bundle
// two unrelated questions in one required merge gate:
//
//   (1) "is the endpoint serving a real, complete procedure?" — MERGE-GATED,
//       untouched, and it stays that way. It earned its place by catching a
//       MEASURED incident: robotmoney-core replaced the path with a 1,951-byte
//       deprecation stub that passed every marker assertion (robotmoney-core
//       #1199 / PR #1200). Check B restates those assertions here as an
//       OBSERVER copy so a drift finding is legible from a report with no PR
//       attached; the live test is the gate, and B is not why they are safe.
//       Do not "simplify" this by dropping B because "the live test already
//       checks it".
//
//   (2) "is the served copy safe to install?" — the unverified `| tar` floor,
//       asserted over the served body directly. It also left that gate, for
//       the same structural reason: whether production currently serves that
//       form is a question about production, and its only exit is a human
//       deploying the site. It is check C here, and it keeps its own status
//       line, its own OK/DRIFT/UNKNOWN verdict, and its own
//       UNKNOWN-never-a-pass semantics.
//
//   (3) "is the deploy fresh?" — also left that gate, and has since been
//       deleted from the repository outright. See the section above.
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
// the first one is a claim. This is the same invariant the live test enforces
// with a red exit, pointed the other way: nothing here is gating, so a
// silently dropped check is the one failure nobody would ever notice.
//
// NOT A REIMPLEMENTATION OF THE LIVE TEST. B restates the live test's procedure
// assertions because they are prose in a test file rather than a shared
// constant, and that duplication is deliberate and cross-referenced: the LIVE
// test is the gate, this is the observer. If you change one, change the other —
// see the pointers at both sites.
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
// than pass). They are NOT configuration: nothing in CI sets them, and a run
// that has one in effect prints an OVERRIDE IN EFFECT banner at the top of its
// report, so an override run can never be mistaken for a production verdict.
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
// These restate contract/tests/live/swarm-onboarding-skill-url-live.test.ts's
// substantive assertions, which are a merge gate and stay one. They are prose
// in a test file rather than a shared constant, so the duplication is
// deliberate and bounded: the live test is the GATE, this is the OBSERVER, and
// what separates them is only that one blocks a merge and one does not. Change
// one, change the other. Why they exist here at all, given the live test
// already asserts them: a drift finding has to be legible from a report with no
// PR attached to it, and the report is the thing an operator reads. Why the
// procedure assertions matter at all: a 200 with the right front-matter `name:`
// is not sufficient — when robotmoney-core landed #1199 it served a 1,951-byte
// deprecation stub that passed every marker assertion above the size floor
// while reading, verbatim, "This file is a compatibility stub. It contains no
// instructions to follow." Agents were handed a signpost instead of a
// procedure, and CI stayed green. So assert the PROCEDURE, not the label.

const PROCEDURE_BODY_FLOOR_BYTES = 10_000;

function procedureAssertions(body: string): Array<{ label: string; holds: boolean }> {
  return [
    { label: "names the endpoint an application is actually POSTed to (`/api/swarm/apply`)", holds: body.includes("/api/swarm/apply") },
    { label: "carries the `swarm-token-claim-v1` claim envelope", holds: body.includes("swarm-token-claim-v1") },
    { label: "carries the `claimed` completion gate", holds: body.includes("claimed") },
    {
      label: "still points the applicant at their status page (`/swarm/apply/`) — the only way to watch an application move, until approval email is wired",
      holds: body.includes("/swarm/apply/"),
    },
    { label: "is not a deprecation stub (no \"no instructions to follow\")", holds: !body.toLowerCase().includes("no instructions to follow") },
    { label: `clears the ${PROCEDURE_BODY_FLOOR_BYTES.toLocaleString("en-US")}-byte procedure floor (${body.length} bytes)`, holds: body.length > PROCEDURE_BODY_FLOOR_BYTES },
  ];
}

function checkEndpointServesProcedure(served: Fetched): Check {
  const title = "The endpoint still serves a real procedure, not a deprecation stub";
  if (served.error !== null) {
    return check(
      "B",
      title,
      "unknown",
      bullet(`GET ${SKILL_URL} did not complete — ${served.error}.`),
      bullet(
        "**This check measured nothing.** It is UNKNOWN, not a pass. Note the merge gate is NOT weakened by that unknown: `contract` still runs contract/tests/live/swarm-onboarding-skill-url-live.test.ts on every PR and every push to `main`, and per loud-skip-never it goes RED on exactly this unreachable-network case.",
      ),
    );
  }
  const assertions = procedureAssertions(served.body);
  const broken = assertions.filter((a) => !a.holds);
  if (served.status !== 200 || broken.length > 0) {
    return check(
      "B",
      title,
      "fail",
      bullet(`HTTP ${served.status}${served.status !== 200 ? ` (expected 200; ${served.body.length} bytes returned)` : ""}.`),
      ...assertions.map((a) => bullet(`${a.holds ? "✅" : "❌"} ${a.label}`)),
      ...(served.status === 200
        ? [bullet("A 200 with the right markers is not sufficient on its own — a deprecation stub carried this file's name, mentioned rmpc, and passed every size floor in production for two days.")]
        : []),
    );
  }
  return check(
    "B",
    title,
    "pass",
    bullet(`HTTP ${served.status}, ${served.body.length} bytes.`),
    ...assertions.map((a) => bullet(`✅ ${a.label}`)),
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
// deploying the site. It is NOT the same as check B — the procedure assertions
// are still gated, and stayed in the live test.

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

// ── Report ─────────────────────────────────────────────────────────────────

function render(checks: Check[], startedAt: string): string {
  const overrides: string[] = [];
  if (process.env.PRODUCTION_DRIFT_AUDIT_SKILL_URL) overrides.push(`\`PRODUCTION_DRIFT_AUDIT_SKILL_URL=${SKILL_URL}\` (checks B and C)`);
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
    "> (is the served install form verified? does the endpoint still serve a procedure? does an external",
    "> release still exist?) cannot be fixed by any change to this repository.",
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
    "_Checks B and C are code that MOVED off the merge gate: they are no longer in",
    "`contract/tests/live/swarm-onboarding-skill-url-live.test.ts`, whose only exit is a human deploying the",
    "site. Every reachability and procedure assertion that file still holds is merge-gated, untouched._",
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
    checks = [
      await checkPinnedRelease(repo),
      checkEndpointServesProcedure(served),
      checkServedInstallForm(served),
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
