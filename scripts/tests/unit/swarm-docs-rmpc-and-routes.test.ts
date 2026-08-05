// Swarm docs consistency guard (issue #190, extended for docs/architecture.md
// §11). Checks:
//
//   1. participation.html's "Generate your ed25519 identity" section
//      (#generate-identity) must promote the rmpc CLI (robotmoney-core) —
//      the issue's own AC1.
//   2. Every /api/swarm/... path literal documented in participation.html
//      and api-reference.html must still appear (structurally, allowing for
//      :param vs <param> placeholder spelling) in contract/src/routes.js's
//      swarm route table — the issue's own AC3, re-run against the
//      edited files so the docs can never silently drift from the real route
//      contract.
//   3. (§11 R4) participation.html's and runbook.html's copy-paste prompt
//      blocks must be byte-for-byte the SAME string as ONBOARDING_PROMPT
//      (@robotmoney/contract) — not a hand-copy that can silently drift from
//      what the /swarm/apply page renders — and must name the
//      swarm-onboarding skill and the signed-application step.
//   4. (§11 R2) the public application-status route
//      (ROUTES.swarm.applyStatus) must be documented somewhere in the
//      swarm docs, not just implemented.
//   5. (issue #496) participation.html's rmpc subcommand names must match the
//      REAL binary surface — pinned to the same three-subcommand list
//      scripts/lib/rmpc-fetch.ts asserts against the pinned release's
//      `committee-identity --help`.
//
// Runs in the required unit.yml root job via `bun run test`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ONBOARDING_PROMPT, ROUTES } from "@robotmoney/contract";
import { missingCommitteeIdentitySubcommands } from "../../lib/rmpc-fetch.ts";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const PARTICIPATION = "frontend/public/views/docs/investment-swarm/participation.html";
const API_REFERENCE = "frontend/public/views/docs/investment-swarm/api-reference.html";
const RUNBOOK = "frontend/public/views/docs/investment-swarm/runbook.html";
const ONBOARDING_SKILL = "frontend/public/skills/swarm-onboarding/SKILL.md";

function decodeEntities(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Pull the '#generate-identity' section: from its <h2> to the next <h2>.
function extractSection(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) throw new Error(`section id="${id}" not found`);
  const nextH2 = html.indexOf("<h2", html.indexOf(">", start) + 1);
  return html.slice(start, nextH2 === -1 ? undefined : nextH2);
}

// Pull the FIRST <pre><code>...</code></pre> block inside section `id`,
// entity-decoded — this is the literal text a reader's clipboard gets from
// the docs page's Copy button (main.js's data-copy-code handler copies this
// same <pre>'s textContent).
function extractCodeBlock(html: string, sectionId: string): string {
  const section = extractSection(html, sectionId);
  const openTag = "<pre><code>";
  const start = section.indexOf(openTag);
  if (start === -1) throw new Error(`no <pre><code> block found in section id="${sectionId}"`);
  const contentStart = start + openTag.length;
  const end = section.indexOf("</code></pre>", contentStart);
  if (end === -1) throw new Error(`unterminated <pre><code> block in section id="${sectionId}"`);
  return decodeEntities(section.slice(contentStart, end));
}

// Extract every /api/swarm/... path literal a doc reader would copy,
// including placeholder segments spelled either ":id" or "<id>" (both appear
// across participation.html and api-reference.html). Stops a segment at a
// real closing HTML tag (e.g. "</code>", which has NO angle-bracket
// placeholder form since placeholders never start with "/").
const PATH_RE = /\/api\/swarm(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_]+|<[A-Za-z0-9_]+>))+/g;

function extractDocPaths(html: string): string[] {
  const decoded = decodeEntities(html);
  const matches = decoded.match(PATH_RE) ?? [];
  // Drop the one literal ellipsis reference ("/api/swarm/...") — not a
  // real endpoint, just prose shorthand for "the swarm namespace".
  return matches.filter((m) => !m.endsWith("/..."));
}

// Normalize a path template's placeholder segments (":id", "<id>") to a
// single wildcard token so spelling differences between the docs and the
// contract don't produce false positives — only path SHAPE is asserted.
function normalize(p: string): string {
  return p
    .split("/")
    .map((seg) => (seg.startsWith(":") || (seg.startsWith("<") && seg.endsWith(">")) ? "*" : seg))
    .join("/");
}

function flattenRoutes(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) flattenRoutes(v, out);
  return out;
}

// Flatten an HTML fragment to the prose a reader actually sees: drop tags,
// decode entities, collapse whitespace. `<code>sign</code>.` must become
// "sign." so a word-boundary subcommand match works across markup.
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Pull the `.docs-callout__body` of the callout whose `.docs-callout__label`
// contains `label`.
function extractCalloutBody(html: string, label: string): string {
  const labelAt = html.indexOf(label);
  if (labelAt === -1) throw new Error(`no docs-callout labelled with ${JSON.stringify(label)} found`);
  const bodyOpen = html.indexOf('class="docs-callout__body"', labelAt);
  if (bodyOpen === -1) throw new Error(`callout ${JSON.stringify(label)} has no docs-callout__body`);
  const contentStart = html.indexOf(">", bodyOpen) + 1;
  const end = html.indexOf("</div>", contentStart);
  if (end === -1) throw new Error(`unterminated docs-callout__body after ${JSON.stringify(label)}`);
  return html.slice(contentStart, end);
}

