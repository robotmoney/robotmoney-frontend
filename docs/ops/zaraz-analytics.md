# Consent-gated GA4 through Cloudflare Zaraz (#1350)

Engineering ships an inactive integration. Activation requires the existing GA4
measurement ID (`G-…`) and zone permissions; neither is supplied by this change.
Admin stays on `robotmoney.network`. Zaraz executes Cloudflare-managed browser
code with this origin's privileges, including access to an existing admin token
in sessionStorage. Document replacement and exclusions do not create origin
isolation. Do not configure Custom HTML, ad tools, replay or unrelated scripts.

## Publish order and account setup

1. Deploy engineering with `analyticsConfig.enabled: false`. Confirm the hostname
   is Cloudflare-proxied. In Zaraz use Preview & Publish rather than real-time
   changes. Turn **Auto-inject script**, **Iframe injection**, **Single Page
   Application support** and **Data layer compatibility mode** off. Automatic
   injection must stay off permanently, including staging and privileged routes.
2. Enable Consent Management. Create the **Analytics** purpose, associate the GA4
   tool with it, and copy the actual generated purpose ID. Disable the automatic
   Zaraz consent modal because the site owns the accessible choice UI. Set Google
   Consent Mode mapping: analytics_storage follows Analytics; ad_storage,
   ad_user_data and ad_personalization are denied. Do not configure cookieless
   denied-consent collection or call `sendQueuedEvents()`.
3. Add GA4 with the existing measurement ID. Remove the default Pageview firing
   action and any enhanced-measurement/history actions. Create exactly one firing
   trigger: **Event Name equals `rm_page_view`**, constrained to the production
   hostname and public routes. Create one GA4 event action for **`page_view`**,
   mapping the fields below. Require Analytics consent on this tool/action.
4. Apply privacy settings: **Remove URL query parameters** and **Remove external
   referrers** on. Review the actual browser Zaraz transport AND Google-bound
   data: Zaraz can add ambient URL/referrer/title context beyond our explicit
   fields. Remove fragment values and privileged referrers from this ambient
   context using a reviewed [Context Enricher](https://developers.cloudflare.com/zaraz/advanced/context-enricher/)
   if the settings alone do not do so. Override Google page location/title with
   the explicit mapped fields; never use default ambient page location. Add
   blocking rules for every route in `analytics-policy.js`, including `/admin`
   and gated dashboard routes. Before activation capture a fixture request with
   `?token=example#private` and a privileged referrer: none may reach Google.
   Cloudflare handles the loader/event requests and can see client context; edge
   redaction protects downstream GA, not data already received by Cloudflare.
5. Publish the reviewed Zaraz configuration first. In
   `frontend/public/assets/js/app/analytics-config.js` set the generated
   `purposeId` and `enabled: true`, then build/deploy the site through its normal
   release. Leave the integration disabled if any consent/privacy/action setting
   cannot be verified. This is an explicit rollout prerequisite, not an assumed
   automatic consequence of merging engineering.

`zaraz-contract.json` is an executable review fixture documenting these required
settings, **not** a Cloudflare configuration export. Export and archive the
actual account config after setup, then compare its effective behavior against
this contract before activation. Account publishing is outside this issue.

## Event contract

The loader is `/cdn-cgi/zaraz/i.js`, with `referrerpolicy="origin"`. It loads
once per eligible document, only after an accepted version-1 preference and the
first rendered route. It waits for `zaraz.consent.APIReady` /
`zarazConsentAPIReady` and the configured purpose; unavailable API/loader fails
closed. It grants that purpose via `zaraz.consent.set({ [purposeId]: true })`,
then calls `zaraz.track("rm_page_view", fields)`.

| Client field | Meaning | GA4 mapping |
| --- | --- | --- |
| `page_title` | Final router-updated document title | `{{ client.page_title }}` |
| `page_path` | Current pathname, no query/hash | `{{ client.page_path }}` |
| `page_location` | Origin + pathname, no query/hash | `{{ client.page_location }}` |

There is intentionally an empty query allowlist, including UTMs. Campaign
attribution from URL parameters is therefore unavailable in this release.
No token, form values, wallet identity or admin metadata is sent by the adapter.
No pre-consent routes are queued. Delayed loader readiness sends the latest
rendered page once; navigation completed while it was unavailable is not replayed.
Only explicit pageviews ship: outbound clicks, downloads, scrolls and conversions
need future specified actions. Referrers that reveal privileged paths must be
removed by the effective edge privacy configuration.

Rejection/withdrawal persists locally and stops adapter calls immediately. A
loaded/loading document reloads to discard code; deleting a script cannot revoke
it. Stored acceptance survives ordinary reloads; public/privileged transitions
force clean documents in production, including history. BFCache restoration
reloads to recheck consent. Preference version changes invalidate earlier choices.
With unavailable config no consent banner or transport is loaded.

## Observable verification

- In a fresh production tab ignore/reject consent: DevTools shows no
  `/cdn-cgi/zaraz/i.js`, `/cdn-cgi/zaraz/t`, Google script or measurement request.
  Check actual Cloudflare-delivered HTML for injected scripts as well.
- Accept on a public page: one loader and one `rm_page_view`, followed by one
  event for each completed SPA navigation with its final title/path. In GA
  Realtime/DebugView verify **one `page_view`**, not a second automatic event.
- Refresh with acceptance: one new pageview. Navigate before acceptance or while
  the loader is delayed: no history replay. Verify sensitive test query/hash and
  privileged referrer are absent from Google-bound fields AND ambient context.
- Change Analytics preferences to Reject: a document reload, no subsequent
  collection, persisted rejection on reload. Block the loader: site navigation
  continues without uncaught errors.
- Enter `/admin` and dashboard routes directly and from public links/history:
  clean document, no loader/events, sign-in works. Stage/local never load it.
- Check delivered CSP using `curl -sSI https://robotmoney.network/privacy` and
  direct `/admin`: `script-src 'self' 'unsafe-eval'`, `connect-src 'self'` must
  remain effective after Cloudflare transformations. Read-only inspection on
  2026-10-14 18:14 UTC confirmed `/privacy` delivered this origin policy through
  Cloudflare; recheck after account activation. No Google/GTM allowlist is
  needed. Do not relax CSP for Zaraz tools that request external browser code.

CI uses the real adapter in 32+ unit cases and an intercepted production SPA
with the nginx policy as a response header. The same-origin fixture executes
and POSTs; Google/GTM scripts are blocked. These fixtures prove engineering
behavior and CSP compatibility, not the unconfigured account's edge delivery.
Live account verification above is required during rollout.

## Rollback

Disable the GA4 tool in Zaraz first (stops forwarding for already-open tabs).
Deploy `enabled: false`, purge the affected site assets using the standard release
process, and keep auto-injection off. Existing tabs can retain loaded code until
reload; server-side disabling is essential. Remove unexpected auto actions and
review the exported account config before re-enabling. Saved choices may remain;
increment `CONSENT_VERSION` if a new consent decision is needed.

## Authoritative API references

- [Manual loading](https://developers.cloudflare.com/zaraz/advanced/load-zaraz-manually/)
- [Track API and action field interpolation](https://developers.cloudflare.com/zaraz/web-api/track/)
- [Consent API readiness and purpose setting](https://developers.cloudflare.com/zaraz/consent-management/api/)
- [Settings, automatic SPA behavior and privacy controls](https://developers.cloudflare.com/zaraz/reference/settings/)
- [Google Consent Mode](https://developers.cloudflare.com/zaraz/advanced/google-consent-mode/)
