// All API handlers. Each one is exposed as POST /api/<name> (see index.ts).
// Every handler receives the authenticated user (verified Supabase token).
import { z } from "zod";
import * as L from "./ledger.js";
import { readCardDetails } from "./ledger.js";
import { freda, FredaError, fredaConfigured, fredaMode, pickArray, pickId, readClosure } from "./freda.js";
import { closureFee, getConfig, normalizeHaitiPhone, round2 } from "./config.js";
import { adminHandlers } from "./admin.js";
import { amountRange, computeFee } from "./fees.js";
import { decryptField, encryptField, hashCardCode, verifyCardCode } from "./crypto.js";
import { clearStepUpFailures, recordStepUpFailure, stepUpLocked } from "./stepup.js";
import { cardCodeAttemptAllowed, resetCardCodeAttempts } from "./cardcode.js";
import { MAX_SUBSCRIPTIONS_PER_USER, isAllowedPushEndpoint, pushConfigured, pushPublicKey, sendTestPush, validPushKeys, validTimeZone } from "./push.js";
import { createSession, diditConfigured, getDecision, mapStatus } from "./didit.js";
import { linkStillValid, mentionsIdentityVerification, pickVerification, safeHttpsUrl } from "./verification.js";
import * as H from "./holders.js";

export type { Ctx } from "./types.js";
type Handler = import("./types.js").Handler;
type Ctx = import("./types.js").Ctx;

const provider = z.enum(["moncash", "natcash"]);
const providerName = (p: string) => (p === "moncash" ? "MonCash" : "NatCash");
const cardColor = z.enum(["mint", "sunset", "ocean", "gold", "midnight", "forest", "chrome"]);

async function loadProfile(userId: string) {
  const { data } = await L.db.from("profiles").select("*").eq("id", userId).single();
  return data;
}

// Admin access (2FA, roles) lives in admin.ts; re-exported here for the tests that import it from this module.
export { ADMIN_MFA_MESSAGE, adminMfaOk } from "./admin.js";

/** Client-chosen key that makes a send retry-safe: 8-64 chars, letters, digits, "_" and "-". */
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** True when a stored transfer_out row is the same transfer (same recipient and amount) as the one being requested. */
export function sameTransfer(prev: { amount: unknown; counterparty_id: unknown }, toId: string, amount: number): boolean {
  return prev.counterparty_id === toId && Math.abs(Math.abs(Number(prev.amount)) - amount) < 0.005;
}

