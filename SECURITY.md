# Kasho Pay backend: security status

## Covered (and how it was checked)

| Area | Protection | Checked |
| --- | --- | --- |
| Authentication | Every `/api/*` call needs a valid Supabase token; unconfirmed emails are refused (403) | code review |
| Handler lookup | Own-property lookup only (`/api/constructor` used to crash the server) | unit test |
| KYC uploads | Path must be `<ownUserId>/<safe file>`, file must exist in storage | unit test + review |
| Disputes | Transaction must belong to the caller; title and amount come from the database | review |
| Webhook | HMAC-SHA256 on the raw body, constant-time compare, empty secret never validates, duplicate event ids ignored | unit test |
| Money | Balance changes only through atomic SQL functions with row locks; unknown provider outcomes are never auto-refunded | review (SQL not run, see below) |
| Rate limits | 300/min per IP, 120/min per user, tighter per action (reveal 10/min, withdraw 5/min, KYC 5/hour...) | unit test |
| Daily caps | `DAILY_TRANSFER_LIMIT_USD`, `DAILY_WITHDRAW_LIMIT_USD` (rolling 24h) | review |
| Headers | nosniff, frame deny, CSP none, HSTS in production, `no-store` on API answers | unit test |
| CORS | Listed origins only; LAN origins only outside production | unit test |
| Input | JSON only (415 otherwise), 100 KB body limit, zod schemas, clean errors without stack traces | review |
| Secrets | Service role and Freda key only in this backend `.env`; the frontend has none | review |
| Logs | No card number, CVV or holder payload is logged | review |
| Database | RLS on every table, browser has select only (plus a few harmless columns), `kyc_status` and balances are server only | review |

Run the unit tests: `npm test`. Run the live probes against a running server: `npm run smoke`.

## Not verified yet (could not run here, no network)

- The SQL migration was never executed on a real Postgres.
- The full server was never started (npm registry blocked in the build sandbox).
- Nothing was tested against the real Freda or Supabase APIs.

## Added in this round
- Step-up: revealing a card, withdrawing to MonCash/NatCash, changing the password and reading the ID number (`getIdentity`) require the account password (re-checked by the server against Supabase, 5 wrong tries lock it for 15 minutes). If the user enabled 2FA (TOTP), the session must also be `aal2`, otherwise the server answers `MFA_REQUIRED`.
- Password change now goes through the server (`changePassword`), so the check cannot be skipped from the browser.
- ID numbers are encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`) before being stored. Existing rows: run `npm run encrypt:existing` once. Back up the key: without it the values are unrecoverable.
- Card withdrawals and card closures write the ledger row BEFORE calling Freda and record the card balance seen at that moment. If the server dies in between, the reconcile loop compares the real Freda balance (or card status) with it: money moved -> wallet credited once; nothing moved after 10 minutes -> closed without credit. No manual step.
- `npm run webhook:register -- https://<public-url>` registers the Freda webhook (`POST /v1/webhooks`) and prints the `whsec_` secret.
- Old manual KYC upload (`submitKyc`) removed: less attack surface.

## Added in the remaining-fixes round (migration `20261021020000_remaining_fixes.sql`)
- Admin fee endpoints: the admin must have a verified TOTP factor AND an aal2 session ("Turn on two-factor authentication to manage fees."). Fee rules are capped (flat <= $100, percent <= 20).
- `ENFORCE_MFA_ALL` defaults to TRUE. Users with a verified TOTP factor need an aal2 session for every endpoint in `MFA_ENDPOINTS`; the refusal is always HTTP 403 with `code: "MFA_REQUIRED"`. Users without 2FA are unaffected (except admins). Set `ENFORCE_MFA_ALL=false` to disable.
- `getIdentity` (returns the decrypted ID number) needs the password re-check: the frontend must send `confirmPassword`.
- Error and log hygiene: unknown Freda codes and Didit errors give generic user messages (fixed allow-list of known codes only); the "insufficient funds" shortcut applies only to the payer's mobile-money case, never to platform or card balances; logs never contain Freda request/response bodies, e-mails or identity data (code, status and message only).
- `sendMoney` idempotency key (unique per user in the database): a retried request cannot send twice.
- Stuck pending money: ambiguous card fundings and card creations are replayed with the same Freda `reference` (idempotent) by the reconcile loop; fundings older than 24 h stay flagged `needs_review` and are logged hourly. Underpaid deposits are never credited: `meta` gets `underpaid`, `paid_htg`, `expected_htg`, `needs_refund`; support must refund by hand (query: `select * from transactions where meta->>'needs_refund' = 'true'`).
- `changePassword` revokes the user's other sessions (`auth.admin.signOut(token, "others")`). Access tokens already issued to those sessions stay valid until they expire (default 1 h) but cannot be refreshed.
- Legacy `kyc-documents` storage policies removed. `package-lock.json` is committed; `npm audit` reports 0 vulnerabilities.

