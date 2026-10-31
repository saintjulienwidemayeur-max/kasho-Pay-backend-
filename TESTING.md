# Manual test checklist (real services)

Automated tests (`npm test`) cover the logic with fakes. These flows need a real Supabase project, a Freda **sandbox** key (`sk_test_...`),
a Didit workflow and a real mailbox, so they must be run by a person once before going live. Use two test accounts (A and B).

Before starting: run every file in `supabase/migrations/` in order, set `.env` (see `.env.example`), start the backend and the frontend.

## 1. Sign up and email confirmation
- [ ] Sign up A with a real mailbox: the confirmation email arrives, the link opens the app, "I have verified my email" works.
- [ ] Before confirming, money endpoints answer "Please verify your email first."
- [ ] Wrong email/password shows one error toast; a correct login works.

## 2. Password reset
- [ ] "Forgot password" sends an email; the link opens `/reset-password`; the new password (8+ chars, matching confirmation) works and the old one does not.
- [ ] After changing the password in Security, a second browser logged in as A can no longer refresh its session (it is signed out within about an hour).

## 3. Identity verification (Didit)
- [ ] "Verify identity" opens the Didit page, finishing it returns to `/kyc`, status becomes verified (webhook or polling), name becomes locked.
- [ ] A rejected check shows "Verification declined" and can be retried.

## 4. Money flows (sandbox)
- [ ] Deposit $10 by MonCash: fee $0.80, wallet gets $9.20. Same for NatCash.
- [ ] Deposit $3 and $150 are refused with the min/max message.
- [ ] Withdraw $10: wallet pays $10.70 after password confirmation; wrong password shows the inline error.
- [ ] Transfer A to B of $10: A pays $10.15, B receives $10.00; repeating the same request (double click) sends only once.
- [ ] Create a card (fee $10 + prefund), fund it ($2.30 fee), move money back ($2.15 fee), reveal details with the 4-digit code, freeze, close.
- [ ] Close a card holding $12: the dialog mentions the $0.50 closing fee, the wallet gets $11.50, the closing row shows fee $0.50, a card with less than $0.50 left gives back nothing.
- [ ] Turn on 2FA for A: transfers, card actions and withdrawals now ask for the 6-digit code once, then continue.
- [ ] Admin: add B to `public.admins`, turn on 2FA, change a fee in the admin API; an admin without 2FA is refused.

## 5. QR
- [ ] A's receive QR scans from B's phone camera and opens the transfer screen with A selected.

## 6. Language and layout
- [ ] Switch to French: amounts show as `10,00 $`, no English left on the screens above, no console hydration error.
- [ ] 360 px wide phone: no horizontal scroll on any screen.

Report anything that fails with the screen, the exact steps and the browser console / backend log lines.
