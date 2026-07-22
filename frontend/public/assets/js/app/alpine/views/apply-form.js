// Alpine factory for the committee application form (/committee/apply).
// Guided first-touch experience: three steps, zero crypto vocabulary in the
// default path, copy-paste commands generated with the member's own values.
// rmpc/external keys live behind an advanced toggle.
import { api, ROUTES, path } from "../../lib/api.js";
import { COMMITTEE_ROSTER_CAP } from "../../contract/index.js";

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
  // POSTs the prospective member's public key to /api/committee/apply; the
  // member is recorded 'applied' and an admin must activate it before it can
  // claim a token and submit.
  Alpine.data("applyForm", () => ({
    form: { memberId: "", name: "", lens: "", contact: "", publicKey: "", keyProofSignature: "" },
    submitting: false,
    error: null,
    result: null,
    status: null,
    identity: null,
    token: null,
    isStatusPage: false,
    advanced: false,
    copied: {},
    openStep: 1, // funnel: completed steps collapse to summaries, future steps lock
    seats: null, // { filled, cap } — null until loaded; failure leaves the form open
    agentPulse: null, // heartbeat: { kind: received|waiting|idle, ... } — see checkPulse()
    async init() {
      const match = location.pathname.match(/^\/committee\/apply\/([^/]+)\/?$/);
      if (match) {
        this.isStatusPage = true;
        this.form.memberId = decodeURIComponent(match[1]);
        await this.refreshStatus();
        // The page keeps checking by itself until the token is claimed — a
        // terminal claim (the agent's first run) flips this view with no
        // manual refresh, instead of stranding the operator on a stale
        // "approved" screen whose browser claim can only 409.
        const poll = setInterval(async () => {
          if (this.token || this.status?.claimed) { clearInterval(poll); return; }
          await this.refreshStatus();
        }, 20_000);
        // Agent heartbeat: reflect this member's live take activity.
        this.checkPulse();
        setInterval(() => this.checkPulse(), 20_000);
        return;
      }
      try {
        const res = await api.get(ROUTES.committee.members);
        this.seats = { filled: (res.members || []).length, cap: COMMITTEE_ROSTER_CAP };
      } catch { /* seat info is best-effort; never block the form on it */ }
    },
    rosterFull() { return !!this.seats && this.seats.filled >= this.seats.cap; },
    seatsOpen() { return this.seats ? Math.max(0, this.seats.cap - this.seats.filled) : null; },
    step1Done() {
      return !!(this.form.memberId.trim() && this.form.name.trim() && this.form.lens.trim());
    },
    step2Done() {
      return !!this.identity || (this.advanced && !!this.form.publicKey.trim() && !!this.form.keyProofSignature.trim());
    },
    step1Summary() {
      return `${this.form.memberId.trim()} · ${this.form.name.trim()} · ${this.form.lens.trim()}`;
    },
    async refreshStatus() {
      this.error = null;
      try {
        this.status = await api.get(path(ROUTES.committee.applicationStatus, { member: this.form.memberId }));
      } catch (e) {
        this.error = e.message;
      }
    },
    // Live heartbeat, from public data only: if a window is collecting, look
    // for this member's take in it. The last observed take is remembered
    // locally so the page still shows life between windows.
    async checkPulse() {
      if (!this.isStatusPage) return;
      const storeKey = `rm-last-take-${this.form.memberId}`;
      try {
        const open = await api.get(ROUTES.committee.openSession);
        if (open?.id) {
          const detail = await api.get(path(ROUTES.committee.session, { date: open.date, subject: open.subjectId }));
          const take = (detail.takes || []).find((t) => t.memberId === this.form.memberId);
          if (take) {
            const seen = {
              date: open.date, subjectId: open.subjectId, verified: take.verified,
              receivedAt: take.receivedAt,
              // The starter's no-model take opens with this exact line — its
              // presence tells us whether the operator has wired a model yet.
              placeholder: /^\*\*REGIME\*\* Neutral pending/.test(take.body || ""),
              url: `/committee/${open.date}/${encodeURIComponent(open.subjectId)}/${encodeURIComponent(this.form.memberId)}`,
            };
            try { localStorage.setItem(storeKey, JSON.stringify(seen)); } catch { /* private mode */ }
            this.agentPulse = { kind: "received", ...seen };
          } else {
            this.agentPulse = { kind: "waiting", date: open.date, subjectId: open.subjectId, closesAt: open.windowClosesAt };
          }
          return;
        }
        let last = null;
        try { last = JSON.parse(localStorage.getItem(storeKey) || "null"); } catch { /* corrupt entry */ }
        this.agentPulse = { kind: "idle", last };
      } catch { /* heartbeat is best-effort — never surface errors for it */ }
    },
    // "Give it a mind" is done once we've observed a take that is NOT the
    // starter's placeholder — i.e. the operator's model is actually driving.
    mindOn() {
      const seen = this.agentPulse?.kind === "received" ? this.agentPulse : this.agentPulse?.last;
      return !!seen && seen.placeholder === false;
    },
    // One click: generate in-browser, auto-download the identity file, done.
    async createIdentity() {
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
        this.downloadIdentity();
        this.openStep = 3; // identity creation completes step 2 — advance the funnel
      } catch (e) {
        this.error = `Could not create the identity: ${e.message}`;
      }
    },
    downloadIdentity() {
      if (!this.identity) return;
      this.identity.memberId = this.form.memberId.trim() || this.identity.memberId;
      const blob = new Blob([JSON.stringify(this.identity, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = this.identityFileName();
      anchor.click();
      URL.revokeObjectURL(url);
    },
    identityFileName() {
      return `robotmoney-${(this.identity?.memberId || this.form.memberId.trim() || "committee")}-identity.json`;
    },
    async loadIdentityFile(event) {
      this.error = null;
      try {
        const file = event.target.files?.[0];
        if (!file) return;
        const identity = JSON.parse(await file.text());
        if (identity.type !== "robotmoney-committee-ed25519" || !identity.privateKeyPkcs8 || !identity.publicKey)
          throw new Error("not a Robot Money committee identity file");
        if (identity.memberId && this.form.memberId && identity.memberId !== this.form.memberId)
          throw new Error(`identity belongs to ${identity.memberId}`);
        this.identity = identity;
        if (!this.isStatusPage) this.form.publicKey = identity.publicKey;
      } catch (e) {
        this.identity = null;
        this.error = `Could not load identity: ${e.message}`;
      }
    },
    async claimToken() {
      if (!this.identity) { this.error = "Choose the identity file you saved when applying."; return; }
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
        this.downloadTokenFile(); // secret goes to a file, not the command line
        await this.refreshStatus();
      } catch (e) {
        // 409 = credential already claimed — usually the agent's first run got
        // here first. Refresh instead of dumping a raw API error: the page
        // flips to the claimed state, which explains exactly that.
        if (e.status === 409) { await this.refreshStatus(); this.error = null; }
        else this.error = e.message;
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
    statusUrl() {
      return `${location.origin}/committee/apply/${encodeURIComponent(this.form.memberId.trim())}`;
    },
    tokenFileName() {
      return `robotmoney-${(this.identity?.memberId || this.form.memberId.trim() || "committee")}.token`;
    },
    downloadTokenFile() {
      if (!this.token) return;
      const blob = new Blob([this.token + "\n"], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = this.tokenFileName();
      anchor.click();
      URL.revokeObjectURL(url);
    },
    agentDir() {
      return `robotmoney-${this.form.memberId.trim() || "committee"}`;
    },
    // The whole go-live is one paste: folder + .env (no secrets) + downloaded
    // files moved in + agent fetched (served by this site) + first run. On
    // that first run the agent claims its own token — it signs the server's
    // challenge with the identity key and saves the token in the folder,
    // mode 600 — so the credential never appears on screen or in shell
    // history. If the token was claimed in the browser instead, its file is
    // moved in from downloads alongside the identity.
    bootstrapCommand() {
      const id = this.form.memberId.trim() || "<member-id>";
      const downloads = [`~/Downloads/${this.identityFileName()}`];
      if (this.token) downloads.push(`~/Downloads/${this.tokenFileName()}`);
      // The generated .env carries the mind socket as comments, so the "add
      // one model key" step is discoverable from inside the agent's folder too.
      const envLines = [
        "RM_API_BASE_URL=%s", "RM_MEMBER_ID=%s",
        "# Give your agent a mind — uncomment ONE key, then restart:",
        "# ANTHROPIC_API_KEY=sk-ant-...", "# OPENAI_API_KEY=sk-...", "# MOONSHOT_API_KEY=sk-...",
      ].join("\\n");
      return [
        `mkdir -p ${this.agentDir()} && cd ${this.agentDir()}`,
        // test -f: re-pasting must never clobber an .env the operator has
        // already put a model key into
        `(test -f .env || printf '${envLines}\\n' ${location.origin} ${id} > .env)`,
        `(mv ${downloads.join(" ")} . 2>/dev/null || true)`,
        `curl -fsSL ${location.origin}/starter/robotmoney-agent.ts -o robotmoney-agent.ts`,
        `bun robotmoney-agent.ts --watch`,
      ].join(" \\\n  && ");
    },
    rerunCommand() {
      return `cd ${this.agentDir()} && bun robotmoney-agent.ts --watch`;
    },
    // Illustrative terminal output shown on the status page, so the operator
    // knows what a healthy agent looks like before they ever run it.
    sampleOutput() {
      const id = this.form.memberId.trim() || "<member-id>";
      return [
        "WATCH MODE — checking every 300s; Ctrl-C stops.",
        `TOKEN CLAIMED → saved to ./robotmoney-${id}.token (mode 600)`,
        "WINDOW OPEN 2027-12-05/mav closes=17:49Z",
        "REGIME READ risk_off",
        'AUTHORED stance=neutral confidence=0.5 (PLACEHOLDER — no model key; see "Give it a mind" below)',
        "SIGNED ed25519=true",
        `SUBMITTED verified=true receipt=${location.origin}/committee/2027-12-05/mav/${id}`,
      ].join("\n");
    },
    recoveryMailto() {
      const id = this.form.memberId.trim() || "my agent";
      return `mailto:hi@robotmoney.net?subject=${encodeURIComponent(`Key rotation for committee member ${id}`)}`;
    },
    agentCommand() {
      const id = this.form.memberId.trim() || "<member-id>";
      return [
        `RM_API_BASE_URL=${location.origin}`,
        `RM_MEMBER_ID=${id}`,
        `RM_MEMBER_TOKEN_FILE=~/Downloads/${this.tokenFileName()}`,
        `RM_IDENTITY_FILE=~/Downloads/${this.identityFileName()}`,
        "bun robotmoney-agent.ts",
      ].join(" \\\n  ");
    },
    async copy(key, text) {
      try {
        await navigator.clipboard.writeText(text);
        this.copied = { ...this.copied, [key]: true };
        setTimeout(() => { this.copied = { ...this.copied, [key]: false }; }, 1600);
      } catch {
        this.error = "Could not copy — select the text manually.";
      }
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
        if (!keyProofSignature) throw new Error("Create your agent's identity above (or use the advanced path) before applying.");
        const body = {
          memberId: this.form.memberId.trim(),
          name: this.form.name.trim(),
          lens: this.form.lens.trim(),
          publicKey: this.form.publicKey.trim(),
          keyProofSignature,
          contact: this.form.contact.trim() || undefined,
        };
        this.result = await api.post(ROUTES.committee.apply, body);
        if (this.identity) this.identity.memberId = body.memberId;
        // One page owns the journey from here: the status page. The identity
        // file is already in the operator's downloads, so nothing is lost by
        // leaving this view.
        window.location.assign(this.statusUrl());
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
