# Licence key / paid gate for the store build

Board #16959 (follow-up of #16955). Design only. Nothing here is built.

**Decided (Matt, console, 2026-10-18 23:43Z, q3639): "no paid version".** NarWal stays free. Option A stands. No key check, licence server or payment will be built. Options B to E below are kept as a record only; reopen them only on a new decision from Matt.

Any server, payment account or price is Tier 3 and waits for Matt's recorded words.

**Superseded (2026-10-31, board #27493): NarWal is open source under the MIT licence** (`LICENSE.md`). A licence key cannot gate MIT code, so options B to E no longer apply.

## Where things stand

- 1.0.0 shipped free, proprietary, all rights reserved (ProSoft IP); later builds are MIT. No key check, no server, no payment.
- narwal sends nothing to ProSoft IP. The only network call is the transcript, and only when the user picks OpenAI.
- Pages run under `connect-src 'none'`. The manifest has no `host_permissions` for a ProSoft IP origin.
- The privacy policy (`docs/release/privacy-policy.html`, from #16955), the Chrome data-use answers and the Edge listing all say "nothing is sent to us".

## Facts that shape the options

- The Chrome Web Store no longer sells paid extensions or in-app purchases (Google retired Chrome Web Store payments in 2020). A paid narwal needs an outside seller: a payment provider or an invoice.
- Edge Add-ons lists free extensions only. Same consequence.
- A key check in a browser extension is a speed bump, not DRM. The code ships to the user and can be edited. Design for honest customers; do not spend effort on tamper resistance.

## Decisions Matt owns

1. Free or paid.
2. Per seat or per organisation.
3. Key check offline or by server.
4. Payment provider.

Decisions 2 to 4 only matter if decision 1 is "paid".

## Options

### A. Stay free (no gate)

- Cost: none. Privacy statements stay true. Nothing to change.
- Risk: none for the listing. Revenue: none.
- Undo: add a gate later; see C.

### B. Free, with a soft organisation key (unlocks nothing locked; shows the name)

- A key only labels exports ("licensed to Acme"). Nothing stops working without it.
- Needs the same key code as C but no enforcement and no server. Low value; listed for completeness. Not recommended.

### C. Paid, offline signed key (recommended if paid)

- ProSoft IP holds an Ed25519 private key offline. The extension ships only the public key.
- A key is `base64url(payload) + "." + base64url(signature)`. Payload: licensee name, plan (`org`), seat count, issued-at, optional expiry, key id.
- The extension verifies the signature with WebCrypto in the service worker. No network. No new permission. No `connect-src` change.
- The user pastes the key on the Options page. It is stored in `chrome.storage.local`.
- What is gated: Start recording after a short grace (for example 14 days from first install, or N free recordings). Saved recordings, Replay and export of existing recordings are never locked: the user's evidence must stay readable.
- Seat count is an honour clause in the licence text, not enforced. Per organisation means one key for the whole company.
- Revocation: not possible offline. Use expiry (annual keys) and ship a short deny-list of key ids with each extension update.
- Privacy impact: none. The policy, the Chrome data-use answers and the Edge listing stay as they are. The Options page and the policy gain one line: "A licence key is checked on this computer."
- Build size: about 150 lines of verify code, one Options field, one gate in the Start path, tests with a fixed test keypair. About one day.
- Issuing: a small CLI in this repo (`narwal-license sign`) run by ProSoft IP on a trusted machine. Key custody is the real risk: the private key must never enter the repo, CI or a lane. That is a Tier 3 credential step for the controller or Matt.

### D. Paid, server-checked key

- The extension calls a ProSoft IP endpoint to validate, activate and count seats, and to revoke.
- Needs: a server and database, an origin in `host_permissions`, `connect-src` for the page that calls it (or the service worker only), uptime duty, and a failure mode when the server is down.
- Privacy impact: the extension sends the key, an install id and a timestamp to ProSoft IP. In the same change: update `docs/release/privacy-policy.html`, the Chrome data-use answers, the Edge listing, and `PRODUCT.md` line "Nothing leaves the computer". Chrome re-reviews a new host permission and will ask why.
- Gains over C: real revocation, seat counting, trial keys, usage numbers.
- Cost: weeks, a running service, a support duty, and a hole in the "nothing is sent to us" claim that is currently a selling point.

### E. Payment provider (only for C or D)

The provider sells the key and emails it. Candidates, none chosen:

| Provider | Fit | Note |
| --- | --- | --- |
| Stripe Payment Links / Checkout | Needs a ProSoft IP Stripe account. Key delivery needs a webhook plus a signer. | Most control; most work. You own tax. |
| Paddle / Lemon Squeezy (merchant of record) | Handles sales tax and VAT. Can issue licence keys itself. | Fits D (their key API) or a webhook into C. Fees are higher. |
| Invoice and manual key (no provider) | Matt signs a key by hand per customer. | Fine for a handful of organisations. Zero integration. |

The first sales are likely a few organisations, so manual invoice plus offline keys (C) is enough to start and removes decisions 3 and 4.

## Recommendation

1. Keep 1.0.0 free (A). It is already scoped that way in #16955.
2. If Matt wants revenue later: C, per organisation, annual expiry, invoiced by hand. Move to a merchant of record only when manual issuing hurts.
3. Choose D only if seat counting or revocation becomes a contractual need.

## If C is approved: build plan (not started)

1. `packages/extension/src/shared/licence.ts`: parse and verify; pure, unit-tested with a fixed test keypair.
2. Options page: key field, status line ("Licensed to X until D" or "Trial: N days left").
3. Gate in the Start path only. Existing recordings stay fully usable.
4. Public key constant and key-id deny-list in source; private key never in the repo.
5. `tools/sign-licence` CLI for the offline signer.
6. Docs: one line in the privacy policy and listing: "licence key checked on this computer".

## If D is approved: the same-change checklist

- `docs/release/privacy-policy.html`: name the data sent (key, install id, time), purpose, retention, where processed.
- Chrome Web Store data-use answers and the Edge listing: match the policy.
- Manifest: the exact origin in `host_permissions`; no wildcard.
- `PRODUCT.md` and `README.md`: remove "nothing leaves the computer" where it is no longer true.
- Failure mode: server down never blocks an already activated install.
