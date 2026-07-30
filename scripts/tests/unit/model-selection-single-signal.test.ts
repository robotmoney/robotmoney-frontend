// THE REGRESSION GUARD THAT REPLACED THE KEYLESS ONE, POINTING THE OPPOSITE WAY
// (docs/decisions.md D22 rule 1 as amended 2026-07-28, docs/architecture.md
// §11.3 E1 as amended; issue #278's rescope).
//
// Issue #278 was originally scoped to ENFORCE keylessness: an in-code
// `EVAL_MODEL` constant, no env passthrough, and a `check-eval-keyless.sh` that
// went red if a provider key reached any eval path. #292 amended D22 rule 1 —
// `opencode/big-pickle`, the free model that mandate pinned, is saturated
// upstream with no paid sibling, so enforcing "keyless" would enforce an
// outage. The eval now runs a FUNDED, registry-selected model.
//
// The property worth protecting was never "no key". It was AMBIENT,
// UNREVIEWABLE MODEL SELECTION: an `export` someone did months ago quietly
// deciding which model a benchmark ran on. That property survived the
// amendment, and this file is what enforces it from the test side:
//
//   `resolveAgentModel()` in scripts/lib/model-registry.ts is the SINGLE
//   model-selection signal. No second constant, no second env read, no second
//   selection path.
//
// WHY THIS IS NOT A DUPLICATE of scripts/tests/unit/model-selection-guard.test.ts.
// That file executes the SHELL guard, scripts/checks/check-model-selection.sh,
// against planted fixture trees. This file grades the same property with an
// independent, in-TypeScript scanner and adds three rules the shell guard does
// not have (a declared env-name set, a no-string-literal rule on exported model
// constants, and an import-provenance rule), plus the behavioural assertion
// that only AGENT_MODEL can move the resolved model. The two are deliberately
// belt-and-braces: a single guard whose regex silently stops matching is
// exactly the failure mode both exist to prevent.
//
// RED CONTROLS. Every rule below is graded by a function that takes a tree
// ROOT, and each is pointed at BOTH the real repository and a planted fixture
// tree that reintroduces a competing selection path. The same function grades
// both, so a rule that has quietly stopped matching cannot pass here.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DEFAULT_AGENT_MODEL, resolveAgentModel } from "../../lib/model-registry.ts";
import { DEFAULT_INFERENCE_MODEL, resolveModelConfig } from "../../lib/onboarding-eval.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// ── The tree the rules grade ────────────────────────────────────────────────
// RUNTIME source, workflows, and compose files. scripts/tests/** is excluded on
// purpose and for the same reason the shell guard excludes it: a test asserting
// what the registry RESOLVES TO must name concrete ids, and one proving a
// retired knob is gone must name that knob.
const SCAN_DIRS = ["scripts", "evals", ".github/workflows"];
const SCAN_EXTS = [".ts", ".js", ".sh", ".yml", ".yaml"];
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "tests"]);
/** The one file allowed to hold model ids. */
const REGISTRY_REL = join("scripts", "lib", "model-registry.ts");

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** Every scanned file in `root`, as paths relative to it. */
function scannedFiles(root: string): string[] {
  const files: string[] = [];
  for (const rel of SCAN_DIRS) {
    const full = join(root, rel);
    if (existsSync(full)) walk(full, files);
  }
  for (const entry of readdirSync(root)) {
    if (/^docker-compose.*\.ya?ml$/.test(entry)) files.push(join(root, entry));
  }
  return files.map((f) => relative(root, f));
}

interface Finding {
  rule: "model-id-literal" | "undeclared-model-env" | "model-string-constant" | "off-registry-import";
  file: string;
  line: number;
  text: string;
}

