import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createAnalytics } from "../../../frontend/public/assets/js/app/analytics.js";
import { analyticsConfig } from "../../../frontend/public/assets/js/app/analytics-config.js";
import { CONSENT_KEY, isPrivilegedRoute, pageFields } from "../../../frontend/public/assets/js/app/analytics-policy.js";

function harness(path = "/", choice = "unknown", origin = "https://robotmoney.network", config = { enabled: true, purposeId: "analytics" }) {
  const events = new EventTarget();
  const docEvents = new EventTarget();
  const scripts: any[] = [];
  const tracks: any[] = [];
  const values = new Map<string, string>();
  if (choice !== "unknown") values.set(CONSENT_KEY, JSON.stringify({ version: 1, choice }));
  let reloads = 0;
  let timeout: () => void = () => {};
  const win: any = {
    location: { origin, pathname: path, search: "?token=secret&utm_source=email", hash: "#private", reload: () => reloads++ },
    localStorage: { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v) },
    addEventListener: events.addEventListener.bind(events),
    setTimeout: (fn: () => void) => { timeout = fn; return 1; }, clearTimeout() {},
  };
  const doc: any = { title: "Final title", addEventListener: docEvents.addEventListener.bind(docEvents),
    createElement: () => ({}), head: { appendChild: (script: any) => scripts.push(script) } };
  const adapter = createAnalytics(win, doc, config);
  function ready() {
    win.zaraz = { track: (event: string, fields: any) => tracks.push({ event, fields }),
      consent: { APIReady: true, purposes: { analytics: {} }, set: (v: any) => { win.consent = v; } } };
    docEvents.dispatchEvent(new Event("zarazConsentAPIReady"));
    scripts[0]?.onload();
  }
  return { adapter, win, doc, scripts, tracks, ready, expire: () => timeout(), reloads: () => reloads,
    render: () => events.dispatchEvent(new Event("rm:view-changed")) };
}

describe("consent-gated Zaraz adapter", () => {
  test.each(["unknown", "rejected"])("%s consent causes zero loader/event calls", (choice) => {
    const h = harness("/", choice); h.render(); h.ready(); expect(h.scripts).toHaveLength(0); expect(h.tracks).toHaveLength(0);
  });
  test.each(["https://staging.robotmoney.network", "http://localhost:8787", "https://www.robotmoney.network"])("excludes %s", (origin) => {
    const h = harness("/", "accepted", origin); h.render(); h.ready(); expect(h.scripts).toHaveLength(0); expect(h.tracks).toHaveLength(0);
  });
  test.each(["/admin", "/admin/swarm", "/dashboard", "/market", "/list", "/list2", "/list3", "/agents", "/agents/id", "/lobster", "/lobster/id", "/vaults", "/vaults/id", "/wallets", "/wallets/id", "/methodology", "/about", "/ask-mr-roboto", "/admin/", "/%61dmin/swarm"])("privileged %s loads/sends nothing", (path) => {
    expect(isPrivilegedRoute(path)).toBe(true);
    const h = harness(path, "accepted"); h.render(); h.ready(); expect(h.scripts).toHaveLength(0); expect(h.tracks).toHaveLength(0);
  });
  test("default or missing purpose configuration fails closed", () => {
    expect(analyticsConfig.enabled).toBe(false);
    for (const config of [analyticsConfig, { enabled: true, purposeId: "" }]) {
      const h = harness("/", "accepted", undefined, config); h.render(); expect(h.scripts).toHaveLength(0);
    }
  });
  test("acceptance counts current final render once, never pre-consent history", () => {
    const h = harness(); h.render(); h.win.location.pathname = "/privacy"; h.doc.title = "Privacy"; h.render();
    h.adapter.choose("accepted"); h.adapter.choose("accepted"); expect(h.scripts).toHaveLength(1);
    expect(h.scripts[0].src).toBe("/cdn-cgi/zaraz/i.js"); expect(h.scripts[0].referrerPolicy).toBe("origin");
    h.ready(); h.ready();
    expect(h.tracks).toEqual([{ event: "rm_page_view", fields: { page_title: "Privacy", page_path: "/privacy", page_location: "https://robotmoney.network/privacy" } }]);
    expect(h.win.consent).toEqual({ analytics: true });
    h.win.location.pathname = "/terms"; h.doc.title = "Terms"; h.render(); expect(h.tracks).toHaveLength(2);
  });
  test("delayed readiness counts only latest rendered route", () => {
    const h = harness("/", "accepted"); h.render(); h.win.location.pathname = "/privacy"; h.render();
    expect(h.scripts).toHaveLength(1); h.ready(); expect(h.tracks).toHaveLength(1); expect(h.tracks[0].fields.page_path).toBe("/privacy");
  });
  test("withdrawal stops pending and subsequent calls and discards loaded code", () => {
    const h = harness("/", "accepted"); h.render(); h.adapter.choose("rejected"); h.ready(); h.render();
    expect(h.reloads()).toBe(1); expect(h.tracks).toHaveLength(0);
    expect(JSON.parse(h.win.localStorage.getItem(CONSENT_KEY)).choice).toBe("rejected");
  });
  test("privileged route during pending loader never sends", () => {
    const h = harness("/", "accepted"); h.render(); h.win.location.pathname = "/admin"; h.ready(); h.render(); expect(h.tracks).toHaveLength(0);
  });
  test("blocked loader and unavailable API leave adapter inert", () => {
    for (const unavailable of [true, false]) {
      const h = harness("/", "accepted"); h.render();
      if (unavailable) h.expire(); else h.scripts[0].onerror();
      h.ready(); h.render(); expect(h.tracks).toHaveLength(0); expect(h.scripts).toHaveLength(1);
    }
  });
  test("allowlist discards all query/hash values", () => {
    expect(pageFields({ origin: "https://robotmoney.network", pathname: "/privacy", search: "?token=x&email=x&utm_source=x", hash: "#secret" }, "Title")).toEqual({ page_title: "Title", page_path: "/privacy", page_location: "https://robotmoney.network/privacy" });
  });
});


test("ops fixture requires manual injection, pageview mapping and consent gates", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../docs/ops/zaraz-contract.json", import.meta.url), "utf8"));
  expect(fixture.autoInject).toBe(false);
  expect(fixture.spaSupport).toBe(false);
  expect(fixture.automaticPageviewActions).toBe(false);
  expect(fixture.trigger).toEqual({ eventName: "rm_page_view", publicOnly: true });
  expect(fixture.ga4Action.eventName).toBe("page_view");
  expect(fixture.ga4Action.fields).toEqual({ page_title: "{{ client.page_title }}", page_location: "{{ client.page_location }}", page_path: "{{ client.page_path }}" });
  expect(fixture.consent.requiredPurpose).toBe("Analytics");
  expect(fixture.consent.analytics_storage).toBe("purpose");
  expect(fixture.consent.ad_storage).toBe("denied");
  expect(fixture.privacy.queryAllowlist).toEqual([]);
  expect(fixture.privacy.stripFragments).toBe(true);
  expect(fixture.privacy.blockPrivilegedContext).toBe(true);
});
