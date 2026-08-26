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
// It takes precedence over `avatar.path` deliberately, which is also what
// repairs the noop-analyst mistake without a backend write. A member absent
// from the map falls through to `avatar.path`, then to the derived mark, then
// to initials -- the chain member-mark.js already implements.
//
// PROVENANCE. Two of these are the operator's own shipped asset. One is not,
// and the difference matters if anyone asks:
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
// - woon.png        NOT A LOGO. woon.peaq.xyz ships no Woon mark at all, only
//                   peaq's wordmark and character renders. This is a square
//                   head crop taken from their own robot-hero.png. It matches
//                   how Woon presents itself everywhere else, but it is our
//                   crop rather than their asset, so it is worth peaq's nod
//                   before it goes anywhere louder than a 40px avatar.
// - robot-money.svg Our own brand-assets/mark.svg, unchanged.
//
// Athena, Noop Analyst and Maximus deliberately keep derived marks. Athena and
// Noop Analyst are house personas, and giving them the house mark would make
// them indistinguishable from the member literally named Robot Money.
//
// Keyed on `handle`, not `id`: the handle is the stable public URL segment and
// is what a human editing this file can recognise.

/** @type {Record<string, string>} */
export const MEMBER_LOGOS = {
  shodai: "/avatars/swarm/shodai.svg",
  dualmint: "/avatars/swarm/dualmint.png",
  woon: "/avatars/swarm/woon.png",
  "robot-money": "/avatars/swarm/robot-money.svg",
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
