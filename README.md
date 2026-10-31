# Kasho Pay Backend

Node.js (Express + TypeScript) API for Kasho Pay. Talks to Supabase (auth, database, storage)
and to the Freda Pay Issuing API (MonCash / NatCash payments and payouts, virtual cards).

## Run it

```bash
# 1. In Supabase Dashboard > SQL Editor: paste and run supabase/migrations/20261005000000_kasho_backend.sql
# 2. Supabase > Authentication > URL Configuration:
#      Site URL: http://localhost:5173      Redirect URLs: http://localhost:5173/**
npm install
npm run dev        # http://localhost:4000
npm run smoke      # in a second terminal: checks the server, Freda key and Supabase tables
```

`.env` is already filled in (Supabase + Freda test keys). Rotate those keys after testing.

## API

All endpoints are `POST /api/<name>` with a JSON body and the header
`Authorization: Bearer <Supabase access token>`. Success: `{ "data": ... }`.
Error: `{ "error": { "message": "..." } }`.

| Endpoint | Purpose |
| --- | --- |
| `getPublicConfig` | rates, fees, minimums, sandbox flag |
| `logActivity` | write a security activity entry |
| `startDeposit` / `syncTransaction` | MonCash / NatCash top-up (`/v1/payments`) and status check |
| `startWithdrawal` | wallet to MonCash / NatCash (`/v1/payouts`), fee from the fee schedule |
| `searchUsers` / `sendMoney` | Kasho to Kasho transfers by `@username` |
| `createHolderFn` | step 1 of cards: register the card holder (`/v1/cards/holders`), stored in `card_holders` |
| `createCardFn` `syncCardFn` `fundCardFn` `withdrawCardFn` `freezeCardFn` `terminateCardFn` `updateCardFn` `revealCardFn` `cardTransactionsFn` | virtual cards (`/v1/cards`) |
| `fileDisputeFn` / `sendSupportMessage` | disputes and support |
| `adminStatus` `adminOverview` `adminFredaFunds` `adminListFees` `adminSaveFee` `adminDeleteFee` `adminListUsers` `adminGetUser` `adminAdjustBalance` `adminSetUserBlocked` `adminListCards` `adminGetCard` `adminListTransactions` `adminListSupport` `adminListAudit` | admin site (administrators only, from the admin site only, see "Admin site" below) |

Other routes: `GET /health`, `POST /api/webhooks/freda` (signed by Freda, no token).

## How money stays safe

- Wallet balance changes only through atomic SQL functions (`kasho_debit`, `kasho_complete_tx`,
  `kasho_fail_tx`, `kasho_transfer`). The browser can only read its own rows (RLS).
- An ambiguous provider error (timeout / 5xx) never refunds automatically: the transaction stays
  `pending`. A background loop (every 30 s) re-checks pending deposits, withdrawals and card
  creations with Freda and settles them, so webhooks are optional.
- Payout references are reused on retry, which Freda treats as idempotent (no double payment).

## Fees (KASHOPAY LLC billing)

Fees are rows of the `fee_rules` table (migration `supabase/migrations/20261021000000_fee_rules.sql`), not environment variables, so the admin page can change them. Defaults:

| Operation | Fee |
| --- | --- |
| Card creation (`card_creation`) | $10.00 |
| Wallet top-up (`wallet_deposit`) | $5-10: $0.80 · $10-25: $1.15 · $25-50: $1.50 · $50-100: $2.00 |
| Wallet withdrawal (`wallet_withdrawal`) | $5-10: $0.70 · $10-25: $1.00 · $25-50: $1.25 · $50-100: $1.75 |
| Virtual card top-up (`card_fund`) | $2.30 |
| Virtual card withdrawal (`card_withdraw`) | $2.15 |
| Kasho to Kasho transfer (`transfer`) | 1.5 % per transaction |