// Pull the params-table <tr> whose docs-params__name cell names `param`.
function extractParamRow(html: string, param: string): string {
  const nameAt = html.indexOf(`docs-params__name">${param}<`);
  if (nameAt === -1) throw new Error(`no docs-params row for ${JSON.stringify(param)}`);
  const rowStart = html.lastIndexOf("<tr", nameAt);
  const rowEnd = html.indexOf("</tr>", nameAt);
  if (rowStart === -1 || rowEnd === -1) throw new Error(`malformed docs-params row for ${JSON.stringify(param)}`);
  return html.slice(rowStart, rowEnd);
}

describe("participation.html promotes rmpc as the recommended signing tool", () => {
  test("#generate-identity references rmpc and robotmoney-core", () => {
    const section = extractSection(read(PARTICIPATION), "generate-identity");
    expect(section).toContain("rmpc");
    expect(section).toContain("robotmoney-core");
  });
});

// Issue #496. `rmpc` is robotmoney-core's binary (pinned v0.3.2), and its
// `committee-identity` namespace was deliberately excluded from this repo's
// Committee→Swarm rename — docs/decisions.md (ADR D28) records that sweep being
// caught and reverted across scripts/**. The DOCS occurrence survived the
// revert, telling applicants to sign with `rmpc swarm-identity sign`, a
// subcommand the binary does not have: following the participation guide by
// hand produced "unrecognized subcommand" and the application could not be
// signed. It survived precisely because nothing asserted on the docs while
// every code occurrence was pinned.
//
// The subcommand list below is READ OUT OF scripts/lib/rmpc-fetch.ts rather
// than re-typed here — `missingCommitteeIdentitySubcommands("")` reports every
// subcommand missing from empty help text, i.e. the exact list that module
// asserts against the downloaded binary's `committee-identity --help`. So the
// docs and the binary verification cannot drift apart: changing one list
// changes this test's expectation too.
describe("participation.html names rmpc's real subcommands (issue #496)", () => {
  const SUBCOMMANDS = missingCommitteeIdentitySubcommands("");

  // Canary against a vacuous pass — if the helper ever returns [] for empty
  // help text, every assertion below would trivially hold.
  test("rmpc-fetch.ts still declares the three-subcommand contract it verifies against the pinned binary", () => {
    expect(SUBCOMMANDS).toEqual(["create", "show-public-key", "sign"]);
  });

  test("no `swarm-identity` anywhere in participation.html — that subcommand does not exist", () => {
    expect(read(PARTICIPATION)).not.toContain("swarm-identity");
  });

  test("the DIY-path callout names every subcommand rmpc-fetch requires, under the real `committee-identity` namespace", () => {
    const body = extractCalloutBody(read(PARTICIPATION), "For the DIY path: the rmpc reference CLI");
    expect(textOf(body)).toContain("rmpc committee-identity");
    expect(
      missingCommitteeIdentitySubcommands(textOf(body)),
      "the DIY-path callout omits rmpc subcommand(s) that scripts/lib/rmpc-fetch.ts requires of the binary",
    ).toEqual([]);
  });

  test("the signature param row points at the real signing command", () => {
    const row = extractParamRow(read(PARTICIPATION), "signature");
    expect(textOf(row)).toContain("rmpc committee-identity sign");
  });

  // AC4: both spots must say WHY the name looks un-renamed, so the next
  // Committee→Swarm sweep leaves them alone instead of re-breaking apply.
  for (const [label, extract] of [
    ["the DIY-path callout", (h: string) => extractCalloutBody(h, "For the DIY path: the rmpc reference CLI")],
    ["the signature param row", (h: string) => extractParamRow(h, "signature")],
  ] as const) {
    test(`${label} explains why the subcommand name is deliberately not renamed`, () => {
      const text = textOf(extract(read(PARTICIPATION)));
      expect(text.toLowerCase()).toContain("rename");
      expect(text).toContain("robotmoney-core");
    });
  }
});

describe("participation.html links the runnable starter swarm agent", () => {
  test("wiring quickstart names the repo-native starter", () => {
    const section = extractSection(read(PARTICIPATION), "starter-agent-quickstart");
    expect(section).toContain("scripts/starter-swarm-agent.ts");
    expect(section).toContain("--transport=rest");
  });
});

