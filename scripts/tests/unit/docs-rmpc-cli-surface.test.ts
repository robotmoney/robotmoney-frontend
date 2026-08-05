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
import { RMPC_COMMAND_NAMESPACE, missingCommitteeIdentitySubcommands } from "../../lib/rmpc-fetch.ts";

const repoRoot = join(import.meta.dir, "../../..");
const SHIPPED_ROOT = "frontend/public";
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

// The subcommand vocabulary rmpc-fetch.ts requires of the pinned binary.
const SUBCOMMANDS = missingCommitteeIdentitySubcommands("");
// "identity" — the namespace's trailing word, used to recognise a RENAMED
// namespace (`swarm-identity`, `member-identity`, …) anywhere in a page's prose,
// not just inside a command block. Derived, so renaming the real namespace in
// rmpc-fetch.ts (with a matching release) moves this rule with it.
const NAMESPACE_TAIL = RMPC_COMMAND_NAMESPACE.split("-").slice(-1)[0];

// A namespace-shaped token in prose. The lookbehind/lookahead keep file paths
// out of it: `./robotmoney-identity.json` is a keystore filename, not a command.
const NAMESPACE_SHAPED = new RegExp(`(?<![\\w./-])[a-z][a-z0-9]*-${NAMESPACE_TAIL}(?!\\.[a-z0-9]{1,5}\\b)`, "g");
// `rmpc <namespace> <word>` — an actual invocation, whose next word must be a
// real subcommand. Matching only after `rmpc` leaves prose ABOUT the namespace
// ("the committee-identity subcommand keeps its original name") alone.
const INVOCATION = new RegExp(`\\brmpc\\s+${RMPC_COMMAND_NAMESPACE}\\s+([a-z][a-z0-9-]*)`, "g");
// A bare word: a positional command token, as opposed to a flag (`--path`), a
// path (`./id.json`), a shell variable, or a quoted argument.
const POSITIONAL = /^[a-z][a-z0-9-]*$/;

function walkHtml(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkHtml(full, out);
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

function decodeEntities(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// The prose a reader actually sees: <script>/<style> bodies dropped first (a CSS
// class like `a3-dossier-identity` is not something anyone can type at a shell),
// then tags stripped, entities decoded, whitespace collapsed.
function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Every line inside a <code> span (inline or wrapped in <pre>), entity-decoded —
// the text a reader's clipboard gets from the docs' Copy button.
function codeLines(html: string): string[] {
  const lines: string[] = [];
  for (const [, body] of html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)) {
    for (const line of decodeEntities(body.replace(/<[^>]*>/g, " ")).split("\n")) lines.push(line.trim());
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
function rmpcSurfaceViolations(html: string): Violation[] {
  const found: Violation[] = [];
  const text = textOf(html);

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

  // Rule 2 — `rmpc <namespace> <word>` in the prose must name a subcommand
  // rmpc-fetch.ts verifies against the release.
  for (const m of text.matchAll(INVOCATION)) {
    if (SUBCOMMANDS.includes(m[1])) continue;
    found.push({
      rule: `subcommand must be one of ${SUBCOMMANDS.join(", ")} (verified against the pinned rmpc release)`,
      found: `rmpc ${RMPC_COMMAND_NAMESPACE} ${m[1]}`,
      context: text.slice(Math.max(0, m.index - 60), m.index + 60),
    });
  }

  // Rule 3 — copy-pasteable command lines. A <code> line that STARTS with
  // `rmpc` is a command, not prose (which is why the onboarding prompt block —
  // one long paragraph mentioning "the rmpc message-signing client" — is not
  // read as one). Its first two positional tokens are the namespace and the
  // subcommand; anything after those is arguments.
  for (const line of codeLines(html)) {
    if (!/^rmpc(\s|$)/.test(line)) continue;
    const positionals = line.split(/\s+/).slice(1).filter((t) => POSITIONAL.test(t));
    if (positionals.length > 0 && positionals[0] !== RMPC_COMMAND_NAMESPACE) {
      found.push({
        rule: `a copy-pasteable \`rmpc\` command must use the \`${RMPC_COMMAND_NAMESPACE}\` namespace`,
        found: positionals[0],
        context: line,
      });
    } else if (positionals.length > 1 && !SUBCOMMANDS.includes(positionals[1])) {
      found.push({
        rule: `a copy-pasteable \`rmpc ${RMPC_COMMAND_NAMESPACE}\` command must use one of ${SUBCOMMANDS.join(", ")}`,
        found: positionals[1],
        context: line,
      });
    }
  }

  return found;
}

function describeViolations(rel: string, violations: Violation[]): string {
  return violations.map((v) => `  ${rel}: ${JSON.stringify(v.found)} — ${v.rule}\n    …${v.context}…`).join("\n");
}

const shippedPages = walkHtml(join(repoRoot, SHIPPED_ROOT)).map((full) => ({
  rel: relative(repoRoot, full),
  html: readFileSync(full, "utf8"),
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
    const violations = shippedPages.flatMap(({ rel, html }) =>
      rmpcSurfaceViolations(html).map((v) => ({ rel, ...v })),
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
  const plant = (body: string) => `<html><body>${body}</body></html>`;

  test("the historical failure — `rmpc swarm-identity sign` in prose — is red", () => {
    const v = rmpcSurfaceViolations(plant("<p>Sign with <code>rmpc swarm-identity sign</code>.</p>"));
    expect(v.length).toBeGreaterThan(0);
    expect(v.map((x) => x.found)).toContain("swarm-identity");
  });

  test("a renamed namespace with no `rmpc` next to it is still red", () => {
    const v = rmpcSurfaceViolations(plant("<p>Drive it with its member-identity commands.</p>"));
    expect(v.map((x) => x.found)).toContain("member-identity");
  });

  test("a plausible but unverified subcommand is red", () => {
    const v = rmpcSurfaceViolations(plant("<p>Run <code>rmpc committee-identity vote</code> to submit.</p>"));
    expect(v.map((x) => x.found)).toContain("vote");
  });

  test("a copy-pasteable command under a bogus namespace is red", () => {
    const v = rmpcSurfaceViolations(plant("<pre><code>rmpc swarm vote-submit --payload ./take.json</code></pre>"));
    expect(v.map((x) => x.found)).toContain("swarm");
  });

  test("the shapes the rules must NOT flag stay green", () => {
    // Prose naming the binary, a keystore path, a CSS class, a flag-only
    // invocation, the real commands, and the onboarding prompt's "the rmpc
    // message-signing client" sentence — none of these are wrong commands.
    expect(
      rmpcSurfaceViolations(
        plant(
          '<style>.a3-dossier-identity { color: red }</style>' +
            "<p>an <code>rmpc</code> signature over the payload</p>" +
            "<p>See <code>rmpc --help</code> output.</p>" +
            "<pre><code>rmpc committee-identity --path ./robotmoney-identity.json show-public-key</code></pre>" +
            "<p>Drive it with <code>rmpc committee-identity create</code>, <code>show-public-key</code>, and <code>sign</code>.</p>" +
            "<pre><code>install the rmpc message-signing client, generate your signing key</code></pre>",
        ),
      ),
    ).toEqual([]);
  });
});
