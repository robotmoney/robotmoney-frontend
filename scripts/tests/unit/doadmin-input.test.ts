// scripts/lib/doadmin-input.ts: doadmin is typed at a hidden prompt or piped
// with --doadmin-stdin, and read from nowhere else (D61, owner 2026-10-08).
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOADMIN_STDIN_FLAG, DoadminInputRefused, readDoadminPassword, type SecretInput } from "../../lib/doadmin-input.ts";

/** A fake stream: a TTY with raw mode when `tty`, else a pipe. Chunks are emitted once it is resumed. */
function fakeInput(chunks: string[], tty: boolean): SecretInput & { rawModes: boolean[] } {
  const ee = new EventEmitter();
  const rawModes: boolean[] = [];
  let started = false;
  const input = {
    isTTY: tty,
    rawModes,
    ...(tty ? { setRawMode: (m: boolean) => rawModes.push(m) } : {}),
    on: (event: string, listener: (...a: any[]) => void) => ee.on(event, listener),
    removeAllListeners: (event?: string) => (event ? ee.removeAllListeners(event) : ee.removeAllListeners()),
    resume: () => {
      if (started) return;
      started = true;
      queueMicrotask(() => {
        for (const c of chunks) ee.emit("data", Buffer.from(c));
        if (!tty) ee.emit("end");
      });
    },
    pause: () => undefined,
  };
  return input as never;
}

function fakeOutput(): { write(t: string): void; text: string } {
  const o = { text: "", write(t: string) {
    o.text += t;
  } };
  return o;
}

const SECRET = "typed-doadmin-Qx7!pw";

describe("the hidden prompt (a terminal)", () => {
  test("reads until Enter in raw mode, echoes nothing, and restores the terminal", async () => {
    const input = fakeInput([SECRET.slice(0, 5), `${SECRET.slice(5)}\r`], true);
    const out = fakeOutput();
    expect(await readDoadminPassword([], input, out)).toBe(SECRET);
    expect(input.rawModes).toEqual([true, false]);
    expect(out.text).toContain("doadmin password");
    expect(out.text).not.toContain(SECRET);
    expect(out.text).not.toContain("Q");
  });

  test("backspace edits; Ctrl-C and an empty line refuse", async () => {
    expect(await readDoadminPassword([], fakeInput(["abX\u007fc\n"], true), fakeOutput())).toBe("abc");
    await expect(readDoadminPassword([], fakeInput(["ab\u0003"], true), fakeOutput())).rejects.toThrow(/cancelled/);
    await expect(readDoadminPassword([], fakeInput(["\r"], true), fakeOutput())).rejects.toThrow(/no doadmin password was typed/);
  });
});

describe("--doadmin-stdin (a pipe)", () => {
  test("one line, then EOF; the trailing newline is not part of the value; nothing is echoed", async () => {
    const out = fakeOutput();
    expect(await readDoadminPassword([DOADMIN_STDIN_FLAG], fakeInput([`${SECRET}\n`], false), out)).toBe(SECRET);
    expect(out.text).toBe("");
  });

  test("the flag wins over a terminal: a piped value is read even when stdin claims to be a TTY", async () => {
    const input = fakeInput([`${SECRET}\n`], false);
    (input as { isTTY: boolean }).isTTY = true;
    expect(await readDoadminPassword([DOADMIN_STDIN_FLAG], input, fakeOutput())).toBe(SECRET);
  });

  test("RED CONTROL: empty stdin or two lines refuse, and the refusal never holds the value", async () => {
    await expect(readDoadminPassword([DOADMIN_STDIN_FLAG], fakeInput([""], false), fakeOutput())).rejects.toThrow(DoadminInputRefused);
    const error = await readDoadminPassword([DOADMIN_STDIN_FLAG], fakeInput([`${SECRET}\nsecond\n`], false), fakeOutput()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(DoadminInputRefused);
    expect((error as Error).message).not.toContain(SECRET);
  });
});

describe("nowhere else", () => {
  test("RED CONTROL: no terminal and no flag refuses, even when a doadmin value sits in the environment", async () => {
    process.env.doadmin = SECRET;
    process.env.DOADMIN = SECRET;
    try {
      const error = await readDoadminPassword([`--doadmin=${SECRET}`], fakeInput([`${SECRET}\n`], false), fakeOutput()).catch((e: Error) => e);
      expect(error).toBeInstanceOf(DoadminInputRefused);
      expect((error as Error).message).not.toContain(SECRET);
    } finally {
      delete process.env.doadmin;
      delete process.env.DOADMIN;
    }
  });

  test("the module reads no file, no environment variable and no argv value", () => {
    const source = readFileSync(join(import.meta.dir, "../../lib/doadmin-input.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|readFileSync|process\.env|process\.argv|Bun\.file/);
  });
});
