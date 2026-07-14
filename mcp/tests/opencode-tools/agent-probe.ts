const BACKEND = "http://fixture-backend:8787";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const registered = await fetch(`${BACKEND}/api/committee/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ memberId: "fixture-agent", name: "Fixture Agent", publicKey: "fixture-public-key" }),
}).then((response) => response.json()) as { token?: string };
invariant(registered.token, "fixture registration returned no member token");

const prompt = [
  "Act as an external Robot Money Investment Committee agent.",
  "Use the robotmoney MCP tools for every fact; do not use shell, files, or prior knowledge.",
  "First call robotmoney_get_regime.",
  "Then call robotmoney_get_brief with date 2026-07-14 and subject fixture-treasury.",
  "Then call robotmoney_post_memo with sessionId fixture-session and a report body that includes both the exact composite 0.731 and exact evidence string FIXTURE_MCP_EVIDENCE_731.",
  "After all three tool calls succeed, reply with exactly TOOLS_OK.",
].join("\n");

const process = Bun.spawn([
  "opencode",
  "run",
  "--model", "opencode/big-pickle",
  "--format", "json",
  "--dangerously-skip-permissions",
  "--dir", "/app",
  prompt,
], {
  cwd: "/app",
  env: { ...Bun.env, ROBOTMONEY_MEMBER_TOKEN: registered.token },
  stdout: "pipe",
  stderr: "pipe",
});

let timer: ReturnType<typeof setTimeout> | undefined;
const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(() => {
    process.kill();
    reject(new Error("opencode run timed out after 120 seconds"));
  }, 120_000);
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

invariant(exitCode === 0, `opencode run exited ${exitCode}: ${stderr.slice(0, 2000)}`);

const events = stdout.split("\n").flatMap((line) => {
  try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
}) as Array<{ type?: string; part?: { type?: string; text?: string; tool?: string } }>;
const assistantText = events
  .filter((event) => event.type === "text")
  .map((event) => event.part?.text ?? "")
  .join("\n")
  .trim();

const observed = await fetch(`${BACKEND}/__observed`).then((result) => result.json()) as {
  register: number;
  verifyToken: number;
  regime: number;
  brief: number;
  memo: number;
  memoBody: string;
};

invariant(observed.register === 1, `expected one registration, got ${observed.register}`);
invariant(observed.verifyToken > 0, "OpenCode CLI did not authenticate to the MCP server");
invariant(observed.regime === 1, `OpenCode CLI did not call get_regime exactly once: ${observed.regime}`);
invariant(observed.brief === 1, `OpenCode CLI did not call get_brief exactly once: ${observed.brief}`);
invariant(observed.memo === 1, `OpenCode CLI did not call post_memo exactly once: ${observed.memo}`);
invariant(observed.memoBody.includes("0.731"), "posted memo omitted the get_regime fixture value");
invariant(observed.memoBody.includes("FIXTURE_MCP_EVIDENCE_731"), "posted memo omitted the get_brief fixture evidence");
invariant(assistantText === "TOOLS_OK", `unexpected OpenCode CLI response: ${assistantText || stdout.slice(0, 2000)}`);

console.log(JSON.stringify({
  ok: true,
  cli: "opencode run",
  workaround: "git init",
  tools: { get_regime: observed.regime, get_brief: observed.brief, post_memo: observed.memo },
}));