describe("documented /api/swarm/... paths match contract/src/routes.js", () => {
  const contractPaths = flattenRoutes(ROUTES).filter((p) => p.startsWith("/api/swarm"));
  const normalizedContract = new Set(contractPaths.map(normalize));

  // Canary against a vacuous pass — the contract is known to define swarm
  // routes today.
  test("contract defines a non-empty swarm route table", () => {
    expect(contractPaths.length).toBeGreaterThan(0);
  });

  for (const [label, rel] of [
    ["participation.html", PARTICIPATION],
    ["api-reference.html", API_REFERENCE],
  ] as const) {
    test(`every /api/swarm path documented in ${label} matches a contract route`, () => {
      const docPaths = extractDocPaths(read(rel));
      // Canary: each doc is known to reference swarm endpoints today.
      expect(docPaths.length).toBeGreaterThan(0);

      const missing = [...new Set(docPaths)]
        .map((p) => ({ path: p, normalized: normalize(p) }))
        .filter(({ normalized }) => !normalizedContract.has(normalized));
      expect(
        missing,
        `${rel} documents /api/swarm paths absent from contract ROUTES:\n` +
          missing.map((m) => `  ${m.path} (normalized: ${m.normalized})`).join("\n"),
      ).toEqual([]);
    });
  }
});

// docs/architecture.md §11 R4/R5: the copy-paste prompt tells the agent to
// install the swarm-onboarding skill (robotmoney-core) — the skill
// itself, not a live tool call, is the discovery mechanism (D21 retired the
// MCP server). These two docs pages hand-embed the SAME text for readers who
// never leave the browser — pinning them to the literal constant (not just
// "looks similar") is what actually catches a silent copy/paste drift like a
// placeholder getting renamed in only one place (caught while writing this:
// runbook.html had "<desk name>" where the constant and participation.html
// both say "<display name>").
describe("participation.html and runbook.html render ONBOARDING_PROMPT verbatim", () => {
  // Canary against a vacuous pass — the constant itself must be non-empty, must
  // point at the skill, and must tell the agent to COLLECT the owner's identity.
  // It must NOT carry fill-in-the-blank placeholders: operators paste the prompt
  // verbatim, so a `<display name>` left in the text gets applied under
  // literally that string instead of a real person's name.
  test("ONBOARDING_PROMPT is non-empty, names the swarm-onboarding skill, and collects identity without placeholders", () => {
    expect(ONBOARDING_PROMPT.length).toBeGreaterThan(0);
    expect(ONBOARDING_PROMPT).toContain("swarm-onboarding");
    expect(ONBOARDING_PROMPT.toLowerCase()).toContain("ask me for");
    expect(ONBOARDING_PROMPT).not.toMatch(/<[a-z][a-z ]*>/i);
  });

  for (const [label, rel, sectionId] of [
    ["participation.html", PARTICIPATION, "quickstart"],
    ["runbook.html", RUNBOOK, "onboard"],
  ] as const) {
    test(`${label}'s copy-paste prompt is byte-for-byte ONBOARDING_PROMPT`, () => {
      expect(extractCodeBlock(read(rel), sectionId)).toBe(ONBOARDING_PROMPT);
    });

    test(`${label} names the swarm-onboarding skill and the signed-application step outside the prompt too`, () => {
      const html = read(rel);
      expect(html).toContain("swarm-onboarding");
      expect(html.toLowerCase()).toContain("signed application");
    });
  }
});

// docs/architecture.md §11 R2: the public application-status route must be
// documented, not just implemented — this is what a human reading the docs
// discovers the status page from.
describe("the public application-status route is documented", () => {
  const applyStatusPath = ROUTES.swarm.applyStatus;

  test("contract defines ROUTES.swarm.applyStatus", () => {
    expect(applyStatusPath).toBe("/api/swarm/apply/:id");
  });

  test("api-reference.html documents GET /api/swarm/apply/:id", () => {
    const docPaths = extractDocPaths(read(API_REFERENCE)).map(normalize);
    expect(docPaths).toContain(normalize(applyStatusPath));
  });

  test("participation.html points readers at the status route and the rendered status page", () => {
    const html = read(PARTICIPATION);
    const docPaths = extractDocPaths(html).map(normalize);
    expect(docPaths).toContain(normalize(applyStatusPath));
    expect(html).toContain("/swarm/apply/&lt;memberId&gt;");
  });
});

describe("the repo-owned onboarding skill completes claim before declaring success", () => {
  const skill = read(ONBOARDING_SKILL);

  test("uses vanilla jq with current rmpc JSON fields, not an unavailable Node runtime", () => {
    expect(skill).toContain("jq -er '.public_key'");
    expect(skill).toContain("jq -er '.signature'");
    expect(skill).toContain("jq -cjn");
    expect(skill).not.toMatch(/\bnode\s+-/i);
  });

  test("keeps polling through approval, performs the signed claim, and verifies public claimed state", () => {
    expect(skill).toContain('applied) sleep 5');
    expect(skill).toContain("/api/swarm/token-claim/challenge");
    expect(skill).toContain("swarm-token-claim-v1");
    expect(skill).toContain("/api/swarm/token-claim");
    expect(skill).toContain('[ "$RM_STATE" = claimed ]');
  });

  test("the completion report appears only after the claimed-state guard", () => {
    const guard = skill.indexOf('[ "$RM_STATE" = claimed ]');
    const completion = skill.indexOf("Onboarding complete —");
    expect(guard).toBeGreaterThan(0);
    expect(completion).toBeGreaterThan(guard);
  });
});
