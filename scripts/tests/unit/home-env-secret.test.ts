// scripts/lib/home-env-secret.ts: the atomic `~/.env` line write behind
// `prod-init role-passwords`' set and rotate paths (D61).
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envLineKey, withEnvLine, writeEnvSecret } from "../../lib/home-env-secret.ts";
import { parseEnvFile } from "../../lib/env-role.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function envFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-home-env-"));
  dirs.push(dir);
  const path = join(dir, ".env");
  writeFileSync(path, text, { mode: 0o644 });
  return path;
}

const PANEL = "# DigitalOcean panel\nhost = db.example\n  port=25060\n\nexport database = defaultdb\nsslmode = \"require\"\nrm_readonly = ro\ndoadmin = da\n";

describe("withEnvLine", () => {
  test("appends a missing line and keeps every other line byte for byte, in order", () => {
    const { text, previousLine } = withEnvLine(PANEL, "rm_owner", "abc_DEF-123");
    expect(previousLine).toBeUndefined();
    expect(text).toBe(`${PANEL}rm_owner = abc_DEF-123\n`);
    expect(parseEnvFile(text)).toMatchObject({ host: "db.example", port: "25060", database: "defaultdb", sslmode: "require", rm_owner: "abc_DEF-123" });
  });

  test("a file with no trailing newline gets one before the new line", () => {
    expect(withEnvLine("host = h", "rm_owner", "x").text).toBe("host = h\nrm_owner = x\n");
  });

  test("replaces the first line of the key in place and drops later duplicates, so the parsed value is the new one", () => {
    const { text, previousLine } = withEnvLine("a = 1\nrm_owner = old\nb = 2\nexport rm_owner=older\n", "rm_owner", "new");
    expect(previousLine).toBe("rm_owner = old");
    expect(text).toBe("a = 1\nrm_owner = new\nb = 2\n");
    expect(parseEnvFile(text).rm_owner).toBe("new");
  });

  test("RED CONTROL: a comment or a longer key that merely contains the name is not the line", () => {
    expect(envLineKey("# rm_owner = x")).toBeUndefined();
    expect(envLineKey("rm_owner_old = x")).toBe("rm_owner_old");
    const { text } = withEnvLine("# rm_owner = x\nrm_owner_old = y\n", "rm_owner", "z");
    expect(text).toBe("# rm_owner = x\nrm_owner_old = y\nrm_owner = z\n");
  });

  test("refuses a value a .env line cannot hold unquoted, without printing it", () => {
    for (const bad of ["has space", "quote'", "hash#x", "new\nline", ""]) {
      expect(() => withEnvLine("", "rm_owner", bad)).toThrow(/cannot hold unquoted/);
      try {
        withEnvLine("", "rm_owner", bad);
      } catch (e) {
        if (bad) expect((e as Error).message).not.toContain(bad);
      }
    }
  });
});

describe("writeEnvSecret", () => {
  test("writes atomically: a new inode renamed into place, mode 0600, no temp file left", () => {
    const path = envFile(PANEL);
    const inodeBefore = statSync(path).ino;
    // A reader holding the old file keeps reading the old file: the write never truncates it in place.
    const fd = openSync(path, "r");
    writeEnvSecret(path, "rm_owner", "generated_PW-1");
    const buf = Buffer.alloc(PANEL.length);
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    expect(buf.toString()).toBe(PANEL);
    expect(statSync(path).ino).not.toBe(inodeBefore);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`${PANEL}rm_owner = generated_PW-1\n`);
    expect(readdirSync(join(path, ".."))).toEqual([".env"]);
  });

  test("an existing line refuses without a rotation and writes nothing", () => {
    const text = `${PANEL}rm_owner = old\n`;
    const path = envFile(text);
    expect(() => writeEnvSecret(path, "rm_owner", "new")).toThrow(/without a rotation/);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(join(path, ".."))).toEqual([".env"]);
  });

  test("a rotation keeps the old line in .env.retired-<ts> (0600) and replaces it in place", () => {
    const path = envFile(`host = h\nrm_owner = old-pw\nport = 1\n`);
    const result = writeEnvSecret(path, "rm_owner", "new-pw", { retire: true, now: new Date("2026-10-08T01:02:03.004Z") });
    expect(result.replaced).toBe(true);
    expect(result.retiredFile).toBe(`${path}.retired-2026-10-08T01-02-03-004Z`);
    expect(readFileSync(result.retiredFile!, "utf8")).toMatch(/^# .*\nrm_owner = old-pw\n$/);
    expect(statSync(result.retiredFile!).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("host = h\nrm_owner = new-pw\nport = 1\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a rotation with no line to retire just appends, and writes no retired file", () => {
    const path = envFile("host = h\n");
    expect(writeEnvSecret(path, "rm_owner", "p", { retire: true })).toEqual({ replaced: false });
    expect(readdirSync(join(path, ".."))).toEqual([".env"]);
  });
});
