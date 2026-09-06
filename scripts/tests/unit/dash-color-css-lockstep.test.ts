// Lockstep guard for `DASH_COLOR` — the hex constants in
// frontend/public/assets/js/app/alpine/lib/sparkline.js that are a hand-copied
// duplicate of dash.css's `.a3` HSL tokens (issue #516).
//
// sparkline.js cannot do a CSSOM read without giving up its purity (see its
// header), so the hex literals stay — but until this file existed the ONLY
// link between the two sides was a `//` comment, and
// scripts/tests/unit/sparkline.test.ts asserted the rendered stroke/fill
// against `DASH_COLOR` itself. That assertion is vacuous with respect to the
// real invariant: both sides could drift apart and nothing went red. Exactly
// the failure mode that let the retired `"IC"` initials fallback survive a
// whole-repo rename in two files at once (issue #496 / PR #481).
//
// What this file does instead, in the discovery shape of
// scripts/tests/unit/swarm-initials-lockstep.test.ts: it never enumerates the
// pairs. It reads sparkline.js, discovers every `DASH_COLOR` entry AND the
// `--token` name(s) its own comment cites, then resolves those names in
// dash.css's `.a3` block and checks the hex against the token's exact HSL.
// Adding a fifth `DASH_COLOR` entry is therefore covered automatically — and
// adding one WITHOUT a `--token` comment is red, so the comment that used to
// be decorative is now load-bearing.
//
// The rendered-output tests at the bottom close the loop end to end: the
// expected color comes from dash.css, the actual color from a real
// renderSparkline/renderRowSparkline call. Nothing is compared to itself.
//
// Runs in the required `unit.yml` job via `bun run test:unit` (issue #819
// removed that workflow's separate `bun run test` sweep — it recursed into
// the Docker-backed scripts/tests/integration/, so test:unit is now the only
// selector this file runs under). It is NOT run by integration.yml: #275
// moved the root sweep out of it (the stale headers that still claim
// otherwise are issue #517).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderRowSparkline, renderSparkline } from "../../../frontend/public/assets/js/app/alpine/lib/sparkline.js";

const repoRoot = join(import.meta.dir, "../../..");
const SPARKLINE_JS = "frontend/public/assets/js/app/alpine/lib/sparkline.js";
const DASH_CSS = "frontend/public/assets/css/dash.css";

const sparklineSource = readFileSync(join(repoRoot, SPARKLINE_JS), "utf8");
const dashCssSource = readFileSync(join(repoRoot, DASH_CSS), "utf8");

/** One discovered `DASH_COLOR` entry: its key, hex literal, and cited CSS tokens. */
interface ColorEntry {
  key: string;
  hex: string;
  /** `--var` names named by the entry's own comment, e.g. ["--chart-1", "--primary"]. */
  tokens: string[];
  /** The `hsl(...)` triple the comment claims, normalized, or "" when absent. */
  claimedHsl: string;
}

// ── Parsers ────────────────────────────────────────────────────────────────

/** Body of `export const DASH_COLOR = { ... }` (throws rather than scanning nothing). */
function dashColorBlock(js: string): string {
  const start = js.indexOf("export const DASH_COLOR = {");
  if (start === -1) throw new Error(`${SPARKLINE_JS}: no 'export const DASH_COLOR = {' — the guard would scan nothing`);
  const end = js.indexOf("\n};", start);
  if (end === -1) throw new Error(`${SPARKLINE_JS}: DASH_COLOR object literal is not closed by a '\\n};'`);
  return js.slice(start + "export const DASH_COLOR = {".length, end);
}

/** Normalize `142 70% 45%` / `142, 70%, 45%` to a canonical `142 70% 45%`. */
function normalizeHsl(raw: string): string {
  return raw.trim().replace(/,/g, " ").replace(/\s+/g, " ");
}

/**
 * Every `key: "#hex"` entry in the DASH_COLOR literal, together with the
 * `--token` names and `hsl(...)` triple its immediately-preceding `//` comment
 * cites. An entry with no comment yields `tokens: []`, which the checks below
 * treat as a failure — the annotation is the link being enforced.
 */
function parseDashColorEntries(js: string): ColorEntry[] {
  const entries: ColorEntry[] = [];
  let comment = "";
  for (const line of dashColorBlock(js).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      comment = `${comment} ${trimmed.slice(2).trim()}`.trim();
      continue;
    }
    const decl = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*"([^"]*)"\s*,?$/);
    if (decl) {
      const hsl = comment.match(/hsl\(\s*([^)]*?)\s*\)/);
      entries.push({
        key: decl[1] as string,
        hex: decl[2] as string,
        tokens: [...comment.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]),
        claimedHsl: hsl ? normalizeHsl(hsl[1] as string) : "",
      });
    }
    comment = "";
  }
  return entries;
}

