export interface SiteMeta { title: string; description: string; image: string; canonical: string; robots: string }
export const SITE_ORIGIN: string;
export const SITE_ROUTES: readonly string[];
export const SITE_REDIRECTS: Readonly<Record<string, string>>;
export const SITE_PATHS: Readonly<{
  committeeReceipt: string;
  committeeApplication: string;
}>;
export function metaForPath(pathname: string): SiteMeta;
export function injectSiteMeta(html: string, pathname: string): string;
