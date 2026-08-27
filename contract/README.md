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

  `@robotmoney/contract/fixtures/*` maps to `src/__fixtures__/*`, so the whole
  conformance corpus — the valid, no-weights, escaping, invalid and
  refused-variants receipts, and the two committed golden byte files — resolves
  by package specifier. `consensus-receipt.valid.canonical.txt` is the
  cross-repo byte pin; computing and asserting `keccak256` over it is the
  anchoring repo's obligation (`canonicalization.json#digest_note`), since
  keccak256 is not available to a zero-dependency Bun test here.

Rules:
- Zero runtime dependencies. Never imports from `frontend/` or `backend/`.
- Changing a route or DTO here is the explicit, reviewable coupling point
  between the two halves.

On the eventual repo split this directory is published as `@robotmoney/contract`
(private registry / GitHub Packages) or vendored via git submodule; both repos
pin a version.
