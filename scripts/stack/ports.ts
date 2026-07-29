// Host-port DISCOVERY for a compose stack — pure of the process environment,
// free of module-scope work (see scripts/stack/config.ts's header for the three
// invariants this directory holds to).
//
// THE RULE: DOCKER assigns every published host port; this repo never picks
// one. docker-compose.yml publishes both ports with the container-port-only
// short form (`ports: ["8787"]`, `ports: ["5432"]`), the daemon chooses a free
// host port and binds it in one atomic step, and we ASK what it chose after
// `compose up` with `docker compose -p <project> port <service> <container>`.
// parseComposePortOutput below is that readback.
//
// WHY DOCKER-ASSIGNED BEATS PRE-BINDING — the whole point of this module's
// current shape. The previous version drew ports itself: it opened a socket on
// a free port, held it, closed it, and handed the NUMBER to compose as
// `${WEB_PORT:?…}`. That is a TOCTOU race. Between our close and compose's
// bind there is a window in which any other process on this box can take the
// port — a second `bun demo`, a concurrent job on the self-hosted CI runner
// (this host is both the runner and the standing stage demo), or an unrelated
// service. The bring-up then dies on an opaque "address already in use", or —
// worse — two things believe they own the same number. Randomizing MORE stacks
// widened that window rather than closing it. Docker's allocator has no such
// window: choose-and-bind happen inside the daemon, under its own lock.
//
// This is also why the file exports no allocator. `allocatePorts`, the
// `preferred`/`required` request shape and `stackPortRequests()` are DELETED,
// not deprecated: any surviving "pick a free port" helper is an invitation to
// re-introduce the race.
//
// THE ONE EXCEPTION is the stage web port. `bun run demo -- --stage` appends
// docker-compose.stage.yml, which pins api to 48787 with `ports: !override`.
// That is a CLI ARGUMENT, never an env var (the same hard rule `--pg-data`
// follows: no per-property env config), because pinning the tunnel-facing port
// is a property of one deliberate invocation and never of a shell that happens
// to have something exported. `assertStageWebPortFree` below is the PRE-FLIGHT
// for it — see that function's comment for why a bind probe there is not the
// TOCTOU pattern this module exists to delete.
import { createServer } from "node:net";

// The single fixed host port in the whole system: cloudflared on the demo host
// routes stage.robotmoney-labs.dev to localhost:48787 and to nothing else, so
// a stage boot that "helpfully" fell back to a random port would come up green
// and serve a 502 to every visitor. That is why a stage pin is REQUIRED, not
// preferred: unavailable means stop, loudly, naming what holds it.
export const STAGE_WEB_PORT = 48787;

// Spelled once, used in the pre-flight below and in the operator-facing error.
export const STAGE_WEB_PORT_PURPOSE = "web/api (--stage — the cloudflared tunnel origin)";

// Env vars that USED to pin a host port and now influence nothing whatsoever.
// They are no longer even compose interpolation OUTPUTS: docker-compose.yml has
// no `${WEB_PORT}` / `${POSTGRES_PORT}` left to interpolate, because the host
// side of both publishes is gone. An operator whose stale `.env` still carries
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
      `WARNING: ${name}=${raw.trim()} is set and is being IGNORED. Host ports are assigned by DOCKER ` +
        `now — the compose files publish container ports only, so there is no host side left for this ` +
        `variable to fill. Pinning one from the environment was removed because a pinned :48787 raced ` +
        `the stage tunnel and took the site down. Delete ${name} from your .env / shell. ` +
        `(The only pin left is \`bun demo --stage\`, which pins the web port to ${STAGE_WEB_PORT} and nothing else.)`,
    );
  }
  return out;
}

// ── Readback: what did Docker actually publish? ──────────────────────────────

/**
 * Thrown when `docker compose port` cannot be turned into one host port — an
 * empty result (service not running / port not published), garbage, or the `:0`
 * compose prints for an unpublished port. Carries the raw output so the caller
 * can show the operator what it actually got instead of a bare "failed to
 * parse".
 */
