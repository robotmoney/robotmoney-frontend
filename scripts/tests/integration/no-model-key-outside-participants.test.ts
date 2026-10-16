// NO MODEL KEY OUTSIDE A PARTICIPANT (D52; smoke spec §3, §6.1; criteria 134
// and 152). Moved here from no-docker-socket-compose-config.test.ts, and now
// exercised over the REAL participant services a boot starts.
//
// `api` used to carry OPENCODE_API_KEY for an inline judge, and the standing
// boot put the checkout's key into every container that asked for it. The
// judge is a participant now, and every participant — agent or judge — takes
// its OWN model key from its own `credential.json` entry, as RM_INFERENCE_KEY
// (scripts/lib/participant-compose.ts). So the property is two-sided:
//
//   - no rendered service other than a participant carries a model key, in any
//     composition, profile or not;
//   - a participant carries exactly its own model key, and no other service —
//     participant or not — carries it.
//
// And one question settled: `bun smoke` does NOT forward OPENCODE_API_KEY to
// the stack (smoke-compose-env.ts's passthrough list omits it). The standing
// boot's inference preflight still hands compose the key as an interpolation
// variable, and no compose file interpolates it — so, as proved below by
// rendering with the key exported, it reaches no service's environment at all.
//
// A participant is identified by the label the renderer stamps on it
// (`robotmoney.participant=1`), not by a name pattern or a profile.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_COMPOSE_PASSTHROUGH, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";
import { credentialFile, entriesOf, repoRoot, writeParticipantOverlay } from "./participant-fixture.ts";

interface ServiceLike {
  environment?: Record<string, string | null> | string[];
  labels?: Record<string, string>;
}
interface ConfigLike {
  services?: Record<string, ServiceLike | undefined>;
}

/** A model credential by name: the shapes a vendor key is delivered under. */
const MODEL_KEY_SHAPE = /(^|_)(API_KEY|MODEL_KEY|INFERENCE_KEY)$|^OPENCODE_API_KEY$|^ANTHROPIC_|^OPENAI_/;
/** Data-vendor keys the pipeline worker legitimately holds. They pay for market data, never for inference. */
const DATA_VENDOR_KEYS: ReadonlySet<string> = new Set(["COINGECKO_API_KEY"]);
const MODEL_KEY = { test: (name: string): boolean => MODEL_KEY_SHAPE.test(name) && !DATA_VENDOR_KEYS.has(name) };
const isParticipant = (svc: ServiceLike | undefined): boolean => svc?.labels?.["robotmoney.participant"] === "1";

function environmentOf(svc: ServiceLike | undefined): Record<string, string | null> {
  const env = svc?.environment ?? {};
  if (!Array.isArray(env)) return env;
  const out: Record<string, string | null> = {};
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq === -1) out[entry] = null;
    else out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** `service: KEY` for every rendered environment key matching `pattern`, skipping participants when asked. */
function modelKeysOutsideParticipants(cfg: ConfigLike): string[] {
  const out: string[] = [];
  for (const [name, svc] of Object.entries(cfg.services ?? {})) {
    if (isParticipant(svc)) continue;
    for (const key of Object.keys(environmentOf(svc))) if (MODEL_KEY.test(key)) out.push(`${name}: ${key}`);
  }
  return out.sort();
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "COMPOSE_FILE" || k === "COMPOSE_PROJECT_NAME" || k === "OPENCODE_API_KEY") continue;
    env[k] = v;
  }
  return {
    ...env,
    SMOKE_PROJECT: "no-model-key-test",
    RM_STACK_ENV_CLASS: "local",
    RM_STACK_ENV_HASH: "nomodelkey0",
    RM_INSTANCE: "rm_local_nomodelkey",
    RM_INSTANCE_STATE_DIR: "/var/empty/rm_local_nomodelkey",
    WEB_PORT: "18787",
    POSTGRES_PORT: "15432",
    ...extra,
  };
}

function compose(args: readonly string[], env: Record<string, string>): string {
  const r = Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", ...args], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`docker compose ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout);
}

function render(files: readonly string[], profiles: readonly string[] = [], extraEnv: Record<string, string> = {}): ConfigLike {
  return JSON.parse(
    compose([...profiles.flatMap((p) => ["--profile", p]), ...files.flatMap((f) => ["-f", f]), "config", "--format", "json"], baseEnv(extraEnv)),
  ) as ConfigLike;
}

const SMOKE = ["docker-compose.yml"] as const;
const FILE = credentialFile(["athena", "noop-analyst", "robot-money"], ["themis"]);
const PARTICIPANTS = writeParticipantOverlay(entriesOf(FILE)).overlay;
const FILE_SETS: readonly { label: string; files: readonly string[] }[] = [
  { label: "base", files: ["docker-compose.yml"] },
  { label: "base + smoke", files: SMOKE },
  { label: "base + smoke + stage", files: [...SMOKE, "docker-compose.stage.yml"] },
  { label: "base + smoke + participants (rendered)", files: [...SMOKE, PARTICIPANTS] },
];

