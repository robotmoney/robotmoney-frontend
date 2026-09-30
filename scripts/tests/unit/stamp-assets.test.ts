// scripts/lib/stamp-assets.ts: cache busting for the application JavaScript (docs/technical/static-asset-cache.md, C3).
// Every import form is proven, including the cases that would leave ONE import unstamped (a module loaded under two
// URLs is two instances), and the whole real frontend/public tree is stamped and checked.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jsTreeStamp, nonLiteralDynamicImports, relativeImports, stampEntryHtml, stampSite, stampSource, verifySite, verifyStampedTree,
} from "../../lib/stamp-assets.ts";

const S = "abcdef12";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "stamp-assets-test-"));
  made.push(d);
  return d;
};

describe("jsTreeStamp", () => {
  const a = { rel: "assets/js/app/a.js", text: "export const a = 1;" };
  const b = { rel: "assets/js/app/b.js", text: "export const b = 2;" };
  test("eight hex characters, and the order the files are given in does not matter", () => {
    expect(jsTreeStamp([a, b])).toMatch(/^[0-9a-f]{8}$/);
    expect(jsTreeStamp([b, a])).toBe(jsTreeStamp([a, b]));
  });
  test("one changed byte, one renamed file or one added file changes it: a release that touches a script never reuses its URLs", () => {
    const base = jsTreeStamp([a, b]);
    expect(jsTreeStamp([a, { ...b, text: "export const b = 3;" }])).not.toBe(base);
    expect(jsTreeStamp([a, { ...b, rel: "assets/js/app/c.js" }])).not.toBe(base);
    expect(jsTreeStamp([a, b, { rel: "assets/js/app/d.js", text: "" }])).not.toBe(base);
  });
  test("a path and a content that concatenate the same do not collide", () => {
    expect(jsTreeStamp([{ rel: "x", text: "yz" }])).not.toBe(jsTreeStamp([{ rel: "xy", text: "z" }]));
  });
});

describe("stampSource: every import form", () => {
  const stamp = (text: string) => stampSource("assets/js/app/m.js", text, S);

  test("default, named (multi-line), namespace and side-effect imports", () => {
    const r = stamp(`import a from "./a.js";\nimport {\n  x,\n  y,\n} from "../b.js";\nimport * as ns from './c.js';\nimport "./d.js";\n`);
    expect(r.count).toBe(4);
    expect(r.text).toBe(`import a from "./a.js?v=${S}";\nimport {\n  x,\n  y,\n} from "../b.js?v=${S}";\nimport * as ns from './c.js?v=${S}';\nimport "./d.js?v=${S}";\n`);
  });
  test("re-exports", () => {
    const r = stamp(`export * from "./e.js";\nexport { z } from "./f.js";\nexport * as q from "./g.js";\n`);
    expect(r.count).toBe(3);
    expect(r.text).toContain(`"./e.js?v=${S}"`);
    expect(r.text).toContain(`"./f.js?v=${S}"`);
    expect(r.text).toContain(`"./g.js?v=${S}"`);
  });
  test("a dynamic import() with a string literal", () => {
    const r = stamp(`const m = await import("./h.js");\nconst n = () => import('../i.js');\n`);
    expect(r.count).toBe(2);
    expect(r.text).toContain(`import("./h.js?v=${S}")`);
    expect(r.text).toContain(`import('../i.js?v=${S}')`);
  });
  test("bare specifiers and absolute URLs are left alone", () => {
    const src = `import chart from "chart.js";\nimport u from "https://cdn.example/x.js";\nexport const k = 1;\n`;
    expect(stamp(src)).toEqual({ text: src, count: 0 });
  });
  test("a comment that quotes an import is not rewritten (alpine/views.js has exactly such a comment)", () => {
    const src = `// main.js's boot import (\`import { registerViews } from "./alpine/views.js"\`)\nimport r from "./h.js";\n`;
    const r = stamp(src);
    expect(r.count).toBe(1);
    expect(r.text).toContain(`from "./alpine/views.js"\`)`);
    expect(r.text).toContain(`"./h.js?v=${S}"`);
  });
  test("a JSDoc type reference is documentation, not code (lib/vault-source.js has one)", () => {
    const src = `/**\n * @typedef {{ overview: import("./vault-data.js").Overview | null }}\n */\nimport v from "./j.js";\n`;
    const r = stamp(src);
    expect(r.count).toBe(1);
    expect(r.text).toContain(`import("./vault-data.js").Overview`);
  });
  test("removing the stamps gives back the original bytes: nothing else was touched", () => {
    const src = `import a from "./a.js";\n// note\nconst s = 'import x from "./nope.js"';\nexport * from "./b.js";\nawait import("./c.js");\n`;
    expect(stamp(src).text.split(`?v=${S}`).join("")).toBe(src);
  });
});

describe("stampSource: refuses rather than guesses", () => {
  test("two statements on one line: the second is not at a statement start and cannot be found safely", () => {
    expect(() => stampSource("m.js", `import a from "./a.js"; import b from "./b.js";\n`, S)).toThrow(/rewrote 1 specifier\(s\) but the transpiler reports 2/);
  });
  test("import(x) with a non-literal argument cannot be stamped", () => {
    expect(() => stampSource("m.js", `const n = "./x.js";\nawait import(n);\n`, S)).toThrow(/non-literal argument/);
    expect(nonLiteralDynamicImports(`await import(n);`)).toBe(1);
    expect(nonLiteralDynamicImports(`await import("./x.js");`)).toBe(0);
    expect(nonLiteralDynamicImports(`// await import(n);\nexport const a = 1;`)).toBe(0);
  });
  test("a tree that is already stamped is refused, not stamped twice", () => {
    expect(() => stampSource("m.js", `import a from "./a.js?v=11111111";\n`, S)).toThrow(/already stamped/);
  });
});

