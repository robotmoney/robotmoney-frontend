import { expect, test } from "bun:test";
import { registerApplyForm } from "../../frontend/public/assets/js/app/alpine/views/apply-form.js";

test("committee apply form generates a matching Ed25519 keypair entirely in-form", async () => {
  let factory: (() => any) | undefined;
  registerApplyForm({
    data(name: string, candidate: () => any) {
      expect(name).toBe("applyForm");
      factory = candidate;
    },
  });
  if (!factory) throw new Error("applyForm factory was not registered");
  const form = factory();
  await form.generateKeypair();

  expect(form.error).toBeNull();
  expect(form.form.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(form.generatedPrivateKey.length).toBeGreaterThan(40);

  const publicKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(form.form.publicKey, "base64"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(form.generatedPrivateKey, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode("committee-apply-keygen-proof");
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message);
  expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)).toBe(true);
});
