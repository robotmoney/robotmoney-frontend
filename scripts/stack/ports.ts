// Host-port allocation for a compose stack — pure of the process environment,
// free of module-scope work (see scripts/stack/config.ts's header for the three
// invariants this directory holds to).
//
// THE RULE: every published host port is drawn FREE at boot, on EVERY run.
// There is no pinned default anywhere in the system — not in docker-compose.yml
// (both port lines are now `${VAR:?…}`, which REFUSES to interpolate a
// fallback), not in .env.example, and not here.
//
// Why it is a rule and not a preference. The old shape had two fallbacks: the
// api port "preferred" 48787, and either port could be PINNED from the
// environment via WEB_PORT / POSTGRES_PORT. Both halves misfired at once. The
// operator's gitignored `.env` pinned BOTH, so nothing was ever randomized on
// the dev box and postgres sat on the host's :5432; CI has no `.env`, so it
// took the `preferred: 48787` path and raced the standing stage demo for the
// exact port cloudflared routes stage.robotmoney-labs.dev to — and won, taking
// the site down. On a host that runs the standing demo, the self-hosted CI
// runner and local evals side by side, a port that is *usually* free is a
// latent outage, so "usually" was removed rather than made more likely.
//
// THE ONE EXCEPTION is the stage web port below, requested by `bun demo
// --stage` and by nothing else. It is a CLI ARGUMENT, never an env var (the
// same hard rule `--pg-data` follows: no per-property env config), because
// pinning the tunnel-facing port is a property of one deliberate invocation and
// never of a shell that happens to have something exported. It FAILS rather
// than falling back, for the reason in STAGE_WEB_PORT's comment.
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

type Held = ReturnType<typeof createServer>;

// The single fixed host port in the whole system: cloudflared on the demo host
// routes stage.robotmoney-labs.dev to localhost:48787 and to nothing else, so
// a stage boot that "helpfully" fell back to a random port would come up green
// and serve a 502 to every visitor. That is why a stage pin is REQUIRED, not
// preferred: unavailable means stop, loudly, naming what holds it.
export const STAGE_WEB_PORT = 48787;

// Spelled once, used both in the request below and in the operator-facing error.
export const STAGE_WEB_PORT_PURPOSE = "web/api (--stage — the cloudflared tunnel origin)";

// Env vars that USED to pin a host port and now influence nothing. They still
// exist as OUTPUT names (scripts/stack/config.ts's buildComposeEnv sets them
// from the allocated values so docker-compose.yml can interpolate them); what
// was removed is the INPUT path. An operator whose stale `.env` still carries
// them must be told, or they will believe a pin took effect.
export const IGNORED_PORT_ENV_VARS = ["WEB_PORT", "POSTGRES_PORT"] as const;

/**
 * Loud-never-silent warnings for a stale port pin left in the environment.
 * Pure: the caller passes its own env in, and printing is the caller's job.
 * Returns one line per var actually present (empty array = nothing to say).
 */
export function stalePortEnvWarnings(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const name of IGNORED_PORT_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    out.push(
      `WARNING: ${name}=${raw.trim()} is set and is being IGNORED. Host ports are drawn free on ` +
        `every run — pinning one from the environment was removed because a pinned :48787 raced the ` +
        `stage tunnel and took the site down. Delete ${name} from your .env / shell. ` +
        `(The only pin left is \`bun demo --stage\`, which pins the web port to ${STAGE_WEB_PORT} and nothing else.)`,
    );
  }
  return out;
}