describe("stampEntryHtml", () => {
  test("stamps the module entry point and nothing else", () => {
    const html = `<script src="/config.js"></script>\n<script type="module" src="/assets/js/app/main.js"></script>\n<script defer src="/assets/js/vendor/p5-1.11.2.min.js"></script>`;
    const r = stampEntryHtml(html, S);
    expect(r.count).toBe(1);
    expect(r.html).toContain(`src="/assets/js/app/main.js?v=${S}"`);
    expect(r.html).toContain(`src="/config.js"`);
    expect(r.html).toContain(`src="/assets/js/vendor/p5-1.11.2.min.js"`);
  });
});

describe("verifyStampedTree", () => {
  const files = [
    { rel: "assets/js/app/main.js", text: `import a from "./lib/a.js?v=${S}";\n` },
    { rel: "assets/js/app/lib/a.js", text: `export const a = 1;\n` },
  ];
  const html = `<script type="module" src="/assets/js/app/main.js?v=${S}"></script>`;
  test("a consistent tree has no problems", () => {
    expect(verifyStampedTree(files, html, S)).toEqual([]);
  });
  test("an unstamped import is named: this is the two-instances failure", () => {
    const bad = [{ ...files[0]!, text: `import a from "./lib/a.js";\n` }, files[1]!];
    expect(verifyStampedTree(bad, html, S).join("\n")).toContain("assets/js/app/main.js: imports ./lib/a.js without the stamp");
  });
  test("an import that resolves to no file is named", () => {
    const bad = [{ ...files[0]!, text: `import a from "./lib/missing.js?v=${S}";\n` }, files[1]!];
    expect(verifyStampedTree(bad, html, S).join("\n")).toContain("resolves to assets/js/app/lib/missing.js, not a file in the tree");
  });
  test("an unstamped or missing entry point is named", () => {
    expect(verifyStampedTree(files, `<script type="module" src="/assets/js/app/main.js"></script>`, S).join("\n")).toContain("module entry /assets/js/app/main.js is not stamped");
    expect(verifyStampedTree(files, "<html></html>", S).join("\n")).toContain("no module entry point");
  });
});

describe("the real frontend/public tree", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  function copyOfSite(): string {
    const dir = tmp();
    cpSync(join(repoRoot, "frontend/public"), dir, { recursive: true });
    return dir;
  }

  test("every application script is stamped consistently, and the count matches what the transpiler reports", () => {
    const dir = copyOfSite();
    // What the transpiler says is there, before anything is changed.
    let expected = 0;
    const glob = new Bun.Glob("assets/js/app/**/*.js");
    for (const rel of glob.scanSync(dir)) expected += relativeImports(readFileSync(join(dir, rel), "utf8")).length;

    const summary = stampSite(dir);
    expect(summary.specifiers).toBe(expected);
    expect(summary.specifiers).toBeGreaterThan(200);
    expect(verifySite(dir)).toEqual({ stamp: summary.stamp, problems: [] });
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain(`/assets/js/app/main.js?v=${summary.stamp}`);
  });

  test("removing the stamp from every script restores the source exactly, and every stamped script still parses", () => {
    const dir = copyOfSite();
    const { stamp } = stampSite(dir);
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const rel of new Bun.Glob("assets/js/app/**/*.js").scanSync(dir)) {
      const stamped = readFileSync(join(dir, rel), "utf8");
      expect(stamped.split(`?v=${stamp}`).join(""), rel).toBe(readFileSync(join(repoRoot, "frontend/public", rel), "utf8"));
      expect(() => transpiler.transformSync(stamped), `${rel} still parses`).not.toThrow();
    }
  });

  test("nothing outside assets/js/app and index.html is touched: vendor scripts, config.js, styles and views are byte-identical", () => {
    const dir = copyOfSite();
    stampSite(dir);
    for (const rel of ["config.js", "assets/js/vendor/p5-1.11.2.min.js", "assets/css/views.css", "views/regime.html", "sitemap.xml"]) {
      expect(readFileSync(join(dir, rel)).equals(readFileSync(join(repoRoot, "frontend/public", rel))), rel).toBe(true);
    }
  });

  test("changing one script changes the stamp; a change outside the scripts does not", () => {
    const a = copyOfSite();
    const b = copyOfSite();
    const c = copyOfSite();
    writeFileSync(join(b, "assets/js/app/alpine/substrate.js"), `${readFileSync(join(b, "assets/js/app/alpine/substrate.js"), "utf8")}\n// changed\n`);
    writeFileSync(join(c, "assets/css/views.css"), `${readFileSync(join(c, "assets/css/views.css"), "utf8")}\n/* changed */\n`);
    const [sa, sb, sc] = [stampSite(a).stamp, stampSite(b).stamp, stampSite(c).stamp];
    expect(sb).not.toBe(sa);
    expect(sc, "a stylesheet change leaves the script URLs, and their cached copies, alone").toBe(sa);
  });

  test("stamping twice is refused", () => {
    const dir = copyOfSite();
    stampSite(dir);
    expect(() => stampSite(dir)).toThrow(/already stamped/);
  });

  test("a failure writes nothing: the directory is left exactly as it was", () => {
    const dir = copyOfSite();
    const tooltip = join(dir, "assets/js/app/lib/tooltip.js");
    writeFileSync(tooltip, `${readFileSync(tooltip, "utf8")}\nconst n = "./x.js";\nawait import(n);\n`);
    const before = readFileSync(join(dir, "assets/js/app/main.js"), "utf8");
    expect(() => stampSite(dir)).toThrow(/non-literal/);
    expect(readFileSync(join(dir, "assets/js/app/main.js"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain("main.js?v=");
  });
});
