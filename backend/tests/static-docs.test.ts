import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStatic } from "../src/api/static.ts";

const staticRoots: string[] = [];

afterEach(async () => {
  await Promise.all(staticRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "robotmoney-static-"));
  staticRoots.push(root);
  await mkdir(join(root, "views/docs/investment-swarm"), { recursive: true });
  await writeFile(root + "/index.html", '<!doctype html><head><meta name="robots" content="index, follow"></head><main id="view"></main>');
  await writeFile(
    join(root, "views/docs/investment-swarm/participation.html"),
    "<article><h1>Participation</h1><p>Use the canonical payload before signing.</p></article>",
  );
  return root;
}

describe("static documentation routes", () => {
  test("returns the participation guide inside the SPA shell for a no-JS request", async () => {
    const response = await serveStatic("/docs/investment-swarm/participation", await fixture());

    expect(response?.headers.get("Content-Type")).toContain("text/html");
    const html = await response?.text();
    expect(html).toContain('meta name="robots" content="index, follow"');
    expect(html).toContain("Use the canonical payload before signing.");
  });

  test("keeps non-doc client routes on the unchanged SPA shell", async () => {
    const response = await serveStatic("/swarm/apply", await fixture());

    expect(await response?.text()).toBe(
      '<!doctype html><head><meta name="robots" content="index, follow"></head><main id="view"></main>',
    );
  });
});
