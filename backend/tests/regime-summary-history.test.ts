import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import {
  aggregateSession,
  buildRegimeSummary,
  closeWindow,
  ensureSubject,
  openSession,
  publishBrief,
  registerMember,
  submitRecommendation,
} from "../src/swarm/domain.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

test("buildRegimeSummary(endDate) selects the snapshot row matching endDate even when a newer row exists", async () => {
  // Scenario described in issue #962:
  // On 2026-09-10, composite is 0.6045.
  // On 2026-09-11, a newer row is inserted with composite 0.5978.
  // buildRegimeSummary("2026-09-10") must select the 2026-09-10 row, not 2026-09-11.
  await sql`
    INSERT INTO regime_snapshots (date, composite, composite_percentile, regime, macro_percentile, onchain_percentile, factor_percentile)
    VALUES
      ('2026-09-08', 0.5500, 0.50, 'neutral', 0.52, 0.48, 0.51),
      ('2026-09-09', 0.5800, 0.56, 'neutral', 0.55, 0.53, 0.54),
      ('2026-09-10', 0.6045, 0.62, 'neutral', 0.60, 0.58, 0.61),
      ('2026-09-11', 0.5978, 0.59, 'neutral', 0.57, 0.56, 0.58),
      ('2026-09-12', 0.7200, 0.75, 'risk_on', 0.71, 0.70, 0.73)
  `;

  const summary = await buildRegimeSummary("2026-09-10");

  // Latest selected snapshot matches 2026-09-10
  expect(summary.composite).toBe(0.6045);
  expect(summary.composite_percentile).toBe(0.62);
  expect(summary.regime).toBe("neutral");
  expect(summary.macro_percentile).toBe(0.60);
  expect(summary.onchain_percentile).toBe(0.58);
  expect(summary.factor_percentile).toBe(0.61);

  // Trailing history contains only points on or before endDate (<= 2026-09-10)
  expect(summary.history.length).toBe(3);
  const dates = summary.history.map((h) => h.date);
  expect(dates).toEqual(["2026-09-08", "2026-09-09", "2026-09-10"]);

  const lastPoint = summary.history[summary.history.length - 1];
  expect(lastPoint.date).toBe("2026-09-10");
  expect(lastPoint.composite).toBe(0.6045);
  expect(lastPoint.composite_percentile).toBe(0.62);
  expect(lastPoint.regime).toBe("neutral");

  // Newer dates are excluded
  expect(dates).not.toContain("2026-09-11");
  expect(dates).not.toContain("2026-09-12");
});

test("publishBrief and session summary agree on the regime row when newer snapshot is added after brief publish", async () => {
  // 1. Initial state at brief publish time: latest regime snapshot is 2026-09-10
  await sql`
    INSERT INTO regime_snapshots (date, composite, composite_percentile, regime)
    VALUES ('2026-09-10', 0.6045, 0.62, 'neutral')
  `;

  const subjectId = rid("subj");
  await ensureSubject(subjectId, "Agreement Subject");

  // Create session dated 2026-09-10 via convened_at (date is a generated column)
  const sessionRow = (
    await sql`
      INSERT INTO swarm_sessions (subject_id, subject_name, state, convened_at)
      VALUES (${subjectId}, 'Agreement Subject', 'scheduled', '2026-09-10T12:00:00Z')
      RETURNING id, date, subject_id, state
    `
  )[0];
  const sessionId = sessionRow.id;

  await publishBrief(sessionId, 60);
  const briefRow = (await sql`SELECT body FROM swarm_briefs WHERE session_id = ${sessionId}`)[0];
  const briefRegime = (briefRow.body as any)?.regime;
  expect(Number(briefRegime.composite)).toBe(0.6045);

  // 2. Later, before aggregation, a newer snapshot for 2026-09-11 is inserted
  await sql`
    INSERT INTO regime_snapshots (date, composite, composite_percentile, regime)
    VALUES ('2026-09-11', 0.5978, 0.59, 'neutral')
  `;

  // Submit a recommendation so session can aggregate
  const memberId = rid("mem");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const reg = await registerMember({ memberId, name: memberId, publicKey: publicKeyB64 });
  const token = (reg as any).token;

  const sub = {
    memberId,
    date: "2026-09-10",
    subjectId,
    nonce: rid("n"),
    stance: "neutral",
    confidence: 0.7,
    body: "take body",
  };
  const sig = await signMessage(canonicalizeSubmission(sub), privateKey);
  await submitRecommendation(token, { ...sub, signature: sig });

  await closeWindow(sessionId);
  await aggregateSession(sessionId);

  // 3. Verify session regimeSummary matches the brief (0.6045), NOT the newer snapshot (0.5978)
  const sessionAfter = (await sql`SELECT regime_summary FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  const rs = sessionAfter.regime_summary;

  expect(rs).toBeTruthy();
  expect(rs.composite).toBe(0.6045);
  expect(rs.composite).toBe(Number(briefRegime.composite));
  expect(rs.history[rs.history.length - 1].date).toBe("2026-09-10");
  expect(rs.history[rs.history.length - 1].composite).toBe(0.6045);
});
