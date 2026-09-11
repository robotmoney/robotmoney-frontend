// RM-119. The changelog dropped the roadmap and became a Linear-style log:
// dated entries, an in-progress callout, a tag filter, permalinks. This spec
// boots `bun run preview` itself (same pattern as preview-smoke.spec.ts) so it
// can run locally without a live stack, and still runs in the e2e suite.
//
// Assertions are on the RENDERED page, including computed styles: a source
// grep would still pass if the old two-column roadmap CSS won, or if a capture
// loaded at 0x0.

import { test, expect, type Page, type FrameLocator } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mockVendorScripts } from "./vendor-scripts.ts";

const repoRoot = process.cwd();

let server: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  server = spawn("bun", ["scripts/preview-server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview server did not print its URL within 15s")), 15_000);
    let out = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview server exited early (code ${code})`));
    });
  });
});

test.afterAll(() => {
  server?.kill();
});

test.beforeEach(async ({ page }) => {
  await mockVendorScripts(page);
});

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual([]);
}

async function openChangelog(page: Page): Promise<FrameLocator> {
  await page.goto(`${baseUrl}/`);
  const frame = page.frameLocator("#frame");
  await expect(frame.locator(".nav__ctas .btn-primary")).toBeAttached({ timeout: 15_000 });
  // Drive the router inside the iframe. The desktop nav CTA is `display:none`
  // at phone widths, and the preview wrapper's hash replay replaceStates
  // without a popstate, so neither click nor `#/changelog` is reliable here.
  await page.evaluate(() => {
    const win = (document.querySelector("#frame") as HTMLIFrameElement).contentWindow!;
    win.history.pushState({}, "", "/changelog");
    win.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(frame.locator("h1.cl__h1")).toHaveText("Changelog", { timeout: 15_000 });
  return frame;
}

test("/changelog is a shipped-work log, not a roadmap", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  const frame = await openChangelog(page);

  await expect(frame.locator("h1.cl__h1")).toHaveText("Changelog");
  await expect(frame.getByRole("heading", { name: /roadmap/i })).toHaveCount(0);
  await expect(frame.locator(".cl__entry")).toHaveCount(27);
  await expect(frame.locator(".cl__now")).toBeVisible();
  await expect(frame.locator(".cl__now .rm-sphase--open")).toHaveText("In progress");
  await expect(frame.locator(".cl__now-list li")).toHaveCount(4);
  await expect(frame.locator(".nav__ctas .btn-primary")).toHaveText("Changelog");

  const title = await page.evaluate(() => {
    const iframe = document.querySelector("#frame") as HTMLIFrameElement;
    return iframe.contentDocument?.title ?? "";
  });
  expect(title).toBe("Changelog — Robot Money");

  await expectNoBrowserErrors(errors);
});

test("the in-progress chip is the only colour in that callout", async ({ page }) => {
  await openChangelog(page);

  const styles = await page.evaluate(() => {
    const iframe = document.querySelector("#frame") as HTMLIFrameElement;
    const win = iframe.contentWindow!;
    const doc = iframe.contentDocument!;
    const cs = (el: Element) => win.getComputedStyle(el as HTMLElement);
    const probe = doc.createElement("span");
    probe.style.color = "var(--color-warm)";
    doc.body.appendChild(probe);
    const warm = cs(probe).color;
    probe.remove();
    const chip = doc.querySelector(".cl__now .rm-sphase--open");
    const state = doc.querySelector(".cl__now-state");
    const box = doc.querySelector(".cl__now");
    const entry = doc.querySelector(".cl__entry");
    const frameEl = doc.querySelector(".cl__frame");
    if (!chip || !state || !box || !entry || !frameEl) {
      throw new Error("changelog callout or entry missing");
    }
    const before = win.getComputedStyle(chip, "::before");
    return {
      warm,
      chipColor: cs(chip).color,
      beforeW: parseFloat(before.width),
      beforeH: parseFloat(before.height),
      stateColor: cs(state).color,
      boxShadow: [cs(box).boxShadow, cs(entry).boxShadow, cs(frameEl).boxShadow],
    };
  });

  expect(styles.chipColor).toBe(styles.warm);
  expect(styles.beforeW).toBe(6);
  expect(styles.beforeH).toBe(6);
  expect(styles.stateColor).not.toBe(styles.warm);
  for (const shadow of styles.boxShadow) {
    expect(shadow === "none" || shadow === "").toBe(true);
  }
});

test("the tag filter hides entries that do not carry the tag", async ({ page }) => {
  const frame = await openChangelog(page);

  const swarm = frame.getByRole("button", { name: "Swarm", exact: true });
  await expect(frame.locator(".cl__count")).toHaveText("27 releases");
  await swarm.click();
  await expect(swarm).toHaveAttribute("aria-pressed", "true");
  await expect(frame.locator(".cl__count")).toHaveText(/\d+ releases in Swarm/);

  const visible = await page.evaluate(() => {
    const iframe = document.querySelector("#frame") as HTMLIFrameElement;
    const win = iframe.contentWindow!;
    return [...iframe.contentDocument!.querySelectorAll(".cl__entry")].filter((el) => {
      return win.getComputedStyle(el as HTMLElement).display !== "none";
    }).length;
  });
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(27);

  await swarm.click();
  await expect(swarm).toHaveAttribute("aria-pressed", "false");
  await expect(frame.locator(".cl__count")).toHaveText("27 releases");
});

