# @robotmoney/contract

The **only** thing shared across the frontend ↔ backend boundary. It is an API
contract, not an implementation:

- `src/routes.js` — endpoint paths + a `path()` helper. The single source of
  truth for URLs. Runtime values, importable by both sides.
- `src/*.d.ts` — request/response DTOs as pure TypeScript declarations. No
  runtime form; consumed by the backend via `import type` and by the frontend's
  editor tooling via JSDoc `import('@robotmoney/contract').Foo`.
- `src/consensus-receipt.js` + `src/__fixtures__/consensus-receipt.*` — the
  Project Fusion consensus receipt: the reference canonicalizer AND the data it
  takes as arguments. Both halves are exported, because a consumer that can
  import the code but has to vendor the spec and the schema is not pinned to
  anything:

  ```js
  import { canonicalizeReceipt } from "@robotmoney/contract/consensus-receipt";
  import spec from "@robotmoney/contract/fixtures/consensus-receipt.canonicalization.json" with { type: "json" };
  import schema from "@robotmoney/contract/fixtures/consensus-receipt.schema.json" with { type: "json" };
  ```

  `@robotmoney/contract/fixtures/consensus-receipt.*` maps to
  `src/__fixtures__/consensus-receipt.*`, so the whole conformance corpus — the
  spec, the schema, the valid, no-weights, escaping, invalid and
  refused-variants receipts, the bucket/vault map, and the two committed golden
  byte files — resolves by package specifier.
  `consensus-receipt.valid.canonical.txt` is the cross-repo byte pin; computing
  and asserting `keccak256` over it is the anchoring repo's obligation
  (`canonicalization.json#digest_note`), since keccak256 is not available to a
  zero-dependency Bun test here.

  THE CORPUS IS THE EXPORT, NOT THE DIRECTORY. The subpath pattern names the
  `consensus-receipt.` prefix rather than `*` on purpose: `src/__fixtures__/` is
  a test-fixture directory by name and convention, and a `./fixtures/*` wildcard
  published every file in it — including `swarm-application.json`, an unrelated
  module's fixture — as semver-stable public API, and committed the package to
  the filename of every future file dropped in there. Anything genuinely
  cross-repo gets its own named subpath.

  The spec argument is ALL-OR-NOTHING. `canonicalizeReceipt(receipt)` and
  `receiptSemanticErrors(receipt)` with the spec omitted canonicalize under this
  package's pinned constants. Supply a spec and you are the authority for every
  field it names: a complete-but-different spec is honoured verbatim (that is
  how a consumer holding another version's spec discovers the bytes disagree),
  while a spec missing a field is refused with a `ReceiptCanonicalizationError`
  naming the key, never quietly completed from the pin.

Rules:
- Zero runtime dependencies. Never imports from `frontend/` or `backend/`.
- Changing a route or DTO here is the explicit, reviewable coupling point
  between the two halves.

On the eventual repo split this directory is published as `@robotmoney/contract`
(private registry / GitHub Packages) or vendored via git submodule; both repos
pin a version.
