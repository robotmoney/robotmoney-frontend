// Unit tests for the `--external-pg` resolver (scripts/lib/demo-external-pg.ts).
// Imported from scripts/demo.ts — the `bun run demo` entrypoint re-exports the
// resolver and only triggers the side-effectful bring-up under
// `import.meta.main`, so this import is safe and proves the tested resolver is
// exactly the one the demo consumes (same arrangement as demo-env.test.ts).
//
// Contract under test:
//   - OFF unless the flag is passed. No env var can turn it on.
//   - ON, the connection details come from the `.env` FILE: DATABASE_URL wins;
//     otherwise the discrete keys DigitalOcean's connection panel prints are
//     assembled into one URL.
//   - Every failure is LOUD (throws with an actionable message) — never a
//     silent fall back to the ephemeral container, which would look healthy
//     while writing to a database nobody asked for.
//   - The generated overlay removes the postgres service, the pgdata volume,
//     and every `depends_on: postgres` edge.
//   - No printed or recorded form ever carries the password.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  externalPgOverlayYaml,
  parseEnvFile,
  redactPostgresUrl,
  resolveExternalPg,
  urlFromDiscreteKeys,
} from "../../demo.ts";

function envFileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-external-pg-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

// The exact shape DigitalOcean's "Connection details" panel produces, spaces
// and all — this is what an operator actually pastes into `.env`.
const DO_PANEL = [
  "# postgres",
  "username = doadmin",
  "password = hunter2secret",
  "host = private-db-do-user-1-0.g.db.ondigitalocean.com",
  "port = 25060",
  "database = defaultdb",
  "sslmode = require",
].join("\n");

describe("resolveExternalPg — off unless the flag is passed", () => {
  test("no flag → disabled, and nothing else is resolved", () => {
    const path = envFileWith(`DATABASE_URL=postgres://u:p@db.example.com:25060/x\n`);
    const r = resolveExternalPg(["bun", "demo.ts"], { envFilePath: path });
    expect(r.enabled).toBe(false);
    expect(r.url).toBeUndefined();
  });

  test("the flag is the ONLY switch — a DATABASE_URL in .env alone changes nothing", () => {
    const path = envFileWith(`DATABASE_URL=postgres://u:p@db.example.com:25060/x\n`);
    expect(resolveExternalPg(["bun", "demo.ts", "--stage"], { envFilePath: path }).enabled).toBe(false);
  });
});

describe("resolveExternalPg — where the connection details come from", () => {
  test("DATABASE_URL in .env wins", () => {
    const path = envFileWith(`DATABASE_URL=postgres://u:p@db.example.com:25060/appdb?sslmode=require\n${DO_PANEL}\n`);
    const r = resolveExternalPg(["--external-pg"], { envFilePath: path });
    expect(r.enabled).toBe(true);
    expect(r.url).toBe("postgres://u:p@db.example.com:25060/appdb?sslmode=require");
    expect(r.host).toBe("db.example.com");
    expect(r.source).toBe("DATABASE_URL");
  });

  test("a pasted DigitalOcean connection panel is assembled into one URL", () => {
    const path = envFileWith(DO_PANEL);
    const r = resolveExternalPg(["--external-pg"], { envFilePath: path });
    expect(r.enabled).toBe(true);
    expect(r.source).toBe("discrete keys");
    const u = new URL(r.url!);
    expect(u.hostname).toBe("private-db-do-user-1-0.g.db.ondigitalocean.com");
    expect(u.port).toBe("25060");
    expect(u.username).toBe("doadmin");
    expect(u.password).toBe("hunter2secret");
    expect(u.pathname).toBe("/defaultdb");
    expect(u.searchParams.get("sslmode")).toBe("require");
  });

  test("a half-specified panel is an error, not a defaulted URL", () => {
    const path = envFileWith("host = db.example.com\nport = 25060\n"); // no user/password/database
    expect(() => resolveExternalPg(["--external-pg"], { envFilePath: path })).toThrow(/no DATABASE_URL/);
  });
});

