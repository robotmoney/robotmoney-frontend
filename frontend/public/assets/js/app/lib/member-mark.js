// Deterministic identity marks for swarm members (issue #560, RM-48).
//
// No member avatar resolves: /avatars/swarm/{woon,robotmoney,athena}.jpg all
// 404, `frontend/public/avatars/` does not exist, and members who arrive
// through the funnel have no manifest to declare one in. So the whole roster
// renders as two grey letters in a box. A derived mark needs no art, no upload
// pipeline and no moderation surface, and it is the same mark on every page
// because it is a pure function of the member's identifier.
//
// THE SEED. #560 specifies the Ed25519 public key, on the argument that a
// member's mark should be a function of the thing that signs its takes. No
// route exposes one: `toMember()` and `toMemberAdmin()` both omit key material
// deliberately, and the receipt route recomputes verification server-side
// rather than publishing the key. So the caller passes `keyFingerprint ?? id`
// and today that is always the id. If a non-secret fingerprint is ever added
// to the projection, this file does not change and the call sites do not
// change; the marks shift once, which is the cost of the deferral.
//
// COLOUR. Two hues per mark, from the same brand set the charts use, with two
// withheld for reasons that already exist in this codebase:
//
// - CYAN IS NEVER A FIGURE. Beam is the house colour and the covenant makes it
//   a LINE: a seam or a rule, never a plane and never a numeral. A mark is a
//   figure, so cyan cannot be in its palette. #560's reference list opens with
//   a cyan; this is the one place it is not followed. (This used to cite the
//   cyan seam on `.sv__avatar` as the precedent. RM-100 removed that seam for
//   being an accent rail that marked nothing; the covenant reason stands on
//   its own and is the real one.)
// - BEACON MEANS LOSS. `subjectDot()` already withholds it for the same
//   reason: letting a hash land an ordinary member on the attention colour
//   would say something untrue about that member, permanently.
//
// The remaining five split into a green family and everything else, and the
// pairing table below never draws both hues from the green family. Two greens
// in adjacent quadrants is the muddiness #560 flags at small sizes, and it is
// cheaper to make it unreachable than to check for it after the fact.
import { PALETTE, SERIES } from "./chart-theme.js";

/** @type {Record<string, string>} */
const HUES = {
  emerald: SERIES.emerald, // #10b981 green
  sand: SERIES.sand, // #e8a640 warm
  slate: SERIES.slate, // #7e889e neutral
  teal: SERIES.teal, // #5fb3a1 blue-green
  mint: SERIES.mint, // #9cffd2 light green
};

// Every first hue, and the hues that genuinely contrast with it. Read down the
// left column for the primary; the right is what the second hue may be.
//
// SLATE IS A PARTNER, NEVER A PRIMARY. It is --color-text-muted, and the whole
// interface uses it to mean absent, secondary or inactive. A member whose mark
// leads with it looks switched off next to one that leads with green, which is
// a status claim the mark has no business making. It stays available as the
// contrast half, where it reads as ground rather than as the figure.
/** @type {Record<string, string[]>} */
const CONTRAST = {
  emerald: ["sand", "slate"],
  teal: ["sand", "slate"],
  mint: ["sand", "slate"],
  sand: ["emerald", "slate", "teal", "mint"],
};
const PRIMARIES = Object.keys(CONTRAST);

// Below this rendered size the four-quadrant form loses legibility (#560's own
// note: quadrant blocks are the most distinct at 120px and the muddiest at
// 32px). Measured on the real roster, 32px still reads: it is 20px that turns
// four cells into noise. Under the threshold the mark drops to two cells,
// which is the smallest form that still varies by shape and not by hue alone.
export const QUADRANT_MIN_PX = 32;

// FNV-1a, re-mixed per byte. Deterministic, no dependencies, and stable across
// engines, which matters because the same member must get the same mark on
// every device and in the prerendered HTML. `Math.imul`, `charCodeAt` and
// `>>> 0` are all exactly specified, so no engine is free to disagree.
//
// NEVER TAKE THE LOW BYTE. The first cut of this function ended `h & 0xff` and
// it was not a hash at all. `Math.imul` is a multiply mod 2^32, so the low 8
// bits of a product are a function of only the low 8 bits of its operands, and
// XOR is bitwise — meaning the low byte of `h` evolves in a closed 8-bit
// system that never sees the other 24. The generator's whole effective state
// was one byte, every one of the n outputs was drawn from it, and the marks
// collided immediately: `woon` and `noop-analyst`, both on the committed
// roster, rendered byte-identical SVG, as did `hermes`/`kronos` and
// `selene`/`zephyr`. Over 50,000 random UUID seeds the 40px form produced 140
// distinct marks; this encoder can reach 247,303. FNV's low bits are its
// documented weak end; this is what relying on them looks like.
//
// The fix xor-folds all four bytes down to one. FNV's own authors specify
// xor-folding as the way to narrow a hash to fewer bits than it computes, and
// it is the choice that does not require betting on which end of `h` carries
// the entropy: taking `h >>> 24` measures identically well here, but it is
// only correct for as long as the high end stays the strong one. Folding uses
// every bit, so it survives a change of multiplier or offset basis. Measured
// against the same shape encoder driven by crypto-random bytes, the folded
// output is indistinguishable from ideal input (see
// scripts/tests/unit/member-mark-distinctness.test.ts).
/**
 * @param {string} seed
 * @param {number} n
 * @returns {number[]}
 */