## Still missing before real customers
1. Rotate every key that was pasted in chat (Supabase service role, Freda secret, Didit key).
2. An admin tool to review transactions flagged `needs_review` / `needs_reconcile` (today: manual SQL). KYC is decided by Didit.
3. Rate limiter store shared between instances (Redis) if you run more than one server.
4. Infrastructure that code cannot do for you, see OPERATIONS.md: SMTP provider, CAPTCHA, monitoring and alerts, backups, public HTTPS URL for webhooks.
5. Supabase settings I cannot change from here (dashboard only): Authentication > Sign In / Providers > Email: enable "Secure email change" and "Secure password change". Email change now goes through the server (`changeEmail`: password + 2FA), and the reset-by-email page asks for the 2FA code, but a determined attacker holding a session could still call Supabase directly until those two toggles are on.
6. Anti-fraud rules beyond the daily caps (new account cooling period, velocity, device checks).
7. Legal pages, privacy policy, data retention rules.

## Didit KYC
- API key only in backend `.env`; browser only receives the hosted session URL (https enforced client side).
- Webhook: HMAC-SHA256 (raw body or canonical JSON), 5 minute timestamp window, constant-time compare; the payload is never trusted, the decision is re-fetched from Didit and its `vendor_data` must equal the session owner.
- A verified user is never downgraded by a later event. Rate limited: `createKycSession` 10/h, `syncKyc` 12/min.
- Not tested against the live Didit API from the build sandbox (no network). Exact webhook header names (`X-Signature`, `X-Signature-V2`, `X-Timestamp`) and decision field names should be confirmed with one real test session.

## Card code (4 digits)

Card details (number, CVV, expiry) are revealed only after the customer creates a 4-digit code (`setCardCode`, requires password and 2FA if enabled). The code is stored hashed (scrypt + HMAC pepper) in `card_codes`, which the browser cannot read. Revealing requires the code (`revealCardFn`) and, when 2FA is on, an aal2 session. 5 wrong codes lock reveal for 15 minutes. Trivial codes (1111, 1234, ...) are refused.

## Web Push notifications (migration `20261025000000_push_subscriptions.sql`)
- Setup: run `npm run vapid:generate`, put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or https URL) in the environment (Render: dashboard, `sync: false`), run the migration. Without the keys push is silently disabled (one startup warning).
- Endpoints: `savePushSubscription`, `removePushSubscription`, `sendTestPush` (3/min); `getPublicConfig` returns `pushPublicKey` (or null).
- What is sent: every in-app transaction notification (same title/body as the notifications table, in French or English depending on the device language) and one "Bonjour" greeting per device per local day between 08:00 and 10:59 (device time zone, default America/Port-au-Prince).
- The morning greeting contains the first name only: never a balance or an amount (lock screens are visible to others). Transaction pushes do contain the amount, like the in-app notification; users can turn push off with `notification_prefs.push = false`.
- Who can receive: only the authenticated owner of a subscription; one endpoint belongs to one user (re-registering from another account moves it); max 10 devices per user.
- Safety: the table is server-only (RLS on, no policies). Endpoints must be https on a known push service (FCM, Mozilla, Apple, Windows) so the server cannot be used to call arbitrary URLs; keys are length-checked; endpoints, keys and message bodies are never logged. Dead subscriptions (404/410) are deleted, others after 5 consecutive failures. The greeting is claimed in the database before sending, so a restart or several instances never greet twice.
- Rotating VAPID keys: generate a new pair, update the three variables, redeploy. Old subscriptions stop working and are removed on their next failed send; users must re-enable notifications.