Who pays: top-up fee is kept from the amount credited (pay $10, wallet gets $10 - fee); withdrawal, card top-up and transfer fees are added on top (the wallet pays amount + fee); the card withdrawal fee is taken from the amount moved back to the wallet. Closing a card returns its balance minus Freda's closing fee ($0.50, never more than what is left on the card; `CARD_CLOSURE_FEE_USD`): the wallet is credited exactly what Freda sends back to the Master Wallet (`refunded_usd`). Brackets match when `min <= amount <= max`; a shared boundary ($10) belongs to the lower bracket. Top-ups and withdrawals outside the brackets ($5-$100) are refused. Fees are re-read on every request, so a change applies immediately. `getPublicConfig` returns the schedule (`fees`) for the app.

Admin page API: add yourself once in the SQL editor (`insert into public.admins (user_id) values ('<auth user uuid>');`), then call `adminListFees`, `adminSaveFee` (create when no `id`, otherwise update; sends `confirmPassword`) and `adminDeleteFee`. The server validates brackets (no overlap, one fee for non-bracket operations).

## Cards and KYC

Card creation does **not** need KYC by default (`REQUIRE_KYC_FOR_CARDS=false`): the app only asks for the
holder details Freda Issuing requires (name, date of birth, ID number, phone, country, address).
To require identity verification again, set `REQUIRE_KYC_FOR_CARDS=true`, then approve users with:

```sql
update public.profiles set kyc_status = 'verified' where id = '<user uuid>';
```

## Webhook (optional)

Expose port 4000 with a tunnel, register `https://<tunnel>/api/webhooks/freda` with Freda
(`POST /v1/webhooks`), and put the returned `whsec_...` in `FREDA_WEBHOOK_SECRET`.

## Identity verification (Didit)

