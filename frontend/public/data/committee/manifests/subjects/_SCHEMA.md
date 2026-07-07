# Subject Manifest Schema

Each IC subject is a single JSON file in this directory. Filename
`<id>.json` matches the manifest's `id` field.

## Schema

```jsonc
{
  "id": "<slug>",                           // required, matches filename
  "status": "active" | "inactive",          // optional, default "active". inactive subjects are
                                            //   skipped by scraper, brief generator, session
                                            //   generator. past sessions remain visible.
  "name": "<display name>",                 // required
  "operator": "<who runs this entity>",     // required, e.g. "peaq" | "robotmoney"
  "homepage": "https://...",                // optional but recommended
  "thesis_blurb": "<paragraph>",            // required, shown on subject page + sessions
  "wallets": [                              // required, at least one
    {
      "address": "0x...",
      "chain": "base",                      // base | peaq (extend chains.js to add more)
      "label": "<freeform>"                 // e.g. "main", "holdings", "treasury"
    }
  ],
  "nft_contracts": [                        // optional, declared not read in v1
    { "address": "0x...", "chain": "peaq", "label": "..." }
  ],
  "source": {
    "type": "rpc"                           // rpc | manual | vault_tvl | framework
  },
  "recommendation_type": "position_actions",// position_actions | bucket_weights — controls the IC's recommendation shape for this subject
  "linked_member_id": "<id>",               // optional FK; if set, that member writes in self-advocacy mode when this subject is selected
  "structural_notes": ["..."],              // optional, surfaced in every session brief for personas to riff on
  "last_reviewed": "YYYY-MM-DD"             // optional; for manual subjects, when the manifest was last hand-checked
}
```

## Source types

- **rpc** — Scraper at `scripts/committee/hourly-subject-balances.js`
  reads each wallet's `balanceOf` for every token in the universe via
  the chain's RPC. Default for agent subjects.
- **framework** — Subject has no portfolio to scrape. The "state" is the
  allocation framework file (`data/committee/allocation.json`) itself. The
  scraper skips framework subjects; the brief generator pulls the
  framework state in directly; the committee reviews whether the
  published targets should change at both the bucket and within-bucket
  layers. `wallets[]` must be empty.

- **vault_tvl** — Subject positions come from
  `public/data/hourly-vault-tvl.csv` (the existing vault TVL scraper),
  not from RPC `balanceOf`. Used for the Robot Money vault, which
  holds depositor capital across sleeves rather than direct ERC20
  positions.
- **manual** — Positions hand-maintained in the manifest with a
  `positions_manual` field plus a `last_reviewed` date the UI
  surfaces. Used when a subject has holdings on chains the scraper
  doesn't yet support.

## Recommendation types

- **position_actions** — IC produces per-position actions
  (add / trim / hold / rotate). Use for agent subjects holding mixed
  portfolios where bucket weights wouldn't fit cleanly.
- **bucket_weights** — IC produces target weights for the 4 vault
  buckets (Conservative DeFi / Agent Tokens / Protocol Tokens / RWA).
  Use for vault subjects where the buckets framework applies.

## Adding a subject

1. Create `data/committee/subjects/<id>.json` matching this schema.
2. If the subject holds tokens not yet in the universe, add them to
   `scripts/hourly-prices.js` ASSETS and the new scraper's ERC20 list.
3. If the subject is on a chain not yet in `scripts/committee/lib/chains.js`,
   add it.
4. Next daily-committee-session run will pick the subject up via the
   rotation in `scripts/committee/select-subject.js`.

## Subject-member overlap

When `linked_member_id` is set, this subject IS that member. The
session generator handles two cases:

- Subject selected for the day, persona is not the linked member →
  persona writes a regular take.
- Subject selected for the day, persona IS the linked member → persona
  writes last in **self-advocacy mode**, sees the other takes, and
  defends. Not recused.

Athena has no `linked_member_id` because she holds no portfolio and
can never be a subject.