export class PortDiscoveryError extends Error {
  readonly service: string;
  readonly containerPort: number;
  readonly raw: string;
  constructor(service: string, containerPort: number, raw: string, detail: string) {
    super(
      `could not determine the host port Docker published for ${service}:${containerPort} — ${detail}. ` +
        `Raw \`docker compose port\` output: ${JSON.stringify(raw)}`,
    );
    this.name = "PortDiscoveryError";
    this.service = service;
    this.containerPort = containerPort;
    this.raw = raw;
  }
}

// An IPv4 dotted quad and nothing else — `[::]`, `::`, a hostname and an empty
// host all fail it. Used to PREFER the IPv4 line below.
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Parse `docker compose port <service> <containerPort>` output into ONE host
 * port.
 *
 * The output is one line per published binding, and a service published on all
 * interfaces yields TWO on a dual-stack daemon:
 *
 *     0.0.0.0:32768
 *     [::]:32769
 *
 * They are usually the same number but are not guaranteed to be, so this
 * PREFERS the IPv4 / 0.0.0.0 line: everything host-side in this repo talks to
 * 127.0.0.1 (scripts/stack/config.ts's hostBackendUrl explains why "localhost"
 * — which Bun resolves to ::1 first — breaks the CI health check). An
 * IPv6-only result is still ACCEPTED rather than refused; refusing would turn a
 * working stack into a failed boot for a reason the operator cannot act on.
 *
 * Port 0 counts as NOT PUBLISHED, not as a port: compose prints `:0` (and older
 * versions an empty string) when the service has no such published port, and a
 * caller that took the 0 would go on to build `http://127.0.0.1:0`.
 */
export function parseComposePortOutput(stdout: string, service: string, containerPort: number): number {
  const candidates: { host: string; port: number }[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on the LAST colon: the host half may itself contain colons
    // (`[::]`, `::`), the port half never does.
    const idx = line.lastIndexOf(":");
    if (idx < 0) continue;
    const tail = line.slice(idx + 1);
    if (!/^\d+$/.test(tail)) continue;
    const port = Number(tail);
    if (port <= 0 || port > 65535) continue;
    candidates.push({ host: line.slice(0, idx), port });
  }
  if (candidates.length === 0) {
    throw new PortDiscoveryError(
      service,
      containerPort,
      stdout,
      stdout.trim() === ""
        ? "no binding was reported at all (is the container running, and does it publish that port?)"
        : "no line carried a usable host port",
    );
  }
  const ipv4 = candidates.find((c) => c.host === "0.0.0.0" || IPV4.test(c.host));
  return (ipv4 ?? candidates[0]!).port;
}

// ── The stage pre-flight ────────────────────────────────────────────────────

/**
 * Thrown when the stage web port is already held. Carries the port (and what it
 * was for) as DATA so the entrypoint can attach a "who holds it" diagnostic
 * without this module having to spawn anything during the check.
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

// Try to bind `port` on 127.0.0.1; resolve true if it bound (releasing it
// immediately), false if something already holds it. 127.0.0.1 is enough to
// detect a docker-proxy holding 0.0.0.0:<port>, which is exactly the co-tenancy
// case this guards against.
function bindProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.on("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/**
 * PRE-FLIGHT for `bun run demo -- --stage`: refuse to start when something
 * already holds 48787.
 *
 * This binds, and that is deliberately NOT the TOCTOU pattern this module's
 * header condemns. The difference is that nothing here CHOOSES a number. The
 * stage port is 48787 whatever the probe says; the probe only decides whether
 * to fail EARLY with an actionable message (naming the holder) or LATE with
 * compose's opaque bind error. If another process claims 48787 in the gap after
 * the probe, `compose up` still fails — loudly, just less legibly. Losing that
 * race costs a worse error message, never a wrong port. It is a diagnostic, not
 * an allocation.
 *
 * Returns void or THROWS PortUnavailableError (test-coverage policy: there is
 * no boolean a caller could quietly branch into a fallback).
 */
export async function assertStageWebPortFree(
  port: number = STAGE_WEB_PORT,
  purpose: string = STAGE_WEB_PORT_PURPOSE,
): Promise<void> {
  if (await bindProbe(port)) return;
  throw new PortUnavailableError(port, purpose);
}

// ── "What holds this port?" diagnostic ──────────────────────────────────────
// Only ever reached on the stage pre-flight failure path. An error that says
// "48787 is in use" and stops there costs the operator a shell session of
// guessing; one that names the container or the pid is actionable immediately.

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
