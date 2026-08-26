// `bun run smoke:stage` decides two flags and then runs the ordinary smoke
// (scripts/smoke-stage.ts). Both branches are pinned here because the wrapper is
// the ONE place in this repo allowed to infer a data path, and an inference that
// silently picks the wrong one is worse than no wrapper at all: choosing
// `ephemeral` when a managed database is configured throws the boot's work away,
// and choosing `external` when it is not would fail loudly at migrate time.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStageArgs, STATIC_PORT_FLAG } from "../../smoke-stage.ts";

function envFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-smoke-stage-"));
  const path = join(dir, ".env");
  if (contents !== null) writeFileSync(path, contents);
  return path; // when contents is null the file does not exist
}

const DB_URL = "DATABASE_URL=postgres://u:p@db.example.com:25060/appdb?sslmode=require\n";

describe("planStageArgs — the port pin is unconditional", () => {
  test("always passes --static-port, whichever data path is chosen", () => {
    expect(planStageArgs(envFile(DB_URL)).args).toContain(STATIC_PORT_FLAG);
    expect(planStageArgs(envFile(null)).args).toContain(STATIC_PORT_FLAG);
  });

  test("passing --static-port explicitly does not duplicate it", () => {
    const args = planStageArgs(envFile(null), [STATIC_PORT_FLAG]).args;
    expect(args.filter((a) => a === STATIC_PORT_FLAG).length).toBe(1);
  });
});

describe("planStageArgs — the data path follows .env", () => {
  test("a DATABASE_URL in .env selects the external database", () => {
    const plan = planStageArgs(envFile(DB_URL));
    expect(plan.dataPath).toBe("external");
    expect(plan.args).toContain("--db");
    expect(plan.args).toContain("external");
    expect(plan.target).toContain("db.example.com");
    expect(plan.target).not.toContain(":p@"); // redacted, never the password
  });

  test("a pasted DigitalOcean connection panel also selects it", () => {
    const plan = planStageArgs(envFile(
      "username = doadmin\npassword = s3cret\nhost = db.example.com\nport = 25060\ndatabase = defaultdb\n",
    ));
    expect(plan.dataPath).toBe("external");
    expect(plan.target).not.toContain("s3cret");
  });

  test("NO .env at all falls back to the ephemeral container rather than failing", () => {
    const plan = planStageArgs(envFile(null));
    expect(plan.dataPath).toBe("ephemeral");
    expect(plan.args).not.toContain("--external-pg");
  });

  test("an .env with no database (only unrelated keys) falls back too", () => {
    const plan = planStageArgs(envFile("OPENCODE_API_KEY=sk-test\nRM_ENV=smoke\n"));
    expect(plan.dataPath).toBe("ephemeral");
    expect(plan.args).not.toContain("--external-pg");
  });

  test("an UNUSABLE database entry falls back instead of throwing", () => {
    // resolveExternalPg rejects localhost (inside a container that is the
    // container itself). Asked to CHOOSE rather than told, the wrapper must
    // treat that as "no usable database" and boot the ephemeral one — a probe
    // must never turn a bad .env line into a failed boot.
    const plan = planStageArgs(envFile("DATABASE_URL=postgres://u:p@localhost:5432/x\n"));
    expect(plan.dataPath).toBe("ephemeral");
  });

  test("half a connection panel is not enough to select external", () => {
    const plan = planStageArgs(envFile("host = db.example.com\nport = 25060\n"));
    expect(plan.dataPath).toBe("ephemeral");
  });
});

describe("planStageArgs — operator passthrough", () => {
  test("extra flags are forwarded in order, after the decided ones", () => {
    const plan = planStageArgs(envFile(DB_URL), ["--no-tui"]);
    expect(plan.args).toEqual([STATIC_PORT_FLAG, "--db", "external", "--no-tui"]);
  });

  test("an operator's own --db external is not doubled up", () => {
    const plan = planStageArgs(envFile(DB_URL), ["--db", "external"]);
    expect(plan.args.filter((a) => a === "--db").length).toBe(1);
  });

  test("the deprecated --external-pg spelling still suppresses the emitted one", () => {
    // The wrapper must not turn one operator-stated data path into two
    // conflicting flags; smoke-main then prints the deprecation notice once.
    const plan = planStageArgs(envFile(DB_URL), ["--external-pg"]);
    expect(plan.args).toEqual([STATIC_PORT_FLAG, "--external-pg"]);
  });

  test("an operator's --db smoke-twin is never overridden by what .env happens to hold", () => {
    const plan = planStageArgs(envFile(DB_URL), ["--smoke", "--db", "smoke-twin"]);
    expect(plan.args).toEqual([STATIC_PORT_FLAG, "--smoke", "--db", "smoke-twin"]);
  });

  test("an operator may force --external-pg even when .env has nothing usable", () => {
    // The smoke itself then fails loudly with the reason, which is the correct
    // outcome for an explicit request that cannot be honoured.
    const plan = planStageArgs(envFile(null), ["--external-pg"]);
    expect(plan.args).toContain("--external-pg");
    expect(plan.dataPath).toBe("ephemeral"); // what .env said; the flag still goes through
  });
});