// Bind `port` (0 = a random free one) on 127.0.0.1; resolve the HELD server if
// it bound, else null (port already in use). Callers keep every returned server
// open until all ports are chosen so two allocations can't draw the same one.
// 127.0.0.1 is enough to detect a docker-proxy holding 0.0.0.0:<port>, which is
// exactly the co-tenancy case this guards against.
function tryBind(port: number): Promise<Held | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.on("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

export interface PortRequest {
  /**
   * Pin this exact host port. PROBED, never assumed: if it is not free the
   * allocation THROWS a PortUnavailableError. There is deliberately no
   * "preferred" mode any more — a soft preference is what silently moved a
   * stack onto (and off) the tunnel port.
   */
  required?: number;
  /** Human description of what the pin is for, quoted back in the error. */
  purpose?: string;
}

/**
 * Thrown when a `required` port is held. Carries the port (and what it was for)
 * as DATA so the entrypoint can attach a "who holds it" diagnostic without this
 * module having to spawn anything during allocation.
 */
export class PortUnavailableError extends Error {
  readonly port: number;
  readonly purpose: string;
  constructor(port: number, purpose: string) {
    super(`host port ${port} is already in use, and it is REQUIRED for ${purpose}`);
    this.name = "PortUnavailableError";
    this.port = port;
    this.purpose = purpose;
  }
}

// Choose every port in one go, holding EVERY bound socket open until all of
// them are chosen and then closing them together. That collision-safety
// property is the reason this is a batch API rather than a `freePort()`.
export async function allocatePorts(requests: PortRequest[]): Promise<number[]> {
  const held: Held[] = [];
  try {
    const out: number[] = [];
    for (const req of requests) {
      if (req.required !== undefined) {
        const s = await tryBind(req.required);
        // No fallback. See STAGE_WEB_PORT: a fallback here is a green boot
        // serving a broken site.
        if (!s) throw new PortUnavailableError(req.required, req.purpose ?? "this stack");
        held.push(s);
        out.push(req.required);
        continue;
      }
      const s = await tryBind(0);
      if (!s) throw new Error("could not bind a free host port");
      held.push(s);
      out.push((s.address() as AddressInfo).port);
    }
    return out;
  } finally {
    await Promise.all(held.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}

/**
 * The stack's port requests, in [web/api, postgres] order.
 *
 * Postgres is ALWAYS random — even under `--stage`. Nothing external routes to
 * it (api and the worker lanes reach it over the compose network by service
 * name), a dev box usually already has a postgres on :5432, and publishing the
 * demo's database on a predictable host port is a liability, not a feature.
 *
 * Takes no environment: whether this is a stage boot is decided by argv at the
 * entrypoint and passed in.
 */
export function stackPortRequests(opts: { stage: boolean }): [PortRequest, PortRequest] {
  return [
    opts.stage ? { required: STAGE_WEB_PORT, purpose: STAGE_WEB_PORT_PURPOSE } : {},
    {},
  ];
}

// ── "What holds this port?" diagnostic ──────────────────────────────────────
// Only ever reached on the stage-pin failure path. An error that says "48787 is
// in use" and stops there costs the operator a shell session of guessing; one
// that names the container or the pid is actionable immediately.

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string[]) => CommandResult;

/**
 * Real runner. `env` is passed EXPLICITLY (directory invariant 2) — this module
 * never reads process.env, so PATH / DOCKER_HOST come from the caller.
 */
export function makeCommandRunner(env: Record<string, string | undefined>): CommandRunner {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return (cmd: string[]): CommandResult => {
    try {
      const r = Bun.spawnSync(cmd, { env: clean, stdout: "pipe", stderr: "pipe" });
      return {
        exitCode: r.exitCode,
        stdout: new TextDecoder().decode(r.stdout),
        stderr: new TextDecoder().decode(r.stderr),
      };
    } catch (e) {
      // A missing binary (no `ss` on this host) is a partial answer, not a
      // crash: the OTHER probe may still identify the holder.
      return { exitCode: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * Human-readable description of whatever currently holds `port`: any container
 * publishing it, plus any listening socket `ss` can attribute to a pid. Never
 * throws — a diagnostic that fails must not replace the error it is explaining.
 */
export function describePortHolders(port: number, run: CommandRunner): string {
  const lines: string[] = [];

  const ps = run([
    "docker", "ps", "--filter", `publish=${port}`,
    "--format", "{{.ID}}  {{.Names}}  {{.Image}}  {{.Ports}}",
  ]);
  const psOut = ps.stdout.trim();
  if (ps.exitCode === 0 && psOut) {
    lines.push("  docker containers publishing this port:");
    for (const l of psOut.split("\n")) lines.push(`    ${l.trim()}`);
  } else if (ps.exitCode === 0) {
    lines.push("  docker containers publishing this port: none");
  } else {
    lines.push(`  docker ps could not be consulted: ${(ps.stderr || ps.stdout).trim() || `exit ${ps.exitCode}`}`);
  }

  const ss = run(["ss", "-tlnp"]);
  if (ss.exitCode === 0) {
    // Match ":<port>" only where the port ends the Local Address:Port field, so
    // :48787 never matches :4878 or :148787.
    const rx = new RegExp(`:${port}\\s`);
    const hits = ss.stdout.split("\n").filter((l) => rx.test(l));
    if (hits.length) {
      lines.push("  listening sockets (ss -tlnp):");
      for (const l of hits) lines.push(`    ${l.trim()}`);
    } else {
      lines.push("  listening sockets (ss -tlnp): none matched");
    }
  } else {
    lines.push(`  ss -tlnp could not be consulted: ${(ss.stderr || ss.stdout).trim() || `exit ${ss.exitCode}`}`);
  }

  return lines.join("\n");
}
