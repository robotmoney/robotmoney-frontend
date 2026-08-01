// External/managed Postgres resolver for `bun run demo -- --external-pg`.
//
// WHAT IT IS. By default the demo runs its own ephemeral `postgres` container
// (docker-compose.yml's `postgres` service + the `pgdata` named volume). With
// `--external-pg` it runs NO postgres container at all: the connection details
// come from `.env`, and api/workers/migrations all talk to that server instead.
// Nothing else about the boot changes.
//
// WHY A CLI ARGUMENT, NOT AN ENV VAR. Same hard rule `--pg-data` and `--stage`
// follow (scripts/lib/demo-main.ts's header): pointing a demo at a real,
// persistent database is a property of ONE deliberate invocation, never of a
// shell that happens to have something exported. An exported value that silently
// redirected a boot onto a managed database is precisely the failure mode the
// no-per-property-env-config rule exists to prevent. The flag opts in; `.env`
// only supplies the address.
//
// WHY IT READS `.env` ITSELF rather than trusting process.env. Two reasons.
// First, the discrete keys DigitalOcean's connection panel prints (`host`,
// `port`, `database`, `username`, `password`) are far too generic to read off an
// ambient environment — a stray exported `host` must never influence which
// database a demo writes to. Second, reading the file makes the source of the
// value auditable: the resolution says which key of which file it came from.
// `DATABASE_URL` (the form `.env.example` documents) always wins when present;
// otherwise the discrete DO-panel keys are assembled into one, so a pasted
// connection panel works without hand-editing.
//
// This module MUST stay side-effect free apart from the explicit readFileSync in
// loadEnvFile() — no process.env reads, no spawning — so the unit tests
// (scripts/tests/unit/demo-external-pg.test.ts) can drive every branch without a
// demo boot. It is imported by scripts/lib/demo-main.ts and re-exported from
// scripts/demo.ts alongside resolveDemoEnv.
import { readFileSync } from "node:fs";

/** The compose services whose `depends_on: postgres` must be dropped. */
export const POSTGRES_DEPENDENT_SERVICES = [
  "api",
  "worker-committee",
  "worker-analytics",
  "worker-research",
] as const;

/** The compose service and named volume the overlay removes outright. */
export const EPHEMERAL_PG_SERVICE = "postgres";
export const EPHEMERAL_PG_VOLUME = "pgdata";

export const EXTERNAL_PG_FLAG = "--external-pg";

export interface ExternalPgResolution {
  /** True when `--external-pg` was passed. Everything below is set only then. */
  enabled: boolean;
  /** The exact URL handed to containers. NEVER log or serialize this. */
  url?: string;
  /** Password-redacted form — the ONLY variant safe to print or record. */
  redactedUrl?: string;
  /** Host as parsed, for the boot banner. */
  host?: string;
  /** Which `.env` key the value came from, for the boot banner. */
  source?: "DATABASE_URL" | "discrete keys";
}

/**
 * Parse a `.env`-style file into a flat map. Deliberately permissive about the
 * spacing DigitalOcean's panel uses (`username = doadmin`) and about `export `
 * prefixes; deliberately strict about nothing else, because this is only ever
 * asked for a handful of known keys. Quotes around a value are stripped.
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
 * Assemble a URL from the discrete keys DigitalOcean's connection panel prints.
 * Returns undefined unless the four load-bearing parts are all present — a
 * half-specified database is a mistake to report, not a default to invent.
 */
export function urlFromDiscreteKeys(env: Record<string, string>): string | undefined {
  const host = env.host ?? env.PGHOST;
  const user = env.username ?? env.PGUSER;
  const password = env.password ?? env.PGPASSWORD;
  const database = env.database ?? env.PGDATABASE;
  if (!host || !user || !password || !database) return undefined;
  const port = env.port ?? env.PGPORT ?? "5432";
  const sslmode = env.sslmode ?? env.PGSSLMODE;
  const u = new URL(`postgres://${host}`);
  u.port = port;
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  u.pathname = `/${database}`;
  if (sslmode) u.searchParams.set("sslmode", sslmode);
  return u.toString();
}

/**
 * Reject the two addresses that LOOK right and are always wrong here, with the
 * reason rather than a generic refusal. Both fail at a distance otherwise: the
 * containers start, then every query dies with a connection error that names an
 * address the operator never typed.
 */
