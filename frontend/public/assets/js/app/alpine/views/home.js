// Alpine factory for the home page (RM-175): the model portfolio, how the
// swarm makes it, the agents behind it, and how to hold it, under the
// Monument hero (app/home/*).
//
// Reads, each failing on its own:
//   the latest recommendation  the model portfolio itself, through the same
//                              loader /allocation and the vault pages use, so
//                              the home ring can never disagree with theirs
//   the allocation framework   each sleeve's assets, and the hero's lane names
//   the swarm roster           analysts and judges, and the seats left
//
// The page's words are static HTML (the prerender inlines them for readers
// that run no JavaScript); only figures, names and links are bound here.
import { api, ROUTES } from "../../lib/api.js";
import { ALLOCATION_SUBJECT_ID } from "../../lib/allocation-subject.js";
import { allocationFramework } from "../../lib/allocation-framework.js";
import { isJudge } from "../../lib/judgements.js";
import { sessionSummary } from "../../lib/session-summary.js";
import { sessionTakes } from "../../lib/session-takes.js";
import { memberLogo } from "../../lib/member-logos.js";
import { memberAvatarMarkup } from "../../lib/member-mark.js";
import { fmtDate, vaultForBucket } from "../../lib/vault-data.js";
import { loadLatestRecommendation } from "../../lib/vault-source.js";
import { createMonument } from "../../home/scene.js";
import { runHero } from "../../home/loop.js";
import { mountPlate } from "../../home/plate.js";
import { STILL_AT } from "../../home/story.js";

const PLATE_SRC = "/assets/img/home/plate.jpg";
/** @param {string} name */
const plateSrc = (name) => `/assets/img/home/${name}.jpg`;

// The hero's lanes name assets from the framework's universe and carry no
// weights; this list stands in only when no framework can be read at all.
const FALLBACK_UNIVERSE = ["Aave", "Morpho", "Compound", "Sky", "BTC", "ETH", "HYPE"];

// The bare ring, for a model portfolio not yet published: the same track
// ringSvg draws under every mix.
const EMPTY_RING = `<svg class="sv__wdonut" viewBox="0 0 42 42" aria-hidden="true" focusable="false">`
  + `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--color-border)" stroke-width="4"></circle></svg>`;

/** "86.5%": one decimal at most, no trailing zero. @param {number} v */
const pctText = (v) => `${Number(v.toFixed(1))}%`;

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// The hero copy rises in on CSS alone, from first paint of the prerendered
// page. The router then swaps that markup for a fresh copy of the same view,
// whose animations would start over; the copy that replaces it is handed the
// time already elapsed, so the rise carries on instead of restarting.
const ENTER_MS = 1400;
/** @type {number | null} */
let enterStart = null;

