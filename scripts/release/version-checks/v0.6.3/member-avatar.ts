// Q35-member-avatar/C23-member-avatar (PR 1393): an admin uploads a swarm member's avatar from
// the member page, and an upload outranks the curated logo.
//
// The change is site files only: the admin member page gains an Avatar block
// (views/admin/swarm-member.html, alpine/views/admin/swarm-member.js) that posts
// the file through api.adminUpload, and member-logos.js gains memberAvatarSrc(),
// which puts an upload path ahead of MEMBER_LOGOS. So the check reads what the
// site serves, not the repository. It also asks the public avatar GET for a
// member with no stored upload: a 404 says the route the uploads point at is
// up, and a 5xx says it is not. It uploads nothing; a write belongs on no target.
import type { VersionCheck } from "../../version-check.ts";

export const MEMBER_LOGOS_PATH = "/assets/js/app/lib/member-logos.js";
export const MEMBER_PAGE_PATH = "/views/admin/swarm-member.html";
export const MEMBER_VIEW_PATH = "/assets/js/app/alpine/views/admin/swarm-member.js";
export const API_PATH = "/assets/js/app/lib/api.js";

export interface MemberAvatarObservation {
  readonly logos: { status: number; text: string };
  readonly page: { status: number; text: string };
  readonly view: { status: number; text: string };
  readonly api: { status: number; text: string };
  /** The public avatar GET for a member with no upload, or null when every member has one. */
  readonly avatarGet: { memberId: string; status: number } | null;
}

/** PURE. The body of memberAvatarSrc() in a served member-logos.js, or null. */
export function memberAvatarSrcBody(js: string): string | null {
  return /export function memberAvatarSrc\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(js)?.[1] ?? null;
}

/** PURE. Every reason the avatar upload is not in place. */
export function memberAvatarProblems(o: MemberAvatarObservation): string[] {
  const out: string[] = [];
  for (const [path, r] of [[MEMBER_LOGOS_PATH, o.logos], [MEMBER_PAGE_PATH, o.page], [MEMBER_VIEW_PATH, o.view], [API_PATH, o.api]] as const) {
    if (r.status !== 200) out.push(`${path} answered ${r.status}`);
  }
  if (o.logos.status === 200) {
    if (!/export function isUploadedAvatar\s*\(/.test(o.logos.text)) out.push(`the served member-logos.js exports no isUploadedAvatar`);
    const body = memberAvatarSrcBody(o.logos.text);
    if (body === null) out.push(`the served member-logos.js exports no memberAvatarSrc`);
    else {
      const upload = body.indexOf("isUploadedAvatar(");
      const curated = body.indexOf("memberLogo(");
      if (upload < 0 || curated < 0 || upload > curated) out.push(`the served memberAvatarSrc does not put an upload ahead of the curated logo`);
    }
  }
  if (o.page.status === 200 && !o.page.text.includes('data-testid="member-avatar"')) out.push(`the served admin member page has no Avatar block`);
  if (o.view.status === 200 && !/api\.adminUpload\(\s*path\(ROUTES\.swarm\.admin\.memberAvatar/.test(o.view.text)) out.push(`the served admin member view does not post the file to the member avatar route`);
  if (o.api.status === 200 && !/adminUpload\s*:/.test(o.api.text)) out.push(`the served api.js has no adminUpload`);
  if (o.avatarGet && o.avatarGet.status !== 404) out.push(`the avatar GET for ${o.avatarGet.memberId}, which has no upload, answered ${o.avatarGet.status}, not 404`);
  return out;
}

export default (async (ctx) => {
  const [logos, page, view, api] = await Promise.all([MEMBER_LOGOS_PATH, MEMBER_PAGE_PATH, MEMBER_VIEW_PATH, API_PATH].map((p) => ctx.http(p)));
  const db = await ctx.db();
  const rows = await db.query<{ id: string }>(
    `SELECT m.id FROM swarm_members m LEFT JOIN swarm_member_avatars a ON a.member_id = m.id WHERE a.member_id IS NULL ORDER BY m.id LIMIT 1`,
  );
  const memberId = rows[0]?.id ?? null;
  const avatarGet = memberId === null ? null : { memberId, status: (await ctx.http(`/api/swarm/members/${encodeURIComponent(memberId)}/avatar`)).status };
  const o: MemberAvatarObservation = { logos: logos!, page: page!, view: view!, api: api!, avatarGet };
  return {
    found: {
      statuses: { logos: logos!.status, page: page!.status, view: view!.status, api: api!.status },
      memberAvatarSrc: logos!.status === 200 ? memberAvatarSrcBody(logos!.text)?.trim() ?? null : null,
      avatarGet,
    },
    problems: memberAvatarProblems(o),
  };
}) satisfies VersionCheck;
