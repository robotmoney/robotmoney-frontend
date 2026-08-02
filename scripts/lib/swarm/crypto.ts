// Member-side ed25519 (Web Crypto). Each agent generates and holds its OWN key;
// only the public key and signatures ever leave. Mirrors the backend verifier.
const ALG = { name: "Ed25519" } as const;
const b64 = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");

export async function generateKeyPair(): Promise<{ publicKeyB64: string; privateKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { publicKeyB64: b64(raw), privateKey: kp.privateKey };
}

export async function sign(message: string, privateKey: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign(ALG, privateKey, new TextEncoder().encode(message));
  return b64(sig);
}
