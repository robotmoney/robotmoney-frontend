// @ts-check
// The early access gate on /deposit and Your requests (RM-146, under RM-205).
// Deposits open to the early access list first: each person gets their own
// code by email or Telegram, so one code can be revoked and we know who was
// let in. A request's status link (/deposit/requests/:id) stays open: it is
// what a depositor bookmarks and what an agent sends its owner.
//
// What this is and is not: a gate on the page, not on the vault. The queue on
// Base is permissionless, so anyone who calls it directly can deposit; what
// bounds exposure during early access is the vault's TVL and per-deposit caps.
// The page holds only PBKDF2 hashes of the codes, never a code, so the list in
// this public repo does not give one away. Revoking a code is deleting its
// hash; a browser that used it relocks on its next visit.
//
// Codes look like RM-K7Q4M-X2PHT (31 unambiguous characters, ten random). The
// gate shows RM fixed and ten boxes; a pasted or typed "RM" in front is the
// prefix, which is why no code's ten characters start with RM. New codes and
// their hashes come from the generator kept with the early access list,
// outside this repo. Open the gate for everyone by setting GATE_ON to false.

export const GATE_ON = true;

const SALT = "robotmoney-deposit-access-v1";
const ITERATIONS = 20_000;
const KEY = "rm-deposit-access-v1";

/** Hashes of the codes sent so far. One per person; delete a line to revoke it. */
const CODE_HASHES = new Set([
  // Batch 1, 16 Nov 2026 (40 codes). The codes are with the early access list.
  "9a7a768093fb215e195aac6929ae132601015ca1fbec321b18fc8c4ef88e7dbb",
  "9f18e077e8e83b6ee24cbfa382217b078714fb40fcb56d628cfc528f6af7f2e3",
  "97570254f2be590cbc424caa7f2444b4e11b518706838763e02e6b452680b0f0",
  "8bcd85e3997d2c0e8fc1da9bccd49eade27934ce5e7a45281a5b0c1ace3edb7e",
  "b707d73e3f4e23167dce564af3a7dbc9da3140ed70a7255caf96fe0d59d79cb4",
  "d47664636bcfe0b430796775b47629229c47e54d6df4f331bea51b34af2b4356",
  "31c4bfa5cecd35fac87c2cff0ec4d4f67fadd05617a14f5b56b72c28917a6a01",
  "0922ae93301162e0d930ece80b441897ccccfad1acf38f6ae90fa224f875f7e9",
  "8d16e8e8af3231f3e25b75e3f3fbf2358d25459a43b3701f0c8a2769063eba51",
  "9e45a15ad3ee1bee2569d631aa612b5b92ac0d8f112e1e6b2c83c613f210798f",
  "369daa7558bb27f0a80d3928dc929bc24ae010b2e834e6cccc5d021503a0f8b2",
  "1b78d68885113a574aa2d6ecab47a8f2068fe6350f4b7b096bb883991d8ad431",
  "d07961a942f90591f75f00cbb2cc6af26b101870a06ed4be542ea6c9ed686841",
  "5ffb36a0ed3a094e633b1377fcd5cf668136e2674f6b89da7b83bbac6e389363",
  "3e42fd4e2c06186e5af4e36ca6a4bceba5c0854cbd2ae3a009b0494ae55b2e60",
  "d43628ffe373a4f9e9654dc979231cc9c1cf0132fc823c6acfa1b9e1bc689f4b",
  "8fbe5cd3f659e4b0a1ecb87c833108d1368cf6a647a2a6a4ae6af49c8108f649",
  "6932fbb9b93c9486b3a4afe5994183bf6d46c639eeb033ea2e153060781091ce",
  "617bcc13c6cdd6f8661ecdfbade1b13e6060e74514b7a7a5eb4f9792ee9a2db0",
  "e82fb709b40b2c104d4a49ad494b26c7128c20b05c93303db86bc19a5d4b04c8",
  "4feb1ca582b2bac2ada31a7e736b016e842cc4f05dfa3c200488af4a115783e6",
  "a8dfaecfcc2c7bc1aa35fa4b98e49c76c41d6daf7de591288a6dd4eadb9a2486",
  "6c5c699e059f66b48bbc8aee0177b049a28d39c070495a669d71d8447d2584ab",
  "0ae7c2639bd7ab3e96b8e9bc4f80cf51b7091eecf05a76ef40294b1169660117",
  "1e202de255c434f6881b7cd99037db7eddbed8e68020f7fc9542e7c5a659cdbc",
  "5810719be2853b26999357ca1919f382b964c4554741fdc7660939244bccd516",
  "365e58bc276e8d597a1309ac7fefe54b076943616bc566880374746ee0eb52d9",
  "a9a7ec368492a67981ae00844d2c1c614fe00dd4b80431ddd7b8595b5fe4bff0",
  "b1e4332faa7a2db841793bf9944e6bdc31d5fc83e8d7376dacf8e09086876251",
  "a15bd8888875da26a623a5740070860badea83cd732fa0063f29a1b17ffb9edd",
  "aabacc6df822518cdc3c51869e1ec3f55a39f849f37e1108e9f2878b517dd0d1",
  "c6f46541d0fe62ef485201ddac513e8b18557a6b88c02ec4007d66c1ca52034b",
  "c17a08ef16b65a68348f923acd983ea490e4779860818f376fb41d8e47c202b9",
  "a78b059a02a7c71375f3f43affc54dfd757a72e190497cd8c7a66f17b6c2c9b8",
  "af32e5a0a9f1839a4f6d2593d9e3123ee41243941bae64908e1cb0cb9b1894f8",
  "c7d5a9be8ba85113cda07b0cc5e63ffee665c4cd2ac75aede11db1e33efb7f03",
  "30b2c09cef9b36a4a1a0e6677e5af79c4c21eda556f0e25b73cda4275b8ced08",
  "aa8bd5ae5f5d69ccb9be6751016601589458f9d5c97902a90c9c2f4235725a29",
  "8ba60bbf8f30d7b4e7a8e215e7fa50b3735dc000d9a76616d7282c852e7e66db",
  "c4c11929973f5a44b4e9072f282f835ef246227381605420b65502f508b83d93",
]);