/** Custom properties declared in dash.css's `.a3 { ... }` block, as `--name → value`. */
function parseA3Tokens(css: string): Record<string, string> {
  const start = css.indexOf("\n.a3 {");
  if (start === -1) throw new Error(`${DASH_CSS}: no top-level '.a3 {' block — the guard would resolve nothing`);
  const end = css.indexOf("\n}", start);
  if (end === -1) throw new Error(`${DASH_CSS}: '.a3 {' block is not closed by a '\\n}'`);
  const tokens: Record<string, string> = {};
  for (const line of css.slice(start, end).split("\n")) {
    const decl = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/);
    if (decl) tokens[decl[1] as string] = normalizeHsl(decl[2] as string);
  }
  return tokens;
}

// ── Color math ─────────────────────────────────────────────────────────────

/**
 * CSS `hsl(h s% l%)` → exact, UNROUNDED rgb channels in 0..255. Kept
 * fractional on purpose: `hsl(186 100% 50%)` is exactly (0, 229.5, 255), a
 * half-step tie no rounding rule resolves canonically, and the shipped
 * `#00e5ff` picks 229. Rounding here would manufacture a false mismatch.
 */
function hslToRgb(hsl: string): [number, number, number] {
  const parts = hsl.split(" ");
  if (parts.length !== 3) throw new Error(`not an hsl triple: ${JSON.stringify(hsl)}`);
  const h = Number(parts[0]);
  const s = Number((parts[1] as string).replace("%", "")) / 100;
  const l = Number((parts[2] as string).replace("%", "")) / 100;
  if (![h, s, l].every(Number.isFinite)) throw new Error(`not an hsl triple: ${JSON.stringify(hsl)}`);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  ) as [number, number, number];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** `#rrggbb` → integer channels. */
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) throw new Error(`not a 6-digit hex color: ${JSON.stringify(hex)}`);
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const CHANNEL_TOLERANCE = 0.5 + 1e-9; // nearest byte, incl. the .5 tie; float slack only

/** "" when `hex` is the nearest byte to `hsl` on every channel, else the reason. */
function hexVsHsl(hex: string, hsl: string): string {
  const got = hexToRgb(hex);
  const want = hslToRgb(hsl);
  const off = [0, 1, 2].filter((i) => Math.abs((got[i] as number) - (want[i] as number)) > CHANNEL_TOLERANCE);
  if (off.length === 0) return "";
  return `${hex} is rgb(${got.join(", ")}) but hsl(${hsl}) is rgb(${want.map((v) => v.toFixed(2)).join(", ")})`;
}

// ── The check, as a pure function so it can be driven over planted violations ──

/**
 * Every way `DASH_COLOR` and dash.css's `.a3` tokens can be out of lockstep,
 * as human-readable problem strings. Empty array = in sync.
 */
function lockstepProblems(js: string, css: string): string[] {
  const tokens = parseA3Tokens(css);
  const problems: string[] = [];
  const entries = parseDashColorEntries(js);
  if (entries.length === 0) problems.push("DASH_COLOR declares no entries — the guard would compare nothing");

  for (const entry of entries) {
    const where = `DASH_COLOR.${entry.key}`;
    if (entry.tokens.length === 0) {
      problems.push(`${where}: no '--token' named in its comment, so nothing in dash.css can be cross-checked against it`);
      continue;
    }
    const values = new Set<string>();
    for (const token of entry.tokens) {
      const value = tokens[token];
      if (value === undefined) {
        problems.push(`${where}: comment cites ${token}, which is not declared in ${DASH_CSS}'s .a3 block`);
        continue;
      }
      values.add(value);
    }
    if (values.size > 1) {
      problems.push(`${where}: cited tokens ${entry.tokens.join(" / ")} no longer hold the same value (${[...values].join(" vs ")})`);
      continue;
    }
    const [value] = [...values];
    if (value === undefined) continue;
    if (entry.claimedHsl && entry.claimedHsl !== value) {
      problems.push(`${where}: comment claims hsl(${entry.claimedHsl}) but ${entry.tokens[0]} is ${value} in ${DASH_CSS}`);
    }
    const drift = hexVsHsl(entry.hex, value);
    if (drift) problems.push(`${where}: ${drift} (${entry.tokens.join(" / ")})`);
  }
  return problems;
}

