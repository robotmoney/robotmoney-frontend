# @robotmoney/contract

The **only** thing shared across the frontend ↔ backend boundary. It is an API
contract, not an implementation:

- `src/routes.js` — endpoint paths + a `path()` helper. The single source of
  truth for URLs. Runtime values, importable by both sides.
- `src/*.d.ts` — request/response DTOs as pure TypeScript declarations. No
  runtime form; consumed by the backend via `import type` and by the frontend's
  editor tooling via JSDoc `import('@robotmoney/contract').Foo`.

Rules:
- Zero runtime dependencies. Never imports from `frontend/` or `backend/`.
- Changing a route or DTO here is the explicit, reviewable coupling point
  between the two halves.

On the eventual repo split this directory is published as `@robotmoney/contract`
(private registry / GitHub Packages) or vendored via git submodule; both repos
pin a version.
