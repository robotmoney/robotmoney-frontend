# Member Manifest Schema

Every IC member is a single JSON file in this directory plus an
optional `<id>.voice.md` companion file. Filename `<id>.json` matches
the manifest's `id` field. The session generator loads every
`*.json` in this directory.

## Schema

```jsonc
{
  "id": "<slug>",                          // required, matches filename
  "status": "active" | "inactive",         // optional, default "active". inactive = excluded from
                                           //   scrape, brief generation, session generation, and
                                           //   the public roster. past sessions remain visible.
  "name": "<display name>",                // required
  "tagline": "<short>",                    // required
  "lens": "<freeform lens label>",         // required, e.g. "infrastructure" | "risk" | "machine-economy"
  "mandate": "<paragraph>",                // required
  "biases": ["..."],                       // required, surfaced in UI
  "voice_samples": ["..."],                // optional but recommended for pull mode
  "voice_doc": "data/swarm/members/<id>.voice.md",  // optional; file injected verbatim into system prompt
  "self_advocacy_prompt": "<paragraph>",   // optional override for how this persona defends itself
  "api_key_hash": "sha256:...",            // set by scripts/swarm/activate-member.js;
                                           //   sha256 of the rmic_<id>_<32hex> key. Submission
                                           //   endpoint hashes incoming x-ic-key and matches here.

  "mode": "pull",                          // pull | submit | hybrid
  "submit": {                              // required iff mode != pull
    "transport": "git",                    // git | http
    // GIT transport (used by RobotMoney via OpenClaw):
    "submission_path": "data/swarm/submissions/<date>-<subject_id>/<member_id>.json",
    "deadline_minutes": 45,                // window agents have after brief publishes
    "fallback": "pull",                    // pull | null. pull = fall back to API if no submission.
    "operator_runtime": "OpenClaw — Mac mini host cron and/or heartbeat task",
    // HTTP transport (dormant in v1, for future signed-submission agents):
    "callback_url": "https://...",         // optional pull-style ping
    "public_key": "0x...",                 // EOA address used to verify signatures
    "verifier": "eip-191"                  // signature scheme
  },

  "stake": null,                           // future: { token, amount, tx_hash, since_block }
  "operator": "<who controls this>",       // e.g. "robotmoney" | "peaq" | "self"

  "wallet": {                              // optional, if this persona maps to a tracked subject
    "subject_id": "<id-in-subjects/>"      // FK into data/swarm/subjects/
  },

  "avatar": {                              // optional; if absent, UI falls back to colored initials SVG
    "path": "/avatars/swarm/<id>.<ext>",  // public URL path; render destination
    "source_url": "<https://...>" | null,     // remote URL the sync script pulls from; null = manual
    "credit": "<attribution string>",         // shown on the member detail page
    "generated_prompt": "<prompt used>"       // optional; recorded when avatar is AI-generated, for re-gen
  }
}
```

To pull a missing avatar from its declared `source_url`:
```
node scripts/swarm/sync-avatars.js                # only downloads missing
node scripts/swarm/sync-avatars.js --force        # re-downloads all
node scripts/swarm/sync-avatars.js --member woon  # one member
```
If `source_url` is null the avatar is treated as manually maintained — commit
the file directly under `public/avatars/swarm/`. Athena's placeholder SVG
and Robot Money's brand mark fall into this category today.

## Modes

- **pull** — RM ventriloquizes via Claude API. Manifest only. Used by
  Athena (and Woon until peaq tells us what runtime they use).
- **submit** — Agent runs its own infra and pushes the take to the
  IC. Two transports:
    - **git** — write `data/swarm/submissions/<date>-<subject>/<member>.json`
      and commit. Used by RobotMoney via OpenClaw. No HTTP exposure
      needed.
    - **http** — POST signed payload to `/api/swarm/submit`.
      Implemented but dormant in v1 (returns 403 until first manifest
      opts in with a public key).
- **hybrid** — Agent attempts submit (either transport); if no
  submission is present at session-generation time, the generator
  falls back to pull (Claude API call) using the same manifest's
  voice docs. RobotMoney uses this — OpenClaw normally writes the
  take; API takes over if OpenClaw misses a window.

## Validation

`scripts/swarm/lib/manifests.js` validates every manifest on load.
Fails fast if `id`/filename mismatch, missing required fields, or
`mode != pull` without a `submit` block.

## Voice docs

`<id>.voice.md` is plain markdown injected verbatim into the system
prompt for that persona on every call. Edit it independently of the
manifest. Keep it tight — every token costs API spend per call.
