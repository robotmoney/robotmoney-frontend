// Shipped-docs guard for `rmpc`'s CLI surface (issue #515).
//
// `rmpc` is robotmoney-core's binary (pinned v0.3.2), not this repo's code, so
// a command name in our HTML can only be wrong at RUNTIME, in a reader's
// terminal. That already happened: the Committee→Swarm rename reached into the
// docs and participation.html told applicants to sign with
// `rmpc swarm-identity sign` — a subcommand the binary does not have — while
// CI stayed green, because nothing asserted on the docs at all (docs/decisions.md
// D28; fixed in PR #481). Five more shipped pages name `rmpc` and were still
// unguarded when this file was written.
//
// This guard is deliberately NOT a list of today's pages: an enumerated list is
// silently escaped by the next page someone adds, which is the same shape of
// failure it exists to prevent. It DISCOVERS every shipped .html under
// frontend/public and applies three pattern rules to all of them, so a new page
// is covered the moment it lands. (Same discovery-over-enumeration shape as
// scripts/tests/unit/swarm-initials-lockstep.test.ts, which finds its subjects
// via a stub Alpine rather than naming them.)
//
// Every expectation is DERIVED from scripts/lib/rmpc-fetch.ts — the module that
// downloads the pinned release and asserts this exact surface against the real
// binary's `committee-identity --help`, and whose byte-exact signing path is
// proven by scripts/tests/integration/rmpc-canonical-apply.test.ts. Nothing here
// is a hand-typed expected command string:
//
//   * the namespace comes from RMPC_COMMAND_NAMESPACE, the literal argv token
//     that module passes to the binary;
//   * the subcommand list comes from missingCommitteeIdentitySubcommands(""),
//     which returns everything absent from empty help text — i.e. exactly the
//     set verified against the release.
//
// So the docs and the binary verification cannot drift apart: documenting a
// command rmpc does not expose is red here, and adopting a genuinely new rmpc
// command means teaching rmpc-fetch.ts to verify it first.
//
// No network, no binary download, nothing to skip: the rules are pure functions
// over checked-in files, executed in the REQUIRED unit.yml job (`bun run
// test:unit`, whose summary is grepped for a non-zero pass count). The
// planted-violation controls at the bottom keep the rules from being vacuously
// green — a guard only ever run against a clean tree is indistinguishable from
// one whose regexes match nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RMPC_COMMAND_NAMESPACE, missingCommitteeIdentitySubcommands, RMPC_ON_CHAIN_NAMESPACE, missingCommitteeSubcommands } from "../../lib/rmpc-fetch.ts";

const repoRoot = join(import.meta.dir, "../../..");
const SHIPPED_ROOT = "frontend/public";
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

// The subcommand vocabulary rmpc-fetch.ts requires of the pinned binary.
const SUBCOMMANDS = missingCommitteeIdentitySubcommands("");
const COMMITTEE_SUBCOMMANDS = missingCommitteeSubcommands("");

// "identity" — the namespace's trailing word, used to recognise a RENAMED
// namespace (`swarm-identity`, `member-identity`, …) anywhere in a page's prose.
const NAMESPACE_TAIL = RMPC_COMMAND_NAMESPACE.split("-").slice(-1)[0];

// A namespace-shaped token in prose.
const NAMESPACE_SHAPED = new RegExp(`(?<![\\w./-])[a-z][a-z0-9]*-${NAMESPACE_TAIL}(?!\\.[a-z0-9]{1,5}\\b)`, "g");

const VALID_NAMESPACES = new Map([
  [RMPC_COMMAND_NAMESPACE, SUBCOMMANDS],
  [RMPC_ON_CHAIN_NAMESPACE, COMMITTEE_SUBCOMMANDS]
]);

// `rmpc <namespace> <word>` — an actual invocation, whose next word must be a real subcommand.
const INVOCATION_IDENTITY = new RegExp(`\\brmpc\\s+${RMPC_COMMAND_NAMESPACE}\\s+([a-z][a-z0-9-]*)`, "g");
const INVOCATION_COMMITTEE = new RegExp(`\\brmpc\\s+${RMPC_ON_CHAIN_NAMESPACE}\\s+([a-z][a-z0-9-]*)`, "g");

// A bare word: a positional command token, as opposed to a flag (`--path`), a
// path (`./id.json`), a shell variable, or a quoted argument.
const POSITIONAL = /^[a-z][a-z0-9-]*$/;

