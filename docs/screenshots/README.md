# Feature Parity Screenshot Reference

This directory contains visual references from **robotmoney-site** (the original Next.js implementation) to enable pixel-perfect parity with **robotmoney-frontend** (the buildless HTML/Alpine version).

---

## Quick Start

1. **Reference Index:** Open [`reference/index.html`](reference/index.html) in a browser
   - Lists all pages that need visual comparison
   - Direct links to robotmoney-site running on `http://localhost:3000`

2. **Manifest:** [`reference/manifest.json`](reference/manifest.json)
   - Structured list of pages, routes, and expected screenshot files
   - Used for comparison automation (future Percy/visual-diff integration)

---

## Setup

The robotmoney-site dev server is running on `http://localhost:3000`

### To start robotmoney-site manually:
```bash
cd /home/lucas/robotmoney/robotmoney-site
npm install
npm run dev
# → http://localhost:3000
```

---

## Capturing Screenshots

### Option 1: Browser DevTools (Recommended for 1-2 pages)
1. Open each URL in the reference index
2. Open DevTools → Device Toolbar (Ctrl+Shift+M)
3. Set to Desktop (1440px) width
4. Ctrl+Shift+P → "Capture screenshot" → Save as `{name}-desktop-1440.png`
5. Change to Mobile (375px) width
6. Capture again → Save as `{name}-mobile-375.png`

### Option 2: Browser Extensions (Recommended for bulk)
- **Full Page Screen Capture** (Chrome/Edge)
- **Nimbus Screenshot** (Chrome/Firefox)
- **FireShot** (Chrome/Firefox)
- Settings: Full page, no UI chrome

### Option 3: Command Line (Linux/macOS)
```bash
# If gnome-screenshot available
gnome-screenshot -w -a 1440,900,/path/to/screenshot.png http://localhost:3000/route

# If scrot available
scrot -s /path/to/screenshot.png
```

### Option 4: Browser Automation (if Python available)
```bash
pip install playwright
playwright install chromium
# Then run: python capture-all.py
```

---

## File Organization

After capturing screenshots, organize them as:

```
reference/
├── index.html                      ← Open this to start
├── manifest.json                   ← Metadata for automation
├── home-desktop-1440.png
├── home-mobile-375.png
├── regime-desktop-1440.png
├── regime-mobile-375.png
├── visualizations-index-desktop-1440.png
├── visualizations-index-mobile-375.png
├── viz-orbits-desktop-1440.png
├── viz-orbits-mobile-375.png
└── ...
```

---

## Pages to Capture (Priority Order)

### P0 Critical (For layout comparison during development)
1. `/` — Home page (hero + sections)
2. `/regime` — Regime analysis dashboard
3. `/committee` — Committee member list
4. `/allocation` — Allocation dashboard (charts, TVL)
5. `/visualizations` — Visualization gallery index

### P1 High (Visualization samples)
6. `/orbits` — Sample visualization page
7. `/substrate` — Sample visualization page (complex)
8. `/plasma` — Sample visualization page
9. `/mandelbrot` — Sample visualization page (simple)

### P2 Medium (Supporting pages)
10. `/committee/apply` — Committee application form
11. `/research/channel-divergence` — Research page
12. `/research/late-cycle-signals` — Research page

---

## Using Screenshots During Development

### Side-by-side Comparison
1. Open robotmoney-site in browser at 1440px: `http://localhost:3000`
2. Open robotmoney-frontend dev server in another window: `http://localhost:8080` (or configured port)
3. Navigate to same page on both
4. Use browser DevTools to measure spacing, fonts, colors
5. Use screenshot references to verify:
   - Layout and grid alignment
   - Component spacing and sizing
   - Typography (font-family, weight, size, line-height)
   - Colors (exact hex or RGB values)
   - Animations and transitions
   - Responsive behavior at 375px breakpoint

### Visual Diff Automation (Future)
Once screenshots are captured, you can:
- **Integrate with Percy.io** — automatic visual regression testing
- **Use Pixelmatch** — pixel-perfect comparison in CI
- **Manual diff tools** — macOS Preview, Linux `feh`, Windows Paint can layer images

---

## Manifest Format

The `manifest.json` contains structured data:

```json
{
  "generatedAt": "2026-06-30T...",
  "baseUrl": "http://localhost:3000",
  "pages": [
    {
      "name": "home",
      "route": "/",
      "url": "http://localhost:3000/",
      "widths": [1440, 375],
      "expectedFiles": [
        "home-1440.png",
        "home-375.png"
      ]
    }
  ]
}
```

Use this manifest to:
- Validate which screenshots exist
- Drive automated comparison workflows
- Track parity progress
- Generate reports

---

## Comparison Workflow (Daily During Phase 0-2)

1. **After each feature is ported:**
   - Take fresh screenshot of robotmoney-frontend
   - Compare against saved robotmoney-site reference
   - Measure pixel-level differences in:
     - Spacing (margin, padding)
     - Typography (font, size, weight, line-height)
     - Colors (hex values)
     - Component dimensions
2. **Fix discrepancies** in CSS/HTML
3. **Re-screenshot** to verify
4. **Move to next component**

---

## Troubleshooting

**Q: Server not responding at localhost:3000?**
- Check if robotmoney-site dev server is running: `ps aux | grep "next dev"`
- Restart: `cd /home/lucas/robotmoney/robotmoney-site && npm run dev`
- Check logs: `tail -30 /tmp/next-dev.log`

**Q: Screenshots won't open in reference/index.html?**
- Use `file://` protocol: `file:///path/to/reference/index.html`
- Or start a local HTTP server:
  ```bash
  cd reference
  python -m http.server 8000
  # → http://localhost:8000
  ```

**Q: Desktop/mobile screenshots don't match?**
- Verify responsive breakpoints in robotmoney-site `tailwind.config.ts`
- Check CSS media queries in robotmoney-frontend `/assets/css/`
- Use Chrome DevTools responsive mode to test exact widths

---

## References

- **robotmoney-site:** `/home/lucas/robotmoney/robotmoney-site` (source of truth)
- **robotmoney-frontend:** `/home/lucas/robotmoney/robotmoney-frontend` (being ported)
- **Feature Parity Plan:** `../FEATURE_PARITY_PLAN.md`
- **Audit Report:** Same plan doc (Section 1-5 contain detailed findings)
