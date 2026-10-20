// Operator brand marks for swarm members (RM-100).
//
// WHY THIS EXISTS AND NOT `avatar.path`. The projection already carries an
// avatar object, and member-mark.js already prefers it over the derived mark
// (#625). But the only paths production serves are the seeded
// `/avatars/committee/{athena,robotmoney,woon}.jpg`, and none of those files
// exist -- `frontend/public/avatars/` was absent until this commit -- so every
// one of them 404s into the derived mark. One of them is wrong on top of that:
// `noop-analyst` is seeded pointing at `woon.jpg`. Members who arrive through
// the funnel (dualmint, shodai, maximus) have `avatar: null` and no way to set
// one short of the admin upload in #626.
//
// So this map is the curated rung: assets committed to the repo, reviewed in a
// diff, identical in demo, staging and production, and immune to a DB reseed.
// It takes precedence over a seeded `avatar.path` deliberately, which is also
// what repairs the noop-analyst mistake without a backend write.
//
// One `avatar.path` outranks the map: an admin upload (#626, RM-184). The
// upload route points it at `/api/swarm/members/:id/avatar`, a path no seed
// ever wrote, so it is told apart by shape and nothing else. That is what lets
// an admin set or replace a logo from the admin panel without a PR. The full
// chain, in memberAvatarSrc() below: upload, curated logo, any other
// `avatar.path`, then the derived mark and initials member-mark.js implements.
//
// PROVENANCE.
//
// - shodai.svg      The mark is inline SVG in shodai.network's nav; the site
//                   ships no logo file and every conventional path 404s. Path
//                   geometry is theirs byte for byte. Two edits were required:
//                   their source paints with `currentColor` plus a CSS variable
//                   that does not resolve outside their page (it would render
//                   as a black plate on black), so the colours are pinned to
//                   their own tokens -- #DAE5C5 on #000 -- which reproduces
//                   their apple-touch-icon exactly; and the opaque plate is
//                   dropped, because our slot paints its own ground and carries
//                   a border, so a black square inside it reads as a second box.
// - dualmint.png    dualmint.com/favicon/web-app-manifest-512x512.png,
//                   unmodified, checksum-verified against the live URL, then
//                   downscaled to 256 (the slot renders at 40px). Their
//                   favicon.svg was the SVG-first candidate and was rejected:
//                   its monogram is a live <text> element in Helvetica Black,
//                   so it re-renders differently on any machine lacking that cut.
//                   `dualmint-2` wears it too: DualMint's second seat, taken
//                   on 2026-10-14 after the first seat's keystore passphrase
//                   was lost. Same operator, same mark. `dualmint` keeps its
//                   entry so the first seat's takes still carry it.
// - animoca-brands.svg  Minds by Animoca Brands wears its operator's mark.
//                   animocabrands.com's Webclip.svg (their apple-touch-icon),
//                   path geometry byte for byte. Two edits: the white plates
//                   are lifted out, as for shodai, and the viewBox is trimmed
//                   to the lockup's own 10px margin so it reads at 40px.
//                   Animoca has no mark apart from the lockup; their favicon
//                   is the same artwork. Their white logo was rejected: it
//                   disappears on the light register.
// - peaq.png        Woon's mark is its operator's: peaq's logo, supplied by
//                   the team, trimmed to the mark and padded square. It
//                   replaces a head crop of peaq's robot-hero.png, which was
//                   our crop rather than their asset.
// - zyfai.png       Supplied by the team on an opaque #0C131C plate. The
//                   plate is lifted out (edge pixels un-mixed against it) for
//                   the same reason as shodai's; the mark itself is untouched.
// - robot-money.svg Our own brand-assets/mark.svg, unchanged. Themis wears it
//                   too (RM-172): the judge is ours as well, and its Judge role
//                   pill tells it apart from the member named Robot Money.
//
// Athena, Noop Analyst and Maximus deliberately keep derived marks. Athena and
// Noop Analyst are house analysts, and giving them the house mark would make
// them indistinguishable from the member literally named Robot Money.
//
// Keyed on `handle`, not `id`: the handle is the stable public URL segment and
// is what a human editing this file can recognise.

/** @type {Record<string, string>} */
export const MEMBER_LOGOS = {
  shodai: "/avatars/swarm/shodai.svg",
  dualmint: "/avatars/swarm/dualmint.png",
  "dualmint-2": "/avatars/swarm/dualmint.png",
  "minds-by-animoca-brands": "/avatars/swarm/animoca-brands.svg",
  woon: "/avatars/swarm/peaq.png",
  zyfai: "/avatars/swarm/zyfai.png",
  "robot-money": "/avatars/swarm/robot-money.svg",
  themis: "/avatars/swarm/robot-money.svg",
};

/**
 * The curated logo for a member, or null to fall through to the API's
 * `avatar.path` and then to the derived mark.
 *
 * @param {{ handle?: string | null } | null | undefined} member
 * @returns {string | null}
 */
export function memberLogo(member) {
  const handle = String(member?.handle || "").trim().toLowerCase();
  return (handle && MEMBER_LOGOS[handle]) || null;
}

// The path the admin upload route writes (#626): the public GET that serves
// the stored bytes, with a ?v= cache-bust token.
const UPLOADED_AVATAR_RE = /^\/api\/swarm\/members\/[^/?#]+\/avatar(?:[?#]|$)/;

/**
 * Whether an `avatar.path` is an admin upload rather than a seeded path.
 *
 * @param {string | null | undefined} avatarPath
 * @returns {boolean}
 */
export function isUploadedAvatar(avatarPath) {
  return UPLOADED_AVATAR_RE.test(String(avatarPath || "").trim());
}

/**
 * The image a member wears, or null for the derived mark: an admin upload,
 * then the curated logo, then any other `avatar.path`.
 *
 * @param {string | null | undefined} handle
 * @param {string | null | undefined} avatarPath
 * @returns {string | null}
 */
export function memberAvatarSrc(handle, avatarPath) {
  if (isUploadedAvatar(avatarPath)) return String(avatarPath).trim();
  return memberLogo({ handle }) || avatarPath || null;
}
