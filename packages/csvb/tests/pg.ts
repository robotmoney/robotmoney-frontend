// An ephemeral Postgres in Docker for the tests. The container is named and labelled, and the helper removes
// exactly the container it started.
import postgres from "postgres";

export interface TestPg {
  sql: postgres.Sql<{}>;
  url: string;
  stop: () => Promise<void>;
}

const run = (args: string[]): { out: string; code: number } => {
  const p = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString().trim(), code: p.exitCode ?? 1 };
};

export async function startPg(): Promise<TestPg> {
  const name = `csvb_test_${crypto.randomUUID().slice(0, 8)}`;
  const r = run(["run", "-d", "--name", name, "--label", "csv-backups-test=1", "-e", "POSTGRES_PASSWORD=pw", "-p", "127.0.0.1::5432", "postgres:18"]);
  if (r.code !== 0) throw new Error(`could not start Postgres in Docker: ${r.out}`);
  const port = run(["port", name, "5432/tcp"]).out.split("\n")[0]!.split(":").pop()!;
  const url = `postgres://postgres:pw@127.0.0.1:${port}/postgres`;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const t0 = Date.now();
  for (;;) {
    try {
      await sql`SELECT 1`;
      break;
    } catch (e) {
      if (Date.now() - t0 > 60_000) {
        run(["rm", "-f", name]);
        throw new Error(`Postgres did not come up: ${(e as Error).message}`);
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
  }
  return {
    sql,
    url,
    stop: async () => {
      await sql.end({ timeout: 2 }).catch(() => {});
      run(["rm", "-f", name]);
    },
  };
}
