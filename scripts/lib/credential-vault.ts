import sodium from "libsodium-wrappers";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface CredentialVault {
  admin: Record<string, string>;
  deployment: Record<string, Record<string, string>>;
}

const OPSLIMIT = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
const MEMLIMIT = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
const KEY_LENGTH = sodium.crypto_secretbox_KEYBYTES;
const NONCE_LENGTH = sodium.crypto_secretbox_NONCEBYTES;

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return sodium.crypto_pwhash(
    KEY_LENGTH,
    passphrase,
    salt,
    OPSLIMIT,
    MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function loadVault(
  path: string,
  passphrase: string,
): Promise<CredentialVault> {
  await sodium.ready;
  const raw = await readFile(path, { encoding: "utf8" });
  const parsed = JSON.parse(raw) as {
    salt: string;
    nonce: string;
    ciphertext: string;
  };
  const salt = sodium.from_base64(parsed.salt, sodium.base64_variants.ORIGINAL);
  const nonce = sodium.from_base64(parsed.nonce, sodium.base64_variants.ORIGINAL);
  const ciphertext = sodium.from_base64(parsed.ciphertext, sodium.base64_variants.ORIGINAL);
  const key = deriveKey(passphrase, salt);
  const decrypted = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  if (decrypted === undefined) {
    throw new Error("incorrect vault passphrase or corrupted data");
  }
  return JSON.parse(new TextDecoder().decode(decrypted)) as CredentialVault;
}

export async function saveVault(
  path: string,
  vault: CredentialVault,
  passphrase: string,
): Promise<void> {
  await sodium.ready;
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(NONCE_LENGTH);
  const key = deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(vault, null, 2));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  const payload = JSON.stringify({
    salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, payload, { encoding: "utf8", mode: 0o600 });
}
