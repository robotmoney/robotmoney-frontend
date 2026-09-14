// PROJECT FUSION RC2 — A JUDGE MODE TRANSITION IS ONE FIELD, NOT TWO.
//
// v0.5.0-rc.1's `setJudgeConfig` wrote `INSERT … ON CONFLICT (id) DO UPDATE`
// with a COALESCE in the DO UPDATE arm written precisely so a mode-only patch
// would preserve the stored model. The arm never ran: PostgreSQL evaluates a
// table CHECK against the PROPOSED INSERT TUPLE before the arbiter index
// redirects the statement, and that tuple carried model = NULL beside
// mode = 'enforce'. Migration 0056's constraint fired on a row that was never
// stored, and `POST /api/swarm/admin/judge {"mode":"enforce"}` returned 400
// with a raw driver string (observed on staging, 1.12 acceptance mutation #3).
//
// Nothing here relaxes 0056. The constraint is asserted still to hold — an
// on-with-no-model patch is still refused, by NAME — and what changes is only
// that preserving the model no longer requires resending it.
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { getJudgeConfig, setJudgeConfig } from "../src/swarm/judge-session.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const MODEL = "deepseek-v4-flash";
const OTHER = "kimi-k3";

test("a mode-only patch preserves the stored model through every transition", async () => {
  await setJudgeConfig({ mode: "off", model: MODEL });
  expect(await getJudgeConfig()).toMatchObject({ mode: "off", model: MODEL });

  // The exact call staging made, which used to 400.
  expect(await setJudgeConfig({ mode: "shadow" })).toMatchObject({ mode: "shadow", model: MODEL });
  expect(await setJudgeConfig({ mode: "enforce" })).toMatchObject({ mode: "enforce", model: MODEL });
  expect(await setJudgeConfig({ mode: "off" })).toMatchObject({ mode: "off", model: MODEL });
});

test("a minTakes-only patch touches neither mode nor model", async () => {
  await setJudgeConfig({ mode: "enforce", model: MODEL, minTakes: 3 });
  expect(await setJudgeConfig({ minTakes: 5 })).toMatchObject({ mode: "enforce", model: MODEL, minTakes: 5 });
});

test("the pair patch still works, and still wins when both fields are sent", async () => {
  await setJudgeConfig({ mode: "off", model: MODEL });
  expect(await setJudgeConfig({ mode: "enforce", model: OTHER })).toMatchObject({ mode: "enforce", model: OTHER });
});

