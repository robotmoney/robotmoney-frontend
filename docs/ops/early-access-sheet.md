# Early access: the sheet behind the form

The early-access page (`/early-access`, RM-189) does not post to our API. It
posts to a Google Apps Script web app that writes each sign-up into a private
Google Sheet on the Robot Money Workspace. There is no backend code and no
database table for it.

## Set it up

1. In Google Drive on `david@robotmoney.net`, create a sheet named
   `Early access`. Share it with the team only.
2. In that sheet: Extensions, Apps Script. Replace `Code.gs` with the script
   below and save.
3. Deploy, New deployment, type Web app. Execute as: Me. Who has access:
   Anyone. Deploy and authorise.
4. Copy the web app URL (`https://script.google.com/macros/s/…/exec`) into
   `EARLY_ACCESS_URL` in
   `frontend/public/assets/js/app/alpine/views/early-access.js`.
5. The site's Content-Security-Policy must allow the browser to reach
   `https://script.google.com` and `https://script.googleusercontent.com`
   (`connect-src`). Until it does, the form works on the local preview only.

A change to the script needs a new version of the same deployment (Deploy,
Manage deployments, edit, New version), or the URL keeps serving the old code.

## What it stores

One row per handle, on a tab named `Requests`:

| Column | Notes |
| -- | -- |
| Received | First sign-up, UTC |
| Updated | Last sign-up from the same handle |
| Handle | `@name`; a pasted t.me or x.com link is stored as its handle |
| Email | Optional |
| Wallet | Optional, EIP-55 checksummed |
| Business type | `dao`, `agentic-company`, `wealth-manager`, `robotics-company`, `individual` |
| Intended deposit | `under-10k`, `10k-100k`, `100k-1m`, `over-1m` |
| Share outside stablecoins | `0`, `under-10`, `10-30`, `over-30` |
| Referral code | Raw, from the visitor's `?ref=` link |
| Source | `early-access` in production; `early-access@<host>` from a preview or staging |

- The same handle again (ignoring case and a leading `@`) updates its row. The
  first referral code it brought is kept, as the earliest attribution wins on
  chain.
- Every cell is plain text, so a handle starting with `=` is never run as a
  formula and `10-30` never becomes a date.
- A request that fills the hidden `website` field is a bot: it gets a success
  reply and nothing is written.
- Export is File, Download, CSV.

## The script

```js
const TAB = "Requests";
const HEADERS = ["Received", "Updated", "Handle", "Email", "Wallet", "Business type",
  "Intended deposit", "Share outside stablecoins", "Referral code", "Source"];
const CHOICES = {
  businessType: ["dao", "agentic-company", "wealth-manager", "robotics-company", "individual"],
  intendedDeposit: ["under-10k", "10k-100k", "100k-1m", "over-1m"],
  nonStableShare: ["0", "under-10", "10-30", "over-30"],
};

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: "body" }); }
  if (d.website) return reply({ ok: true });

  const handle = text(d.handle, 64);
  if (!/^'?@[A-Za-z0-9_]{1,32}$/.test(handle)) return reply({ ok: false, error: "handle" });
  for (const k in CHOICES) if (CHOICES[k].indexOf(d[k]) === -1) return reply({ ok: false, error: k });
  const wallet = text(d.wallet, 42);
  if (wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return reply({ ok: false, error: "wallet" });
  const email = text(d.email, 254), ref = text(d.referralCode, 64), source = text(d.source, 80);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = tab();
    const key = handleKey(handle);
    const n = sh.getLastRow() - 1;
    const handles = n > 0 ? sh.getRange(2, 3, n, 1).getValues() : [];
    const i = handles.findIndex((r) => handleKey(r[0]) === key);
    const now = new Date();
    const answers = [d.businessType, d.intendedDeposit, d.nonStableShare];
    if (i === -1) {
      sh.appendRow([now, now, handle, email, wallet].concat(answers, [ref, source]));
    } else {
      const row = i + 2;
      const prev = sh.getRange(row, 1, 1, HEADERS.length).getValues()[0];
      sh.getRange(row, 2, 1, HEADERS.length - 1).setValues([
        [now, handle, email || prev[3], wallet || prev[4]].concat(answers, [prev[8] || ref, source]),
      ]);
    }
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

function tab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TAB);
  if (!sh) {
    sh = ss.insertSheet(TAB);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.getRange(2, 3, sh.getMaxRows() - 1, HEADERS.length - 2).setNumberFormat("@");
  }
  return sh;
}

// Trimmed, capped, and never read as a formula.
function text(v, max) {
  const s = String(v == null ? "" : v).trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function handleKey(v) {
  return String(v).replace(/^'/, "").trim().replace(/^@/, "").toLowerCase();
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
```