function isComment(line: string): boolean {
  return /^\s*(\/\/|#|\*|<!--)/.test(line);
}

// ── Rule B's declared set ───────────────────────────────────────────────────
// Every environment variable name containing "MODEL" that runtime code or a
// workflow is allowed to touch. Pinned as a LITERAL so that adding a fourth
// arrives red and has to be justified in a diff rather than appearing.
//
//   AGENT_MODEL                          — THE selector (model-registry.ts).
//   ONBOARDING_SWEEP_MODELS              — nightly sweep: a ":"-separated list
//                                          of AGENT_MODEL SELECTORS, each still
//                                          resolved through the registry. Not a
//                                          second selection path; a loop over
//                                          the first one.
//   ONBOARDING_SWEEP_IDENTITIES_PER_MODEL— a COUNT, not a model.
export const DECLARED_MODEL_ENV_NAMES = ["AGENT_MODEL", "ONBOARDING_SWEEP_MODELS", "ONBOARDING_SWEEP_IDENTITIES_PER_MODEL"];

const MODEL_ENV_READ = /(?:process\.env\.|env\.|process\.env\[["']|env\[["'])([A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*)/g;
const MODEL_ENV_YAML_KEY = /^\s{2,}([A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*)\s*:/;
const MODEL_ID_LITERAL = /["'](opencode\/[A-Za-z0-9][A-Za-z0-9._-]*)["']/;
const MODEL_STRING_CONST = /export\s+const\s+[A-Za-z0-9_]*MODEL[A-Za-z0-9_]*\s*(?::[^=]+)?=\s*["']/;
const REGISTRY_SYMBOL_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const REGISTRY_SYMBOLS = ["resolveAgentModel", "isKeylessModel", "keylessModel", "DEFAULT_AGENT_MODEL", "MODEL_FAMILIES"];

/**
 * The competing model-selection paths present in `root`, or [] when
 * `resolveAgentModel()` really is the only one.
 *
 * ONE function, pointed at the real repository AND at every planted fixture
 * below. A rule that stops matching therefore cannot go quietly green: its own
 * red control fails first.
 */
export function competingSelectionPaths(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const rel of scannedFiles(root)) {
    if (rel === REGISTRY_REL) continue; // the one place ids are allowed to live
    const isYaml = rel.endsWith(".yml") || rel.endsWith(".yaml");
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((raw, i) => {
      const line = { rule: "" as Finding["rule"], file: rel, line: i + 1, text: raw.trim() };
      // Prose about a model id is documentation — the opposite of ambient
      // selection — and is not graded. Rule B's YAML key form cannot be a
      // comment (a commented key is not a key), so this is safe for it too.
      if (isComment(raw)) return;

      // A. A raw model id in versioned source outside the registry.
      if (MODEL_ID_LITERAL.test(raw)) findings.push({ ...line, rule: "model-id-literal" });

      // B. An env var whose name names a MODEL and is not one of the declared
      //    three. This is the "ambient selection" case rule 1 always meant.
      for (const m of raw.matchAll(MODEL_ENV_READ)) {
        if (!DECLARED_MODEL_ENV_NAMES.includes(m[1]!)) findings.push({ ...line, rule: "undeclared-model-env" });
      }
      const yamlKey = isYaml ? MODEL_ENV_YAML_KEY.exec(raw) : null;
      if (yamlKey && !DECLARED_MODEL_ENV_NAMES.includes(yamlKey[1]!)) {
        findings.push({ ...line, rule: "undeclared-model-env" });
      }

      // C. An exported model constant whose value is a STRING. A model constant
      //    must be an expression over the registry (keylessModel(),
      //    DEFAULT_AGENT_MODEL), never a hand-written id.
      if (MODEL_STRING_CONST.test(raw)) findings.push({ ...line, rule: "model-string-constant" });

      // D. A registry symbol imported from somewhere that is not the registry
      //    (directly, or via a module that re-exports it) — i.e. a second
      //    module claiming to own model selection.
      for (const m of raw.matchAll(REGISTRY_SYMBOL_IMPORT)) {
        const named = m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
        const from = m[2]!;
        if (!named.some((n) => REGISTRY_SYMBOLS.includes(n))) continue;
        if (/model-registry(\.ts)?$/.test(from)) continue; // the registry itself
        if (/onboarding-eval(\.ts)?$/.test(from)) continue; // documented re-exporter
        findings.push({ ...line, rule: "off-registry-import" });
      }
    });
  }
  return findings;
}

// ── Fixture trees ───────────────────────────────────────────────────────────
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "model-selection-single-signal-"));
  made.push(root);
  // Every fixture carries the registry, exactly as the real tree does.
  const all = { [REGISTRY_REL]: 'export const ZEN_PREFIX = "opencode/";\n', ...files };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

// ---------------------------------------------------------------------------
// 1. THE REAL TREE. resolveAgentModel is the only selection signal there is.
// ---------------------------------------------------------------------------
describe("resolveAgentModel is the SINGLE model-selection signal (real tree)", () => {
  test("the scan is not vacuous — it really reads the runtime tree", () => {
    const files = scannedFiles(repoRoot);
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(join("scripts", "lib", "onboarding-eval.ts"));
    expect(files).toContain(join("scripts", "agent", "member-agent.ts"));
    expect(files).toContain(join("scripts", "lib", "demo-main.ts"));
  });

  test("no competing model-selection path exists anywhere in the runtime tree", () => {
    const findings = competingSelectionPaths(repoRoot);
    expect(findings.map((f) => `${f.rule} @ ${f.file}:${f.line} — ${f.text}`)).toEqual([]);
  });

  test("the shared container primitive holds NO model of its own — it takes what the registry resolved", () => {
    const src = readFileSync(join(repoRoot, "scripts", "agent", "member-agent.ts"), "utf8");
    // No env read at all, and no model id: the primitive's `modelConfig`
    // parameter is the only way a model reaches a container.
    const code = src.split("\n").filter((l) => !isComment(l));
    expect(code.filter((l) => /process\.env\.[A-Z]/.test(l))).toEqual([]);
    expect(code.filter((l) => MODEL_ID_LITERAL.test(l))).toEqual([]);
    expect(src).toContain("modelConfig: MemberAgentModel");
  });

  test("the eval harness resolves through the registry and nowhere else", () => {
    const src = readFileSync(join(repoRoot, "scripts", "lib", "onboarding-eval.ts"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*resolveAgentModel[^}]*\}\s*from\s*["']\.\/model-registry\.ts["']/);
    expect(src).toMatch(/import\s*\{[^}]*isKeylessModel[^}]*\}\s*from\s*["']\.\/model-registry\.ts["']/);
    // Exactly one resolver definition in the file.
    expect(src.match(/export function resolveModelConfig/g)).toHaveLength(1);
  });

  test("the withdrawn keyless deliverables are absent — re-adding either would regress main", () => {
    // #278's original scope; withdrawn by the D22 rule-1 amendment.
    expect(existsSync(join(repoRoot, "scripts", "agent", "model-config.ts"))).toBe(false);
    expect(existsSync(join(repoRoot, "scripts", "checks", "check-eval-keyless.sh"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. RED CONTROLS. Each rule is proven to FIRE on a planted competing path,
//    graded by the SAME function that graded the real tree above.
// ---------------------------------------------------------------------------
describe("red controls: a reintroduced selection path is caught", () => {
  test("a clean fixture tree passes — the rules are not failing for an unrelated reason", () => {
    const root = tree({
      "scripts/lib/thing.ts": 'import { resolveAgentModel } from "./model-registry.ts";\nexport const m = resolveAgentModel();\n',
    });
    expect(competingSelectionPaths(root)).toEqual([]);
  });

  test("RULE A — an in-code EVAL_MODEL constant (issue #278's own withdrawn deliverable) is RED", () => {
    // Verbatim the line PR #284 originally shipped in scripts/agent/model-config.ts.
    const root = tree({ "scripts/agent/model-config.ts": 'export const EVAL_MODEL = "opencode/big-pickle";\n' });
    const findings = competingSelectionPaths(root);
    expect(findings.map((f) => f.rule)).toContain("model-id-literal");
    expect(findings.map((f) => f.rule)).toContain("model-string-constant");
    expect(findings[0]!.file).toBe(join("scripts", "agent", "model-config.ts"));
  });

  test("RULE A — a raw model id in a WORKFLOW is RED (ambient selection by `export`)", () => {
    const root = tree({ ".github/workflows/x.yml": '        AGENT_MODEL: "opencode/kimi-k2.6"\n' });
    expect(competingSelectionPaths(root).map((f) => f.rule)).toEqual(["model-id-literal"]);
  });

  test("RULE A — a raw model id in a COMPOSE file is RED", () => {
    const root = tree({ "docker-compose.demo.yml": '      OPENCODE_DEFAULT: "opencode/gpt-5.4"\n' });
    expect(competingSelectionPaths(root).map((f) => f.rule)).toEqual(["model-id-literal"]);
  });

  test("RULE B — a SECOND model env knob is RED, even with no id in sight", () => {
    for (const knob of ["OPENCODE_MODEL", "ONBOARDING_EVAL_MODEL", "EVAL_MODEL_OVERRIDE"]) {
      const root = tree({ "scripts/lib/sneaky.ts": `const m = process.env.${knob} ?? resolveAgentModel();\n` });
      const findings = competingSelectionPaths(root);
      expect(findings.map((f) => f.rule), knob).toEqual(["undeclared-model-env"]);
    }
  });

  test("RULE B — a second model env knob wired in a WORKFLOW is RED", () => {
    const root = tree({ ".github/workflows/x.yml": "        env:\n          OPENCODE_MODEL: something\n" });
    expect(competingSelectionPaths(root).map((f) => f.rule)).toEqual(["undeclared-model-env"]);
  });

  test("RULE B — the declared set is a LITERAL: a fourth name cannot be waved through", () => {
    // Pins the allowlist itself. Widening it must show up in a diff.
    expect(DECLARED_MODEL_ENV_NAMES).toEqual([
      "AGENT_MODEL",
      "ONBOARDING_SWEEP_MODELS",
      "ONBOARDING_SWEEP_IDENTITIES_PER_MODEL",
    ]);
  });

  test("RULE C — an exported model constant with a STRING value is RED even when the id is not a Zen one", () => {
    const root = tree({ "scripts/lib/x.ts": 'export const REVIEW_MODEL = "some-vendor/some-model";\n' });
    expect(competingSelectionPaths(root).map((f) => f.rule)).toEqual(["model-string-constant"]);
  });

  test("RULE C — a model constant DERIVED from the registry is fine", () => {
    const root = tree({
      "scripts/lib/x.ts": 'import { keylessModel } from "./model-registry.ts";\nexport const REVIEW_MODEL = keylessModel();\n',
    });
    expect(competingSelectionPaths(root)).toEqual([]);
  });

  test("RULE D — importing resolveAgentModel from a SECOND module claiming to own selection is RED", () => {
    const root = tree({
      "scripts/lib/shadow-registry.ts": "export function resolveAgentModel() { return process.env.X; }\n",
      "scripts/lib/consumer.ts": 'import { resolveAgentModel } from "./shadow-registry.ts";\nexport const m = resolveAgentModel();\n',
    });
    expect(competingSelectionPaths(root).map((f) => f.rule)).toEqual(["off-registry-import"]);
  });

  test("prose naming a model id is NOT red — a guard that cries wolf gets deleted", () => {
    const root = tree({
      "scripts/lib/documented.ts": "// the default is `opencode/deepseek-v4-flash`, resolved via the registry\n",
      ".github/workflows/dl.yml": '      - run: curl -L "https://github.com/anomalyco/opencode/releases/download/v1/x.tar.gz"\n',
    });
    expect(competingSelectionPaths(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. BEHAVIOURAL. Only AGENT_MODEL moves the resolved model — asserted by
//    calling the real resolver, not by reading source.
// ---------------------------------------------------------------------------
describe("only AGENT_MODEL moves the resolved model", () => {
  test("every retired knob set at once changes nothing", () => {
    const noisy = {
      OPENCODE_API_KEY: "sk-zen",
      OPENCODE_MODEL: "opencode/kimi-k2.6",
      ONBOARDING_EVAL_MODEL: "opencode/gpt-5.4",
      EVAL_MODEL: "opencode/big-pickle",
      ANTHROPIC_API_KEY: "leak-me",
      OPENAI_API_KEY: "leak-me",
    };
    expect(resolveAgentModel(noisy)).toBe(DEFAULT_AGENT_MODEL);
    const cfg = resolveModelConfig(noisy);
    expect(cfg.model).toBe(DEFAULT_INFERENCE_MODEL);
    // And the credential is the single Zen key, never one of the retired ones.
    expect(cfg.apiKeyEnv).toBe("OPENCODE_API_KEY");
    expect(cfg.apiKey).toBe("sk-zen");
  });

  test("AGENT_MODEL alone does move it — the assertion above is not vacuous", () => {
    expect(resolveAgentModel({ AGENT_MODEL: "kimi/k2.6" })).toBe("opencode/kimi-k2.6");
    expect(resolveAgentModel({ AGENT_MODEL: "kimi/k2.6" })).not.toBe(DEFAULT_AGENT_MODEL);
  });

  test("DEFAULT_INFERENCE_MODEL is the registry's default, not a second constant", () => {
    expect(DEFAULT_INFERENCE_MODEL).toBe(DEFAULT_AGENT_MODEL);
  });
});

// ---------------------------------------------------------------------------
// 4. THE SHELL GUARD STILL STANDS, AND NO COMPETING ONE JOINED IT.
// ---------------------------------------------------------------------------
describe("scripts/checks/check-model-selection.sh survives this diff", () => {
  const CHECK = join(repoRoot, "scripts", "checks", "check-model-selection.sh");

  test("it exists and exits 0 against this repository's real tree", () => {
    expect(existsSync(CHECK)).toBe(true);
    const p = Bun.spawnSync(["bash", CHECK], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    expect(out).toContain("check-model-selection: OK");
    expect(p.exitCode).toBe(0);
  });

  test("it is still wired as an unconditional per-PR step in the required repo-guards job", () => {
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "repo-guards.yml"), "utf8");
    expect(wf).toContain("bash scripts/checks/check-model-selection.sh");
  });

  test("no COMPETING guard was added alongside it — scripts/checks/ holds exactly these two", () => {
    // A second, contradictory guard (the withdrawn check-eval-keyless.sh being
    // the specific one) is the failure this pins: two guards asserting opposite
    // rules means one of them is permanently red or permanently ignored.
    expect(readdirSync(join(repoRoot, "scripts", "checks")).filter((f) => f.endsWith(".sh")).sort()).toEqual([
      "check-model-selection.sh",
      "check-no-test-imports-in-runtime.sh",
    ]);
  });
});