test("captures load as real images, and permalinks are the titles", async ({ page }) => {
  const frame = await openChangelog(page);

  const imgs = frame.locator(".cl__win img");
  const n = await imgs.count();
  expect(n).toBe(6);
  for (let i = 0; i < n; i++) {
    await imgs.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(async () =>
      page.evaluate((idx) => {
        const img = (document.querySelector("#frame") as HTMLIFrameElement)
          .contentDocument!.querySelectorAll(".cl__win img")[idx] as HTMLImageElement;
        return img.complete && img.naturalWidth > 100 && img.naturalHeight > 100
          ? img.getAttribute("src")
          : "";
      }, i),
    ).not.toBe("");
  }

  const permalink = frame.locator('[id="2026-09-07-a-new-allocation-page"] .cl__title a');
  await expect(permalink).toHaveAttribute("href", "#2026-09-07-a-new-allocation-page");
  await permalink.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const iframe = document.querySelector("#frame") as HTMLIFrameElement;
        return iframe.contentWindow?.location.hash ?? "";
      }),
    )
    .toBe("#2026-09-07-a-new-allocation-page");
});

test("the hero is full-bleed, and a phone swaps the receipt diagram", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openChangelog(page);

  const desktop = await page.evaluate(() => {
    const iframe = document.querySelector("#frame") as HTMLIFrameElement;
    const win = iframe.contentWindow!;
    const doc = iframe.contentDocument!;
    const hero = doc.querySelector(".cl__hero") as HTMLElement;
    const wide = doc.querySelector(".cl__dg--wide") as HTMLElement;
    const narrow = doc.querySelector(".cl__dg--narrow") as HTMLElement;
    const box = hero.getBoundingClientRect();
    return {
      heroW: box.width,
      heroX: box.x,
      clientW: doc.documentElement.clientWidth,
      wideDisplay: win.getComputedStyle(wide).display,
      narrowDisplay: win.getComputedStyle(narrow).display,
    };
  });
  expect(Math.abs(desktop.heroW - desktop.clientW)).toBeLessThanOrEqual(2);
  expect(desktop.heroX).toBeLessThanOrEqual(1);
  expect(desktop.wideDisplay).not.toBe("none");
  expect(desktop.narrowDisplay).toBe("none");

  await page.setViewportSize({ width: 390, height: 844 });
  await openChangelog(page);

  const mobile = await page.evaluate(() => {
    const iframe = document.querySelector("#frame") as HTMLIFrameElement;
    const win = iframe.contentWindow!;
    const doc = iframe.contentDocument!;
    const wide = doc.querySelector(".cl__dg--wide") as HTMLElement;
    const narrow = doc.querySelector(".cl__dg--narrow") as HTMLElement;
    const h1 = doc.querySelector("h1.cl__h1") as HTMLElement;
    return {
      wideDisplay: win.getComputedStyle(wide).display,
      narrowDisplay: win.getComputedStyle(narrow).display,
      h1Overflow: win.getComputedStyle(h1).overflow,
      h1Visible: h1.getBoundingClientRect().height > 0,
    };
  });
  expect(mobile.wideDisplay).toBe("none");
  expect(mobile.narrowDisplay).not.toBe("none");
  expect(mobile.h1Visible).toBe(true);
});

test("the home CTA and the FAQ no longer advertise a roadmap", async ({ page }) => {
  await page.goto(`${baseUrl}/`);
  const home = page.frameLocator("#frame");
  await expect(home.locator(".hero__cta .btn-primary")).toContainText("CHANGELOG", { timeout: 15_000 });

  await page.evaluate(() => {
    const win = (document.querySelector("#frame") as HTMLIFrameElement).contentWindow!;
    win.history.pushState({}, "", "/faq");
    win.dispatchEvent(new PopStateEvent("popstate"));
  });
  const faq = page.frameLocator("#frame");
  await expect(faq.getByRole("heading", { name: "What is the Robot Money roadmap?" })).toBeVisible();
  const answer = faq.locator(".faq__qa", {
    has: faq.getByRole("heading", { name: "What is the Robot Money roadmap?" }),
  });
  await expect(answer).toContainText("There's no public roadmap");
  await expect(answer).not.toContainText("Multi-Chain Expansion");
});

test("llms.txt is a file the router does not swallow", async ({ page }) => {
  const frame = await openChangelog(page);
  await frame.locator('a.cl__lnk[href="/llms.txt"]').first().click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const iframe = document.querySelector("#frame") as HTMLIFrameElement;
        return iframe.contentWindow?.location.pathname ?? "";
      }),
    )
    .toBe("/llms.txt");
  const body = await page.evaluate(() => {
    const iframe = document.querySelector("#frame") as HTMLIFrameElement;
    return iframe.contentDocument?.body?.innerText ?? "";
  });
  expect(body).toContain("everything Robot Money has shipped");
});
