# Next Agent Prompt: Feature Parity Pages (P0/P1)

## Context

Feature parity work is underway to match robotmoney-frontend with robotmoney-site's **discoverable public surface**. Prior work completed Phase 0 (foundation) and Phase 1 (core pages).

**Branch:** `adhoc/20260630-125844-feature-parity-visualizations-nemotron`  
**Status:** 4/25 pages complete (16%)  
**Realistic Scope:** 21 remaining pages (not 88+)

## What's Done

✅ **Phase 0 - Foundation**
- Design tokens synced
- Navigation component styled
- Home page sections complete

✅ **Phase 1 - Core Pages (P0 Critical)**
- `/` (home)
- `/allocation` — dashboard with charts
- `/committee` + dynamic routes (`/committee/[date]/[subject]`, `/committee/members/[id]`)

## What's Left (21 Pages)

### P0 Main Navigation (3 pages) — PRIORITY
These are linked from the main navbar and are foundational:

1. **`/allocation2`** (labeled "Performance" in nav)
   - Variant allocation view with different layout/metrics
   - Reference: robotmoney-site/src/app/allocation2/page.tsx
   - Similar to /allocation but different data presentation

2. **`/changelog`** (linked from nav + home)
   - Development tracking page
   - List of commits/features/fixes with dates
   - Reference: robotmoney-site/src/app/changelog/page.tsx

3. **`/disclaimer`** (linked from nav + home)
   - Legal/risk disclaimer
   - Important info about the protocol
   - Reference: robotmoney-site/src/app/disclaimer/page.tsx

### P1 Secondary Pages (16 pages) — Can parallelize after P0
These are discoverable from primary pages:

4. **`/skills`** (main nav)
   - Skill documentation hub
   - Links to skill documentation
   - Reference: robotmoney-site/src/app/skills/page.tsx

5. **`/tokenomics`** (main nav)
   - Token economics page
   - Charts, tables, allocations
   - Reference: robotmoney-site/src/app/tokenomics/page.tsx

6. **`/media`** (main nav, labeled "Coverage")
   - Media hub linking to articles/videos
   - Sub-pages: `/media/articles`, `/media/videos`
   - Reference: robotmoney-site/src/app/media/page.tsx

7. **`/blog`** (linked from /regime + /faq)
   - Blog index with list of 6 posts
   - Reference: robotmoney-site/src/app/blog/page.tsx
   - Posts: announcement, regime-conservative-aggressive, regime-eq-vs-base, honest-backtesting-weights, treasury-allocation, peaq-partnership, ai-ate-the-bull-market

8. **`/blog/[slug]`** (6 posts)
   - Individual blog post pages
   - Rich content, internal/external links
   - Reference: robotmoney-site/src/app/blog/*/page.tsx

9. **`/docs`** (via /skills or direct)
   - Docs index with two categories
   - Links to subpages
   - Reference: robotmoney-site/src/app/docs/page.tsx

10. **`/docs/investment-committee`** + 3 subpages
    - How it works, API reference, Participation
    - Reference: robotmoney-site/src/app/docs/investment-committee/*

11. **`/docs/skill`** + 3 subpages
    - Installation, Commands, Agent Basket
    - Reference: robotmoney-site/src/app/docs/skill/*

12. **`/research/channel-divergence`** (linked from blog)
    - Research analysis page — already partially done
    - Reference: robotmoney-site/src/app/research/channel-divergence/page.tsx

13. **`/research/late-cycle-signals`** (linked from blog)
    - Research analysis page — already partially done
    - Reference: robotmoney-site/src/app/research/late-cycle-signals/page.tsx

14. **`/faq`** (linked from blog posts)
    - Frequently asked questions
    - Q&A format
    - Reference: robotmoney-site/src/app/faq/page.tsx

## Implementation Notes

- **Router:** The buildless router.js already supports dynamic routes via fallback (e.g., `/blog/[slug].html`)
- **Layout:** All pages use consistent section-based layout (container, section with headings, etc.)
- **Components:** Navigation + footer already in place; pages use Alpine.js for interactivity
- **CSS:** Use existing design system tokens (tokens.css, components.css, views.css)
- **Data:** Allocations/charts use Chart.js (already vendored); use mock/fallback data (Phase 3 wires up APIs)

## Next Steps

1. **Start with P0 (3 pages)** — these unblock secondary work
   - `/allocation2`, `/changelog`, `/disclaimer`
   
2. **Then parallelize P1 (16 pages)** — they're mostly independent
   - Pages can be built in batches by similarity (docs, blog, media)
   
3. **Deliverable:** Create `.html` files in `frontend/public/views/`
   - Structure: `<section class="section">` with semantic HTML
   - Styling: Inline `<style>` tags at bottom (buildless approach)
   - Data: Alpine.js `x-data` providers with mock/fallback data
   
4. **Commit:** One commit per page or batch (clear history)

5. **Test:** Open each page at localhost:8080 (after robotmoney-frontend dev server starts) to verify layout, responsive behavior, links

## Scope NOT Included

❌ Visualization pages (28 pages) — not discoverable from public surfaces  
❌ Allocation variants (/allocation3, /allocation-v2, etc.)  
❌ Home variants (/home2, /home_archived)  
❌ Special/orphaned pages  

These were dropped after audit confirmed zero discovery path.

## Reference Files

- Scope definition: `docs/FEATURE_PARITY_PLAN.md`
- Screenshot reference: `docs/screenshots/reference/all-routes.html` (64 discoverable routes mapped)
- robottmoney-site source: `/home/lucas/robotmoney/robotmoney-site/src/app/`
- robotmoney-frontend view examples: `frontend/public/views/` (allocation.html, committee/session.html, etc.)

## Questions/Blockers

If you hit a blocker:
1. Check the FEATURE_PARITY_PLAN.md for context
2. Compare with robotmoney-site source code
3. Verify the page is actually discoverable (linked from nav or another public page)
4. Use existing pages (allocation.html, committee/session.html) as style/structure references

## Success Criteria

- All 21 pages created and viewable
- Responsive design (mobile-first, tested at 375px + 1440px)
- Links between pages work (breadcrumbs, cross-references)
- Consistent styling (same color palette, typography, spacing)
- No broken links or 404s
- Git history is clean (one commit per page or batch)

Good luck! 🚀
