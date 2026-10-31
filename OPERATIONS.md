# Operations checklist (things that live outside the code)

## 1. Public HTTPS URL for webhooks
Freda and Didit must reach your backend. Locally use a tunnel (`cloudflared tunnel --url http://localhost:4000` or `ngrok http 4000`), in production deploy behind HTTPS.
- Freda: `npm run webhook:register -- https://<url>` then put the printed `whsec_...` in `FREDA_WEBHOOK_SECRET`.
- Didit: Console > Webhooks > `https://<url>/api/webhooks/didit`, copy the secret into `DIDIT_WEBHOOK_SECRET`.
Without webhooks everything still settles through the 30 second reconcile loop and the KYC polling.

## 2. SMTP (auth emails)
Supabase default mailer is limited to a few emails per hour and lands in spam. Supabase > Authentication > SMTP Settings: use Resend, Postmark, SendGrid or Amazon SES with a verified domain (SPF, DKIM, DMARC).

## 3. CAPTCHA
Supabase > Authentication > Attack Protection > enable CAPTCHA (Cloudflare Turnstile or hCaptcha), add the secret there. The frontend sign up, login and reset forms must then send `options: { captchaToken }`: add the Turnstile widget to those forms (needs your site key).
Also enable there: leaked password protection, minimum password length 8+, "Secure password change", "Secure email change".

## 4. Monitoring and alerts
- Uptime: ping `GET /health` (UptimeRobot, Better Stack).
- Errors: add Sentry (`@sentry/node`) in `src/index.ts`; alert on `[reconcile]`, `[webhook]` and `[didit webhook]` log lines.
- Business alerts: a daily query on `transactions where status='pending' and created_at < now() - interval '1 hour'` and on `meta->>'needs_review'`.

## 5. Backups
- Supabase Pro: daily backups + Point in Time Recovery. Free plan: schedule `pg_dump` yourself.
- Back up `.env` secrets in a password manager, especially `DATA_ENCRYPTION_KEY` (lost key = ID numbers unreadable).
- Delete uploaded KYC images older than your retention period (new KYC images stay at Didit, not in your bucket).

## 6. Supabase Auth toggles (dashboard, cannot be set from code)
Authentication > Sign In / Providers > Email:
- Secure email change: ON (both the old and new address must confirm)
- Secure password change: ON (a recent login is required to change the password)
- Also Authentication > Multi-Factor: TOTP enabled.

## 7. Going live with Freda Pay Issuing
- Live key: `FREDA_API_KEY=sk_live_...` (Render). The account must have Live (KYC/KYB) and **Issuing Live** approved, otherwise Freda answers `LIVE_NOT_ENABLED` / `ISSUING_LIVE_NOT_ENABLED` (users see "temporarily unavailable").
- Webhook: a test-key webhook is not a live one. Run `npm run webhook:register -- https://<backend>` with the live key and put the new `whsec_...` in `FREDA_WEBHOOK_SECRET`. Events used: `payment.*`, `payout.*`, `card.created`, `card.failed`, `card.frozen`, `card.unfrozen`, `card.terminated`, `card.balance_updated`, `card.transaction`.
- Master Wallet (cards): deposit real USD in the Freda dashboard. 50 USD of it stays locked as the guarantee, only the rest (`spendable`) pays card creations ($10 + prefund) and top-ups. In Live only a real deposit credits it. The backend prints the figures at startup and logs `[master-wallet] LOW` (alert threshold `MASTER_WALLET_ALERT_USD`): watch for that line.
- Gateway balance (HTG) funds withdrawals to MonCash / NatCash: Freda sends them one at a time, about 2 minutes apart, so several withdrawals take a while to arrive.
- Fees: Freda charges 5 % on payouts and $0.50 when a card is closed; make sure the fee schedule (`fee_rules`) covers your costs.
- Run every new migration before deploying (latest: `20261031000000_kyc_doc_back.sql`).
