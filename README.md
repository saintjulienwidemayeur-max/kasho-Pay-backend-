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
| `submitKyc` | save identity details (files are uploaded by the app to the private `kyc-documents` bucket) |
| `startDeposit` / `syncTransaction` | MonCash / NatCash top-up (`/v1/payments`) and status check |
| `startWithdrawal` | wallet to MonCash / NatCash (`/v1/payouts`), fee `WITHDRAW_FEE_PERCENT` |
| `searchUsers` / `sendMoney` | Kasho to Kasho transfers by `@username` |
| `createHolderFn` | step 1 of cards: register the card holder (`/v1/cards/holders`), stored in `card_holders` |
| `createCardFn` `syncCardFn` `fundCardFn` `withdrawCardFn` `freezeCardFn` `terminateCardFn` `updateCardFn` `revealCardFn` `cardTransactionsFn` | virtual cards (`/v1/cards`) |
| `fileDisputeFn` / `sendSupportMessage` | disputes and support |

Other routes: `GET /health`, `POST /api/webhooks/freda` (signed by Freda, no token).

## How money stays safe

- Wallet balance changes only through atomic SQL functions (`kasho_debit`, `kasho_complete_tx`,
  `kasho_fail_tx`, `kasho_transfer`). The browser can only read its own rows (RLS).
- An ambiguous provider error (timeout / 5xx) never refunds automatically: the transaction stays
  `pending`. A background loop (every 30 s) re-checks pending deposits, withdrawals and card
  creations with Freda and settles them, so webhooks are optional.
- Payout references are reused on retry, which Freda treats as idempotent (no double payment).

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
