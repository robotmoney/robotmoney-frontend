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
