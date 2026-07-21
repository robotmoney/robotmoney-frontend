// Alpine factory for the committee application form (/committee/apply).
// Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES, path } from "../../lib/api.js";

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function applicationProofMessage(memberId, publicKey) {
  return `robotmoney:apply:${String(memberId).trim()}:${String(publicKey).trim()}`;
}

export function registerApplyForm(Alpine) {
  // ── Committee application (apply → pending activation) ─────────────────────
  // The real onboarding entry point. POSTs the prospective member's public key
  // to /api/committee/apply; the member is recorded 'applied' and an admin must
  // activate it before it can submit. No token is minted here.
  Alpine.data("applyForm", () => ({
    form: {
      memberId: "", name: "", operator: "", thesis: "", mandate: "",
      lens: "", biases: "", wallets: "", voiceMd: "", avatar: "",
      contact: "", publicKey: "", keyProofSignature: "",
    },
    submitting: false,
    error: null,
    result: null,
    status: null,
    identity: null,
    token: null,
    isStatusPage: false,
    async init() {
      const match = location.pathname.match(/^\/committee\/apply\/([^/]+)\/?$/);
      if (!match) return;
      this.isStatusPage = true;
      this.form.memberId = decodeURIComponent(match[1]);
      await this.refreshStatus();
    },
    async refreshStatus() {
      this.error = null;
      try {
        this.status = await api.get(path(ROUTES.committee.applicationStatus, { member: this.form.memberId }));
      } catch (e) {
        this.error = e.message;
      }
    },
    async generateIdentity() {
      this.error = null;
      try {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const [publicRaw, privatePkcs8] = await Promise.all([
          crypto.subtle.exportKey("raw", pair.publicKey),
          crypto.subtle.exportKey("pkcs8", pair.privateKey),
        ]);
        this.identity = {
          type: "robotmoney-committee-ed25519",
          memberId: this.form.memberId.trim() || null,
          publicKey: bytesToBase64(publicRaw),
          privateKeyPkcs8: bytesToBase64(privatePkcs8),
        };
        this.form.publicKey = this.identity.publicKey;
      } catch (e) {
        this.error = `Could not generate an Ed25519 identity: ${e.message}`;
      }
    },
    downloadIdentity() {
      if (!this.identity) return;
      this.identity.memberId = this.form.memberId.trim() || null;
      const blob = new Blob([JSON.stringify(this.identity, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `robotmoney-${this.identity.memberId || "committee"}-identity.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    async loadIdentityFile(event) {
      this.error = null;
      try {
        const file = event.target.files?.[0];
        if (!file) return;
        const identity = JSON.parse(await file.text());
        if (identity.type !== "robotmoney-committee-ed25519" || !identity.privateKeyPkcs8 || !identity.publicKey)
          throw new Error("not a Robot Money committee identity file");
        if (identity.memberId && identity.memberId !== this.form.memberId)
          throw new Error(`identity belongs to ${identity.memberId}`);
        this.identity = identity;
        if (!this.isStatusPage) this.form.publicKey = identity.publicKey;
      } catch (e) {
        this.identity = null;
        this.error = `Could not load identity: ${e.message}`;
      }
    },
    async claimToken() {
      if (!this.identity) { this.error = "Choose the identity file created when you applied."; return; }
      this.error = null;
      this.submitting = true;
      try {
        const challenge = await api.post(path(ROUTES.committee.claimChallenge, { member: this.form.memberId }), {});
        const privateKey = await crypto.subtle.importKey(
          "pkcs8", base64ToBytes(this.identity.privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"],
        );
        const signature = await crypto.subtle.sign(
          { name: "Ed25519" }, privateKey, new TextEncoder().encode(challenge.challenge),
        );
        const claimed = await api.post(path(ROUTES.committee.claimToken, { member: this.form.memberId }), {
          challenge: challenge.challenge,
          signature: bytesToBase64(signature),
        });
        this.token = claimed.token;
        await this.refreshStatus();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
    proofMessage() {
      return applicationProofMessage(this.form.memberId, this.form.publicKey);
    },
    keygenCommand() {
      return "rmpc committee-identity --path ~/.config/robotmoney/committee-identity.json create";
    },
    async signApplicationProof() {
      if (!this.identity) return this.form.keyProofSignature.trim();
      if (this.identity.publicKey !== this.form.publicKey.trim()) throw new Error("identity file does not match the submitted public key");
      const privateKey = await crypto.subtle.importKey(
        "pkcs8", base64ToBytes(this.identity.privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"],
      );
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" }, privateKey, new TextEncoder().encode(this.proofMessage()),
      );
      return bytesToBase64(signature);
    },
    async submit() {
      this.error = null;
      this.submitting = true;
      try {
        const keyProofSignature = await this.signApplicationProof();
        if (!keyProofSignature) throw new Error("Generate or load an identity, or paste an rmpc signature for the proof message.");
        const body = {
          memberId: this.form.memberId.trim(),
          name: this.form.name.trim(),
          lens: this.form.lens.trim() || undefined,
          publicKey: this.form.publicKey.trim(),
          keyProofSignature,
          operator: this.form.operator.trim() || undefined,
          thesis: this.form.thesis.trim() || undefined,
          mandate: this.form.mandate.trim() || undefined,
          biases: this.form.biases.split("\n").map((v) => v.trim()).filter(Boolean),
          wallets: this.form.wallets.split("\n").map((v) => v.trim()).filter(Boolean),
          voiceMd: this.form.voiceMd.trim() || undefined,
          avatar: this.form.avatar.trim() || undefined,
          contact: this.form.contact.trim() || undefined,
        };
        this.result = await api.post(ROUTES.committee.apply, body);
        if (this.identity) this.identity.memberId = body.memberId;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