function bytes(seed, n) {
  /** @type {number[]} */
  const out = [];
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j) + i * 31;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(((h >>> 24) ^ (h >>> 16) ^ (h >>> 8) ^ h) & 0xff);
  }
  return out;
}

/**
 * @param {number[]} b
 * @returns {[string, string]}
 */
function huesFor(b) {
  const primary = PRIMARIES[b[0] % PRIMARIES.length];
  const options = CONTRAST[primary];
  return [HUES[primary], HUES[options[b[1] % options.length]]];
}

/** @type {(x: number, y: number, w: number, h: number, fill: string) => string} */
const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
/** @type {(x: number, y: number, s: number, fill: string, corner: number) => string} */
const tri = (x, y, s, fill, corner) => {
  // Right triangle filling half the cell, hypotenuse away from `corner`.
  const pts = [
    [[x, y], [x + s, y], [x, y + s]],
    [[x, y], [x + s, y], [x + s, y + s]],
    [[x + s, y], [x + s, y + s], [x, y + s]],
    [[x, y], [x + s, y + s], [x, y + s]],
  ][corner];
  return `<polygon points="${pts.map((p) => p.join(",")).join(" ")}" fill="${fill}"/>`;
};

// Four cells, each independently filled, halved or triangulated. The cell's
// hue is one of the two, chosen per cell, so a mark reads as a composition
// rather than a checkerboard.
/**
 * @param {number[]} b
 * @param {string} h1
 * @param {string} h2
 * @returns {string}
 */
function quadrants(b, h1, h2) {
  const s = 50;
  let out = "";
  for (let i = 0; i < 4; i++) {
    const x = (i % 2) * s;
    const y = Math.floor(i / 2) * s;
    const fill = b[i + 6] & 1 ? h1 : h2;
    const mode = b[i + 2] % 4;
    if (mode === 0) out += rect(x, y, s, s, fill);
    else if (mode === 1) out += tri(x, y, s, fill, b[i + 2] >> 2 & 3);
    else if (mode === 2) out += rect(x, y + s / 2, s, s / 2, fill);
    else out += rect(x, y, s / 2, s, fill);
  }
  return out;
}

// Small-size form: TWO cells rather than four, each independently solid or
// triangulated. A plain two-hue split was the first cut and it collided badly
// (two members with the same hue pair and the same diagonal are the same mark
// at 20px, and with four hue pairs available that happens on a roster this
// size). Two cells with their own modes give 2 orientations x 4 modes squared
// x 2 hue assignments, which is enough separation for a roster that will not
// outgrow a page.
/**
 * @param {number[]} b
 * @param {string} h1
 * @param {string} h2
 * @returns {string}
 */
function split(b, h1, h2) {
  const vertical = (b[2] & 1) === 0;
  const cells = vertical
    ? [[0, 0, 50, 100], [50, 0, 50, 100]]
    : [[0, 0, 100, 50], [0, 50, 100, 50]];
  let out = "";
  for (let i = 0; i < 2; i++) {
    const [x, y, w, h] = cells[i];
    const fill = b[i + 6] & 1 ? h1 : h2;
    const mode = b[i + 3] % 4;
    if (mode === 0) out += rect(x, y, w, h, fill);
    else if (mode === 1) out += rect(x, y + h / 2, w, h / 2, fill);
    else if (mode === 2) out += rect(x, y, w / 2, h, fill);
    else out += rect(x + w / 2, y, w / 2, h, fill);
  }
  return out;
}

/**
 * SVG markup for a member's identity mark, or "" when there is no seed.
 *
 * The seed is NEVER interpolated into the output: it only ever indexes a fixed
 * palette and produces numbers, so the returned string cannot carry anything a
 * member id put there. That is what makes it safe to bind with `x-html`.
 *
 * @param {string} seed  keyFingerprint when one exists, else the member id.
 * @param {number} [size]  the rendered edge in px, which selects the detail level.
 * @returns {string}
 */
export function memberMark(seed, size = 40) {
  const key = String(seed || "");
  if (!key) return "";
  const b = bytes(key, 12);
  const [h1, h2] = huesFor(b);
  const shapes = size >= QUADRANT_MIN_PX ? quadrants(b, h1, h2) : split(b, h1, h2);
  return `<svg class="sv__mark-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${shapes}</svg>`;
}

