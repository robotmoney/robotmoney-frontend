// Q37-home-monument/C25-home-monument (PR 1388): the Monument home page. Site files only.
//
// The check reads what the site serves: the home view and its scene modules answer 200, the
// view imports memberAvatarSrc so an admin upload (1393) shows on the home page too, and the
// page's hero image answers 200. It writes nothing.
import type { VersionCheck } from "../../version-check.ts";

export const HOME_VIEW_PATH = "/assets/js/app/alpine/views/home.js";
export const HOME_SCENE_PATH = "/assets/js/app/home/scene.js";
export const HOME_IMAGE_PATH = "/assets/img/home/pyramid.jpg";

export interface HomeObservation {
  readonly view: { status: number; text: string };
  readonly scene: { status: number };
  readonly image: { status: number };
}

/** PURE. Every reason the Monument home page is not in place. */
export function homeProblems(o: HomeObservation): string[] {
  const out: string[] = [];
  if (o.view.status !== 200) out.push(`${HOME_VIEW_PATH} answered ${o.view.status}`);
  else if (!/memberAvatarSrc/.test(o.view.text)) out.push(`the served home view does not use memberAvatarSrc, so an uploaded avatar would not show on the home page`);
  if (o.scene.status !== 200) out.push(`${HOME_SCENE_PATH} answered ${o.scene.status}`);
  if (o.image.status !== 200) out.push(`${HOME_IMAGE_PATH} answered ${o.image.status}`);
  return out;
}

export default (async (ctx) => {
  const [view, scene, image] = await Promise.all([HOME_VIEW_PATH, HOME_SCENE_PATH, HOME_IMAGE_PATH].map((p) => ctx.http(p)));
  const o: HomeObservation = { view: view!, scene: { status: scene!.status }, image: { status: image!.status } };
  return { found: { statuses: { view: view!.status, scene: scene!.status, image: image!.status }, usesMemberAvatarSrc: /memberAvatarSrc/.test(view!.text) }, problems: homeProblems(o) };
}) satisfies VersionCheck;
