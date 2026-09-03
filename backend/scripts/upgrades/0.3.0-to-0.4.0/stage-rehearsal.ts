import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSmokeTwinRehearsal } from "../../../../scripts/lib/smoke-twin-rehearsal.ts";
import { TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const backupDir = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
const emit = process.argv.includes("--emit-receipt");
const code = await runSmokeTwinRehearsal({
  name: "stage-rehearsal-0.4.0", backupDir,
  onReady: async ({ databaseUrl }) => {
    const proc = Bun.spawn(["bun", `backend/scripts/upgrades/0.3.0-to-0.4.0/postflight.ts`, ...(emit ? ["--emit-receipt=P5.rehearsal"] : [])], { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  },
});
process.exitCode = code;
