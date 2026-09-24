// Unit specification for scripts/lib/smoke-journal.ts — the redacted plan and
// its content-hash id (§1.2), the phase journal and its three resume rules
// (§1.3), phase-boundary interruption, and the readiness receipt (§1.4) of
// docs/technical/smoke-production-spec.md.
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`; every test here fails today by design and is written
// against the behaviour the module must have once W1.6 lands.
//
// THE ONE TEST THAT MATTERS MOST is "a journal's own committed migration does
// not invalidate its resume". A naive expectation check compares the world
// against what it looked like when the run started, sees the migration the run
// ITSELF applied, and refuses — turning every interrupted run into an
// unresumable one, which is the exact situation the journal exists for. It is
// pinned here alongside its mirror image: the same schema move, unaccounted for
// by any recorded outcome, must refuse.
//
// Acceptance gates served (spec §10, W1):
//   - "Ctrl-C before replace: services not replaced, committed preparation
//      journaled not undone. Ctrl-C after: journal reported, rerun resumes."
//   - "Resume after committed preparation under the same plan id succeeds;
//      changed roster/image/target does not reuse completed phases."
//   - "Receipt read by `smoke:status`."
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePlanId,
  decideResume,
  DEPLOYMENT_PHASES,
  openJournal,
  readJournal,
  readReceipt,
  renderPlan,
  summarizeProgress,
  watchForInterrupt,
  writeReceipt,
  type DeploymentPlan,
  type Journal,
  type PhaseOutcome,
  type Receipt,
  type StateExpectations,
} from "../../lib/smoke-journal.ts";
import { instancePaths, type InstancePaths } from "../../lib/smoke-state.ts";

const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

function freshPaths(instance = "alpha"): InstancePaths {
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-journal-"));
  return instancePaths(root, instance, { create: true });
}

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    instance: "alpha",
    target: { rmEnv: "stage", identity: "rehearsal", database: "db.example.invalid/robotmoney" },
    images: { api: DIGEST_A, worker: DIGEST_A },
    roster: { agents: ["athena", "robot-money"], judges: ["themis"] },
    // An arbitrary surviving configuration key — the journal records whatever
    // the plan carries and cares only that the value round-trips.
    configuration: { PRODUCER_RESEARCH_CRON: "0 23 * * *" },
    mutations: ["migrate"],
    ...overrides,
  };
}

function expectations(overrides: Partial<StateExpectations> = {}): StateExpectations {
  return {
    schemaHead: "0054_rm_worker_allowlist.sql",
    manifestHash: "manifest-aaa",
    identity: "rehearsal",
    participants: ["athena"],
    services: { api: DIGEST_A, worker: DIGEST_A },
    spoofGeneration: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<PhaseOutcome> = {}): PhaseOutcome {
  return {
    migrationsApplied: [],
    manifestPublished: null,
    participantsStarted: [],
    participantsStopped: [],
    servicesReplaced: {},
    spoofGenerationWritten: null,
    ...overrides,
  };
}

/**
 * A journal whose `prepare` phase committed a migration — the state every
 * interesting resume decision starts from.
 */
async function journalWithCommittedPreparation(paths: InstancePaths): Promise<Journal> {
  const p = plan();
  const id = computePlanId(p);
  const writer = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, p);
  await writer.beginPhase("plan", null, expectations());
  await writer.commitPhase(outcome());
  await writer.beginPhase("prepare", "migrate", expectations());
  await writer.commitPhase(
    outcome({ migrationsApplied: ["0055_deployment_identity.sql"], manifestPublished: "manifest-bbb" }),
  );
  const journal = readJournal(paths);
  if (journal === null) throw new Error("expected a journal");
  expect(journal.planId).toBe(id);
  return journal;
}

describe("DEPLOYMENT_PHASES — §1.3, the ordered phase list with `replace` as the watershed", () => {
  test("is the spec's list, in the spec's order, and every phase in it is one the journal records", async () => {
    expect(DEPLOYMENT_PHASES).toEqual(["plan", "prepare", "preflight", "replace", "participants", "readiness"]);

    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    for (const phase of DEPLOYMENT_PHASES) {
      await writer.beginPhase(phase, null, expectations());
      await writer.commitPhase(outcome());
    }
    expect(readJournal(paths)?.phases.map((record) => record.phase)).toEqual([...DEPLOYMENT_PHASES]);
  });
});

describe("computePlanId — §1.2, the plan id is a content hash of the whole intent", () => {
  test("the same intent hashes to the same id, so rule 1's `only when the plan id matches` can ever fire", () => {
    expect(computePlanId(plan())).toBe(computePlanId(plan()));
  });

  test("key insertion order does not change the id — the serialization is canonical", () => {
    const a: DeploymentPlan = plan({ configuration: { A: "1", B: "2" } });
    const b: DeploymentPlan = plan({ configuration: { B: "2", A: "1" } });
    expect(computePlanId(a)).toBe(computePlanId(b));
  });

  test("a changed roster changes the id — §1.3 names roster explicitly", () => {
    const changed = plan({ roster: { agents: ["athena"], judges: ["themis"] } });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("a changed judge roster changes the id", () => {
    const changed = plan({ roster: { agents: ["athena", "robot-money"], judges: [] } });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("a changed image digest changes the id — §1.3 names digest explicitly", () => {
    const changed = plan({ images: { api: DIGEST_B, worker: DIGEST_A } });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("a changed target changes the id — §1.3 names target explicitly", () => {
    const changed = plan({
      target: { rmEnv: "stage", identity: "rehearsal", database: "other.example.invalid/robotmoney" },
    });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("a changed set of intended mutations changes the id", () => {
    expect(computePlanId(plan({ mutations: ["migrate", "seed"] }))).not.toBe(computePlanId(plan()));
  });

  test("a changed instance changes the id", () => {
    expect(computePlanId(plan({ instance: "beta" }))).not.toBe(computePlanId(plan()));
  });

  test("no timestamp, pid or host path leaks in: two calls a moment apart agree", async () => {
    const first = computePlanId(plan());
    await Bun.sleep(5);
    expect(computePlanId(plan())).toBe(first);
  });

  test("a plan carrying a connection string refuses — this is the choke point the redaction promise rests on", () => {
    const leaky = plan({ configuration: { DATABASE_URL: "postgres://rm_app:hunter2@db.example.invalid/robotmoney" } });
    expect(() => computePlanId(leaky)).toThrow(/redact|credential|postgres:\/\//i);
  });

  test("a plan naming an image by tag rather than digest refuses: a moved tag would collide two deployments", () => {
    expect(() => computePlanId(plan({ images: { api: "robotmoney/api:latest" } }))).toThrow(/digest|tag/i);
  });
});

describe("renderPlan — §1.2, printed before any mutation", () => {
  test("names the instance, the target, the mutations and the plan id", () => {
    const p = plan();
    const text = renderPlan(p, computePlanId(p));
    expect(text).toContain("alpha");
    expect(text).toContain("db.example.invalid/robotmoney");
    expect(text).toContain("migrate");
    expect(text).toContain(computePlanId(p));
  });

  test("the plan id is the last line, so an operator always knows where to look for it", () => {
    const p = plan();
    const id = computePlanId(p);
    const lines = renderPlan(p, id).trimEnd().split("\n");
    expect(lines[lines.length - 1]).toContain(id);
  });

  test("the rendering is deterministic, so two runs' plans are diffable", () => {
    const p = plan();
    const id = computePlanId(p);
    expect(renderPlan(p, id)).toBe(renderPlan(p, id));
  });

  test("the rendering is redacted", () => {
    const p = plan();
    expect(renderPlan(p, computePlanId(p))).not.toContain("postgres://");
  });
});

describe("decideResume rule 1 — §1.3, a matching plan id resumes and its own work never blocks it", () => {
  test("no journal is a fresh start", () => {
    const decision = decideResume(null, computePlanId(plan()), expectations());
    expect(decision.kind).toBe("fresh-start");
  });

  test("a committed preparation under the same plan id resumes at the next phase", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const observed = expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" });
    const decision = decideResume(journal, journal.planId, observed);
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(decision.nextPhase).toBe("preflight");
  });

  test("the journal's own applied migration is accounted for, not treated as someone else's change", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const observed = expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" });
    expect(decideResume(journal, journal.planId, observed).kind).not.toBe("refuse");
  });

  test("a journal whose phases all committed resumes at the phase after the last committed one", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(
      journal,
      journal.planId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" }),
    );
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(DEPLOYMENT_PHASES.indexOf(decision.nextPhase)).toBeGreaterThan(DEPLOYMENT_PHASES.indexOf("prepare"));
  });
});

describe("decideResume rule 2 — §1.3, a different plan id supersedes and never reuses completed phases", () => {
  test("a changed roster supersedes rather than resuming", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(plan({ roster: { agents: ["athena"], judges: ["themis"] } }));
    const decision = decideResume(
      journal,
      newId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" }),
    );
    expect(decision.kind).toBe("supersede");
  });

  test("a changed image digest supersedes rather than resuming", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(plan({ images: { api: DIGEST_B, worker: DIGEST_A } }));
    const decision = decideResume(
      journal,
      newId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" }),
    );
    expect(decision.kind).toBe("supersede");
  });

  test("a changed target supersedes rather than resuming", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(
      plan({ target: { rmEnv: "stage", identity: "rehearsal", database: "other.invalid/robotmoney" } }),
    );
    const decision = decideResume(
      journal,
      newId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" }),
    );
    expect(decision.kind).toBe("supersede");
  });

  test("the supersede carries a report of what the old journal reached, naming its committed migration", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(plan({ mutations: ["migrate", "seed"] }));
    const decision = decideResume(
      journal,
      newId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb" }),
    );
    if (decision.kind !== "supersede") throw new Error("expected a supersede");
    expect(decision.report).toContain("0055_deployment_identity.sql");
    expect(decision.previous.planId).toBe(journal.planId);
  });

  test("an already-closed journal is a fresh start, not a second supersede", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const closed: Journal = { ...journal, closedAt: "2026-09-23T00:00:00.000Z" };
    expect(decideResume(closed, journal.planId, expectations()).kind).toBe("fresh-start");
  });
});

describe("decideResume rule 3 — §1.3, state changed by another operation refuses", () => {
  test("a schema head the journal's outcomes cannot account for refuses, naming both versions", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(
      journal,
      journal.planId,
      expectations({ schemaHead: "0056_someone_elses.sql", manifestHash: "manifest-ccc" }),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.reason).toContain("0056_someone_elses.sql");
  });

  test("a manifest hash that moved unaccountably refuses", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(
      journal,
      journal.planId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-zzz" }),
    );
    expect(decision.kind).toBe("refuse");
  });

  test("a re-enrolled target refuses: every policy decision the plan was built on was taken against another answer", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(
      journal,
      journal.planId,
      expectations({ schemaHead: "0055_deployment_identity.sql", manifestHash: "manifest-bbb", identity: "production" }),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.reason).toContain("production");
  });

  test("a spoofed-key generation nobody journaled refuses", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(
      journal,
      journal.planId,
      expectations({
        schemaHead: "0055_deployment_identity.sql",
        manifestHash: "manifest-bbb",
        spoofGeneration: "gen-unknown",
      }),
    );
    expect(decision.kind).toBe("refuse");
  });

  test("a service on a digest neither the plan nor the journal names refuses", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(
      journal,
      journal.planId,
      expectations({
        schemaHead: "0055_deployment_identity.sql",
        manifestHash: "manifest-bbb",
        services: { api: "sha256:9999999999999999999999999999999999999999999999999999999999999999", worker: DIGEST_A },
      }),
    );
    expect(decision.kind).toBe("refuse");
  });

  test("a refusal is a refusal, never a silent reconciliation", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(journal, journal.planId, expectations({ schemaHead: "0099_foreign.sql" }));
    expect(decision.kind).not.toBe("fresh-start");
    expect(decision.kind).not.toBe("resume");
  });
});

describe("readJournal / openJournal — §1.3, an unparseable record is never an absent one", () => {
  test("an instance that has never run has no journal", () => {
    expect(readJournal(freshPaths())).toBeNull();
  });

  test("a malformed journal refuses rather than reading as absent — absent means `mutate freely`", () => {
    const paths = freshPaths();
    writeFileSync(paths.journalFile, "{ truncated");
    expect(() => readJournal(paths)).toThrow(/journal|malformed|parse/i);
  });

  test("a journal with an unknown format version refuses", () => {
    const paths = freshPaths();
    writeFileSync(paths.journalFile, JSON.stringify({ formatVersion: 9999, phases: [] }));
    expect(() => readJournal(paths)).toThrow(/version|format/i);
  });

  test("openJournal on a `refuse` decision refuses: the check is not re-litigated here", () => {
    const paths = freshPaths();
    expect(() =>
      openJournal(paths, { kind: "refuse", reason: "schema moved under the journal" }, plan()),
    ).toThrow(/refus|schema moved/i);
  });

  test("openJournal on a missing state directory refuses — a run that cannot journal must not mutate", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-smoke-journal-"));
    const paths = instancePaths(root, "never-created");
    expect(() => openJournal(paths, { kind: "fresh-start", reason: "none" }, plan())).toThrow(/director|writ/i);
  });

  test("the journal is written BEFORE the phase acts, so a crash inside a phase leaves a trace", async () => {
    const paths = freshPaths();
    const p = plan();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writer.beginPhase("prepare", "migrate", expectations());

    const journal = readJournal(paths);
    expect(journal?.phases).toHaveLength(1);
    expect(journal?.phases[0]?.phase).toBe("prepare");
    expect(journal?.phases[0]?.step).toBe("migrate");
    expect(journal?.phases[0]?.status).toBe("started");
    expect(journal?.phases[0]?.outcome).toBeNull();
  });

  test("each committed preparation is recorded separately, not as one grouped `prepare`", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan({ mutations: ["migrate", "seed"] }));
    await writer.beginPhase("prepare", "migrate", expectations());
    await writer.commitPhase(outcome({ migrationsApplied: ["0055_deployment_identity.sql"] }));
    await writer.beginPhase("prepare", "seed", expectations());
    await writer.commitPhase(outcome());

    const steps = (readJournal(paths)?.phases ?? []).filter((p) => p.phase === "prepare").map((p) => p.step);
    expect(steps).toEqual(["migrate", "seed"]);
  });
});

describe("interruption — §1.4, Ctrl-C stops at the next phase boundary", () => {
  test("a Ctrl-C before `replace` leaves the committed preparation journaled and no service replaced", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.beginPhase("prepare", "migrate", expectations());
    await writer.commitPhase(outcome({ migrationsApplied: ["0055_deployment_identity.sql"] }));
    await writer.beginPhase("preflight", null, expectations());
    await writer.endPhase("interrupted", "SIGINT at phase boundary");

    const journal = readJournal(paths);
    const prepare = journal?.phases.find((p) => p.phase === "prepare");
    expect(prepare?.status).toBe("committed");
    expect(prepare?.outcome?.migrationsApplied).toEqual(["0055_deployment_identity.sql"]);
    expect(journal?.phases.some((p) => p.phase === "replace")).toBe(false);
    for (const phase of journal?.phases ?? []) {
      expect(phase.outcome?.servicesReplaced ?? {}).toEqual({});
    }
  });

  test("an interrupted phase records the reason and is a first-class ending, not a failure", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.beginPhase("preflight", null, expectations());
    await writer.endPhase("interrupted", "SIGINT at phase boundary");

    const record = readJournal(paths)?.phases.at(-1);
    expect(record?.status).toBe("interrupted");
    expect(record?.reason).toBe("SIGINT at phase boundary");
    expect(record?.endedAt).not.toBeNull();
  });

  test("a Ctrl-C after replacement began leaves the journal describing which services moved, and a rerun resumes", async () => {
    const paths = freshPaths();
    const p = plan({ images: { api: DIGEST_B, worker: DIGEST_A } });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writer.beginPhase("replace", null, expectations());
    await writer.commitPhase(outcome({ servicesReplaced: { api: DIGEST_B } }));
    await writer.beginPhase("participants", null, expectations({ services: { api: DIGEST_B, worker: DIGEST_A } }));
    await writer.endPhase("interrupted", "SIGINT at phase boundary");

    const journal = readJournal(paths);
    if (journal === null) throw new Error("expected a journal");
    const decision = decideResume(
      journal,
      computePlanId(p),
      expectations({ services: { api: DIGEST_B, worker: DIGEST_A } }),
    );
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(decision.nextPhase).toBe("participants");
  });

  test("the watch starts unrequested and observes a stop request without aborting in-flight work", () => {
    const watch = watchForInterrupt();
    try {
      expect(watch.requested()).toBe(false);
      process.emit("SIGINT");
      expect(watch.requested()).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  test("a second Ctrl-C does not escalate to an immediate exit — the thing it would kill is a transaction", () => {
    const watch = watchForInterrupt();
    try {
      process.emit("SIGINT");
      process.emit("SIGINT");
      expect(watch.requested()).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  test("installing the watch never fails a run", () => {
    expect(() => watchForInterrupt().dispose()).not.toThrow();
  });

  test("after dispose the watch no longer reports requests from later signals", () => {
    const watch = watchForInterrupt();
    watch.dispose();
    expect(watch.requested()).toBe(false);
  });
});

describe("receipt — §1.4, the artifact that outlives the run", () => {
  function receiptFor(p: DeploymentPlan, overrides: Partial<Receipt> = {}): Receipt {
    return {
      planId: computePlanId(p),
      plan: p,
      instance: p.instance,
      writtenAt: "2026-09-23T10:00:00.000Z",
      schema: { manifestHash: "manifest-bbb", migrations: ["0054_rm_worker_allowlist.sql"] },
      preflight: [{ check: "roles authenticate", pass: true, detail: "4/4" }],
      readiness: [{ check: "enabled schedules advanced", pass: true, detail: "5/5" }],
      ...overrides,
    };
  }

  test("an instance with no receipt reads as null, which routes the reader to the journal", () => {
    expect(readReceipt(freshPaths())).toBeNull();
  });

  test("a written receipt round-trips exactly — it must be self-contained for incident work", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const receipt = receiptFor(p);
    await writeReceipt(paths, receipt);
    expect(readReceipt(paths)).toEqual(receipt);
  });

  test("a receipt is refused when readiness did not pass — there is no receipt for a boot that never got there", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const failed = receiptFor(p, {
      readiness: [{ check: "scheduler ready", pass: false, detail: "initial rebuild never completed" }],
    });
    await expect(writeReceipt(paths, failed)).rejects.toThrow(/readiness/i);
    expect(readReceipt(paths)).toBeNull();
  });

  test("a receipt whose plan id does not match the open journal refuses", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const mismatched = receiptFor(plan({ instance: "beta" }));
    await expect(writeReceipt(paths, mismatched)).rejects.toThrow(/plan id/i);
  });

  test("a malformed receipt refuses rather than reading as absent", () => {
    const paths = freshPaths();
    writeFileSync(paths.receiptFile, "{ truncated");
    expect(() => readReceipt(paths)).toThrow(/receipt|malformed|parse/i);
  });
});

describe("summarizeProgress — §1.4, receipt when present, journal when not", () => {
  test("with a receipt it reports a finished run", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const receipt: Receipt = {
      planId: computePlanId(p),
      plan: p,
      instance: p.instance,
      writtenAt: "2026-09-23T10:00:00.000Z",
      schema: { manifestHash: "manifest-bbb", migrations: ["0054_rm_worker_allowlist.sql"] },
      preflight: [{ check: "roles authenticate", pass: true, detail: "4/4" }],
      readiness: [{ check: "enabled schedules advanced", pass: true, detail: "5/5" }],
    };
    await writeReceipt(paths, receipt);
    const summary = summarizeProgress(readJournal(paths), readReceipt(paths));
    expect(summary).toContain("readiness");
  });

  test("with no receipt it reports the journal's phase and the preparation that committed", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const summary = summarizeProgress(journal, null);
    expect(summary).toContain("prepare");
    expect(summary).toContain("0055_deployment_identity.sql");
  });

  test("after replacement began it says which services are new versus old, and never claims a gone service still serves", async () => {
    const paths = freshPaths();
    const p = plan({ images: { api: DIGEST_B, worker: DIGEST_A } });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writer.beginPhase("replace", null, expectations());
    await writer.commitPhase(outcome({ servicesReplaced: { api: DIGEST_B } }));
    const summary = summarizeProgress(readJournal(paths), null);
    expect(summary).toContain("api");
    expect(summary).toContain(DIGEST_B);
  });

  test("with neither a journal nor a receipt it says so rather than inventing a phase", () => {
    expect(summarizeProgress(null, null).length).toBeGreaterThan(0);
  });
});