describe("resolveExternalPg — every failure is loud", () => {
  test("missing .env throws and names the flag and the file", () => {
    expect(() => resolveExternalPg(["--external-pg"], { envFilePath: "/nonexistent/.env" })).toThrow(
      /no readable \.env/,
    );
  });

  test("a non-postgres scheme is rejected", () => {
    const path = envFileWith("DATABASE_URL=mysql://u:p@db.example.com:3306/x\n");
    expect(() => resolveExternalPg(["--external-pg"], { envFilePath: path })).toThrow(/must start with postgres/);
  });

  test('host "postgres" is rejected — that IS the service this flag replaces', () => {
    const path = envFileWith("DATABASE_URL=postgres://u:p@postgres:5432/x\n");
    expect(() => resolveExternalPg(["--external-pg"], { envFilePath: path })).toThrow(/ephemeral/);
  });

  test.each(["localhost", "127.0.0.1"])("host %s is rejected — inside a container that is the container", (host) => {
    const path = envFileWith(`DATABASE_URL=postgres://u:p@${host}:5432/x\n`);
    expect(() => resolveExternalPg(["--external-pg"], { envFilePath: path })).toThrow(/CONTAINER/);
  });
});

describe("no printed or recorded form carries the password", () => {
  test("redactPostgresUrl removes it and keeps everything else", () => {
    const red = redactPostgresUrl("postgres://doadmin:hunter2secret@db.example.com:25060/defaultdb?sslmode=require");
    expect(red).not.toContain("hunter2secret");
    expect(red).toContain("doadmin");
    expect(red).toContain("db.example.com");
    expect(red).toContain("sslmode=require");
  });

  test("the resolution's redactedUrl is safe even though its url is not", () => {
    const path = envFileWith(DO_PANEL);
    const r = resolveExternalPg(["--external-pg"], { envFilePath: path });
    expect(r.url).toContain("hunter2secret");
    expect(r.redactedUrl).not.toContain("hunter2secret");
  });

  test("the generated overlay embeds only the redacted target", () => {
    const yaml = externalPgOverlayYaml(
      redactPostgresUrl("postgres://doadmin:hunter2secret@db.example.com:25060/defaultdb"),
    );
    expect(yaml).not.toContain("hunter2secret");
  });
});

describe("externalPgOverlayYaml — removes the container, the volume and the edges", () => {
  const yaml = externalPgOverlayYaml("postgres://doadmin:***@db.example.com:25060/defaultdb");

  test("the postgres service and the pgdata volume are reset away", () => {
    expect(yaml).toContain("  postgres: !reset null");
    expect(yaml).toContain("  pgdata: !reset null");
  });

  test.each(["api", "worker-swarm", "worker-analytics", "worker-research"])(
    "%s loses its depends_on so compose cannot pull postgres back in",
    (service) => {
      expect(yaml).toContain(`  ${service}:\n    depends_on: !reset null`);
    },
  );
});

describe("parseEnvFile / urlFromDiscreteKeys", () => {
  test("handles the spacing, comments, quotes and export prefixes a real .env carries", () => {
    const parsed = parseEnvFile(
      ["# comment", "  ", "username = doadmin", 'export TOKEN="quoted value"', "empty=", "novalue"].join("\n"),
    );
    expect(parsed.username).toBe("doadmin");
    expect(parsed.TOKEN).toBe("quoted value");
    expect(parsed.empty).toBe("");
    expect("novalue" in parsed).toBe(false);
  });

  test("a value containing '=' survives (passwords routinely do)", () => {
    expect(parseEnvFile("password = ab=cd==").password).toBe("ab=cd==");
  });

  test("credentials needing escaping are encoded rather than corrupting the URL", () => {
    const url = urlFromDiscreteKeys({
      host: "db.example.com",
      port: "25060",
      database: "defaultdb",
      username: "doadmin",
      password: "p@ss/word?",
    })!;
    const u = new URL(url);
    expect(u.hostname).toBe("db.example.com");
    expect(u.password).toBe(encodeURIComponent("p@ss/word?"));
    expect(u.pathname).toBe("/defaultdb");
  });

  test("port defaults to 5432 when the panel omits it", () => {
    const url = urlFromDiscreteKeys({ host: "db.example.com", database: "d", username: "u", password: "p" })!;
    expect(new URL(url).port).toBe("5432");
  });
});
