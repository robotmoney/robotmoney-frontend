// The replica connection, from $HOME/.env, the same file the Robot Money deploy tooling reads:
// the connection tokens `host`, `port`, `database` (or `dbname`), `sslmode`, and the password line named
// after the role, `rm_readonly`. The role is always rm_readonly: it can SELECT these tables and nothing else.
// A file that also holds an rm_owner or doadmin line is refused. The password is never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROLE = "rm_readonly";

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

export const homeEnvFilePath = (): string => join(homedir(), ".env");

export function replicaUrlFromEnvFile(path: string): { url: string } | { refuse: string } {
  let env: Record<string, string>;
  try {
    env = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return { refuse: `no readable env file at ${path}` };
  }
  const forbidden = ["rm_owner", "doadmin"].filter((k) => env[k] !== undefined);
  if (forbidden.length) return { refuse: `${path} holds a ${forbidden.join(" and a ")} line; remove it (the backup only needs ${ROLE})` };
  const host = env.host;
  const database = env.database ?? env.dbname;
  const password = env[ROLE];
  if (!host || !database || !password) return { refuse: `${path} cannot assemble an ${ROLE} connection (needs host, port, database, sslmode and an ${ROLE} line)` };
  const u = new URL(`postgres://${host}`);
  u.port = env.port ?? "5432";
  u.username = encodeURIComponent(ROLE);
  u.password = encodeURIComponent(password);
  u.pathname = `/${database}`;
  u.searchParams.set("sslmode", env.sslmode ?? "require");
  return { url: u.toString() };
}

/** `rm_readonly@host:port/db`, the only form safe to print. */
export function redactedTarget(url: string): string {
  const u = new URL(url);
  return `${decodeURIComponent(u.username)}@${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
}
