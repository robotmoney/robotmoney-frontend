const BACKEND = "http://fixture-backend:8787";
const MEMBER_ID = "fixture-agent";
const IDENTITY = "/tmp/fixture-agent-identity.json";
const PASSPHRASE = "fixture-agent-passphrase-2026";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface CliResult {
  text: string;
  tools: string[];
  stdout: string;
}

async function runOpenCode(name: string, prompt: string, memberToken: string): Promise<CliResult> {
  const process = Bun.spawn([
    "opencode",
    "run",
    "--model", "opencode/big-pickle",
    "--format", "json",
    "--dangerously-skip-permissions",
    "--title", `committee-tools-${name}`,
    "--dir", "/app",
    prompt,
  ], {
    cwd: "/app",
    env: {
      ...Bun.env,
      ROBOTMONEY_MEMBER_TOKEN: memberToken,
      RMPC_COMMITTEE_IDENTITY_PASSPHRASE: PASSPHRASE,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      process.kill();
      reject(new Error(`${name}: opencode run timed out after 150 seconds`));
    }, 150_000);
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  invariant(exitCode === 0, `${name}: opencode run exited ${exitCode}: ${stderr.slice(0, 3000)}`);

  const events = stdout.split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  }) as Array<{ type?: string; part?: { type?: string; text?: string; tool?: string } }>;
  return {
    text: events.filter((event) => event.type === "text").map((event) => event.part?.text ?? "").join("\n").trim(),
    tools: [...new Set(events.map((event) => event.part?.tool).filter((tool): tool is string => Boolean(tool)))],
    stdout,
  };
}

async function observed() {
  return await fetch(`${BACKEND}/__observed`).then((response) => response.json()) as {
    apply: number;
    activate: number;
    verifyToken: number;
    openSession: number;
    regime: number;
    brief: number;
    memo: number;
    submit: number;
    verifiedSubmissions: number;
    publicKey: string;
    memos: Array<{ sessionId?: string; body?: string }>;
    submissions: Array<Record<string, unknown>>;
    application: string;
  };
}

function requireTools(name: string, actual: string[], expected: string[]) {
  for (const tool of expected) {
    invariant(actual.includes(tool), `${name}: OpenCode did not call ${tool}; observed tools: ${actual.join(", ")}`);
  }
}

async function setScenario(input: {
  sessionId: string;
  date: string;
  subjectId: string;
  composite: number;
  evidence: string;
}) {
  const response = await fetch(`${BACKEND}/__scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  invariant(response.ok, `failed to configure fixture scenario: ${await response.text()}`);
}

// Scenario 1: a prospective member owns identity creation and application, then
// stops at the real human/admin boundary instead of assuming activation.
const onboarding = await runOpenCode("onboarding-pending", [
  "You are a prospective Robot Money Investment Committee member.",
  "Use bash for this onboarding flow. Do not call any robotmoney MCP tool yet.",
  `Create an identity exactly once with: rmpc committee-identity --path ${IDENTITY} create`,
  "Read public_key from that JSON output.",
  `POST JSON to ${BACKEND}/api/committee/apply with memberId ${MEMBER_ID}, name Fixture Agent, lens external-harness, and that publicKey.`,
  "Confirm the HTTP response says pending. Do not activate yourself.",
  "Finish with the exact text ONBOARDING_PENDING.",
].join("\n"), "not-active-yet");
invariant(onboarding.text.includes("ONBOARDING_PENDING"), `onboarding did not stop pending: ${onboarding.text}`);
requireTools("onboarding", onboarding.tools, ["bash"]);

let state = await observed();
invariant(state.apply === 1, `onboarding expected one application, got ${state.apply}`);
invariant(state.application === "pending", `onboarding did not remain pending: ${state.application}`);
invariant(state.publicKey.length > 40, "onboarding did not submit the rmpc public key");
invariant(state.regime === 0 && state.brief === 0 && state.memo === 0, "pending applicant used committee MCP tools");

// The host performs the administrative handoff between independent CLI runs.
const activation = await fetch(`${BACKEND}/api/committee/admin/activate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ memberId: MEMBER_ID }),
}).then((response) => response.json()) as { token?: string };
invariant(activation.token, "activation did not return a member token");

