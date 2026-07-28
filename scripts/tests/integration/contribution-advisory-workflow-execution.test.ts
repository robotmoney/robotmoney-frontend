/**
 * Executes contribution-advisory-reviewer.yml's real `run:` bash (issue #230)
 * against a stubbed `gh`, instead of only Bun.YAML.parse-ing and string-
 * asserting it (see the sibling contribution-advisory-workflow.test.ts,
 * which is left unweakened). A broken pagination/draft-state-selection,
 * reviewed-head-SHA skip, or PATCH-vs-POST upsert branch now fails this
 * suite loudly.
 *
 * The bash itself is never duplicated here: `runAdvisoryWorkflowScript`
 * extracts it verbatim from the workflow YAML and runs it under `bash -c`
 * with a fake `gh` (and fake OpenCode CLI) resolved via PATH, so there is no
 * risk of the test drifting from the workflow's actual behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdvisoryWorkflowScript } from "../../lib/contribution-advisory-workflow-runner.ts";

const REPOSITORY = "robotmoney/robotmoney-frontend";
const MARKER = "<!-- robotmoney-contribution-advisory-reviewer -->";

interface PrMetadataFixture {
  state: string;
  draft: boolean;
  head: { sha: string };
}

interface CommentFixture {
  id: number;
  user: { login: string };
  body: string;
}

interface AdvisoryGhWorld {
  openPulls?: Array<{ number: number; draft: boolean }>;
  prMetadata?: Record<string, PrMetadataFixture>;
  comments?: Record<string, CommentFixture[]>;
  diffs?: Record<string, string>;
}

interface GhCall {
  method: string;
  path: string;
  body?: { body?: string };
  commentId?: number;
  prNumber?: number;
}

// A bun-executable stand-in for the real `gh` CLI. It never touches the
// network: it answers `gh api` calls out of a JSON "world" fixture (path in
// ADVISORY_GH_WORLD) and appends every call it receives to a JSONL call log
// (path in ADVISORY_GH_CALL_LOG) so tests can assert on PATCH-vs-POST and on
// which PR numbers were ever looked up.
const FAKE_GH_SOURCE = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "api") {
  console.error(\`fake gh stub: unsupported subcommand '\${args[0]}'\`);
  process.exit(1);
}

const rest = args.slice(1);
let header;
let jqFilter;
let method = "GET";
let readStdin = false;
let path;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "-H") header = rest[++i];
  else if (a === "--jq") jqFilter = rest[++i];
  else if (a === "--method") method = rest[++i];
  else if (a === "--input") readStdin = rest[++i] === "-";
  else if (a !== "--paginate" && !a.startsWith("-")) path = a;
}

const worldPath = process.env.ADVISORY_GH_WORLD;
const callLogPath = process.env.ADVISORY_GH_CALL_LOG;
if (!worldPath || !callLogPath) {
  console.error("fake gh stub: ADVISORY_GH_WORLD / ADVISORY_GH_CALL_LOG not set");
  process.exit(1);
}
const world = JSON.parse(readFileSync(worldPath, "utf8"));

function logCall(entry) {
  appendFileSync(callLogPath, JSON.stringify(entry) + "\\n");
}

function runJq(filter, data) {
  const proc = Bun.spawnSync(["jq", "-r", filter ?? "."], {
    stdin: Buffer.from(JSON.stringify(data)),
  });
  if (proc.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(proc.stderr));
    process.exit(proc.exitCode ?? 1);
  }
  return new TextDecoder().decode(proc.stdout);
}

async function main() {
  if (!path) {
    console.error("fake gh stub: missing API path");
    process.exit(1);
  }

  if (method === "PATCH" || method === "POST") {
    const bodyText = readStdin ? await new Response(Bun.stdin.stream()).text() : "";
    const patchMatch = path.match(/issues\\/comments\\/(\\d+)$/);
    const postMatch = path.match(/issues\\/(\\d+)\\/comments$/);
    logCall({
      method,
      path,
      body: bodyText ? JSON.parse(bodyText) : undefined,
      commentId: patchMatch ? Number(patchMatch[1]) : undefined,
      prNumber: postMatch ? Number(postMatch[1]) : undefined,
    });
    process.stdout.write("{}");
    return;
  }

  logCall({ method: "GET", path });

  const commentsMatch = path.match(/issues\\/(\\d+)\\/comments\\?/);
  if (commentsMatch) {
    const comments = (world.comments ?? {})[commentsMatch[1]] ?? [];
    process.stdout.write(runJq(jqFilter, comments));
    return;
  }

  if (path.includes("/pulls?")) {
    process.stdout.write(runJq(jqFilter, world.openPulls ?? []));
    return;
  }

  const prMatch = path.match(/pulls\\/(\\d+)$/);
  if (prMatch) {
    const prNumber = prMatch[1];
    if (header === "Accept: application/vnd.github.diff") {
      process.stdout.write((world.diffs ?? {})[prNumber] ?? "diff --git a/f.txt b/f.txt\\n");
      return;
    }
    const metadata = (world.prMetadata ?? {})[prNumber];
    if (!metadata) {
      console.error(\`fake gh stub: no prMetadata fixture for PR #\${prNumber}\`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(metadata));
    return;
  }

  console.error(\`fake gh stub: unhandled path '\${path}'\`);
  process.exit(1);
}

await main();
`;

// A bun-executable stand-in for the OpenCode CLI. It ignores the prompt
// entirely and always returns the clean-review sentinel — these tests exist
// to exercise PR-selection/skip/upsert bash, not the reviewer model call
// (that is scripts/tests/unit/contribution-advisory-reviewer.test.ts's job).
const FAKE_OPENCODE_SOURCE = `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "step_start", part: {} }));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "No contribution-governance concerns." } }));
`;

let workDir = "";
let ghStubDir = "";
let worldPath = "";
let callLogPath = "";
let opencodeBin = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "advisory-workflow-exec-"));
  ghStubDir = join(workDir, "gh-stub");
  await mkdir(ghStubDir, { recursive: true });
  await writeFile(join(ghStubDir, "gh"), FAKE_GH_SOURCE);
  await chmod(join(ghStubDir, "gh"), 0o755);

  opencodeBin = join(workDir, "opencode");
  await writeFile(opencodeBin, FAKE_OPENCODE_SOURCE);
  await chmod(opencodeBin, 0o755);

  worldPath = join(workDir, "world.json");
  callLogPath = join(workDir, "calls.jsonl");
  await writeFile(callLogPath, "");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeWorld(world: AdvisoryGhWorld): Promise<void> {
  await writeFile(worldPath, JSON.stringify(world));
}

async function readCalls(): Promise<GhCall[]> {
  const text = await readFile(callLogPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GhCall);
}

function run(eventName: "schedule" | "workflow_dispatch", manualPrNumber?: string) {
  return runAdvisoryWorkflowScript({
    eventName,
    repository: REPOSITORY,
    manualPrNumber,
    ghStubDir,
    opencodeBin,
    runnerTemp: workDir,
    extraEnv: { ADVISORY_GH_WORLD: worldPath, ADVISORY_GH_CALL_LOG: callLogPath },
  });
}

describe("contribution advisory workflow bash execution (issue #230)", () => {
  test("schedule run selects only the open, non-draft PR and posts a new comment", async () => {
    await writeWorld({
      openPulls: [
        { number: 501, draft: false },
        { number: 502, draft: true },
      ],
      prMetadata: {
        "501": { state: "open", draft: false, head: { sha: "sha-501" } },
      },
      comments: {},
    });

    const result = await run("schedule");
    expect(result.exitCode).toBe(0);

    const calls = await readCalls();
    // The draft PR must never be looked up at all: selection happens before
    // any per-PR metadata/comment/diff/upsert call.
    expect(calls.some((c) => c.path.includes("pulls/502"))).toBe(false);
    expect(calls.some((c) => c.path.includes("pulls/501") && c.method === "GET")).toBe(true);

    const upserts = calls.filter((c) => c.method === "POST" || c.method === "PATCH");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].method).toBe("POST");
    expect(upserts[0].prNumber).toBe(501);
    expect(upserts[0].body?.body).toContain(MARKER);
    expect(upserts[0].body?.body).toContain("reviewed-head: sha-501");
  });

  test("workflow_dispatch rejects a draft PR number", async () => {
    await writeWorld({
      prMetadata: {
        "77": { state: "open", draft: true, head: { sha: "sha-77" } },
      },
    });

    const result = await run("workflow_dispatch", "77");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("PR #77 is not open and ready for review");

    const calls = await readCalls();
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
  });

  test("workflow_dispatch rejects a closed PR number", async () => {
    await writeWorld({
      prMetadata: {
        "78": { state: "closed", draft: false, head: { sha: "sha-78" } },
      },
    });

    const result = await run("workflow_dispatch", "78");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("PR #78 is not open and ready for review");

    const calls = await readCalls();
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
  });

  test("workflow_dispatch accepts an open, non-draft PR number and upserts", async () => {
    await writeWorld({
      prMetadata: {
        "79": { state: "open", draft: false, head: { sha: "sha-79" } },
      },
      comments: {},
    });

    const result = await run("workflow_dispatch", "79");
    expect(result.exitCode).toBe(0);

    const upserts = (await readCalls()).filter((c) => c.method === "POST" || c.method === "PATCH");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].method).toBe("POST");
    expect(upserts[0].prNumber).toBe(79);
  });

  test("schedule run skips a PR already reviewed at the current head SHA", async () => {
    await writeWorld({
      openPulls: [{ number: 601, draft: false }],
      prMetadata: {
        "601": { state: "open", draft: false, head: { sha: "sha-601-current" } },
      },
      comments: {
        "601": [
          {
            id: 9001,
            user: { login: "github-actions[bot]" },
            body: `previous review\n\n${MARKER}\n<!-- reviewed-head: sha-601-current -->\n`,
          },
        ],
      },
    });

    const result = await run("schedule");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR #601 already reviewed at sha-601-current; skipping");

    const calls = await readCalls();
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
    // Skipping happens before the diff is ever fetched.
    expect(calls.some((c) => c.path === `repos/${REPOSITORY}/pulls/601` && c.method === "GET")).toBe(true);
  });

  test("workflow_dispatch does not skip even when a matching reviewed-head comment exists", async () => {
    await writeWorld({
      prMetadata: {
        "602": { state: "open", draft: false, head: { sha: "sha-602-current" } },
      },
      comments: {
        "602": [
          {
            id: 9002,
            user: { login: "github-actions[bot]" },
            body: `previous review\n\n${MARKER}\n<!-- reviewed-head: sha-602-current -->\n`,
          },
        ],
      },
    });

    const result = await run("workflow_dispatch", "602");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("skipping");

    const upserts = (await readCalls()).filter((c) => c.method === "POST" || c.method === "PATCH");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].method).toBe("PATCH");
    expect(upserts[0].commentId).toBe(9002);
  });

  test("schedule run does not skip a PR once its head SHA has changed, and PATCHes the prior comment", async () => {
    await writeWorld({
      openPulls: [{ number: 603, draft: false }],
      prMetadata: {
        "603": { state: "open", draft: false, head: { sha: "sha-603-new" } },
      },
      comments: {
        "603": [
          {
            id: 9003,
            user: { login: "github-actions[bot]" },
            body: `previous review\n\n${MARKER}\n<!-- reviewed-head: sha-603-old -->\n`,
          },
        ],
      },
    });

    const result = await run("schedule");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("skipping");

    const upserts = (await readCalls()).filter((c) => c.method === "POST" || c.method === "PATCH");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].method).toBe("PATCH");
    expect(upserts[0].commentId).toBe(9003);
    expect(upserts[0].body?.body).toContain("reviewed-head: sha-603-new");
  });
});
