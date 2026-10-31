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
- Fees: Freda charges 5 % on payouts and $0.50 when a card is closed; make sure the fee schedule (`fee_rules`) covers your costs. The admin page (Fees tab) compares what you charge with what Freda charges, operation by operation.
- Run every new migration before deploying (latest: `20261101000000_admin_panel.sql`).

## 8. Admin site: the first super administrator
The admin is a separate site (repo `kasho-pay-admin`, for example at `https://admin.kashopay.com`) that uses this backend and the same Supabase project.
1. Run `supabase/migrations/20261101000000_admin_panel.sql` in the Supabase SQL editor (after the earlier migrations). It adds `admins.role`, the append-only `admin_audit`, `app_settings`, `partner_costs` (Freda's prices), `card_events` and the admin SQL functions.
2. Create the account: Supabase > Authentication > Users > Add user (tick "Auto Confirm User"; the sign-up trigger creates the profile and the wallet), then make it a super administrator in the SQL editor:
   ```sql
   insert into public.admins (user_id, role)
   select id, 'super' from auth.users where lower(email) = lower('admin@your-domain.example')
   on conflict (user_id) do update set role = 'super';
   ```
   Use a long password that exists nowhere else: this account can add and remove customer money. Do not keep scripts that contain the password in the repository.
3. Deploy the admin site (see its README: Cloudflare, build variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_API_URL`) on its own domain.
4. On Render set `ADMIN_ORIGINS` to that origin (for example `https://admin.kashopay.com`, no trailing slash) and redeploy. Without it the admin tools are off in production. CORS needs nothing more: `ADMIN_ORIGINS` is allowed automatically.
5. Open the admin site and sign in with the account of step 2. The first time it asks you to set up 2FA (scan the QR code with an authenticator app, enter the first code); after that every sign-in asks for the code. Do this right away: until 2FA is on, the password alone is enough to reach that screen.
6. Change the password in My account (it asks for the current password and signs the other devices out). Add other administrators the same way with `role = 'admin'` (read access and the customer fee schedule) or `'super'`; remove one with `delete from public.admins where user_id = '...'`.
7. Fees tab: choose the Freda Gateway and Issuing plans you really have and press "Use these plans" (Freda's public prices; edit any line that differs in your contract). The Overview shows the real Master Wallet and Gateway balances once `FREDA_API_KEY` is set (a live key shows live balances).
8. Everything done on the site is in `admin_audit` (Audit log tab). Adding or removing money there changes the Kasho Pay wallet only; it does not move money at Freda, so keep Freda funded for what customers hold.
9. Optional: `ADMIN_MAX_ADJUST_USD` (default 10000) caps one add / remove money adjustment. The admin site signs out after 20 minutes without activity and when the browser is closed.