async function participate(input: {
  name: string;
  sessionId: string;
  date: string;
  subjectId: string;
  composite: number;
  evidence: string;
  nonce: string;
  stance: string;
  confidence: number;
  expectedOrdinal: number;
}) {
  await setScenario(input);
  const reportBody = `MCP report composite ${input.composite.toFixed(3)} evidence ${input.evidence}`;
  const result = await runOpenCode(input.name, [
    "You are now an active Robot Money Investment Committee member.",
    "Use the robotmoney MCP tools and the existing rmpc identity. Do not create or replace the identity.",
    "Perform these steps sequentially; do not skip any step:",
    "1. Call robotmoney_get_open_session and confirm its date and subject.",
    "2. Call robotmoney_get_regime.",
    `3. Call robotmoney_get_brief with date ${input.date} and subject ${input.subjectId}.`,
    `4. Call robotmoney_post_memo with sessionId ${input.sessionId}, title Fixture report, and body exactly: ${reportBody}`,
    "5. Call robotmoney_get_signing_payload using the exact draft fields below and the memoUrl returned by post_memo.",
    `   memberId=${MEMBER_ID} date=${input.date} subjectId=${input.subjectId} nonce=${input.nonce} stance=${input.stance} confidence=${input.confidence} body=${reportBody}`,
    `6. Use bash to sign the exact canonical string returned by get_signing_payload with: rmpc committee-identity --path ${IDENTITY} sign --payload '<canonical>'`,
    "7. Read signature from the rmpc JSON and call robotmoney_submit_recommendation with the exact same draft fields, memoUrl, and signature.",
    `After the verified submission succeeds, finish with the exact text ${input.name.toUpperCase().replaceAll("-", "_")}_OK.`,
  ].join("\n"), activation.token);

  requireTools(input.name, result.tools, [
    "robotmoney_get_open_session",
    "robotmoney_get_regime",
    "robotmoney_get_brief",
    "robotmoney_post_memo",
    "robotmoney_get_signing_payload",
    "bash",
    "robotmoney_submit_recommendation",
  ]);
  invariant(result.text.includes(`${input.name.toUpperCase().replaceAll("-", "_")}_OK`),
    `${input.name}: unexpected final response: ${result.text || result.stdout.slice(0, 3000)}`);

  const after = await observed();
  invariant(after.openSession === input.expectedOrdinal, `${input.name}: wrong open-session count ${after.openSession}`);
  invariant(after.regime === input.expectedOrdinal, `${input.name}: wrong regime count ${after.regime}`);
  invariant(after.brief === input.expectedOrdinal, `${input.name}: wrong brief count ${after.brief}`);
  invariant(after.memo === input.expectedOrdinal, `${input.name}: wrong memo count ${after.memo}`);
  invariant(after.submit === input.expectedOrdinal, `${input.name}: wrong submit count ${after.submit}`);
  invariant(after.verifiedSubmissions === input.expectedOrdinal,
    `${input.name}: signature was not independently verified`);
  const memo = after.memos.at(-1)?.body ?? "";
  invariant(memo.includes(input.composite.toFixed(3)) && memo.includes(input.evidence),
    `${input.name}: memo did not carry MCP fixture evidence`);
}

// Scenario 2: first participation after activation.
await participate({
  name: "first-participation",
  sessionId: "fixture-first-session",
  date: "2026-07-14",
  subjectId: "fixture-treasury",
  composite: 0.731,
  evidence: "FIXTURE_FIRST_EVIDENCE_731",
  nonce: "fixture-first-nonce",
  stance: "constructive",
  confidence: 0.73,
  expectedOrdinal: 1,
});

// Scenario 3: a later session reuses the same identity and credentials.
await participate({
  name: "steady-state",
  sessionId: "fixture-steady-session",
  date: "2026-07-15",
  subjectId: "fixture-vault",
  composite: 0.684,
  evidence: "FIXTURE_STEADY_EVIDENCE_684",
  nonce: "fixture-steady-nonce",
  stance: "neutral",
  confidence: 0.61,
  expectedOrdinal: 2,
});

state = await observed();
invariant(state.apply === 1 && state.activate === 1, "steady state repeated onboarding or activation");
invariant(state.verifiedSubmissions === 2, "expected two independently verified submissions");

console.log(JSON.stringify({
  ok: true,
  cli: "opencode run",
  workaround: "git init (issue #131)",
  scenarios: ["onboarding-pending", "first-participation", "steady-state"],
  verifiedSubmissions: state.verifiedSubmissions,
}));
