// `bun run twin` — the STANDING digital twin, in one command.
//
// Capture a fresh dump of the production replica, restore it locally, and boot
// the real stack against it on the pinned tunnel port, then stay up. This is the
// public demo backed by production-shaped data instead of simulation fixtures.
//
// A THIN WRAPPER, not a fourth code path. It decides two things and then invokes
// the ordinary commands with those decisions spelled out as flags, printing the
// equivalent invocation so the choice is always reproducible by hand — the same
// contract `bun run demo:stage` follows:
//
//   1. twin:capture   UNLESS --reuse. "The latest dump" is the point of this
//                     command; a rehearsal against last week's copy answers a
//                     question nobody asked.
//   2. --static-port  ALWAYS. This is the boot cloudflared points at, so its
//                     host port must be the fixed one rather than whatever
//                     Docker hands out.
//
// HOW IT DIFFERS FROM ITS NEIGHBOURS:
//   bun run demo:stage    standing demo, SIMULATED committee, ephemeral or .env db
//   bun run twin:rehearse one-shot rehearsal, docker-assigned port, tears down
//   bun run twin          standing demo, PRODUCTION data, pinned tunnel port, stays up
//
// ⛔ THIS PUBLISHES A COPY OF PRODUCTION ON A PUBLIC URL. cloudflared routes
// stage.robotmoney-labs.dev to the pinned port, so everything below is reachable
// from the internet, and two consequences are NOT obvious:
//
//   * The restored `admin_credential` table is typically EMPTY — the one-time
//     admin claim is unclaimed (restore-check.ts reports this as a WARN on every
//     v0.2.2-era backup). On a Docker-assigned port that is harmless. On the
//     tunnel it means whoever reaches the admin surface first CLAIMS ADMIN on a
//     database holding real member data. Claim it yourself immediately, or do
//     not run this.
//   * The twin's volume OUTLIVES the boot (the ephemeral-pgdata contract), so a
//     standing twin leaves production-derived data — password hashes, session
//     tokens, member emails — resident on this host until `demo:clean`.
//
// Both are stated at boot rather than left to be discovered.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveZenKey } from "./lib/twin-rehearsal.ts";

const NAME = "twin";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m: string) => console.log(`[${NAME}] ${m}`);

export interface TwinPlan {
  /** Run twin:capture first? */
  capture: boolean;
  /** The argv handed to scripts/demo.ts. */
  args: string[];
  backupDir?: string;
}

/**
 * PURE. Decide the invocation from the operator's flags. Exported so
 * scripts/tests/unit/twin-command.test.ts can pin it without a boot.
 */
export function planTwin(passthrough: readonly string[]): TwinPlan | { error: string } {
  const known = new Set(["--reuse", "--backup-dir", "--no-tui"]);
  for (let i = 0; i < passthrough.length; i++) {
    const a = passthrough[i]!;
    if (!a.startsWith("--")) return { error: `unexpected argument "${a}".` };
    if (!known.has(a)) {
      return { error: `unknown flag "${a}". This command takes: ${[...known].join(" ")}` };
    }
    if (a === "--backup-dir") {
      const v = passthrough[i + 1];
      if (!v || v.startsWith("--")) return { error: "--backup-dir requires a value." };
      i++;
    }
  }
  const i = passthrough.indexOf("--backup-dir");
  const backupDir = i >= 0 ? passthrough[i + 1] : undefined;

  // --static-port and --smoke are NOT optional here: the first is what makes
  // this the tunnel's boot, the second is what --db twin requires (a restored
  // database is populated, and the demo scenario's fixtures overwrite by design).
  const args = ["--smoke", "--db", "twin", "--static-port"];
  if (backupDir) args.push("--backup-dir", backupDir);
  if (passthrough.includes("--no-tui")) args.push("--no-tui");

  return { capture: !passthrough.includes("--reuse"), args, ...(backupDir ? { backupDir } : {}) };
}

if (import.meta.main) {
  const plan = planTwin(process.argv.slice(2));
  if ("error" in plan) {
    console.error(`[${NAME}] ${plan.error}`);
    console.error(`[${NAME}] usage: bun run twin [-- --reuse] [--backup-dir DIR] [--no-tui]`);
    process.exit(2);
  }

  // Resolve the credential BEFORE the dump and the image build. Discovering a
  // missing key after several minutes of work is a wasted window — the same
  // ordering twin:rehearse uses, and the same resolver.
  const zen = resolveZenKey();
  if ("error" in zen) {
    console.error(`[${NAME}] ${zen.error}`);
    process.exit(2);
  }

  log(`host port: PINNED (--static-port) — this is the boot cloudflared points at.`);
  log(`database:  a LOCAL TWIN restored from ${plan.capture ? "a FRESH capture of the production replica" : "the existing backup"}.`);
  log(`inference: production default model, OPENCODE_API_KEY from ${zen.source} — real spend on a real key.`);
  console.warn(
    `[${NAME}] ############################################################\n` +
      `[${NAME}] # THIS PUBLISHES PRODUCTION DATA ON A PUBLIC URL.\n` +
      `[${NAME}] # cloudflared routes stage.robotmoney-labs.dev to this boot.\n` +
      `[${NAME}] #\n` +
      `[${NAME}] # The restored admin claim is usually UNCLAIMED — whoever\n` +
      `[${NAME}] # reaches the admin surface first takes admin on a database\n` +
      `[${NAME}] # of real member data. Claim it yourself, immediately.\n` +
      `[${NAME}] #\n` +
      `[${NAME}] # The twin's volume OUTLIVES this boot. Reclaim it when done:\n` +
      `[${NAME}] #   bun run demo:clean --project <project from demo:status>\n` +
      `[${NAME}] ############################################################`,
  );
  log(`equivalent: ${plan.capture ? "bun run twin:capture && " : ""}bun run demo -- ${plan.args.join(" ")}`);

  if (plan.capture) {
    const captureArgs = ["bun", "run", "--cwd", join(repoRoot, "backend"), "scripts/twin-capture.ts"];
    if (plan.backupDir) captureArgs.push("--out", plan.backupDir);
    log("capturing the latest dump from the production replica…");
    const cap = Bun.spawn(captureArgs, {
      cwd: repoRoot,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const capCode = await cap.exited;
    if (capCode !== 0) {
      console.error(`[${NAME}] capture failed (exit ${capCode}) — NOT booting against a stale or partial backup.`);
      process.exit(capCode);
    }
  }

  const proc = Bun.spawn(["bun", join(repoRoot, "scripts", "demo.ts"), ...plan.args], {
    cwd: repoRoot,
    // The key rides in the child's environment (a credential with a documented
    // env home), never a file — see twin-rehearsal.ts's resolveZenKey.
    env: { ...process.env, OPENCODE_API_KEY: zen.key },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Forward the signals an operator actually sends, so Ctrl-C still reaches the
  // demo's own teardown instead of orphaning a stack behind this wrapper.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try {
        proc.kill(sig === "SIGINT" ? 2 : 15);
      } catch {
        /* already gone */
      }
    });
  }
  process.exit(await proc.exited);
}
