// The early-access form (RM-189): the EIP-55 check its wallet field relies on,
// the referral code it carries from the visitor's link, and the request it
// sends. No DOM and no Alpine runtime: the factory's helpers are pure.
import { test, expect, describe } from "bun:test";
import { keccak256Hex, parseEvmAddress } from "../../../frontend/public/assets/js/app/lib/evm-address.js";
import { captureReferral, referralCode, clearReferral } from "../../../frontend/public/assets/js/app/lib/referral.js";
import { validateEarlyAccess, earlyAccessPayload, sendEarlyAccess, sourceFor, normalizeHandle } from "../../../frontend/public/assets/js/app/alpine/views/early-access.js";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

// The four mixed-case vectors from EIP-55 itself.
const EIP55 = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("evm address", () => {
  test("keccak256 is the Ethereum hash, not SHA3-256", () => {
    expect(keccak256Hex(new Uint8Array())).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Hex(new TextEncoder().encode("abc"))).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });

  test("a checksummed address passes, and a one-letter case change fails", () => {
    for (const a of EIP55) {
      expect(parseEvmAddress(a)).toBe(a);
      const i = a.search(/[a-f]/);
      expect(parseEvmAddress(a.slice(0, i) + a[i].toUpperCase() + a.slice(i + 1))).toBeNull();
    }
  });

  test("an address with no checksum is accepted and returned checksummed", () => {
    for (const a of EIP55) {
      expect(parseEvmAddress(a.toLowerCase())).toBe(a);
      expect(parseEvmAddress("0x" + a.slice(2).toUpperCase())).toBe(a);
      expect(parseEvmAddress(`  ${a}  `)).toBe(a);
    }
  });

  test("anything else is not an address", () => {
    for (const s of ["", "0x", "0x123", EIP55[0].slice(2), EIP55[0] + "0", "0x" + "g".repeat(40)]) {
      expect(parseEvmAddress(s)).toBeNull();
    }
  });
});

describe("referral code", () => {
  test("is read from the link and kept raw", () => {
    const s = memoryStorage();
    captureReferral("?ref=RM_Alice", s);
    expect(referralCode(s)).toBe("RM_Alice");
  });

  test("the first code of a session holds", () => {
    const s = memoryStorage();
    captureReferral("?ref=rm_alice", s);
    captureReferral("?ref=rm_bob", s);
    expect(referralCode(s)).toBe("rm_alice");
  });

  test("a page without one, or with a paragraph for one, keeps nothing", () => {
    const s = memoryStorage();
    captureReferral("?utm_source=x", s);
    captureReferral(`?ref=${"a".repeat(65)}`, s);
    expect(referralCode(s)).toBeNull();
  });

  test("is forgotten once the form is sent", () => {
    const s = memoryStorage();
    captureReferral("?ref=rm_alice", s);
    clearReferral(s);
    expect(referralCode(s)).toBeNull();
  });
});

describe("early-access form", () => {
  const complete = {
    handle: " @treasurer ",
    email: "",
    wallet: EIP55[0].toLowerCase(),
    businessType: "dao",
    intendedDeposit: "100k-1m",
    nonStableShare: "10-30",
    website: "",
  };

  test("the required fields are the handle and the three choices", () => {
    const errors = validateEarlyAccess({ handle: "", email: "", wallet: "", businessType: "", intendedDeposit: "", nonStableShare: "" });
    expect(Object.keys(errors).sort()).toEqual(["businessType", "handle", "intendedDeposit", "nonStableShare"]);
    expect(validateEarlyAccess(complete)).toEqual({});
  });

  test("a handle is taken as @name, from a profile link too", () => {
    for (const s of ["treasurer", "@treasurer", " @treasurer ", "https://x.com/treasurer", "x.com/treasurer?s=21", "https://t.me/treasurer", "twitter.com/treasurer/"]) {
      expect(normalizeHandle(s)).toBe("@treasurer");
    }
    for (const s of ["", "@", "my name", "@a.b", "x".repeat(33), "https://example.com/treasurer"]) {
      expect(normalizeHandle(s)).toBeNull();
    }
    expect(validateEarlyAccess({ ...complete, handle: "my name" }).handle).toContain("@name");
  });

  test("a bad checksum is told apart from a malformed address", () => {
    const i = EIP55[0].search(/[a-f]/);
    const flipped = EIP55[0].slice(0, i) + EIP55[0][i].toUpperCase() + EIP55[0].slice(i + 1);
    expect(validateEarlyAccess({ ...complete, wallet: flipped }).wallet).toContain("checksum");
    expect(validateEarlyAccess({ ...complete, wallet: "0x123" }).wallet).toContain("40 hex");
  });

  test("the request carries every field, the wallet checksummed and the referral code trimmed", () => {
    expect(earlyAccessPayload({ ...complete, referralCode: " rm_alice " }, "robotmoney.network")).toEqual({
      handle: "@treasurer",
      email: null,
      wallet: EIP55[0],
      businessType: "dao",
      intendedDeposit: "100k-1m",
      nonStableShare: "10-30",
      referralCode: "rm_alice",
      source: "early-access",
      website: "",
    });
    expect(earlyAccessPayload({ ...complete, wallet: "" })).toMatchObject({ wallet: null, referralCode: null });
  });

  test("the referral code goes as the visitor left it: a blank field sends none", () => {
    expect(earlyAccessPayload({ ...complete, referralCode: "Alice from the Telegram group" }).referralCode).toBe("Alice from the Telegram group");
    expect(earlyAccessPayload({ ...complete, referralCode: "   " }).referralCode).toBeNull();
    expect(validateEarlyAccess({ ...complete, referralCode: "not a code" })).toEqual({});
  });

  test("a sign-up from anywhere but production names its host", () => {
    expect(sourceFor("robotmoney.network")).toBe("early-access");
    expect(sourceFor("127.0.0.1")).toBe("early-access@127.0.0.1");
    expect(sourceFor("preview.robotmoney-labs.dev")).toBe("early-access@preview.robotmoney-labs.dev");
  });

  test("the send is a simple text/plain POST, and only { ok: true } counts", async () => {
    const calls: any[] = [];
    const reply = (body: unknown, status = 200) => async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    };
    await sendEarlyAccess({ handle: "@a" }, "https://script.example/exec", reply({ ok: true }) as any);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toStartWith("text/plain");
    expect(JSON.parse(calls[0].init.body)).toEqual({ handle: "@a" });
    await expect(sendEarlyAccess({}, "https://script.example/exec", reply({ ok: false, error: "handle" }) as any)).rejects.toThrow("handle");
    await expect(sendEarlyAccess({}, "https://script.example/exec", reply({ ok: true }, 500) as any)).rejects.toThrow();
  });

  test("with no sheet connected, a send fails rather than pretending", async () => {
    await expect(sendEarlyAccess({}, "")).rejects.toThrow("not connected");
  });
});
