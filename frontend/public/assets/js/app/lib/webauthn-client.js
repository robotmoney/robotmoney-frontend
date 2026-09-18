// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage, same as lib/api.js. Pulled into the root TS program transitively by
// admin-api-error-text.test.ts -> admin/shared.js (never typechecked before
// that), so this pragma preserves the status quo rather than typing a vendor
// facade in passing.
// Same-origin facade for the pinned UMD artifact shipped in assets/js/vendor.
// The admin and dashboard surfaces hold an operator session, so never fetch
// executable ceremony code from a third-party origin at runtime.
function browserClient() {
  const client = window.SimpleWebAuthnBrowser;
  if (client?.startRegistration && client?.startAuthentication) return client;
  throw new Error("The local WebAuthn client failed to load.");
}

export function startRegistration(options) {
  return browserClient().startRegistration(options);
}

export function startAuthentication(options) {
  return browserClient().startAuthentication(options);
}