/** Every composition: each file set by default, and under every profile compose says it declares. */
let renders: Array<{ label: string; cfg: ConfigLike }> = [];
let withExportedKey: ConfigLike;
const PLANTED_ZEN_KEY = "sk-zen-exported-by-the-standing-boot-000111222";

beforeAll(() => {
  renders = FILE_SETS.flatMap(({ label, files }) => {
    const profiles = compose([...files.flatMap((f) => ["-f", f]), "config", "--profiles"], baseEnv()).split("\n").map((l) => l.trim()).filter(Boolean);
    return [
      { label, cfg: render(files) },
      ...profiles.map((p) => ({ label: `${label} [profile ${p}]`, cfg: render(files, [p]) })),
    ];
  });
  withExportedKey = render([...SMOKE, PARTICIPANTS], [], { OPENCODE_API_KEY: PLANTED_ZEN_KEY });
}, 300_000);

describe("no rendered service other than a participant carries a model key (criterion 134)", () => {
  test("every composition, every profile, and the rendered participants are clean", () => {
    expect(renders.length).toBeGreaterThanOrEqual(FILE_SETS.length);
    for (const { label, cfg } of renders) {
      expect({ label, keys: modelKeysOutsideParticipants(cfg) }).toEqual({ label, keys: [] });
    }
  });

  test("the participants really are in the render, and each carries its OWN model key and no other's", () => {
    const cfg = renders.find((r) => r.label === "base + smoke + participants (rendered)")!.cfg;
    const entries = entriesOf(FILE);
    const participants = Object.entries(cfg.services ?? {}).filter(([, svc]) => isParticipant(svc));
    expect(participants.map(([name]) => name).sort()).toEqual([
      "participant-agent-athena",
      "participant-agent-noop-analyst",
      "participant-agent-robot-money",
      "participant-judge-themis",
    ]);
    for (const entry of entries) {
      const svc = cfg.services?.[`participant-${entry.kind}-${entry.name}`];
      expect(environmentOf(svc).RM_INFERENCE_KEY).toBe(entry.credential.modelKey);
      // No service but this one — participant or application — holds this key.
      for (const [name, other] of Object.entries(cfg.services ?? {})) {
        if (other === svc) continue;
        expect({ name, holds: JSON.stringify(other).includes(entry.credential.modelKey) }).toEqual({ name, holds: false });
      }
    }
  });

  test("OPENCODE_API_KEY exported to compose (the standing boot's preflight does) reaches NO service", () => {
    const text = JSON.stringify(withExportedKey);
    expect(text).not.toContain(PLANTED_ZEN_KEY);
    for (const [name, svc] of Object.entries(withExportedKey.services ?? {})) {
      expect({ name, has: "OPENCODE_API_KEY" in environmentOf(svc) }).toEqual({ name, has: false });
    }
  });

  test("bun smoke forwards no model key to the stack: smoke-compose-env's passthrough list names none", () => {
    expect(DEMO_COMPOSE_PASSTHROUGH.filter((k) => MODEL_KEY.test(k))).toEqual([]);
    expect(smokePassthroughEnv({ OPENCODE_API_KEY: PLANTED_ZEN_KEY, RM_INFERENCE_KEY: PLANTED_ZEN_KEY })).toEqual({});
  });

  test("the pattern is not over-broad: the worker lanes' OPENCODE_TIMEOUT_MS is not a key", () => {
    const cfg = renders.find((r) => r.label === "base + smoke")!.cfg;
    const timeouts = Object.entries(cfg.services ?? {}).filter(([, svc]) => "OPENCODE_TIMEOUT_MS" in environmentOf(svc));
    expect(timeouts.length).toBeGreaterThan(0); // present, and…
    expect(MODEL_KEY.test("OPENCODE_TIMEOUT_MS")).toBe(false); // …not flagged
    expect(MODEL_KEY.test("COINGECKO_API_KEY")).toBe(false); // a data-vendor key is not an inference key
    expect(MODEL_KEY.test("OPENCODE_API_KEY")).toBe(true); // red control: a real model key still flags
  });

  test("red control: a model key planted on api through a real render is caught and named; a participant's is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-no-model-key-control-"));
    const overlay = join(dir, "docker-compose.planted.yml");
    writeFileSync(
      overlay,
      "services:\n  api:\n    environment:\n      OPENCODE_API_KEY: planted\n" +
        "  participant-judge-planted:\n    image: busybox\n    labels:\n      robotmoney.participant: \"1\"\n    environment:\n      RM_INFERENCE_KEY: allowed\n",
    );
    expect(modelKeysOutsideParticipants(render([...SMOKE, overlay]))).toEqual(["api: OPENCODE_API_KEY"]);
  }, 120_000);
});