function walkDocs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDocs(full, out);
    else if (entry.endsWith(".html") || entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function decodeEntities(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function textOf(content: string, isMarkdown: boolean): string {
  if (isMarkdown) return content.replace(/\s+/g, " ").trim();
  return decodeEntities(
    content
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function codeLines(content: string, isMarkdown: boolean): string[] {
  const lines: string[] = [];
  if (isMarkdown) {
    for (const [, body] of content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      for (const line of body.split("\n")) lines.push(line.trim());
    }
    for (const [, body] of content.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
      lines.push(body.trim());
    }
  } else {
    for (const [, body] of content.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)) {
      for (const line of decodeEntities(body.replace(/<[^>]*>/g, " ")).split("\n")) lines.push(line.trim());
    }
  }
  return lines;
}

interface Violation {
  rule: string;
  found: string;
  context: string;
}

/**
 * The whole guard, as one pure function over a page's HTML, so the planted
 * violations below exercise the SAME code path the shipped pages do.
 */
function rmpcSurfaceViolations(content: string, isMarkdown: boolean): Violation[] {
  const found: Violation[] = [];
  const text = textOf(content, isMarkdown);

  // Rule 1 — a renamed namespace anywhere in the visible prose. This is the
  // literal failure this file exists for: `rmpc swarm-identity sign`.
  for (const m of text.matchAll(NAMESPACE_SHAPED)) {
    if (m[0] === RMPC_COMMAND_NAMESPACE) continue;
    found.push({
      rule: `namespace must be \`${RMPC_COMMAND_NAMESPACE}\` (the argv scripts/lib/rmpc-fetch.ts runs)`,
      found: m[0],
      context: text.slice(Math.max(0, m.index - 60), m.index + 60),
    });
  }

  // Rule 2 — `rmpc <namespace> <word>` in the prose must name a subcommand verified against the release.
  for (const m of text.matchAll(INVOCATION_IDENTITY)) {
    if (SUBCOMMANDS.includes(m[1])) continue;
    found.push({
      rule: `subcommand must be one of ${SUBCOMMANDS.join(", ")} (verified against the pinned rmpc release)`,
      found: `rmpc ${RMPC_COMMAND_NAMESPACE} ${m[1]}`,
      context: text.slice(Math.max(0, m.index - 60), m.index + 60),
    });
  }
  for (const m of text.matchAll(INVOCATION_COMMITTEE)) {
    if (COMMITTEE_SUBCOMMANDS.includes(m[1])) continue;
    found.push({
      rule: `subcommand must be one of ${COMMITTEE_SUBCOMMANDS.join(", ")} (verified against the pinned rmpc release)`,
      found: `rmpc ${RMPC_ON_CHAIN_NAMESPACE} ${m[1]}`,
      context: text.slice(Math.max(0, m.index - 60), m.index + 60),
    });
  }

  // Rule 3 — copy-pasteable command lines. A <code> line that STARTS with `rmpc` is a command, not prose.
  for (const line of codeLines(content, isMarkdown)) {
    if (!/^rmpc(\s|$)/.test(line)) continue;
    const positionals = line.split(/\s+/).slice(1).filter((t) => POSITIONAL.test(t));
    if (positionals.length > 0 && !VALID_NAMESPACES.has(positionals[0])) {
      found.push({
        rule: `a copy-pasteable \`rmpc\` command must use one of the verified namespaces (${Array.from(VALID_NAMESPACES.keys()).join(", ")})`,
        found: positionals[0],
        context: line,
      });
    } else if (positionals.length > 1) {
      const allowedSubs = VALID_NAMESPACES.get(positionals[0])!;
      if (!allowedSubs.includes(positionals[1])) {
        found.push({
          rule: `a copy-pasteable \`rmpc ${positionals[0]}\` command must use one of ${allowedSubs.join(", ")}`,
          found: positionals[1],
          context: line,
        });
      }
    }
  }

  return found;
}

function describeViolations(rel: string, violations: Violation[]): string {
  return violations.map((v) => `  ${rel}: ${JSON.stringify(v.found)} — ${v.rule}\n    …${v.context}…`).join("\n");
}

const shippedPages = walkDocs(join(repoRoot, SHIPPED_ROOT)).map((full) => ({
  rel: relative(repoRoot, full),
  html: readFileSync(full, "utf8"),
  isMarkdown: full.endsWith(".md"),
}));
const rmpcPages = shippedPages.filter((p) => /\brmpc\b/.test(p.html));

// The chain this whole file leans on: constant → argv → real binary. If any
// link breaks, every rule above silently loosens, so each link is asserted.
describe("the expected rmpc surface is derived from the module that runs the binary", () => {
  test("rmpc-fetch.ts still declares the subcommand contract it verifies against the pinned release", () => {
    expect(SUBCOMMANDS).toEqual(["create", "show-public-key", "sign"]);
  });

  test("the exported namespace is the argv token rmpc-fetch.ts actually passes to the binary", () => {
    expect(RMPC_COMMAND_NAMESPACE).toBe("committee-identity");
    const source = readFileSync(join(repoRoot, "scripts/lib/rmpc-fetch.ts"), "utf8");
    expect(
      source,
      "rmpc-fetch.ts must spawn the binary with RMPC_COMMAND_NAMESPACE — a re-typed literal there would let the " +
        "docs guard pin a namespace the binary is never asked for",
    ).toContain('[rmpcPath, RMPC_COMMAND_NAMESPACE, "--help"]');
  });
});

describe("every shipped HTML page names only rmpc commands the binary has (issue #515)", () => {
  // Anti-vacuity floor. The rules apply to every discovered page — a new page
  // needs no edit here — but a walker or a filter that stopped matching would
  // otherwise pass in silence. These six are the pages naming rmpc when the
  // guard was written; the count assertion is a floor, never a cap.
  test("discovery finds the shipped pages that name rmpc", () => {
    expect(shippedPages.length).toBeGreaterThan(50);
    const named = rmpcPages.map((p) => p.rel).sort();
    for (const rel of [
      "frontend/public/views/changelog.html",
      "frontend/public/views/docs/investment-swarm/api-reference.html",
      "frontend/public/views/docs/investment-swarm/how-it-works.html",
      "frontend/public/views/docs/investment-swarm/participation.html",
      "frontend/public/views/docs/investment-swarm/runbook.html",
      "frontend/public/views/swarm/apply.html",
    ]) {
      expect(named, `${rel} names rmpc but the walker did not discover it`).toContain(rel);
    }
    expect(named.length).toBeGreaterThanOrEqual(6);
  });

  test("no shipped page documents an rmpc command the pinned release does not expose", () => {
    const violations = shippedPages.flatMap(({ rel, html, isMarkdown }) =>
      rmpcSurfaceViolations(html, isMarkdown).map((v) => ({ rel, ...v })),
    );
    expect(
      violations,
      "shipped pages document rmpc commands that scripts/lib/rmpc-fetch.ts does not verify against the pinned " +
        "release — a reader following these gets `unrecognized subcommand`:\n" +
        violations.map((v) => describeViolations(v.rel, [v])).join("\n"),
    ).toEqual([]);
  });
});

// Planted violations. Each is the real-world drift the matching rule exists to
// stop, run through the same rmpcSurfaceViolations() the pages are checked with,
// so "green" above always means "the rules looked and found nothing" rather than
// "the rules matched nothing".
describe("the rules are seen to go red on the drift they exist to catch", () => {
  const plantHtml = (body: string) => `<html><body>${body}</body></html>`;

  test("the historical failure — `rmpc swarm-identity sign` in prose — is red", () => {
    const v = rmpcSurfaceViolations(plantHtml("<p>Sign with <code>rmpc swarm-identity sign</code>.</p>"), false);
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.found)).toContain("swarm-identity");
  });

  test("a renamed namespace with no `rmpc` next to it is still red", () => {
    const v = rmpcSurfaceViolations(plantHtml("<p>Drive it with its member-identity commands.</p>"), false);
    expect(v.map((x) => x.found)).toContain("member-identity");
  });

  test("a plausible but unverified subcommand is red", () => {
    const v = rmpcSurfaceViolations(plantHtml("<p>Run <code>rmpc committee-identity vote</code> to submit.</p>"), false);
    expect(v.map((x) => x.found)).toContain("vote");
  });

  test("a copy-pasteable command under a bogus namespace is red", () => {
    const v = rmpcSurfaceViolations(plantHtml("<pre><code>rmpc swarm vote-submit --payload ./take.json</code></pre>"), false);
    expect(v.map((x) => x.found)).toContain("swarm");
  });

  test("the shapes the rules must NOT flag stay green", () => {
    // Prose naming the binary, a keystore path, a CSS class, a flag-only
    // invocation, the real commands, and the onboarding prompt's "the rmpc
    // message-signing client" sentence — none of these are wrong commands.
    expect(
      rmpcSurfaceViolations(
        plantHtml(
          '<style>.a3-dossier-identity { color: red }</style>' +
            "<p>an <code>rmpc</code> signature over the payload</p>" +
            "<p>See <code>rmpc --help</code> output.</p>" +
            "<pre><code>rmpc committee-identity --path ./robotmoney-identity.json show-public-key</code></pre>" +
            "<p>Drive it with <code>rmpc committee-identity create</code>, <code>show-public-key</code>, and <code>sign</code>.</p>" +
            "<pre><code>install the rmpc message-signing client, generate your signing key</code></pre>",
        ),
        false
      ),
    ).toEqual([]);
  });

  test("Markdown rules distinguish prose (rmpc release's) from invocation", () => {
    const md = `the pinned rmpc release's own CLI surface`;
    const v = rmpcSurfaceViolations(md, true);
    expect(v).toEqual([]);
  });

  test("Markdown red control: fabricated rmpc invocation makes guard fail", () => {
    const md = `Here is a command:
\`\`\`bash
rmpc swarm vote-submit
\`\`\``;
    const v = rmpcSurfaceViolations(md, true);
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.found)).toContain("swarm");
  });
});