/** RM-LOCAL-TESTS: opens the gate on a local preview only, for testing. Ignored on any other host. */
const LOCAL_HASH = "37debe83d7541e7e3c16f57cf775df15c2b991ef8c61ee39bfb26645b27698a3";

const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname);

/** "rm-k7q4m x2pht" and "K7Q4MX2PHT" both read as RMK7Q4MX2PHT. @param {string} code */
export function normalize(code) {
  const s = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 10 ? `RM${s}` : s;
}

/** The ten characters after RM-, as the boxes show them: "rm-k7q4m x2pht" reads K7Q4MX2PHT. @param {string} raw */
export function bodyOf(raw) {
  let s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("RM")) s = s.slice(2);
  return s.slice(0, 10);
}

/** PBKDF2-SHA256 of a normalized code, as hex. @param {string} code */
export async function hashCode(code) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(normalize(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(SALT), iterations: ITERATIONS, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}

const valid = (h) => !!h && (CODE_HASHES.has(h) || (isLocal() && h === LOCAL_HASH));

/** Whether this browser is let in. */
export function isOpen() {
  if (!GATE_ON) return true;
  try { return valid(localStorage.getItem(KEY)); } catch { return false; }
}

/** Try a code; true and remembered in this browser when it is on the list. @param {string} code */
export async function tryCode(code) {
  if (!normalize(code)) return false;
  const h = await hashCode(code);
  if (!valid(h)) return false;
  try { localStorage.setItem(KEY, h); } catch { /* this visit only */ }
  // The site's calls to action switch to Deposit now (lib/access-cta.js).
  try { dispatchEvent(new Event("rm:access")); } catch { /* no window */ }
  return true;
}
