// ?view=summary on GET /api/dashboards/research-signals/:key (issue #869b):
// the readable answer (title/asof/question/summary/gauges/spec) without the
// raw price series and indicators dict that back the /research/* charts.
import { expect, test } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { getResearchSignal } from "../../src/api/routes/dashboards.ts";

const KEY = `test-signal-${crypto.randomUUID().slice(0, 8)}`;
const DATE = "2026-09-01";

const FULL_PAYLOAD = {
  title: "Channel Divergence",
  asof: DATE,
  question: "Is price diverging from the channel?",
  summary: "Mild divergence, within normal range.",
  gauges: [{ label: "divergence", value: 0.2 }],
  spec: { kind: "channel" },
  indicators: { rsi: { value: 55 } },
  btc_price: [1, 2, 3],
  qqq_price: [4, 5, 6],
  series: { points: [1, 2] },
};

test("getResearchSignal without summaryView returns the full payload unchanged", async () => {
  await sql`INSERT INTO research_signals (signal_key, date, payload) VALUES (${KEY}, ${DATE}, ${sql.json(FULL_PAYLOAD)})`;
  try {
    const r = await getResearchSignal(KEY, false);
    expect(r?.payload).toEqual(FULL_PAYLOAD);
  } finally {
    await sql`DELETE FROM research_signals WHERE signal_key = ${KEY}`;
  }
});

test("getResearchSignal with summaryView=true drops the raw series/indicators, keeps the readable fields", async () => {
  await sql`INSERT INTO research_signals (signal_key, date, payload) VALUES (${KEY}, ${DATE}, ${sql.json(FULL_PAYLOAD)})`;
  try {
    const r = await getResearchSignal(KEY, true);
    expect(r?.payload).toEqual({
      title: "Channel Divergence",
      asof: DATE,
      question: "Is price diverging from the channel?",
      summary: "Mild divergence, within normal range.",
      gauges: [{ label: "divergence", value: 0.2 }],
      spec: { kind: "channel" },
    });
    expect(r?.payload).not.toHaveProperty("indicators");
    expect(r?.payload).not.toHaveProperty("btc_price");
    expect(r?.payload).not.toHaveProperty("qqq_price");
    expect(r?.payload).not.toHaveProperty("series");
  } finally {
    await sql`DELETE FROM research_signals WHERE signal_key = ${KEY}`;
  }
});

test("getResearchSignal for an unknown key returns null regardless of summaryView", async () => {
  expect(await getResearchSignal("no-such-signal-key", false)).toBeNull();
  expect(await getResearchSignal("no-such-signal-key", true)).toBeNull();
});