/**
 * The mark when there is a seed, the initials when there is not.
 *
 * #560's precedence is uploaded art, then the derived mark, then initials. The
 * first is not built yet (it is the backend half of that issue), so this is the
 * bottom two rungs. `initialsFn` output is already stripped to letters and
 * digits by its own callers, so binding it through `x-html` renders text.
 *
 * @param {string} seed
 * @param {string} name
 * @param {number} size
 * @param {(name: string) => string} initialsFn
 * @returns {string}
 */
export function memberMarkOrInitials(seed, name, size, initialsFn) {
  return memberMark(seed, size) || String(initialsFn(name) ?? "");
}

// Minimal HTML-attribute escaper for memberAvatarMarkup below. Not exported
// with the rest of the app's escaping (static-views.js's `escapeHtml`) because
// this module has no `this` to hang a shared helper off and pulling in a
// second module for four lines is not worth the coupling.
/** @type {Record<string, string>} */
const ATTR_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** @param {string} s */
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ATTR_ESCAPES[ch]);
}

/**
 * Full avatar precedence for #625: manifest `avatar.path` first, the derived
 * mark second, initials only when there is no seed either. Admin-uploaded
 * override (#626) hooks in here too, ahead of the derived mark, once it has a
 * field to read.
 *
 * THE 404 PROBLEM. roster-seed.ts sets `avatar.path` to
 * `/avatars/swarm/{athena,robotmoney,woon}.jpg` for the three seeded members,
 * and none of those files exist (#625's own motivation section) -- so
 * rendering a manifest path unconditionally would put a broken-image icon on
 * every one of them, not a derived mark, breaking the AC that says they must
 * still show marks with "no manual asset added". An <img> that swaps itself
 * for the fallback markup on a load error treats "path set but 404s" the same
 * as "no path": both end up on the derived mark, and a real upload (#626)
 * that resolves renders normally with no code path change here.
 *
 * The recovery is wired with Alpine's `x-on:error`, not an inline `onerror=`
 * content attribute: this app's CSP (backend/src/api/static.ts) is
 * `script-src 'self' 'unsafe-eval'` with no `unsafe-inline`/nonce/hash, which
 * blocks inline event-handler attributes outright (confirmed by driving this
 * exact markup through a real page under that CSP and reading the console
 * violation). `x-on:` runs through Alpine's own `unsafe-eval`'d evaluator and
 * attaches via `addEventListener`, which the same CSP allows, and Alpine's
 * mutation observer initializes directives on nodes `x-html` inserts via
 * innerHTML -- every call site binds this through `x-html`, so that is the
 * only insertion path this needs to work for. The fallback markup travels in
 * a `data-*` attribute rather than a closure, because `x-html` serializes
 * this return value to a string and reparses it; nothing from this
 * function's scope survives that round trip except what is written into the
 * markup itself.
 *
 * @param {string | null | undefined} avatarPath  member.avatar?.path, if any.
 * @param {string} seed  keyFingerprint when one exists, else the member id.
 * @param {string} name
 * @param {number} size
 * @param {(name: string) => string} initialsFn
 * @returns {string}
 */
export function memberAvatarMarkup(avatarPath, seed, name, size, initialsFn) {
  const fallback = memberMarkOrInitials(seed, name, size, initialsFn);
  const path = String(avatarPath || "").trim();
  if (!path) return fallback;
  const src = escapeAttr(path);
  const fallbackAttr = escapeAttr(fallback);
  // Alpine directive, not an inline `onerror=` attribute: the CSP this app
  // serves under (backend/src/api/static.ts) is `script-src 'self'
  // 'unsafe-eval'` with no `unsafe-inline`/nonce/hash, which blocks an inline
  // event-handler CONTENT ATTRIBUTE outright -- confirmed by driving this
  // exact markup through a real page and reading the CSP violation off the
  // console (frontend/test/browser/swarm-index.spec.ts's 404 case). `x-on:`
  // is evaluated through Alpine's own `unsafe-eval`'d Function() path and
  // wired up via addEventListener, which the same CSP allows, and Alpine's
  // mutation observer initializes directives on nodes added by innerHTML
  // (which is how x-html, the binding every call site uses, inserts this).
  return `<img class="sv__mark-img" src="${src}" width="${size}" height="${size}" alt="" data-mark-fallback="${fallbackAttr}" x-on:error="$el.outerHTML = $el.dataset.markFallback">`;
}

// Exported for the unit test: the palette a mark may draw from, so the
// covenant ("no cyan in a figure, no beacon on an ordinary member") is
// asserted against the real values rather than restated in a comment.
export const MARK_PALETTE = Object.values(HUES);
export const WITHHELD = [PALETTE.accent, SERIES.beacon];
