# Visual parity fixtures

Full-page screenshots of the **original** site (`robotmoney-site`, the Next.js
app) for the public, navigable surface that the buildless `robotmoney-frontend`
port targets. These are the reference baseline for visual-parity review of the
ported `frontend/public/views/*.html` pages.

- `original/` — 32 routes captured from the original site at 1440px-wide
  viewport, full page, light/dark per the site's own theme.
- Capture settings: Playwright Chromium, `viewport 1440x900`,
  `fullPage: true`, `deviceScaleFactor: 1`, settle wait after `load`.
- `original/_manifest.json` lists every route and capture status.

Routes covered: home, allocation, allocation2, regime, committee, tokenomics,
skills, media (+articles/videos), blog (+7 posts), docs (+investment-committee
and skill trees), faq, changelog, disclaimer, research (channel-divergence,
late-cycle-signals).

To regenerate: run the original site (`cd robotmoney-site && npm run dev`,
serves `:3000`) then capture with the Playwright script used in the parity
review (1440px, full page).
