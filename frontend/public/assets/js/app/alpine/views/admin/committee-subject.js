// Alpine factory for /admin/committee/subjects/:id — topic detail, edit (with
// optimistic-lock version conflicts), and deactivation. Issue #159 —
// docs/architecture.md §4 US-C1.
//
// Reconciled to the REAL backend (issue #152/PR #169) per PR #172 review: the
// backend has no GET .../subjects/:id at all (committee-admin.ts's `subjects`
// route only owns list+create at length-1 and update+deactivate at length-3;
// see backend/src/api/routes/committee-admin.ts) — this page fetches the full
// admin subjects LIST and picks its row client-side. Edits go via
// POST .../subjects/:id/update (not PATCH), and the optimistic-lock field is
// `expectedVersion` (not `version`).
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, fmtUtc } from "./shared.js";

function reasonError(reason) {
  const r = String(reason || "").trim();
  if (r.length < 10 || r.length > 500) return "Reason must be 10–500 characters.";
  return null;
}

export function registerAdminCommitteeSubject(Alpine) {
  Alpine.data("adminCommitteeSubject", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    subjectId: null,
    topic: null,

    editing: false,
    editForm: null,
    editErrors: {},
    submitting: false,

    deactivateOpen: false,
    deactivateReason: "",
    deactivateError: null,

    fmtUtc,

    async init() {
      this.subjectId = location.pathname.split("/").filter(Boolean).pop();
      await this.bootWithStoredToken(() => this.load());
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const res = await api.adminGet(ROUTES.committee.admin.subjects, this._token());
        if (!Array.isArray(res.subjects)) throw new Error("admin subjects response missing 'subjects' array");
        const found = res.subjects.find((s) => s.id === this.subjectId);
        if (!found) throw new Error(`topic '${this.subjectId}' not found`);
        this.topic = found;
      } catch (e) {
        if (e.status === 403) this._handle403();
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    startEdit() {
      this.editForm = {
        expectedVersion: this.topic.version,
        name: this.topic.name || "",
        operator: this.topic.operator || "",
        thesisBlurb: this.topic.thesisBlurb || "",
        sourceType: this.topic.source?.type || "manual",
        recommendationType: this.topic.recommendationType || "position_actions",
        wallets: Array.isArray(this.topic.wallets) ? [...this.topic.wallets] : [],
        linkedMemberId: this.topic.linkedMemberId || "",
        reason: "",
      };
      this.editErrors = {};
      this.editing = true;
    },
    cancelEdit() { this.editing = false; this.editForm = null; this.editErrors = {}; },
    addWalletRow() { this.editForm.wallets.push({ address: "", chain: "", label: "" }); },
    removeWalletRow(i) { this.editForm.wallets.splice(i, 1); },

    validateEdit() {
      const errors = {};
      if (!this.editForm.name?.trim()) errors.name = "Name is required.";
      if (!this.editForm.operator?.trim()) errors.operator = "Operator is required.";
      if (!this.editForm.thesisBlurb?.trim()) errors.thesisBlurb = "Thesis is required.";
      if (this.editForm.sourceType === "framework" && this.editForm.wallets.length > 0) {
        errors.wallets = "framework topics must not have wallets.";
      }
      if (this.editForm.sourceType === "rpc" && this.editForm.wallets.length === 0) {
        errors.wallets = "rpc topics require at least one wallet.";
      }
      const reasonErr = reasonError(this.editForm.reason);
      if (reasonErr) errors.reason = reasonErr;
      return errors;
    },

    async submitEdit() {
      this.editErrors = this.validateEdit();
      if (Object.keys(this.editErrors).length > 0) return;
      this.submitting = true;
      try {
        const body = {
          expectedVersion: this.editForm.expectedVersion,
          name: this.editForm.name,
          operator: this.editForm.operator,
          thesisBlurb: this.editForm.thesisBlurb,
          wallets: this.editForm.wallets,
          nftContracts: this.topic.nftContracts || [],
          source: { type: this.editForm.sourceType },
          recommendationType: this.editForm.recommendationType,
          linkedMemberId: this.editForm.linkedMemberId || null,
          structuralNotes: this.topic.structuralNotes || [],
          reason: this.editForm.reason,
        };
        await api.adminPost(
          path(ROUTES.committee.admin.subjectUpdate, { id: this.subjectId }),
          this._token(),
          body,
        );
        this.editing = false;
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        if (e.status === 409) { this.editErrors.form = "This topic changed since you loaded it (stale version) — reload and try again."; return; }
        this.editErrors.form = e.message;
      } finally {
        this.submitting = false;
      }
    },

    openDeactivate() { this.deactivateOpen = true; this.deactivateReason = ""; this.deactivateError = null; },
    cancelDeactivate() { this.deactivateOpen = false; },

    async confirmDeactivate() {
      const err = reasonError(this.deactivateReason);
      if (err) { this.deactivateError = err; return; }
      this.submitting = true;
      try {
        await api.adminPost(
          path(ROUTES.committee.admin.subjectDeactivate, { id: this.subjectId }),
          this._token(),
          { expectedVersion: this.topic.version, reason: this.deactivateReason.trim() },
        );
        this.deactivateOpen = false;
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        if (e.status === 409) { this.deactivateError = "This topic changed since you loaded it (stale version) — reload and try again."; return; }
        this.deactivateError = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
