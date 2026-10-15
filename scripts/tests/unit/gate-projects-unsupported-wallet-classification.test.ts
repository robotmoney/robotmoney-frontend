// Issue 1275: projects.refresh_wallets skips wallets it has no live read path
// for (a chain other than base, or an address that is not 0x plus 40 hex) and
// reports them in one info-level summary line per run. The gate must treat
// that summary as a non-error line, so a release baseline needs no triage
// entry for it. The legacy per-wallet "live read failed" error line is still
// how a real Base read failure reads, so no committed rule may excuse it when
// it names a real 40-hex address: it must stay unclassified and fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, lineLevel, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const groupsOf = (lines: string[]) => classify(inventory("worker-analytics", lines.map((text) => ({ ts: null, text }))), committed);

const handlerSrc = readFileSync(join(import.meta.dir, "../../../backend/src/worker/handlers/projects.ts"), "utf8");
const uuid = "5f0c1a7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const REAL = "0x4200000000000000000000000000000000000006";
const legacy = (msg: string) =>
  `[projects.refresh_wallets] wallet ${uuid} live read failed, keeping last-persisted balance (degraded): ${msg}`;
// The exact text refreshWallets logs, for the production counts of 2026-10-14.
const summary = (n: number, total: number) =>
  `[projects.refresh_wallets] skipped ${n} of ${total} wallet(s) with no live read path ` +
  "(chain not base, or address not 0x plus 40 hex); kept their last-persisted balance";

test("the summary line under test is the one the handler emits", () => {
  expect(handlerSrc).toContain("[projects.refresh_wallets] skipped ${unsupported} of ${wallets.length} wallet(s) with no live read path ");
  expect(handlerSrc).toContain('"(chain not base, or address not 0x plus 40 hex); kept their last-persisted balance"');
});

describe("the skip summary produces no error group", () => {
  for (const line of [summary(8, 793), summary(1, 1)]) {
    test(line.slice(0, 80), () => {
      expect(lineLevel(line)).toBeNull();
      expect(groupsOf([line])).toEqual([]);
      for (const mode of ["baseline", "post-release"] as const) {
        const v = inventoryVerdict(groupsOf([line]), mode, "v0.6.0");
        expect(v.failures).toEqual([]);
        expect(v.unclassifiedErrors).toBe(0);
      }
    });
  }
});

describe("RED CONTROL: the legacy live-read error on a real address stays unclassified and fails", () => {
  for (const line of [
    legacy(`Base RPC: eth_call failed for ${REAL}`),
    legacy(`invalid address: ${REAL}`),
    legacy(`live wallet-balance provider only covers chain "base" (got "ethereum") for ${REAL} — no RPC/pricing path exists for other chains yet`),
  ]) {
    test(line.slice(0, 90), () => {
      const [g] = groupsOf([line]);
      expect(g!.level).toBe("ERROR");
      expect(g!.rule).toBeNull();
      const v = inventoryVerdict(groupsOf([line]), "post-release", "v0.6.0");
      expect(v.unclassifiedErrors).toBe(1);
      expect(v.failures.join("\n")).toContain("unclassified error");
    });
  }
});
