// Alpine factory for the /dash/_styleguide fixture (issue #379). Purely
// local, static demo state — no API calls, matching the fixture's job: prove
// every dash.css class + dash-ui.js primitive renders and behaves, not
// exercise a real data path.
export function registerDashStyleguideView(Alpine) {
  Alpine.data("dashStyleguide", () => ({
    // Mirrors the <symbol id="i-*"> ids in assets/img/dash-icons.svg (minus
    // the "i-" prefix) — the plan's §3 glyph list.
    iconNames: [
      "triangle", "list-ordered", "trophy", "layers", "help-circle", "message-square", "activity", "book-open",
      "log-out", "lock", "eye", "eye-off", "send", "clock", "arrow-up", "arrow-down", "arrow-up-down", "globe",
      "twitter", "bot", "coins", "vault", "wallet", "search", "refresh-cw", "radio", "info", "copy", "external-link",
      "thumbs-up", "thumbs-down", "zap", "check-circle-2", "clipboard-list", "dollar-sign", "trending-up",
      "alert-circle", "radar", "upload", "trash", "star",
    ],
  }));
}
