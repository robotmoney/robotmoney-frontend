// scripts/lib/env-role.ts — THE ONE place every member of the smoke/twin/
// preflight/postflight/rollout family learns "what does $HOME/.env say, and
// which role does this command use for it".
//
// THE CONVENTION THIS MODULE IS THE SINGLE RESOLVER FOR (issue #699).
//
//   * ONE FILE. `.env` — the SAME `.env` a `.env.example` describes — lives at
//     the ROOT OF `$HOME` (`/root/.env` on a production deployment,
//     `/home/stage-server/.env` on the staging host). It is THE credential
//     file for the whole family. There is no `.env.readonly` any more, no
//     second discrete-keys file alongside it, and no repo-root `.env` either:
//     the ONLY thing the checkout carries is `.env.example`. The reason the
//     taxonomy (rm_app = writer, rm_worker = worker, rm_readonly = read-only)
//     is reflected here is that a single file now names every role the host
//     has — including the read-only role the twin/capture/preflight
//     deliberately uses — so "which role did that run use?" has exactly one
//     answer, from one file, instead of the old two-file (`.env` versus
//     `.env.readonly`) split where each command re-derived which of two
//     possible locations held its credential.
//
//   * ONE ROLE PER `urlForRole` CALL, ASSEMBLED FROM DISCRETE TOKENS. The
//     DigitalOcean connection panel prints `host port database sslmode` plus a
//     username/password pair; a `.env` written by hand (or re-pasted from a
//     panel) carries the SAME discrete tokens as its load-bearing keys, and
//     each role appears as a `role = password` line (e.g. `rm_readonly =
//     <the role's password>`). This module turns those discrete keys + one
//     role's password line into the ONE `postgres://…` URL that role is
//     allowed to use. It NEVER emits a URL for more than one role from one
//     call, so a single env file can hold rm_app / rm_worker / rm_readonly
//     lines without any of them being confused for another's connection.
//     `host`/`port`/`database`/`sslmode` are connection tokens; every OTHER
//     `KEY = VALUE` line whose KEY names a role is that role's password.
//
//   * WHY DISCRETE, NOT A `DATABASE_URL`. Two reasons, both load-bearing.
//     (1) The digitalocean.com panel's panel-printed panel shows discrete
//     tokens; an operator pastes them in and the file WORKS with no URL
//     hand-assembly, and (2) a role taxonomy exists precisely so that a
//     read-only rehearsing/twinning pair NEVER sees a writer credential. A
//     committed repo-root `.env`/`.env.readonly` that carried a full
//     `DATABASE_URL` made "which role was that, actually?" a question with a
//     wrong-answer-option. The discrete form keeps the read-only role's line
//     in the SAME file as the writer's — one file, `$HOME/.env` — while
//     still letting `resolveReadonly`/`urlForRole` prove at assembly time
//     which one got used.
//
//   * THE FAMILY. Consumers live in BOTH trees and import this via relative
//     paths:
//       - scripts/smoke.ts, scripts/smoke-stage.ts, scripts/smoke-main.ts and
//         scripts/lib/smoke-external-pg.ts (the `--db external` +
//         `smoke:external` + stage auto-detect family)
//       - scripts/lib/smoke-twin-rehearsal.ts (resolveZenKey home-reading)
//       - backend/scripts/smoke-twin-capture.ts (the twin capture's
//         `rm_readonly` target)
//       - backend/scripts/lib/preflight-utils.ts + every
//         backend/scripts/upgrades/*/preflight.ts (the release gates' env
//         path; preflight-utils deliberately imports THIS, not src/)
//       - backend/scripts/lib/rollout-where.ts (replica target banner)
//
//   * THIS MODULE MUST STAY SIDE-EFFECT FREE apart from the explicit
//     readFileSync in loadEnvFile() (which bails to `undefined` on a missing
//     file rather than throwing) — no process.env reads, no spawning — so the
//     unit tests (scripts/tests/unit/env-role.test.ts) can drive every branch
//     without a boot. It needs nothing from src/ and nothing from the
//     frontend tree.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The env filename in the root of `$HOME`. */
export const HOME_ENV_FILE = ".env";

/** The discrete connection tokens a DigitalOcean panel prints. */
export const CONNECTION_TOKENS = ["host", "port", "database", "sslmode"] as const;

/** The role taxonomy this family can assemble. */
export const ROLES = ["rm_app", "rm_worker", "rm_readonly"] as const;

/** `$HOME/.env` — the ONE credential file every member of this family reads. */
export function homeEnvFilePath(home: string = homedir()): string {
  return join(home, HOME_ENV_FILE);
}

/**
 * Parse a `.env`-style file into a flat map. Deliberately permissive about the
 * spacing DigitalOcean's panel uses (`host = db-……db.ondigitalocean.com`) and
 * about an `export ` prefix; deliberately strict about nothing else, because
 * this is only ever asked for a handful of known keys. Quotes around a value
 * are stripped (single or double), so a pasted panel with `"…"` still parses.
 * A missing file is NOT an error here — the caller reports that with context.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Wrapper around parseEnvFile: load the file, or return undefined if unreadable. */
export function loadEnvFile(path: string): Record<string, string> | undefined {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Replace the password with `***`. Used for every printed/recorded form. */
export function redactPostgresUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable postgres url)";
  }
}

/**
 * Assemble a `postgres://` URL for ONE role from the discrete connection
 * tokens in `env` plus that role's own `role = password` line. Returns
 * `undefined` unless the four load-bearing tokens are all present AND the
 * role line exists — a half-specified database is a mistake to report, not a
 * default to invent (same rule urlFromDiscreteKeys held).
 *
 * The role's NAME becomes the URL username; its LINE's value becomes the URL
 * password, so the single role's discrete password is the load-bearing value
 * and no `username`/`password` discrete keys are needed — the environment
 * document's OWN role lines carry them.
 */
export function urlForRole(env: Record<string, string>, role: string): string | undefined {
  const host = env.host;
  const database = env.database;
  const password = env[role]?.toString();
  if (!host || !database || !password) return undefined;
  const port = env.port ?? "5432";
  const sslmode = env.sslmode ?? "require";
  const u = new URL(`postgres://${host}`);
  u.port = port;
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  u.pathname = `/${database}`;
  u.searchParams.set("sslmode", sslmode);
  return u.toString();
}

/** Password-redacted, role-named target for a banner, e.g. `rm_readonly@host:port/db`. */
export function redactedTarget(url: string | undefined, role: string): string {
  if (!url) return role;
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return role;
  }
}