export function assertReachableFromContainer(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${EXTERNAL_PG_FLAG}: could not parse the resolved connection URL: ${redactPostgresUrl(url)}`);
  }
  if (host === EPHEMERAL_PG_SERVICE) {
    throw new Error(
      `${EXTERNAL_PG_FLAG}: the connection URL points at host "${EPHEMERAL_PG_SERVICE}", which IS the ephemeral ` +
        `compose service this flag exists to replace — that service is not started in external mode, so nothing ` +
        `would be listening. Point DATABASE_URL at the managed server's hostname.`,
    );
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    throw new Error(
      `${EXTERNAL_PG_FLAG}: the connection URL points at ${host}, which inside a container means the CONTAINER ` +
        `itself, not this host — the api and workers would each dial their own empty loopback. Use the server's ` +
        `routable hostname or address (for a Postgres running on this host, that is the docker bridge address, ` +
        `e.g. 172.17.0.1, not localhost).`,
    );
  }
}

/**
 * The generated compose overlay. It (1) removes the `postgres` service and the
 * `pgdata` volume outright and (2) drops the `depends_on: postgres` condition
 * from every service that carries one — compose merges `depends_on` maps rather
 * than replacing them, so `!reset` is the only way to remove an entry. Verified
 * against Compose v5.3.1 with `docker compose config --services`: the postgres
 * service and the pgdata volume are both absent from the resolved model.
 *
 * Appended LAST in the compose file list so it resets what the base file and the
 * demo overlay have already defined.
 */
export function externalPgOverlayYaml(redactedUrl: string): string {
  const dependents = POSTGRES_DEPENDENT_SERVICES.map(
    (s) => `  ${s}:\n    depends_on: !reset null\n`,
  ).join("");
  return (
    `# GENERATED by scripts/lib/demo-external-pg.ts for \`bun run demo -- ${EXTERNAL_PG_FLAG}\`.\n` +
    `# Runs the stack against an EXTERNAL/managed Postgres, so no ephemeral\n` +
    `# postgres container and no pgdata volume are created at all.\n` +
    `#   target: ${redactedUrl}\n` +
    `# Safe to delete when no demo is using it.\n` +
    `services:\n` +
    `  ${EPHEMERAL_PG_SERVICE}: !reset null\n` +
    dependents +
    `volumes:\n` +
    `  ${EPHEMERAL_PG_VOLUME}: !reset null\n`
  );
}

/**
 * Resolve the flag. THROWS with an actionable message rather than falling back
 * to the ephemeral container: silently booting a throwaway database when the
 * operator asked for the managed one would be the worst possible outcome — the
 * demo would look healthy while writing to nothing that persists.
 */
/**
 * Is a managed Postgres CONFIGURED in `.env`? Answers the question without
 * requiring the flag, and without throwing — used by `bun run demo:stage`, which
 * chooses a data path rather than being told one.
 *
 * Deliberately separate from resolveExternalPg: that function's contract is
 * "the operator asked for external Postgres, so a broken .env is a FATAL
 * misconfiguration". Here an absent or unusable .env is simply a "no", because
 * nobody asked for anything yet. A wrapper that used the throwing version to
 * probe would turn "you have no .env" into a failed boot.
 */
export function detectEnvPostgres(envFilePath: string): ExternalPgResolution {
  try {
    return resolveExternalPg([EXTERNAL_PG_FLAG], { envFilePath });
  } catch {
    return { enabled: false };
  }
}

export function resolveExternalPg(
  argv: string[],
  opts: { envFilePath: string } = { envFilePath: ".env" },
): ExternalPgResolution {
  if (!argv.includes(EXTERNAL_PG_FLAG)) return { enabled: false };

  const env = loadEnvFile(opts.envFilePath);
  if (!env) {
    throw new Error(
      `${EXTERNAL_PG_FLAG}: no readable .env at ${opts.envFilePath}. This flag takes the connection details from ` +
        `that file — add DATABASE_URL=postgres://user:password@host:port/database?sslmode=require (see .env.example), ` +
        `or drop the flag to boot the ephemeral postgres container.`,
    );
  }

  const direct = env.DATABASE_URL?.trim();
  const assembled = direct ? undefined : urlFromDiscreteKeys(env);
  const url = direct || assembled;
  if (!url) {
    throw new Error(
      `${EXTERNAL_PG_FLAG}: ${opts.envFilePath} has no DATABASE_URL, and not enough discrete keys to assemble one ` +
        `(needs host, port, database, username, password — the fields DigitalOcean's connection panel prints). ` +
        `Add DATABASE_URL=postgres://user:password@host:port/database?sslmode=require and re-run.`,
    );
  }

  const scheme = url.split(":")[0];
  if (scheme !== "postgres" && scheme !== "postgresql") {
    throw new Error(
      `${EXTERNAL_PG_FLAG}: the connection URL must start with postgres:// or postgresql://, got "${scheme}://".`,
    );
  }
  assertReachableFromContainer(url);

  return {
    enabled: true,
    url,
    redactedUrl: redactPostgresUrl(url),
    host: new URL(url).hostname,
    source: direct ? "DATABASE_URL" : "discrete keys",
  };
}