const ENTRIES = parseDashColorEntries(sparklineSource);
const A3_TOKENS = parseA3Tokens(dashCssSource);

/** The single `.a3` token value backing a DASH_COLOR key, for the render tests. */
function tokenValueFor(key: string): { token: string; hsl: string } {
  const entry = ENTRIES.find((e) => e.key === key);
  if (!entry || entry.tokens.length === 0) throw new Error(`DASH_COLOR.${key} is not annotated with a --token`);
  const token = entry.tokens[0] as string;
  const hsl = A3_TOKENS[token];
  if (hsl === undefined) throw new Error(`${token} is not declared in ${DASH_CSS}`);
  return { token, hsl };
}

function strokeOf(svg: string): string {
  return svg.match(/\bstroke="(#[^"]+)"/)?.[1] ?? "";
}

function fillOf(svg: string): string {
  return svg.match(/<path[^>]*\bfill="(#[^"]+)"/)?.[1] ?? "";
}

/** Assert a color rendered into real SVG output is dash.css's token, not DASH_COLOR's copy of it. */
function expectRenderedToken(rendered: string, key: string): void {
  const { token, hsl } = tokenValueFor(key);
  expect(rendered, `expected a hex color in the rendered SVG for DASH_COLOR.${key}`).toMatch(/^#[0-9a-f]{6}$/);
  expect(hexVsHsl(rendered, hsl), `rendered color for DASH_COLOR.${key} vs ${DASH_CSS} ${token}: ${hsl}`).toBe("");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DASH_COLOR is discovered, not enumerated (issue #516)", () => {
  // Canary against a vacuous pass: if the parse stops finding entries, every
  // comparison below would iterate an empty list and go green.
  test("every DASH_COLOR entry is found by the source parse and matches the imported object", async () => {
    const { DASH_COLOR } = await import("../../../frontend/public/assets/js/app/alpine/lib/sparkline.js");
    expect(ENTRIES.length).toBeGreaterThanOrEqual(4);
    expect(ENTRIES.map((e) => e.key).sort()).toEqual(Object.keys(DASH_COLOR).sort());
    for (const entry of ENTRIES) {
      expect((DASH_COLOR as Record<string, string>)[entry.key], `DASH_COLOR.${entry.key}`).toBe(entry.hex);
    }
  });

  test("dash.css's .a3 block parses to a non-empty token table", () => {
    expect(Object.keys(A3_TOKENS).length).toBeGreaterThan(10);
    expect(A3_TOKENS["--success"]).toBeDefined();
  });

  test("every entry cites at least one dash.css --token in its comment", () => {
    for (const entry of ENTRIES) {
      expect(entry.tokens.length, `DASH_COLOR.${entry.key} names no --token`).toBeGreaterThan(0);
      expect(entry.claimedHsl, `DASH_COLOR.${entry.key} names no hsl() triple`).not.toBe("");
    }
  });
});

describe("DASH_COLOR's hex literals match dash.css's .a3 tokens", () => {
  test("no drift between the two sides", () => {
    const problems = lockstepProblems(sparklineSource, dashCssSource);
    expect(
      problems,
      `${SPARKLINE_JS} and ${DASH_CSS} have drifted — the hex literals are a copy of the .a3 tokens and must be edited together:\n` +
        problems.map((p) => `  ${p}`).join("\n"),
    ).toEqual([]);
  });

  // Planted-violation controls. A cross-check that has only ever run against a
  // clean tree is indistinguishable from one whose regex matches nothing, so
  // the red direction is asserted in CI too — not left to a manual experiment.
  test("RED CONTROL: editing the JS side alone is caught", () => {
    const mutated = sparklineSource.replace('up: "#22c35d"', 'up: "#22c35e"');
    expect(mutated, "fixture no longer matches the real source").not.toBe(sparklineSource);
    expect(lockstepProblems(mutated, dashCssSource).join("\n")).toContain("DASH_COLOR.up");
  });

  test("RED CONTROL: editing the CSS side alone is caught", () => {
    const mutated = dashCssSource.replace("--success: 142 70% 45%;", "--success: 142 70% 46%;");
    expect(mutated, "fixture no longer matches the real source").not.toBe(dashCssSource);
    expect(lockstepProblems(sparklineSource, mutated).join("\n")).toContain("DASH_COLOR.up");
  });

  test("RED CONTROL: a hue-only CSS edit that leaves lightness alone is caught", () => {
    const mutated = dashCssSource.replace("--muted-foreground: 220 12% 60%;", "--muted-foreground: 200 12% 60%;");
    expect(mutated).not.toBe(dashCssSource);
    expect(lockstepProblems(sparklineSource, mutated).join("\n")).toContain("DASH_COLOR.flat");
  });

  test("RED CONTROL: a new entry added without a --token comment is caught", () => {
    const mutated = sparklineSource.replace('export const DASH_COLOR = {', 'export const DASH_COLOR = {\n  warn: "#f5a623",');
    expect(mutated).not.toBe(sparklineSource);
    expect(lockstepProblems(mutated, dashCssSource).join("\n")).toContain("DASH_COLOR.warn: no '--token' named");
  });

  test("RED CONTROL: citing a token that no longer exists in dash.css is caught", () => {
    const mutated = sparklineSource.replace("// --success, hsl(142 70% 45%)", "// --successful, hsl(142 70% 45%)");
    expect(mutated).not.toBe(sparklineSource);
    expect(lockstepProblems(mutated, dashCssSource).join("\n")).toContain("--successful");
  });

  test("RED CONTROL: a comment whose hsl() triple drifts from the token is caught", () => {
    const mutated = sparklineSource.replace("// --destructive, hsl(0 65% 55%)", "// --destructive, hsl(0 65% 50%)");
    expect(mutated).not.toBe(sparklineSource);
    expect(lockstepProblems(mutated, dashCssSource).join("\n")).toContain("comment claims hsl(0 65% 50%)");
  });

  test("GREEN CONTROL: reverting a planted edit is in sync again", () => {
    const mutated = sparklineSource.replace('up: "#22c35d"', 'up: "#22c35e"');
    expect(lockstepProblems(mutated.replace('up: "#22c35e"', 'up: "#22c35d"'), dashCssSource)).toEqual([]);
  });

  test("the hsl→rgb conversion is pinned to known values, so a broken converter cannot pass everything", () => {
    expect(hslToRgb("0 0% 0%").map(Math.round)).toEqual([0, 0, 0]);
    expect(hslToRgb("0 0% 100%").map(Math.round)).toEqual([255, 255, 255]);
    expect(hslToRgb("0 100% 50%").map(Math.round)).toEqual([255, 0, 0]);
    expect(hslToRgb("120 100% 50%").map(Math.round)).toEqual([0, 255, 0]);
    expect(hslToRgb("240 100% 50%").map(Math.round)).toEqual([0, 0, 255]);
    expect(hexVsHsl("#00e5ff", "186 100% 50%")).toBe(""); // the exact .5 tie
    expect(hexVsHsl("#00e6ff", "186 100% 50%")).toBe(""); // the other side of the same tie
    expect(hexVsHsl("#00e7ff", "186 100% 50%")).not.toBe("");
  });
});

describe("rendered sparkline colors come from dash.css, not from DASH_COLOR's copy", () => {
  test("the four trend colors are distinct, so routing between them is observable", () => {
    const hexes = ENTRIES.map((e) => e.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  test("default renderSparkline strokes with the .a3 accent token", () => {
    expectRenderedToken(strokeOf(renderSparkline([1, 2, 3, 4])), "accent");
  });

  test("renderRowSparkline rising >0.5% fills and strokes with the .a3 'up' token", () => {
    const svg = renderRowSparkline([1, 1, 1, 2]);
    expectRenderedToken(fillOf(svg), "up");
    expectRenderedToken(strokeOf(svg), "up");
  });

  test("renderRowSparkline falling fills and strokes with the .a3 'down' token", () => {
    const svg = renderRowSparkline([2, 2, 2, 1]);
    expectRenderedToken(fillOf(svg), "down");
    expectRenderedToken(strokeOf(svg), "down");
  });

  test("renderRowSparkline inside the ±0.5% band fills and strokes with the .a3 'flat' token", () => {
    const svg = renderRowSparkline([1, 1, 1, 1.001]);
    expectRenderedToken(fillOf(svg), "flat");
    expectRenderedToken(strokeOf(svg), "flat");
  });

  test("a zero baseline still routes by sign to the .a3 'up'/'down' tokens", () => {
    expectRenderedToken(fillOf(renderRowSparkline([0, 0, 0, 1])), "up");
    expectRenderedToken(fillOf(renderRowSparkline([0, 0, 0, -1])), "down");
  });
});
