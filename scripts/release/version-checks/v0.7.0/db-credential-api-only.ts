// V03-db-credential-api-only (D75, PR 1418): only the api holds a database
// credential. The check reads `Config.Env` of every running container of the
// instance, participants included, and refuses any container but the api that
// carries a credential: a DB_CREDENTIAL_KEYS name, a PG* connection or pool
// key, or a value that is a connection string. The detector is the one the
// compose-config guard and the participant's startup refusal use
// (scripts/lib/db-credential-keys.ts). Only NAMES reach the receipt: no value
// is ever read into a problem or a log line.
// Reads only: `docker ps` and `docker inspect` on the target host.
import { isDbCredentialKey, looksLikeConnectionString } from "../../../lib/db-credential-keys.ts";
import type { VersionCheck } from "../../version-check.ts";

/** The one service that may hold a credential (D75). A one-shot `migrate` is not a running container. */
export const CREDENTIAL_HOLDER = "api";

export interface Finding {
  readonly container: string;
  readonly service: string;
  readonly key: string;
  readonly reason: "credential key" | "connection or pool key" | "connection string value";
}

/** PURE. The credentials a container's `Config.Env` lines hand it, by name. */
export function credentialsIn(env: readonly string[]): { key: string; reason: Finding["reason"] }[] {
  const out: { key: string; reason: Finding["reason"] }[] = [];
  for (const line of env) {
    const eq = line.indexOf("=");
    const key = eq === -1 ? line : line.slice(0, eq);
    const value = eq === -1 ? null : line.slice(eq + 1);
    if (isDbCredentialKey(key)) out.push({ key, reason: "credential key" });
    else if (/^PG/i.test(key)) out.push({ key, reason: "connection or pool key" });
    else if (looksLikeConnectionString(value)) out.push({ key, reason: "connection string value" });
  }
  return out;
}

/** PURE. Every non-api container that holds a credential, or why nothing could be read. */
export function credentialProblems(rows: ReadonlyArray<{ container: string; service: string; env: readonly string[] | null }>): string[] {
  if (rows.length === 0) return ["no running container of the instance to read"];
  if (!rows.some((r) => r.service === CREDENTIAL_HOLDER)) return [`no running ${CREDENTIAL_HOLDER} container among ${rows.map((r) => r.container).join(", ")}: the composition was not read`];
  const out: string[] = [];
  for (const r of rows) {
    if (r.env === null) { out.push(`${r.container}: its environment could not be read`); continue; }
    if (r.service === CREDENTIAL_HOLDER) continue;
    for (const c of credentialsIn(r.env)) out.push(`${r.container} (${r.service}) holds a database credential: ${c.key} (${c.reason}); only ${CREDENTIAL_HOLDER} may (D75)`);
  }
  return out;
}

export default (async (ctx) => {
  const project = ctx.project();
  const names = ctx.docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  const rows = names.map((container) => {
    const env = ctx.docker(["inspect", "-f", "{{json .Config.Env}}", container]);
    const svc = ctx.docker(["inspect", "-f", '{{index .Config.Labels "com.docker.compose.service"}}', container]);
    let parsed: string[] | null = null;
    if (env.code === 0) { try { parsed = JSON.parse(env.stdout) as string[]; } catch { parsed = null; } }
    return { container, service: svc.code === 0 ? svc.stdout.trim() : "", env: parsed };
  });
  return { found: { project, containers: rows.map((r) => ({ container: r.container, service: r.service, credentialKeys: r.env === null ? null : credentialsIn(r.env).map((c) => c.key) })) }, problems: credentialProblems(rows) };
}) satisfies VersionCheck;