test("migration 0056 still holds: the judge cannot be switched on with no model", async () => {
  await setJudgeConfig({ mode: "off", model: MODEL });
  // Clearing the model while turning the judge on is refused as a PAIR, in the
  // function's own words — never as a driver string.
  await expect(setJudgeConfig({ mode: "enforce", model: null })).rejects.toThrow(
    /requires a model — set \{ mode, model \} together/,
  );
  // And from a genuinely model-less row, a mode-only patch is refused too:
  // there is nothing to preserve, so this is not the defect above.
  await setJudgeConfig({ mode: "off", model: null });
  expect(await getJudgeConfig()).toMatchObject({ mode: "off", model: null });
  await expect(setJudgeConfig({ mode: "enforce" })).rejects.toThrow(
    /requires a model — set \{ mode, model \} together/,
  );
  expect(await getJudgeConfig(), "a refusal changes nothing").toMatchObject({ mode: "off", model: null });

  // The database constraint is intact for writers that never come through here.
  let raw: unknown = null;
  try {
    await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = NULL WHERE id = 1`;
  } catch (e) { raw = e; }
  expect(String((raw as Error | null)?.message ?? "")).toContain("swarm_judge_config_mode_requires_model_check");
});

// ── The property that decided the implementation ────────────────────────────
// The obvious repair — read the row, then send the resolved model in the VALUES
// tuple — also fixes the mode-only patch, and was built and measured against
// this one. It lost because it is a read-modify-write: a second writer landing
// in the window had its model change silently reverted. A plain UPDATE cannot
// do that, because its COALESCE reads the row at statement time.
//
// THE SEQUENTIAL VERSION OF THIS TEST DID NOT PIN IT (RC2 review). Performing
// the competing write BEFORE calling setJudgeConfig proves only that the
// mode-only patch works: a read-modify-write reads AFTER that write too, and
// passes. The window has to be entered, and there is no production hook to
// enter it with — nor should there be, since a seam that exists only for this
// test would itself be the read-modify-write's shape.
//
// So the window is entered through POSTGRES, with no production change at all.
// A competing transaction updates the row and HOLDS its lock; `setJudgeConfig`
// then runs, completes its own SELECT (which is not blocked), and stalls on the
// row lock inside its UPDATE. When the competing transaction commits:
//
//   * a plain UPDATE re-reads the row under READ COMMITTED, so its
//     `COALESCE(NULL, model)` sees the model the other writer just committed;
//   * a read-modify-write has already captured the OLD model in its VALUES
//     tuple and writes it back, reverting the other writer.
//
// That is the discriminator the bake-off used, expressed with a lock instead of
// a hook — and it fails against the rejected design for the same reason.
test("a mode-only patch adopts a model written concurrently INSIDE its own write window", async () => {
  await setJudgeConfig({ mode: "off", model: MODEL });

  let releaseCompetingWriter!: () => void;
  const held = new Promise<void>((resolve) => { releaseCompetingWriter = resolve; });
  // Held open on its own pooled connection (PG_POOL_MAX defaults to 10, so
  // this cannot starve the patch below of a connection).
  const competingWriter = sql.begin(async (tx) => {
    await tx`UPDATE swarm_judge_config SET model = ${OTHER} WHERE id = 1`;
    await held;
  });

  const settled = await Promise.race([
    (async () => { await competingWriter.catch(() => {}); return "committed-early"; })(),
    // Let the competing writer actually take the row lock before the patch runs.
    new Promise<string>((r) => setTimeout(() => r("holding"), 150)),
  ]);
  expect(settled, "the competing writer is still holding its lock").toBe("holding");

  // Enters the window: its SELECT sees `MODEL` (uncommitted OTHER is invisible),
  // then its UPDATE blocks on the row lock.
  const patch = setJudgeConfig({ mode: "enforce" });
  await new Promise((r) => setTimeout(r, 150));

  releaseCompetingWriter();
  await competingWriter;

  // A read-modify-write would answer MODEL here, having decided before it blocked.
  expect(await patch).toMatchObject({ mode: "enforce", model: OTHER });
  expect(await getJudgeConfig(), "and the stored row agrees").toMatchObject({ mode: "enforce", model: OTHER });
});

// ── T06 · THE RESULTING MODEL, NOT THE PATCHED ONE (AC-MODEL-01) ────────────
//
// The fix above — a plain UPDATE whose COALESCE preserves the stored model —
// is exactly what opened this door. `assertJudgeModelAllowed()` had one call
// site and it was guarded on the patch CARRYING a model, so a row already
// holding `nemotron-3-ultra-free` could be switched to `enforce` by a patch
// that never mentioned a model at all. The same id sent explicitly was
// correctly refused. Reproduced empirically on the rc.2 database before this
// test existed.
//
// The row is seeded by RAW SQL rather than through setJudgeConfig(), because
// setJudgeConfig() refuses the id — which is the whole point: the databases
// this has to hold for are the ones whose history nobody watched (a restored
// backup, a psql session, a migration, or a release of this code older than
// the policy).
const FREE = "nemotron-3-ultra-free";

async function seedRawJudgeRow(mode: string, model: string): Promise<void> {
  await sql`
    INSERT INTO swarm_judge_config (id, mode, min_takes, model, third_party_enabled, updated_at)
    VALUES (1, ${mode}, 2, ${model}, false, now())
    ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, model = EXCLUDED.model`;
}

test("a mode-only patch cannot enable a pre-seeded free-family model", async () => {
  await seedRawJudgeRow("off", FREE);
  expect(await getJudgeConfig(), "the seed is genuinely there").toMatchObject({ mode: "off", model: FREE });

  await expect(setJudgeConfig({ mode: "enforce" })).rejects.toThrow(/keyless free family/);
  await expect(setJudgeConfig({ mode: "shadow" })).rejects.toThrow(/keyless free family/);

  // A refusal changes nothing — the judge stays off rather than half-applied.
  expect(await getJudgeConfig()).toMatchObject({ mode: "off", model: FREE });
});

test("the same patch is accepted once the model is corrected in the same call", async () => {
  await seedRawJudgeRow("off", FREE);
  expect(await setJudgeConfig({ mode: "enforce", model: MODEL })).toMatchObject({ mode: "enforce", model: MODEL });
});

test("mode:off is still reachable from a free-family row — the way OUT is never blocked", async () => {
  // Turning a disqualified judge OFF must not be refused: that is the
  // operator's remedy, and a policy that blocks it would strand the row.
  await seedRawJudgeRow("enforce", FREE);
  expect(await setJudgeConfig({ mode: "off" })).toMatchObject({ mode: "off", model: FREE });
});
