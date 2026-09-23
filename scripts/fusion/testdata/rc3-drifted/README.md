# rc.3-era drifted shared-fixture bytes (vendored)

These are the bytes `robotmoney-core` actually carried under `tests/fixtures/` at
tag **v0.4.0-rc.3** (commit `f295e8f6ad22849044d97c39528bdf23064597e3`) — the
release where eight of the nine shared consensus-receipt fixtures had drifted
away from this repo while BOTH repos' CI stayed green.

They exist so `scripts/fusion/test-cross-repo-fixture-drift.sh` — the C-21
negative self-test for `check-cross-repo-fixture-drift.ts` — can reconstruct that
real historical drifted state with **nothing but this checkout**. Before they
were vendored the self-test needed a `robotmoney-core` clone, so in CI it was
gated on `secrets.RM_CORE_RO_TOKEN`; that secret is not configured on this
repository, so the self-test never once ran and the guard was never seen to go
red in CI (only locally). A guard whose only CI evidence is its own exit code on
a green tree is exactly what let rc.3 ship.

Only the nine rows that EXISTED at v0.4.0-rc.3 are here.
`consensus-receipt.envelope.json` and `consensus-receipt.unknown-fields-refused.json`
were added to core later, so there is deliberately no file for them and the
self-test asserts they are left untouched rather than planted (previously they
were truncated to 0 bytes by a redirect, inflating the red).

`SHA256SUMS` pins these bytes against accidental edits. To re-verify against core
directly (needs a core checkout):

    bash scripts/fusion/test-cross-repo-fixture-drift.sh <robotmoney-core checkout>

which adds an arm comparing every file here to `git show v0.4.0-rc.3:tests/fixtures/<name>`.
Do not edit these files: they are a historical record, not test scaffolding to tune.
