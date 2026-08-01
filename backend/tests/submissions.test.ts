import { test, expect } from "bun:test";
import { createSubmission, SUBMISSION_ACTION_TYPES } from "../src/api/routes/submissions.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

test("general submission: validate + insert round-trip", async () => {
  const ip = `10.11.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const handle = rid("agent");

  const missingType = await createSubmission({ submitterHandle: handle, summary: "hi" }, ip);
  expect(missingType.status).toBe(400);

  const missingHandle = await createSubmission({ actionType: "general", summary: "hi" }, ip);
  expect(missingHandle.status).toBe(400);

  const missingSummary = await createSubmission({ actionType: "general", submitterHandle: handle }, ip);
  expect(missingSummary.status).toBe(400);

  const created = await createSubmission(
    { actionType: "general", submitterHandle: handle, summary: "Please review my agent." },
    ip,
  );
  expect(created.status).toBe(201);
  const body = created.body as any;
  expect(body.status).toBe("pending");
  expect(body.actionType).toBe("general");
  expect(body.submitterHandle).toBe(handle);
  expect(body.registration).toBeNull();
});

test("register_agent submission requires registration.name; persists claimed metrics verbatim", async () => {
  const ip = `10.12.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const handle = rid("agent");

  const noName = await createSubmission(
    { actionType: "register_agent", submitterHandle: handle, summary: "New agent", registration: {} },
    ip,
  );
  expect(noName.status).toBe(400);

  const created = await createSubmission(
    {
      actionType: "register_agent",
      submitterHandle: handle,
      summary: "New agent",
      registration: {
        name: "MoneyBot",
        walletAddress: "0x1234567890123456789012345678901234567890",
        claimedRevenueUsd: 1200.5,
        claimedTxns: 42,
        website: "https://example.com",
      },
    },
    ip,
  );
  expect(created.status).toBe(201);
  const body = created.body as any;
  expect(body.registration).toMatchObject({
    name: "MoneyBot",
    walletAddress: "0x1234567890123456789012345678901234567890",
    claimedRevenueUsd: 1200.5,
    claimedTxns: 42,
    website: "https://example.com",
  });
});

test("rejects an unknown actionType, even a plausible-looking one", async () => {
  const ip = `10.13.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const r = await createSubmission(
    { actionType: "delete_agent", submitterHandle: rid("h"), summary: "x" },
    ip,
  );
  expect(r.status).toBe(400);
});

test("SUBMISSION_ACTION_TYPES exposes exactly the 8 form action types (§5.17)", () => {
  expect(SUBMISSION_ACTION_TYPES).toHaveLength(8);
  expect(SUBMISSION_ACTION_TYPES).toContain("register_agent");
});

test("rate limit: a burst from one ip yields 429 after the cap", async () => {
  const ip = `10.14.7.${Math.floor(Math.random() * 250)}-${crypto.randomUUID().slice(0, 4)}`;
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) {
    codes.push(
      (await createSubmission({ actionType: "general", submitterHandle: rid("h"), summary: "x" }, ip)).status,
    );
  }
  expect(codes.filter((c) => c === 201).length).toBe(5);
  expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
});