KYC uses Didit (https://docs.didit.me): hosted ID document scan, liveness and face match.

1. In the Didit Console create a Workflow (ID verification + Liveness + Face match) and copy its ID into `DIDIT_WORKFLOW_ID`.
2. `DIDIT_API_KEY` is already in `.env`.
3. For results to arrive instantly, add a webhook in the Didit Console pointing to `https://<public-backend>/api/webhooks/didit` and put its secret in `DIDIT_WEBHOOK_SECRET`. Locally (no public URL) it still works: the frontend polls `syncKyc` every 6 seconds.
4. Run `supabase/migrations/20261008000000_didit_kyc.sql` in the Supabase SQL editor (or use `kasho-pay-sql-patch.sql`).

Flow: `createKycSession` -> user is sent to the Didit link -> returns to `/kyc` -> `syncKyc` / webhook reads the decision from Didit (never trusts the payload) -> `kyc_status` becomes verified / rejected.

## Cards require a verified identity
`REQUIRE_KYC_FOR_CARDS=true` (default). Once the Didit check is approved the user taps "Create a card": if no card holder exists, the backend creates it automatically with everything Freda requires (name, birth date, ID number, country from the verified profile; email from the account; phone and address from the profile or the small form in the card dialog) and then issues the card with that exact `holder_id`.

Run `supabase/migrations/20261009010000_card_code.sql` (or `kasho-pay-card-code.sql`) before using card reveal.

## Deploy on Render

Create a **Web Service**, language **Node**, repo root = this folder (leave Root Directory empty). Build command `npm install`, start command `npm start`. Enter the variables from `.env.example` in Environment (do not set PORT; set NODE_ENV=production). `package.json` must be at the root of the repository.

## Latest hardening (migration `20261021020000_remaining_fixes.sql`, run it after the previous ones)
- Admin (fees) endpoints need a verified 2FA factor and an aal2 session; fee caps: flat <= $100, percent <= 20.
- `ENFORCE_MFA_ALL` now defaults to `true`: a user with a verified TOTP factor must pass the 2FA code (aal2) for all money / personal-data endpoints. Refusals are always HTTP 403 `{ error: { code: "MFA_REQUIRED" } }`; the app asks for the code and retries.
- `getIdentity` needs `confirmPassword` in the request body (password step-up).
- `sendMoney` accepts an optional `idempotencyKey` (8-64 chars `A-Za-z0-9_-`, one per send). A retry with the same key returns the original `reference` and never sends twice. Needs the migration (`transactions.idempotency_key`, 7-argument `kasho_transfer`).
- Pending money is now recovered automatically: an ambiguous `card_fund` is replayed (same Freda `reference`) for 24 h, a card creation without a Freda card id is replayed with the same `reference`. Underpaid deposits are not credited, are flagged `meta.underpaid / needs_refund` and logged.
- `changePassword` signs out all other sessions of the user.
- Legacy `kyc-documents` storage policies dropped (the backend only uses the private `kyc-docs` bucket).

## Freda Issuing docs update of 30 Oct 2026 (migration `20261031000000_kyc_doc_back.sql`)
What changed in https://issuing.fredapay.com/docs and what the backend does about it:
- **Card closing fee**: `POST /cards/:id/terminate` and the `card.terminated` webhook now give `refunded_usd` and `closure_fee_usd` ($0.50, never more than what is left on the card). The closing row carries that fee, so the wallet gets what really came back (before, it was credited the full balance and the platform paid the fee). The app shows the fee before the user confirms (`getPublicConfig.cardClosureFeeUsd`).
- **ID document back**: `identity.imageBackUrl` is required for some countries. The back of the ID is now saved from Didit (`profiles.kyc_doc_back_path`, `''` = the document has no back) and sent with the front. Users verified earlier are refreshed from Didit the first time a holder is created. Run the migration; until then everything works without the back.
- **`card.failed`**: `failure_reason` and `verification_link` (+ expiry) are kept in the creation transaction's `meta` (`card_failure_reason`, `verification_link`) for support. Users still see the fixed "We could not create your card" message and are refunded.
- **`card.balance_updated`, `card.transaction`** (now with `card_balance`): the card is re-read from Freda and its balance refreshed (never trusting the payload). `card.transaction` names the card in `card_id`.
- **Master Wallet** (`GET /v1/master-wallet`): Freda locks a guarantee deposit (50 USD by default) in it; only `spendable_usd` can pay card creations and top-ups (`BELOW_MINIMUM_BALANCE` otherwise). The backend prints it at startup and logs `[master-wallet] LOW` every 30 minutes while it is below `MASTER_WALLET_ALERT_USD` (default 25) or Freda says `low_balance`.
- Not used by Kasho Pay: crypto wallets (`/v1/crypto/*`), business cards (`BUSINESS_CARDS_PAUSED`).

## Web Push notifications (migration `20261025000000_push_subscriptions.sql`)
- Setup: run `npm run vapid:generate`, put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or https URL) in the environment (Render: dashboard, `sync: false`), run the migration. Without the keys push is silently disabled (one startup warning).
- Endpoints: `savePushSubscription`, `removePushSubscription`, `sendTestPush` (3/min); `getPublicConfig` returns `pushPublicKey` (or null).
- What is sent: every in-app transaction notification (same title/body as the notifications table, in French or English depending on the device language) and one "Bonjour" greeting per device per local day between 08:00 and 10:59 (device time zone, default America/Port-au-Prince).
- The morning greeting contains the first name only: never a balance or an amount (lock screens are visible to others). Transaction pushes do contain the amount, like the in-app notification; users can turn push off with `notification_prefs.push = false`.
- Who can receive: only the authenticated owner of a subscription; one endpoint belongs to one user (re-registering from another account moves it); max 10 devices per user.
- Safety: the table is server-only (RLS on, no policies). Endpoints must be https on a known push service (FCM, Mozilla, Apple, Windows) so the server cannot be used to call arbitrary URLs; keys are length-checked; endpoints, keys and message bodies are never logged. Dead subscriptions (404/410) are deleted, others after 5 consecutive failures. The greeting is claimed in the database before sending, so a restart or several instances never greet twice.
- Rotating VAPID keys: generate a new pair, update the three variables, redeploy. Old subscriptions stop working and are removed on their next failed send; users must re-enable notifications.

