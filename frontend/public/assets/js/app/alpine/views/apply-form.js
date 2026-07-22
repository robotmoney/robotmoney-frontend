// @ts-nocheck — buildless Alpine factory; behavior is executed by the root
// committee-apply-keygen test rather than duplicated in a typed wrapper.
// Alpine factory for the committee application form (/committee/apply).
// Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";

export function registerApplyForm(Alpine) {
  // ── Committee application (apply → pending activation) ─────────────────────
  // The real onboarding entry point. POSTs the prospective member's public key
  // to /api/committee/apply; the member is recorded 'applied' and an admin must
  // activate it before it can submit. No token is minted here.
  Alpine.data("applyForm", () => ({
    form: { memberId: "", name: "", lens: "", contact: "", publicKey: "" },
    submitting: false,
    keygenBusy: false,
    generatedPrivateKey: "",
    error: null,
    result: null,
    _toBase64(buffer) {
      return btoa(String.fromCharCode(...new Uint8Array(buffer)));
    },
    async generateKeypair() {
      this.error = null;
      this.keygenBusy = true;
      try {
        const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        this.form.publicKey = this._toBase64(await crypto.subtle.exportKey("raw", pair.publicKey));
        this.generatedPrivateKey = this._toBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      } catch (error) {
        this.error = `Could not generate an Ed25519 keypair in this browser: ${error.message}`;
      } finally {
        this.keygenBusy = false;
      }
    },
    async copyPrivateKey() {
      await navigator.clipboard.writeText(this.generatedPrivateKey);
    },
    async submit() {
      this.error = null;
      this.submitting = true;
      try {
        const body = {
          memberId: this.form.memberId.trim(),
          name: this.form.name.trim(),
          lens: this.form.lens.trim() || undefined,
          contact: this.form.contact.trim(),
          publicKey: this.form.publicKey.trim(),
        };
        this.result = await api.post(ROUTES.committee.apply, body);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
