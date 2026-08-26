import { basename, dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ANALYTICS_TOKEN_BASENAME = "analytics-token";

function safeProject(project: string): string {
  return project.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function secretDirPrefix(project: string): string {
  return `robotmoney-smoke-${safeProject(project)}-secrets-`;
}

/** Provision one mode-0600 Docker-secret file outside the checkout. */
export function provisionSmokeAnalyticsToken(project: string, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), secretDirPrefix(project)));
  const file = join(dir, ANALYTICS_TOKEN_BASENAME);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return file;
}

/** Run every non-stack preflight before creating secret material. */
export function provisionSmokeAnalyticsTokenAfterPreflight(
  project: string,
  token: string,
  preflight: () => void,
): string {
  preflight();
  return provisionSmokeAnalyticsToken(project, token);
}

/**
 * Remove only the exact project-scoped temp directory shape provisioned above.
 * Returns false rather than deleting when a stale/tampered state path points
 * anywhere else.
 */
export function removeSmokeAnalyticsToken(file: string, project: string): boolean {
  const resolvedFile = resolve(file);
  const dir = dirname(resolvedFile);
  const tempRoot = resolve(tmpdir());
  if (
    basename(resolvedFile) !== ANALYTICS_TOKEN_BASENAME ||
    dirname(dir) !== tempRoot ||
    !basename(dir).startsWith(secretDirPrefix(project))
  ) {
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}
