// `bun run smoke:stage` — the standing/public smoke, in one command.
//
// It is a THIN WRAPPER, not a third code path: it decides two things and then
// invokes `bun scripts/smoke.ts` with those decisions spelled out as ordinary
// flags. Everything the smoke does afterwards is the same code any other
// invocation runs, and the exact equivalent command is printed so the choice can
// always be reproduced by hand.
//
//   1. --static-port   ALWAYS. This is the boot cloudflared points at, so its
//                      host port must be the fixed one rather than whatever
//                      Docker hands out.
//   2. --db external   WHEN `.env` describes a Postgres. Otherwise --db
//                      ephemeral, the smoke's own container, exactly as a plain
//                      `bun run smoke` would use.
//
// WHY AUTO-DETECTION IS ALLOWED HERE, when the smoke itself refuses to infer a
// data path: the refusal exists so that an ambient environment variable can
// never silently redirect a boot onto a real database. This is a NAMED command
// whose documented job is "read .env and stand up the public smoke" — the
// operator chose that by typing it. The decision is announced loudly before
// anything starts, and `bun run smoke -- …` remains fully explicit for anyone who
// wants to state the data path themselves.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { detectEnvPostgres } from "./lib/smoke-external-pg.ts";
import { DB_FLAG } from "./lib/smoke-db-mode.ts";

export const STATIC_PORT_FLAG = "--static-port";

export interface StagePlan {
  /** The argv to hand `scripts/smoke.ts`. */
  args: string[];
  /** Which data path was chosen, for the banner. */
  dataPath: "external" | "ephemeral";
  /** Password-redacted target when external; undefined otherwise. */
  target?: string;
}

/**
 * PURE. Decide the invocation from what `.env` holds plus any extra flags the
 * operator passed through (`bun run smoke:stage -- --no-tui`). Exported so
 * scripts/tests/unit/smoke-stage.test.ts can pin both branches without a boot.
 */
export function planStageArgs(envFilePath: string, passthrough: string[] = []): StagePlan {
  const detected = detectEnvPostgres(envFilePath);
  // Never emit a data-path flag twice: an operator who stated one themselves
  // (either spelling) keeps theirs, and passing --static-port explicitly is a
  // no-op rather than a duplicate.
  const statesDataPath = passthrough.some((a) => a === DB_FLAG || a.startsWith(`${DB_FLAG}=`) || a === "--external-pg");
  const args = [STATIC_PORT_FLAG];
  if (detected.enabled && !statesDataPath) args.push(DB_FLAG, "external");
  args.push(...passthrough.filter((a) => a !== STATIC_PORT_FLAG));
  return detected.enabled
    ? { args, dataPath: "external", target: detected.redactedUrl }
    : { args, dataPath: "ephemeral" };
}

if (import.meta.main) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const passthrough = process.argv.slice(2);
  const plan = planStageArgs(join(repoRoot, ".env"), passthrough);

  console.log(`[smoke:stage] host port: PINNED (${STATIC_PORT_FLAG}) — this is the boot a tunnel points at.`);
  console.log(
    plan.dataPath === "external"
      ? `[smoke:stage] database: EXTERNAL, from .env — ${plan.target}\n` +
        `[smoke:stage]   this boot MIGRATES AND SEEDS that server and its workers write to it.`
      : `[smoke:stage] database: the smoke's own ephemeral postgres container (no usable Postgres found in .env).\n` +
        `[smoke:stage]   its data is deleted with the stack; add DATABASE_URL to .env for a persistent one.`,
  );
  console.log(`[smoke:stage] equivalent: bun run smoke -- ${plan.args.join(" ")}`);

  const proc = Bun.spawn(["bun", join(repoRoot, "scripts", "smoke.ts"), ...plan.args], {
    cwd: repoRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Forward the signals an operator actually sends, so Ctrl-C still reaches the
  // smoke's own teardown instead of orphaning a stack behind this wrapper.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { try { proc.kill(sig === "SIGINT" ? 2 : 15); } catch { /* already gone */ } });
  }
  process.exit(await proc.exited);
}