## Admin site (migration `20261101000000_admin_panel.sql`)
The admin is its **own site**, a separate repository (`admin-page-kasho-pay`: own domain, own login with 2FA), not a page of the Kasho Pay app. It talks to this same backend (one database, one place for the money logic) and to the same Supabase project. Run the migration, create the first super administrator (OPERATIONS.md, section 8), then set `ADMIN_ORIGINS`.
- **Separation**: set `ADMIN_ORIGINS` to the admin site origin (for example `https://admin.kashopay.com`; it is also allowed by CORS automatically). Every `admin...` endpoint answers only to a request whose `Origin` is in that list (code `ADMIN_SITE`): the customer app, other sites and scripts without an Origin are refused, so a session stolen through the customer app cannot use the admin tools. The other way round, the admin site reaches only the admin tools and `changePassword`. With `ADMIN_ORIGINS` empty the tools are open in development and **off in production** (the startup log says so). The browser session of the admin site lives on another origin, so nothing in the customer app can read it.
- **Roles** (`admins.role`): `super` has full access; `admin` can read everything and manage the customer fee schedule. Only a `super` can add or remove customer money, suspend a customer or change Freda's prices.
- **Access rules**: a row in `public.admins` + a verified 2FA (TOTP) factor + an aal2 session (`adminStatus` works without 2FA so the site can say what is missing, everything else needs it). Moving money, suspending, and fee / price changes ask for the password again (`confirmPassword`). All admin endpoints are rate limited. Nothing the site receives contains ID documents or full card numbers.
- **Audit**: every change writes a row in `admin_audit` (who, what, which customer, IP). The table is append-only: not even the backend's service role can update, delete or truncate it.
- **Freda money** (`adminFredaFunds`, also inside `adminOverview`): reads `GET /v1/master-wallet` (cards) and `GET /v1/balance` (MonCash / NatCash Gateway, HTG and USD) with the server's API key, cached for 15 s. "Do we hold enough?" compares what Freda holds with what the customer wallets add up to.
- **No profit figures, on purpose.** The admin site shows real numbers only: the Master Wallet and Gateway balances read from Freda, what customers hold, counts, and what administrators did. Profit, margin and "what the partner earns" were removed because they were estimates from a price list, and with real money a figure that is not exact is worse than none. What the partner really charged is still **recorded** per operation (`meta.fee_htg` on deposits, `meta.payout_fee_htg` on withdrawals, `meta.provider_fee_usd` on card top-ups and withdrawals, and `card_events` for card purchases), so a correct calculation can be built later from real data once its rules are agreed. The tables `partner_costs` and `app_settings` of the migration are no longer used by the code.
- **Fees tab**: the customer fee schedule (`fee_rules`): what customers pay for each operation; add, edit, remove (password asked again).
- **Cards tab** (read only): every card the platform issued (`adminListCards`: search by label, last 4 digits, reference or customer name / @username / Kasho ID, filter by state and brand, newest first, with a summary of the whole fleet) and one card (`adminGetCard`: owner, balance, state, the ledger rows that moved money to or from it, the purchases reported by Freda). A frozen card is `disabled` in the database. No card number or CVV: the platform does not store them.
- **Customers tab**: search by name, e-mail, @username, Kasho ID or phone, then:
  - **Add / remove money** (`adminAdjustBalance` → `kasho_admin_adjust`): one atomic SQL function (balance change + ledger row `admin_credit` / `admin_debit` + audit row). A reason is required, the balance never goes below zero, one adjustment is limited to `ADMIN_MAX_ADJUST_USD` (default 10 000), nobody can adjust their own account or another administrator's, and the customer gets a "Balance adjusted" notification. **This changes the Kasho Pay wallet only: no money moves at Freda.** Keep the Master Wallet and the Gateway funded for what customers hold.
  - **Suspend / reactivate** (`adminSetUserBlocked`): sets `ban_duration` in Supabase Auth, and every API request of that customer is refused at once (`isSuspended` in `requireAuth`, code `ACCOUNT_SUSPENDED`; the login screen says the account is suspended). Their money stays where it is. Administrators cannot be suspended here.
- **Transactions, Support and Audit log tabs** are read-only lists (search by reference, title or Freda id; disputes and support messages; the audit log).