/** Freda keeps at least $1 on a card after a withdrawal (new card program). */
export const CARD_MIN_LEFT_USD = 1;
/** True when the date is the current UTC day (a card cannot be closed on the day it was created). */
export function createdTodayUtc(createdAt: unknown, now = new Date()): boolean {
  const t = new Date(String(createdAt ?? ""));
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

export const handlers: Record<string, Handler> = {
  // ---------------------------------------------------------------- config
  getPublicConfig: {
    schema: z.object({}).passthrough(),
    run: async () => {
      const c = getConfig();
      const rules = await L.feeRules();
      // Brackets of top-ups and withdrawals also set the amount range users can enter.
      const dep = amountRange(rules, "wallet_deposit");
      const wd = amountRange(rules, "wallet_withdrawal");
      return {
        htgPerUsd: c.htgPerUsd,
        // The fee schedule shown in the app (the server recomputes every fee itself when money moves).
        fees: rules.map(({ operation, feeType, minAmount, maxAmount, feeValue }) => ({ operation, feeType, minAmount, maxAmount, feeValue })),
        minDepositUsd: Math.max(c.minDepositUsd, dep?.min ?? 0),
        maxDepositUsd: dep?.max ?? null,
        minWithdrawUsd: Math.max(c.minWithdrawUsd, wd?.min ?? 0),
        maxWithdrawUsd: wd?.max ?? null,
        minCardFundUsd: c.minCardFundUsd,
        minCardPrefundUsd: Math.max(c.minCardPrefundUsd, 2),
        cardClosureFeeUsd: c.cardClosureFeeUsd,
        requireKycForCards: c.requireKycForCards,
        sandbox: fredaConfigured() ? fredaMode() === "sandbox" : true,
        pushPublicKey: pushPublicKey(),
      };
    },
  },

  // ---------------------------------------------------------------- web push
  savePushSubscription: {
    schema: z.object({
      endpoint: z.string().max(2048).refine(isAllowedPushEndpoint, "Unsupported push service."),
      keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(256) }).strict()
        .refine((k) => validPushKeys(k.p256dh, k.auth), "Invalid push keys."),
      lang: z.enum(["fr", "en"]),
      tz: z.string().max(64).refine(validTimeZone, "Invalid time zone.").optional(),
    }).strict(),
    run: async (d, c) => {
      if (!pushConfigured()) return { ok: true };
      // Upsert by endpoint: an endpoint that belonged to someone else (shared device) moves to the caller.
      const { error } = await L.db.from("push_subscriptions").upsert({
        user_id: c.userId, endpoint: d.endpoint, p256dh: d.keys.p256dh, auth: d.keys.auth, lang: d.lang,
        ...(d.tz ? { tz: d.tz } : {}), user_agent: c.ua, failures: 0,
      }, { onConflict: "endpoint" });
      if (error) throw error;
      // At most 10 devices per user: drop the oldest.
      const { data: all } = await L.db.from("push_subscriptions").select("id").eq("user_id", c.userId).order("created_at", { ascending: false });
      const extra = ((all ?? []) as { id: string }[]).slice(MAX_SUBSCRIPTIONS_PER_USER).map((r) => r.id);
      if (extra.length) await L.db.from("push_subscriptions").delete().in("id", extra);
      return { ok: true };
    },
  },

  removePushSubscription: {
    schema: z.object({ endpoint: z.string().max(2048) }).strict(),
    run: async (d, c) => {
      await L.db.from("push_subscriptions").delete().eq("user_id", c.userId).eq("endpoint", d.endpoint);
      return { ok: true };
    },
  },

  sendTestPush: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => ({ sent: await sendTestPush(c.userId) }),
  },

  // ---------------------------------------------------------------- activity
  logActivity: {
    schema: z.object({ event: z.enum(["Successful login"]) }),
    run: async (d, c) => {
      await L.db.from("activity_log").insert({ user_id: c.userId, event: d.event, detail: "", ip: c.ip, user_agent: c.ua });
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------- KYC
  // Decrypted ID number, only for its owner (to prefill the card holder form).
  getIdentity: {
    schema: z.object({}).strict(),
    run: async (_d, c) => {
      const { data } = await L.db.from("profiles").select("id_number").eq("id", c.userId).single();
      return { idNumber: decryptField(data?.id_number) };
    },
  },

  // Email change: password (+2FA) enforced here, then Supabase sends its normal confirmation email(s).
  changeEmail: {
    schema: z.object({ currentPassword: z.string().min(1).max(200), newEmail: z.string().trim().toLowerCase().email().max(120) }),
    run: async (d, c) => {
      if (d.newEmail === c.email.toLowerCase()) throw new L.AppError("That is already your email address.");
      const { data: prof } = await L.db.from("profiles").select("kyc_status").eq("id", c.userId).maybeSingle();
      if (prof?.kyc_status === "verified") throw new L.AppError("Your personal information is locked because your identity is verified. Contact support to change it.");
      const { createClient } = await import("@supabase/supabase-js");
      const user = createClient(process.env["SUPABASE_URL"] ?? "", process.env["SUPABASE_ANON_KEY"] ?? "", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${c.token}` } },
      });
      const { error } = await user.auth.updateUser({ email: d.newEmail });
      if (error) throw new L.AppError("Could not change the email address. It may already be in use.");
      await L.notify(c.userId, "Email change requested", "Confirm the change from the link we emailed you. If this was not you, change your password now.");
      return { ok: true };
    },
  },

  // Password change goes through the server so the current password (and 2FA) is always enforced.
  changePassword: {
    schema: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(72) }),
    run: async (d, c) => {
      if (d.newPassword === d.currentPassword) throw new L.AppError("Choose a new password different from the current one.");
      const { error } = await L.db.auth.admin.updateUserById(c.userId, { password: d.newPassword });
      if (error) throw new L.AppError(error.message.includes("weak") ? "That password is too weak." : "Could not update the password.");
      // Revoke every OTHER session (stolen / forgotten devices); the current one keeps working. Already issued access
      // tokens of those sessions stay valid until they expire (<= 1 h by default), but they can no longer be refreshed.
      if (c.token) {
        try {
          const { error: outErr } = await L.db.auth.admin.signOut(c.token, "others");
          if (outErr) console.error("[password] could not revoke other sessions:", outErr.message);
        } catch (e) {
          console.error("[password] could not revoke other sessions:", (e as Error).message);
        }
      }
      await L.notify(c.userId, "Password changed", "Your password was changed. If this was not you, contact support now.");
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------- Didit identity verification
  createKycSession: {
    schema: z.object({}).strict(),
    run: async (_d, c) => {
      if (!diditConfigured()) throw new L.AppError("Identity verification is not available yet.");
      const { data: p } = await L.db.from("profiles").select("kyc_status").eq("id", c.userId).single();
      if (p?.kyc_status === "verified") throw new L.AppError("Your identity is already verified.");
      const front = (process.env["FRONTEND_URL"] ?? "http://localhost:5173").replace(/\/+$/, "");
      {
        const s = await createSession({ userId: c.userId, callback: `${front}/kyc` });
        // Didit can hand back the same session when the user comes back to continue: reuse its row instead of inserting a duplicate.
        const { data: existing } = await L.db.from("kyc_submissions").select("id, reference, user_id")
          .eq("didit_session_id", s.sessionId).maybeSingle();
        if (existing && existing.user_id !== c.userId) throw new L.AppError("Could not start the verification. Please try again.");
        const reference = existing?.reference ?? `KYC-${Math.floor(100000 + Math.random() * 900000)}`;
        if (existing) {
          const { error } = await L.db.from("kyc_submissions").update({ status: "pending" }).eq("id", existing.id);
          if (error) throw error;
        } else {
          const { error } = await L.db.from("kyc_submissions").insert({
            user_id: c.userId, reference, status: "pending", doc_type: "didit", document_path: "didit", selfie_path: "didit",
            didit_session_id: s.sessionId,
          });
          if (error) throw error;
        }
        await L.db.from("profiles").update({ kyc_status: "pending", kyc_reference: reference }).eq("id", c.userId);
        return { url: s.url, reference };
      }
    },
  },
  syncKyc: {
    schema: z.object({}).strict(),
    run: async (_d, c) => {
      const { data: sub } = await L.db.from("kyc_submissions").select("didit_session_id").eq("user_id", c.userId)
        .not("didit_session_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!sub?.didit_session_id) return { status: "unverified" };
      // DiditError is mapped to a generic user message by toUserError (details stay in the server log).
      return { status: await L.applyKycDecision(sub.didit_session_id, c.userId) };
    },
  },

  // ---------------------------------------------------------------- deposits
  startDeposit: {
    schema: z.object({ provider, amountUsd: z.number().positive().max(5000), phone: z.string().max(30).optional() }),
    run: async (d, c) => {
      const cfg = getConfig();
      const amountUsd = round2(d.amountUsd);
      if (amountUsd < cfg.minDepositUsd) throw new L.AppError(`Minimum deposit is $${cfg.minDepositUsd}.`);
      // The user pays the full amount through MonCash / NatCash; the fee is kept from what is credited to the wallet.
      const fee = computeFee(await L.feeRules(), "wallet_deposit", amountUsd);
      if (fee >= amountUsd) throw new L.AppError("That amount is too small to cover the fee.");
      const amountHtg = Math.ceil(amountUsd * cfg.htgPerUsd);
      const name = providerName(d.provider);
      const phone = d.phone ? normalizeHaitiPhone(d.phone) : null;

      const tx = await L.insertTx({
        user_id: c.userId, kind: "deposit", title: `Top-up via ${name}`, category: "Top-up", method: name,
        amount: amountUsd, fee, status: "pending", provider: "freda",
        meta: { provider: d.provider, amount_htg: amountHtg, rate: cfg.htgPerUsd },
      });
      try {
        // MonCash + phone number: USSD prompt on the phone. Otherwise: hosted checkout page.
        const method = d.provider === "moncash" && phone ? "moncash_ussd" : d.provider;
        const payment: any = await freda.createPayment({
          amount: amountHtg, method, reference: tx.reference, ...(method === "moncash_ussd" ? { phone: phone! } : {}),
        });
        await L.patchTx(tx.id, { provider_ref: payment.id, meta: { ...tx.meta, method } });
        return { transactionId: tx.id as string, checkoutUrl: (payment.checkout_url ?? null) as string | null, amountHtg, ussd: method === "moncash_ussd", fee };
      } catch (e) {
        // Unknown outcome (timeout, 5xx): the payment may exist on Freda and be paid later. Closing the row now would
        // make the webhook ignore that payment (user pays, wallet never credited), so leave it pending: the webhook
        // settles it, or the reconcile loop expires it after 24h. No wallet money was reserved for a deposit.
        if (!(e instanceof FredaError && e.ambiguous)) await L.failTx(tx.id, "Could not start payment");
        throw e;
      }
    },
  },

  syncTransaction: {
    schema: z.object({ transactionId: z.string().uuid() }),
    run: async (d, c) => {
      const tx = await L.getTx(d.transactionId);
      if (!tx || tx.user_id !== c.userId) throw new L.AppError("Transaction not found.");
      return { status: await L.settleTransaction(tx) };
    },
  },

  // ---------------------------------------------------------------- withdrawals
  startWithdrawal: {
    schema: z.object({ provider, amountUsd: z.number().positive().max(5000), phone: z.string().min(8).max(30) }),
    run: async (d, c) => {
      const cfg = getConfig();
      const amountUsd = round2(d.amountUsd);
      if (amountUsd < cfg.minWithdrawUsd) throw new L.AppError(`Minimum withdrawal is $${cfg.minWithdrawUsd}.`);
      const recipient = normalizeHaitiPhone(d.phone);
      if (!recipient) throw new L.AppError("Enter a valid MonCash or NatCash number (e.g. 509 3700 1234).");

      const fee = computeFee(await L.feeRules(), "wallet_withdrawal", amountUsd);
      const amountHtg = Math.floor(amountUsd * cfg.htgPerUsd);
      const name = providerName(d.provider);

      if (cfg.dailyWithdrawLimitUsd > 0) {
        const used = await L.spentLast24h(c.userId, ["withdrawal"]);
        if (used + amountUsd > cfg.dailyWithdrawLimitUsd) throw new L.AppError(`Daily withdrawal limit reached ($${cfg.dailyWithdrawLimitUsd} per 24 hours).`);
      }

      // 1) reserve the money atomically (throws INSUFFICIENT_FUNDS if the wallet is short)
      const txId = await L.debit({
        user: c.userId, kind: "withdrawal", title: `Withdrawal to ${name}`, category: "Withdrawal", method: name,
        amount: amountUsd, fee, status: "pending", dailyLimit: cfg.dailyWithdrawLimitUsd, // re-checked atomically with the debit
        meta: { provider: d.provider, recipient, amount_htg: amountHtg, rate: cfg.htgPerUsd },
      });
      const tx = await L.getTx(txId);

      // 2) ask Freda to send it
      try {
        const payout: any = await freda.createPayout({ amount: amountHtg, method: d.provider, recipient, reference: tx.reference });
        await L.patchTx(txId, { provider_ref: payout.id });
      } catch (e) {
        if (e instanceof FredaError && e.ambiguous) {
          await L.mergeTxMeta(tx, { needs_reconcile: true }); // unknown outcome: keep reserved, reconcile later
          return { transactionId: txId as string, status: "pending" as const, fee };
        }
        await L.failTx(txId, "Provider rejected the payout");
        throw e;
      }
      return { transactionId: txId as string, status: "pending" as const, fee };
    },
  },

  // ---------------------------------------------------------------- Kasho to Kasho
  searchUsers: {
    schema: z.object({ q: z.string().max(80) }),
    run: async (d, c) => {
      const raw = d.q.trim();
      type Found = { username: string; name: string; kashoId?: string; email?: string };
      if (raw.replace(/^@/, "").length < 2) return [] as Found[];
      const mask = (e: string) => { const [u = "", dom = ""] = e.split("@"); return `${u.slice(0, 2)}***@${dom}`; };
      const { data: rows, error } = await L.db.rpc("kasho_search_users", { p_me: c.userId, p_q: raw });
      if (!error && Array.isArray(rows)) {
        return rows.map((r: any): Found => ({
          username: r.username as string, name: (r.display_name || `@${r.username}`) as string,
          kashoId: (r.kasho_id ?? undefined) as string | undefined, ...(r.email ? { email: mask(String(r.email)) } : {}),
        }));
      }
      // The search function is not installed yet: fall back to a username search.
      console.error("[search] kasho_search_users missing, run kasho-pay-user-search.sql:", error?.message);
      const q = raw.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9._]/g, "");
      if (q.length < 2) return [] as Found[];
      const { data: u } = await L.db.from("profiles").select("id, username, display_name, kasho_id")
        .ilike("username", `${q}%`).neq("id", c.userId).limit(6);
      return (u ?? []).map((r: any): Found => ({ username: r.username as string, name: (r.display_name || `@${r.username}`) as string, kashoId: r.kasho_id ?? undefined }));
    },
  },

  sendMoney: {
    schema: z.object({
      username: z.string().min(2).max(40), amountUsd: z.number().positive().max(5000), note: z.string().max(140).optional(),
      /** Random key the app generates once per send (8-64 chars). A retry with the same key never sends twice. */
      idempotencyKey: idempotencyKey.optional(),
    }),
    run: async (d, c) => {
      const username = d.username.toLowerCase().replace(/^@/, "");
      const { data: target } = await L.db.from("profiles").select("id, display_name, username").eq("username", username).maybeSingle();
      if (!target) throw new L.AppError("We could not find that Kasho user.");
      const amount = round2(d.amountUsd);
      const recipientName = (target.display_name || `@${target.username}`) as string;
      // Retry of a transfer that already went through: answer with the original result, move no money, notify nobody.
      const replay = async () => {
        if (!d.idempotencyKey) return null;
        const { data: prev } = await L.db.from("transactions").select("reference, amount, fee, counterparty_id")
          .eq("user_id", c.userId).eq("idempotency_key", d.idempotencyKey).maybeSingle();
        if (!prev) return null;
        if (!sameTransfer(prev, target.id, amount)) throw new L.AppError("This request was already used for a different transfer. Please try again.");
        return { reference: prev.reference as string, recipient: recipientName, fee: Number(prev.fee ?? 0) };
      };
      const earlier = await replay();
      if (earlier) return earlier;
      const cfg = getConfig();
      // The sender pays the amount plus the fee; the recipient receives the full amount.
      const fee = computeFee(await L.feeRules(), "transfer", amount);
      if (cfg.dailyTransferLimitUsd > 0) {
        const used = await L.spentLast24h(c.userId, ["transfer_out"]);
        if (used + amount > cfg.dailyTransferLimitUsd) throw new L.AppError(`Daily transfer limit reached ($${cfg.dailyTransferLimitUsd} per 24 hours).`);
      }
      const { data: ref, error } = await L.db.rpc("kasho_transfer", {
        p_from: c.userId, p_to: target.id, p_amount: amount, p_note: d.note ?? "", p_fee: fee,
        p_daily_limit: cfg.dailyTransferLimitUsd, // re-checked atomically under the wallet lock
        p_idempotency_key: d.idempotencyKey ?? null,
      });
      if (error) {
        // Two parallel requests with the same key: the database accepted only one, answer with its result.
        if (d.idempotencyKey && String(error.code) === "23505") {
          const again = await replay();
          if (again) return again;
        }
        throw error;
      }
      const { data: me } = await L.db.from("profiles").select("display_name, username").eq("id", c.userId).single();
      await L.notify(target.id, "Money received", `${me?.display_name || "@" + me?.username} sent you $${amount.toFixed(2)}`);
      await L.notify(c.userId, "Money sent", `$${amount.toFixed(2)} sent to ${target.display_name || "@" + target.username}${fee > 0 ? ` (fee $${fee.toFixed(2)})` : ""}`);
      return { reference: ref as string, recipient: recipientName, fee };
    },
  },

  // ---------------------------------------------------------------- cards
  /**
   * Where the customer's card holder is (new card program): needs_kyc, needs_profile, none (not registered yet), pending (the issuer is
   * verifying it), ready (a card can be created) or failed. The card page shows it and polls it while it is pending.
   */
  cardProfileFn: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      const info = await H.holderInfo(c.userId, { refresh: true });
      // A verified customer who was never registered (or whose profile was just completed) is registered now; while an attempt is
      // recent, the screen just waits (it polls this every few seconds).
      if (info.state === "none") return info.canRetry ? H.enrollHolder(c.userId, "customer") : { ...info, state: "pending" as const, reason: H.HOLDER_PENDING_MESSAGE };
      return info;
    },
  },

  /** The customer asks for a new verification of the card holder (after completing the profile, or after a refusal). */
  retryCardProfileFn: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      const cur = await H.holderInfo(c.userId);
      if (cur.state === "needs_profile") return cur;
      return H.retryHolder(c.userId);
    },
  },

  /**
   * Issues a card (new card program). Only for a customer whose card holder is "ready": while the issuer is still verifying it, a card
   * would be issued the old way (no Apple Pay / Google Pay), so nothing is charged and the customer is told to wait.
   */
  createCardFn: {
    schema: z.object({
      label: z.string().trim().max(40).optional(),
      color: cardColor,
      brand: z.enum(["VISA", "MASTERCARD"]),
      amountUsd: z.number().positive().max(5000),
    }).passthrough(),
    run: async (d, c) => {
      const cfg = getConfig();
      await L.refreshKycFromDidit(c.userId); // Didit's webhook may never come: ask for the decision now
      const profile = await loadProfile(c.userId);
      if (cfg.requireKycForCards && profile?.kyc_status !== "verified") {
        throw new L.AppError("Verify your identity before creating a card.");
      }
      const amount = round2(d.amountUsd);
      // The new program needs at least $2 on a new card (the issuer takes its fee from it).
      const minPrefund = Math.max(cfg.minCardPrefundUsd, 2);
      if (amount < minPrefund) throw new L.AppError(`Minimum prefund is $${minPrefund}.`);
      const label = d.label?.trim() || "Kasho virtual debit";
      const fee = computeFee(await L.feeRules(), "card_creation", amount); // read before anything is charged

      // The card holder must be verified by the issuer first. Checked now, before anything is charged.
      let holder = await H.holderInfo(c.userId, { refresh: true, force: true });
      if (holder.state === "none") holder = await H.enrollHolder(c.userId, "customer");
      if (holder.state !== "ready" || !holder.holderId) throw new L.AppError(holder.reason ?? H.HOLDER_PENDING_MESSAGE);
      const holderFredaId = holder.holderId;

      const cardId = crypto.randomUUID();
      const reference = `kasho_card_${cardId}`;
      const txId = await L.debit({
        user: c.userId, kind: "card_creation", title: `New card: ${label}`, category: "Card", method: "Wallet",
        amount, fee, status: "pending", meta: { label, holder_id: holderFredaId },
      });
      const { error: insErr } = await L.db.from("cards").insert({
        id: cardId, user_id: c.userId, reference, label, color: d.color, brand: d.brand, status: "pending", creation_tx_id: txId,
      });
      if (insErr) {
        await L.failTx(txId, "Could not save card");
        throw insErr;
      }
      await L.db.from("transactions").update({ card_id: cardId }).eq("id", txId);
      // Freda answers 202 "pending" at once; the card becomes active a few seconds later (webhook, or the sync the app runs while it waits).
      const finish = async (): Promise<void> => {
        const mode = fredaMode();
        let res: any;
        try {
          res = await freda.createCard({ reference, kind: "individual", brand: d.brand, amount, holder_id: holderFredaId });
        } catch (e) {
          if (e instanceof FredaError) console.error("[card] Freda rejected POST /v1/cards", "mode:", mode, "->", e.status, e.code, e.message);
          if (e instanceof FredaError && e.ambiguous) {
            // Unknown outcome (timeout, 5xx): the card may well exist at Freda. It stays pending and the same request is replayed
            // (same `reference`: never a second card) until Freda answers. The customer is NOT told to try again: that would charge twice.
            await L.rememberCardProblem(txId, e);
            console.error("[card] the outcome of POST /v1/cards is unknown, it will be retried:", reference);
            return;
          }
          // The issuer says the holder is not verified after all: the card page shows "being verified" again.
          if (e instanceof FredaError && (e.code === "HOLDER_NOT_ENROLLED" || e.code === "HOLDER_NOT_VERIFIED" || mentionsIdentityVerification(e.message))) {
            await H.markHolderPending(c.userId);
          }
          throw e; // refused for good: the caller gives the money back and tells the customer
        }
        // From here the card exists at Freda: nothing below may fail the transaction or give the money back. If recording it here
        // goes wrong, the periodic sync finishes the job (it asks Freda again).
        try {
          const { error: idErr } = await L.db.from("cards").update({ freda_card_id: res?.id ?? null }).eq("id", cardId);
          if (idErr) console.error("[card] could not save the Freda card id:", reference, idErr.message);
          if (!res?.id) console.error("[card] POST /v1/cards answered without a card id:", reference, Object.keys(res ?? {}).join(","));
          else console.log("[card] POST /v1/cards accepted:", reference, "->", res.id, "status", String(res.status ?? "?"));
          const ver = pickVerification(res);
          if (ver.link || ver.reason) {
            await L.trackPendingCard({ id: cardId, user_id: c.userId, creation_tx_id: txId, created_at: new Date().toISOString(), reference, freda_card_id: res?.id ?? null }, { fredaStatus: String(res?.status ?? "pending"), verification: ver });
          }
          if (res?.status && L.normalizeCardStatus(res.status) !== "pending") {
            const { data: row } = await L.db.from("cards").select("*").eq("id", cardId).single();
            if (L.normalizeCardStatus(res.status) === "failed") console.error("[card] Freda created the card as failed:", reference, "reason:", String(res.failure_reason ?? ver.reason ?? "(none)").slice(0, 300));
            const balance = readCardDetails(res).balance; // the starting balance is the prefund minus the issuer's fee
            await L.applyCardStatus(row, res.status, balance === undefined ? {} : { balance }, { reason: res.failure_reason ?? ver.reason, link: ver.link, linkExpiresAt: ver.expiresAt });
          }
        } catch (e) {
          console.error("[card] created at Freda but not fully recorded yet, the sync will finish it:", reference, (e as Error).message);
        }
      };
      void finish().catch(async (e) => {
        if (e instanceof FredaError && e.ambiguous) return; // unknown outcome: stays pending, the periodic pass retries
        try {
          console.error("[card] creation failed:", reference, (e as Error).message);
          await L.rememberCardProblem(txId, e);
          if (await L.failTx(txId, "Card creation failed")) {
            await L.db.from("cards").update({ status: "failed" }).eq("id", cardId);
            await L.notify(c.userId, "Card creation failed", "We could not create your card. The money is back in your wallet.");
          }
        } catch (e2) { console.error("[card] could not close a failed creation:", (e2 as Error).message); }
      });
      return { cardId, transactionId: txId as string };
    },
  },

  /**
   * The identity verification the card service asks of the customer before it can issue a card (a link to open), if there is one that
   * is still valid. `waiting` = a pending card whose reason says so but without a link (nothing to open: contact support).
   */
  cardVerificationFn: {
    schema: z.object({}),
    run: async (_d, c) => {
      const { data } = await L.db.from("transactions").select("id, status, card_id, meta, created_at").eq("user_id", c.userId).eq("kind", "card_creation")
        .gt("created_at", new Date(Date.now() - 7 * 24 * 3600_000).toISOString()).order("created_at", { ascending: false }).limit(5);
      let waiting: { cardId: string | null } | null = null;
      for (const t of data ?? []) {
        if (t.status !== "pending" && t.status !== "failed") continue;
        const link = safeHttpsUrl(t.meta?.verification_link);
        if (link && linkStillValid(t.meta?.verification_link_expires_at)) {
          return { state: "link" as const, link, expiresAt: typeof t.meta?.verification_link_expires_at === "string" ? (t.meta.verification_link_expires_at as string) : null, cardId: (t.card_id as string | null) ?? null, cardStatus: t.status as string };
        }
        if (!waiting && t.status === "pending" && mentionsIdentityVerification(t.meta?.card_failure_reason)) waiting = { cardId: (t.card_id as string | null) ?? null };
      }
      return waiting ? { state: "waiting" as const, link: null, expiresAt: null, cardId: waiting.cardId, cardStatus: "pending" } : { state: null, link: null, expiresAt: null, cardId: null, cardStatus: null };
    },
  },

  syncCardFn: {
    schema: z.object({ cardId: z.string().uuid() }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      const next = await L.syncCardRow(card);
      return { status: next.status as string };
    },
  },

  fundCardFn: {
    schema: z.object({ cardId: z.string().uuid(), amountUsd: z.number().positive().max(5000) }),
    run: async (d, c) => {
      const cfg = getConfig();
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (card.status !== "active" || !card.freda_card_id) throw new L.AppError("This card is not active.");
      const amount = round2(d.amountUsd);
      if (amount < cfg.minCardFundUsd) throw new L.AppError(`Minimum is $${cfg.minCardFundUsd}.`);
      const fee = computeFee(await L.feeRules(), "card_fund", amount); // the card receives `amount`, the wallet pays amount + fee

      const txId = await L.debit({
        user: c.userId, kind: "card_fund", title: `Added to ${card.label}`, category: "Card",
        method: `Card •••• ${card.last4 ?? ""}`.trim(), amount, fee, card: card.id,
      });
      let res: any;
      try {
        // The ledger reference is the idempotency key, so a retry of the same request can never fund the card twice.
        res = await freda.fundCard(card.freda_card_id, amount, (await L.getTx(txId)).reference);
      } catch (e) {
        if (e instanceof FredaError && e.ambiguous) {
          // unknown outcome: never auto-refund
          await L.mergeTxMeta(await L.getTx(txId), { needs_review: true });
        } else {
          await L.failTx(txId, "Provider rejected the funding");
        }
        throw e;
      }
      await L.completeTx(txId);
      await L.recordProviderFee(txId, { provider_fee_usd: res?.fee }); // what Freda charged, for the profit report
      await L.db.from("cards").update({ balance: round2(Number(card.balance) + amount) }).eq("id", card.id);
      return { ok: true };
    },
  },

  withdrawCardFn: {
    schema: z.object({ cardId: z.string().uuid(), amountUsd: z.number().positive().max(5000) }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (card.status !== "active" || !card.freda_card_id) throw new L.AppError("This card is not active.");
      const amount = round2(d.amountUsd);
      // `amount` leaves the card; the wallet is credited amount - fee (kasho_complete_tx).
      const fee = computeFee(await L.feeRules(), "card_withdraw", amount);
      if (amount <= fee) throw new L.AppError(`The amount must be more than the $${fee.toFixed(2)} fee.`);
      // Real balance on Freda, read before anything moves. It is the reference used to recover from a crash.
      const before = readCardDetails(await freda.getCard(card.freda_card_id)).balance;
      if (before === undefined) throw new L.AppError("Could not read the card balance. Try again.");
      if (amount > before + 0.005) throw new L.AppError("That is more than the card balance.");
      // The card issuer keeps at least $1 on a card after a withdrawal (Freda: CARD_MINIMUM_BALANCE). Closing the card gives everything back.
      if (amount > before - CARD_MIN_LEFT_USD + 0.005) {
        throw new L.AppError(`At least $${CARD_MIN_LEFT_USD.toFixed(2)} must stay on the card. You can move up to $${Math.max(0, round2(before - CARD_MIN_LEFT_USD)).toFixed(2)}, or close the card to get everything back.`);
      }

      // The ledger row exists BEFORE the provider call: if the server dies in between, reconcile() settles it.
      const tx = await L.insertTx({
        user_id: c.userId, kind: "card_withdraw", title: `Moved from ${card.label}`, category: "Card",
        method: `Card •••• ${card.last4 ?? ""}`.trim(), amount, fee, status: "pending", card_id: card.id, provider: "freda",
        meta: { freda_balance_before: before },
      });
      let res: any;
      try {
        res = await freda.withdrawCard(card.freda_card_id, amount, tx.reference);
      } catch (e) {
        // Ambiguous (timeout/5xx): leave it pending, the reconcile loop compares balances and settles it.
        if (!(e instanceof FredaError && e.ambiguous)) await L.failTx(tx.id, "Provider rejected the withdrawal");
        throw e;
      }
      await L.completeTx(tx.id); // credits the wallet once
      await L.recordProviderFee(tx.id, { provider_fee_usd: res?.fee }); // what Freda charged, for the profit report
      await L.db.from("cards").update({ balance: round2(Math.max(0, before - amount)) }).eq("id", card.id);
      return { ok: true };
    },
  },

  freezeCardFn: {
    schema: z.object({ cardId: z.string().uuid(), freeze: z.boolean() }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (!card.freda_card_id) throw new L.AppError("This card is not ready yet.");
      if (d.freeze) await freda.freezeCard(card.freda_card_id);
      else await freda.unfreezeCard(card.freda_card_id);
      await L.db.from("cards").update({ status: d.freeze ? "disabled" : "active" }).eq("id", card.id);
      return { status: d.freeze ? "disabled" : "active" };
    },
  },

  terminateCardFn: {
    schema: z.object({ cardId: z.string().uuid() }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (card.status === "terminated") throw new L.AppError("This card is already terminated.");
      // Stuck cards (never created, failed, or unknown to the provider) can always be removed.
      if (!card.freda_card_id || card.status === "failed") {
        await L.db.from("cards").update({ status: "terminated", balance: 0 }).eq("id", card.id);
        return { refunded: 0, fee: 0 };
      }
      // The card issuer does not close a card on the (UTC) day it was created (Freda: CARD_TERMINATE_SAME_DAY).
      if (createdTodayUtc(card.created_at)) {
        throw new L.AppError("A card cannot be closed on the day it was created. Freeze it now and close it tomorrow.");
      }
      let remote: any;
      try {
        remote = readCardDetails(await freda.getCard(card.freda_card_id));
      } catch (e) {
        if (e instanceof FredaError && e.status === 404) {
          const gone = await L.markCardGone(card);
          const left = Number(card.balance ?? 0);
          const fee = closureFee(left);
          return gone.status === "terminated" && left > 0 ? { refunded: round2(left - fee), fee } : { refunded: 0, fee: 0 };
        }
        throw e;
      }
      if (remote.status === "terminated") {
        const left = Number(remote.balance ?? card.balance ?? 0);
        await L.markCardGone({ ...card, balance: left });
        const fee = closureFee(left);
        return { refunded: round2(left - fee), fee };
      }
      // Freda keeps a closing fee out of what is left on the card and returns the rest to the Master Wallet:
      // mirror exactly that into the user's wallet.
      const remaining = remote.balance ?? Number(card.balance ?? 0);
      let fee = closureFee(remaining);
      let gross = remaining;
      // Ledger row first (pending), then the provider call, so a crash in between is recovered by reconcile().
      const tx = remaining > 0 ? await L.insertTx({
        user_id: c.userId, kind: "card_withdraw", title: `${card.label} closed`, category: "Card",
        method: `Card •••• ${card.last4 ?? ""}`.trim(), amount: remaining, fee, status: "pending", card_id: card.id, provider: "freda",
        meta: { terminate: true },
      }) : null;
      let closed: any;
      try {
        closed = await freda.terminateCard(card.freda_card_id);
      } catch (e) {
        if (tx && !(e instanceof FredaError && e.ambiguous)) await L.failTx(tx.id, "Provider rejected the closure");
        throw e;
      }
      // Freda's answer says what it really did (refunded_usd + closure_fee_usd): the row follows it.
      const real = readClosure(closed);
      if (tx && real) {
        const realGross = round2(real.refunded + real.fee);
        if (realGross !== gross || real.fee !== fee) {
          await L.adjustPendingTx(tx.id, { amount: realGross, fee: real.fee });
          gross = realGross;
          fee = real.fee;
        }
      }
      // Confirm with Freda that the card is really closed before showing it as terminated.
      try {
        const after = L.normalizeCardStatus(readCardDetails(await freda.getCard(card.freda_card_id)).status);
        if (after !== "terminated") {
          console.error("[terminate] Freda still reports", card.freda_card_id, "as", after);
          throw new L.AppError("The card service has not closed this card yet. Please try again in a moment.");
        }
      } catch (e) {
        if (!(e instanceof FredaError && e.status === 404)) throw e; // 404 = card no longer exists = closed
      }
      await L.db.from("cards").update({ status: "terminated", balance: 0 }).eq("id", card.id);
      // A parallel terminate request (double click) must not credit the same balance twice: only the oldest
      // closing row of this card is credited, the others are closed without moving money.
      if (tx) {
        if (await L.hasOlderTerminateTx(card.id, tx)) await L.failTx(tx.id, "Card already closed by another request");
        else await L.completeTx(tx.id);
      }
      await L.notify(c.userId, "Card closed", `${card.label} was closed permanently.`);
      return { refunded: round2(gross - fee), fee };
    },
  },

  removeCardFn: {
    schema: z.object({ cardId: z.string().uuid() }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (card.status !== "terminated" && card.status !== "failed") throw new L.AppError("Only a terminated card can be removed.");
      await L.db.from("cards").update({ hidden: true }).eq("id", card.id);
      return { ok: true };
    },
  },

  updateCardFn: {
    schema: z.object({ cardId: z.string().uuid(), label: z.string().trim().min(1).max(40), color: cardColor }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      await L.db.from("cards").update({ label: d.label, color: d.color }).eq("id", card.id);
      return { ok: true };
    },
  },

  /** Full card number + CVV: only returned to the card owner, never stored or logged. */
  /** Create or change the 4-digit code needed to see card details. Password (and 2FA) is checked by the step-up middleware. */
  setCardCode: {
    schema: z.object({ currentPassword: z.string().min(1).max(200), code: z.string().regex(/^\d{4}$/, "The code must be 4 digits.") }),
    run: async (d, c) => {
      if (/^(\d)\1{3}$/.test(d.code) || ["1234", "4321", "0123", "3210"].includes(d.code)) {
        throw new L.AppError("Choose a code that is harder to guess (not 1111, 1234...).");
      }
      const { error } = await L.db.from("card_codes").upsert({ user_id: c.userId, code_hash: hashCardCode(d.code), updated_at: new Date().toISOString() });
      if (error) throw error;
      await L.db.from("profiles").update({ card_code_set: true }).eq("id", c.userId);
      clearStepUpFailures(`code:${c.userId}`);
      await resetCardCodeAttempts(L.db, c.userId);
      return { ok: true };
    },
  },

  revealCardFn: {
    schema: z.object({ cardId: z.string().uuid(), code: z.string().regex(/^\d{4}$/) }),
    run: async (d, c) => {
      const { data: row } = await L.db.from("card_codes").select("code_hash").eq("user_id", c.userId).maybeSingle();
      if (!row) throw new L.AppError("Create your 4-digit code first.");
      // 5 wrong codes lock card details for 15 minutes (a 4-digit code has only 10,000 possibilities).
      const lockKey = `code:${c.userId}`;
      if (stepUpLocked(lockKey)) throw new L.AppError("Too many wrong codes. Try again in 15 minutes.");
      // Shared, restart-proof counter (in the database): each guess uses one of 5 attempts before it is checked.
      if (!(await cardCodeAttemptAllowed(L.db, c.userId))) throw new L.AppError("Too many wrong codes. Try again in 15 minutes.");
      if (!verifyCardCode(d.code, row.code_hash)) {
        recordStepUpFailure(lockKey);
        throw new L.AppError("Incorrect code.");
      }
      clearStepUpFailures(lockKey);
      await resetCardCodeAttempts(L.db, c.userId);
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (card.status !== "active" || !card.freda_card_id) throw new L.AppError("This card is not active.");
      const r: any = await freda.revealCard(card.freda_card_id);
      return {
        number: String(r?.number ?? ""), cvv: String(r?.cvv ?? ""),
        expiryMonth: String(r?.expiry_month ?? ""), expiryYear: String(r?.expiry_year ?? ""),
        holderName: String(r?.holder_name ?? ""),
      };
    },
  },

  cardTransactionsFn: {
    schema: z.object({ cardId: z.string().uuid() }),
    run: async (d, c) => {
      const card = await L.getOwnedCard(c.userId, d.cardId);
      if (!card.freda_card_id || card.status === "terminated") return { items: [] as ReturnType<typeof L.mapCardTransaction>[], monthSpend: 0 };
      let res: any;
      try {
        res = await freda.cardTransactions(card.freda_card_id);
      } catch (e) {
        if (e instanceof FredaError && e.status === 404) return { items: [] as ReturnType<typeof L.mapCardTransaction>[], monthSpend: 0 };
        throw e;
      }
      const arr = pickArray(res, ["transactions", "data", "items", "results"]);
      return { items: arr.map(L.mapCardTransaction), monthSpend: Number(res?.month_spend ?? 0) };
    },
  },

  // ---------------------------------------------------------------- disputes + support
  fileDisputeFn: {
    schema: z.object({
      transactionRef: z.string().min(3).max(80),
      reason: z.string().min(2).max(120),
      note: z.string().max(1000).optional(),
    }).passthrough(),
    run: async (d, c) => {
      // Never trust title/amount sent by the browser: read the caller's own transaction.
      const { data: tx } = await L.db.from("transactions").select("reference, title, amount")
        .eq("reference", d.transactionRef).eq("user_id", c.userId).maybeSingle();
      if (!tx) throw new L.AppError("Transaction not found.");
      const reference = `DP-${Math.floor(10000 + Math.random() * 90000)}`;
      const { error } = await L.db.from("disputes").insert({
        user_id: c.userId, transaction_ref: tx.reference, title: tx.title,
        amount: Math.abs(Number(tx.amount)), reason: d.reason, note: d.note ?? "", reference,
      });
      if (error) {
        if (String(error.code) === "23505") throw new L.AppError("You already filed a dispute for this transaction.");
        throw error;
      }
      await L.notify(c.userId, "Dispute submitted", `${reference} for ${tx.title}`);
      return { reference };
    },
  },

  sendSupportMessage: {
    schema: z.object({ message: z.string().trim().min(3).max(2000) }),
    run: async (d, c) => {
      const { error } = await L.db.from("support_messages").insert({ user_id: c.userId, email: c.email || null, message: d.message });
      if (error) throw error;
      return { ok: true };
    },
  },
};

// The admin panel endpoints (adminOverview, adminListUsers, adminAdjustBalance...) live in admin.ts.
Object.assign(handlers, adminHandlers);