/** @param {import("alpinejs").Alpine} Alpine */
export function registerHomeView(Alpine) {
  Alpine.data("homeView", () => ({
    ...allocationFramework(),

    /** @type {null | { date: string, receiptHref: string, rows: { key: string, label: string, pct: number, colour: string, assets: string }[], ringHtml: string }} */
    model: null,
    modelLoaded: false,
    /** @type {any[]} */
    analysts: [],
    /** @type {any[]} */
    judges: [],
    /** @type {number | null} */
    seatsAvailable: null,
    rosterLoaded: false,
    rosterFailed: false,
    // 0 to 1: the legend's figures count up once, the first time the ring is
    // seen. They start at 1, so a reader who never scrolls (or a test) reads
    // the true numbers.
    countK: 1,

    // Imperative handles: never bound in the markup.
    /** @type {any} */ _hero: null,
    /** @type {null | (() => void)} */ _stopLoop: null,
    /** @type {(() => void)[]} */ _plates: [],
    /** @type {IntersectionObserver | null} */ _reveal: null,
    /** @type {null | (() => void)} */ _onLeave: null,
    _destroyed: false,
    _counted: false,

    init() {
      this._enter();
      this._destroyed = false;
      this._onLeave = () => this.destroy();
      window.addEventListener("rm:before-view-change", this._onLeave);
      window.addEventListener("pagehide", this._onLeave, { once: true });
      this.load();
      this.$nextTick(() => this._mount());
    },

    async load() {
      const [rec, , roster] = await Promise.allSettled([
        // The weights, not the tally: no read of the session's takes.
        loadLatestRecommendation({ takes: false }),
        this.loadAllocationFw(),
        api.get(ROUTES.swarm.members),
      ]);
      if (this._destroyed) return;

      const session = rec.status === "fulfilled" ? rec.value?.session : null;
      const rows = session ? sessionSummary.sessionWeights(session) : null;
      this.model = rows ? {
        date: fmtDate(session.date || session.publishedAt),
        receiptHref: sessionTakes().sessionHref(session),
        rows: rows.map((r) => ({ ...r, assets: this._assetsFor(r.key) })),
        ringHtml: sessionSummary.ringSvg(rows),
      } : null;
      this.modelLoaded = true;

      if (roster.status === "fulfilled") {
        const members = (roster.value?.members || []).filter((/** @type {any} */ m) => !m.status || m.status === "active");
        this.analysts = members.filter((/** @type {any} */ m) => !isJudge(m));
        this.judges = members.filter(isJudge);
        this.seatsAvailable = Number.isFinite(Number(roster.value?.seatsAvailable)) ? Number(roster.value.seatsAvailable) : null;
      } else {
        this.rosterFailed = true;
      }
      this.rosterLoaded = true;

      this._hero?.setMembers(this.analysts);
      this._hero?.setUniverse(this._universe());
    },

    // ── the model portfolio ────────────────────────────────────────────────
    ringHtml() { return this.model ? this.model.ringHtml : EMPTY_RING; },
    /** @param {number} v */
    countPct(v) { return pctText(v * this.countK); },
    modelLabel() {
      if (!this.model) return "The model portfolio";
      return `The model portfolio: ${this.model.rows.map((r) => `${r.label} ${pctText(r.pct)}`).join(", ")}`;
    },
    historyHref() { return `/swarm/subjects/${ALLOCATION_SUBJECT_ID}`; },
    // The sleeve explorer reads these by name (lib/sleeve-explorer.js). Hue
    // follows the published order, the same index the ring already paints.
    explorerRows() {
      return (this.model?.rows || []).map((r) => ({
        key: r.key, label: r.label, hue: r.colour, pct: r.pct,
      }));
    },
    explorerSvg() { return this.ringHtml(); },
    explorerCenter() { return { value: "", label: "" }; },
    /** @param {string | null | undefined} key */
    vaultHref(key) {
      const v = vaultForBucket(key);
      return v ? `/vault/${v.slug}` : null;
    },
    /** @param {string | null | undefined} key */
    vaultSymbol(key) { return vaultForBucket(key)?.symbol ?? ""; },
    /** @param {string} bucket */
    _assetsFor(bucket) {
      const b = (this.allocationFw?.buckets || []).find((/** @type {any} */ x) => vaultForBucket(x?.key ?? x?.label)?.bucket === bucket);
      return (b?.items || []).map((/** @type {any} */ i) => i?.label).filter(Boolean).join(", ");
    },
    // The lanes' names: every asset the framework holds, less the Real World
    // Assets sleeve, whose tokens are usually KYC-gated, because the caption
    // under the lanes says "permissionless". Picked by the sleeve, not by name.
    _universe() {
      const names = (this.allocationFw?.buckets || [])
        .filter((/** @type {any} */ b) => vaultForBucket(b?.key ?? b?.label)?.bucket !== "real_world_assets")
        .flatMap((/** @type {any} */ b) => (b?.items || []).map((/** @type {any} */ i) => i?.label))
        .filter(Boolean);
      return names.length ? [...new Set(names)] : FALLBACK_UNIVERSE;
    },

    // ── the members ────────────────────────────────────────────────────────
    /** @param {any} m */
    memberHref(m) { return `/swarm/members/${encodeURIComponent(m?.handle || m?.id || "")}`; },
    /** @param {any} m */
    // Judges sit under their own label, so only an analyst's lens is noted.
    memberNote(m) { return isJudge(m) ? "" : (m?.lens || ""); },
    /** @param {string} name */
    initials(name) {
      return String(name || "")
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0].toUpperCase())
        .join("") || "SW";
    },
    // Same precedence as /swarm: curated logo, then avatar.path, then the
    // derived mark. x-html is safe: memberAvatarMarkup never interpolates
    // the seed, and initials() is already stripped to letters and digits.
    memberMark(seed, name, size = 64, avatarPath, handle) {
      const src = memberLogo({ handle }) || avatarPath || null;
      return memberAvatarMarkup(src, seed, name, size, (n) => this.initials(n));
    },
    seatsLabel() {
      if (this.seatsAvailable === null) return "";
      return this.seatsAvailable > 0
        ? `${this.seatsAvailable} ${this.seatsAvailable === 1 ? "seat" : "seats"} open · Judges by invitation`
        : "All seats filled · Judges by invitation";
    },

    // ── the hero, the plates and the reveals ───────────────────────────────
    _enter() {
      if (reducedMotion()) return;
      const root = /** @type {HTMLElement} */ (this.$el);
      const now = Number(document.timeline?.currentTime ?? performance.now());
      if (enterStart !== null && now - enterStart < ENTER_MS) {
        root.style.setProperty("--hm-t", `${Math.round(now - enterStart)}ms`);
        return;
      }
      const first = root.querySelector(".hm-beat")?.getAnimations?.()[0];
      enterStart = typeof first?.startTime === "number" ? first.startTime : now;
    },

    _mount() {
      if (this._destroyed) return;
      const root = /** @type {HTMLElement} */ (this.$el);
      const reduce = reducedMotion();
      const stage = /** @type {HTMLElement | null} */ (root.querySelector(".hm-hero__stage"));
      const host = /** @type {HTMLElement | null} */ (root.querySelector(".hm-hero"));
      const canvasRender = /** @type {HTMLCanvasElement | null} */ (root.querySelector(".hm-hero__render"));
      const fg = /** @type {HTMLCanvasElement | null} */ (root.querySelector(".hm-hero__fg"));
      if (stage && host && canvasRender && fg) {
        this._hero = createMonument({
          canvasRender, fg, img: PLATE_SRC,
          still: root.querySelector(".hm-hero__still"),
          quiet: () => root.querySelector(".hm-hero__copy"),
          members: this.analysts,
          universe: this.rosterLoaded || this.modelLoaded ? this._universe() : [],
          onLive: (live) => stage.classList.toggle("is-live", live),
        });
        this._stopLoop = runHero(this._hero, { stage, host, stillAt: STILL_AT, reduce });
        this._debugHook();
      }
      root.querySelectorAll("[data-plate]").forEach((el) => {
        const fig = /** @type {HTMLElement} */ (el);
        const [name, fx, fy] = String(fig.dataset.plate).split(",");
        // A plate can light another block once its own reveal has crossed it.
        const lights = fig.dataset.plateLights ? root.querySelector(fig.dataset.plateLights) : null;
        const onRevealed = lights ? () => lights.classList.add("is-lit") : undefined;
        this._plates.push(mountPlate(fig, plateSrc(name), { fx: Number(fx ?? 0.5), fy: Number(fy ?? 0.5), reduce, onRevealed }));
      });
      this._reveals(root, reduce);
    },

    // Each block rises in once, the first time it is seen. Under reduced
    // motion nothing moves; without JavaScript nothing is hidden, because the
    // hiding rule hangs off a class only this adds.
    /** @param {HTMLElement} root @param {boolean} reduce */
    _reveals(root, reduce) {
      root.classList.add("is-ready");
      if (reduce) return;
      root.classList.add("hm-anim");
      this._reveal = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-seen");
          this._reveal?.unobserve(e.target);
          if (e.target.matches(".hm-model") && !this._counted) this._countUp();
        }
      }, { threshold: 0.2, rootMargin: "0px 0px -8% 0px" });
      root.querySelectorAll(".hm-reveal").forEach((el) => this._reveal?.observe(el));
    },

    _countUp() {
      this._counted = true;
      const t0 = performance.now(), dur = 900;
      const tick = (/** @type {number} */ now) => {
        if (this._destroyed) return;
        const p = Math.min(1, (now - t0) / dur);
        this.countK = 1 - Math.pow(1 - p, 3);
        if (p < 1) requestAnimationFrame(tick);
      };
      this.countK = 0;
      requestAnimationFrame(tick);
    },

    // For frame-by-frame checks only: ?debug=home exposes the hero's clock.
    _debugHook() {
      if (new URLSearchParams(location.search).get("debug") !== "home") return;
      const hero = this._hero;
      /** @type {any} */ (window).__rmHome = {
        /** @param {number} t */
        seek(t) { hero.seek(t); hero.draw(); },
        get time() { return hero.time; },
        get live() { return hero.live; },
      };
    },

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._onLeave) {
        window.removeEventListener("rm:before-view-change", this._onLeave);
        window.removeEventListener("pagehide", this._onLeave);
      }
      this._onLeave = null;
      this._stopLoop?.();
      this._stopLoop = null;
      this._hero?.destroy();
      this._hero = null;
      for (const dispose of this._plates) dispose();
      this._plates = [];
      this._reveal?.disconnect();
      this._reveal = null;
      if (/** @type {any} */ (window).__rmHome) delete (/** @type {any} */ (window)).__rmHome;
    },
  }));
}
