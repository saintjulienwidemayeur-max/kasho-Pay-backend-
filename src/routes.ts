// All API handlers. Each one is exposed as POST /api/<name> (see index.ts).
// Every handler receives the authenticated user (verified Supabase token).
import { z } from "zod";
import * as L from "./ledger.js";
import { readCardDetails } from "./ledger.js";
import { freda, FredaError, fredaConfigured, fredaMode, pickArray, pickId, readClosure } from "./freda.js";
import { closureFee, getConfig, normalizeHaitiPhone, round2 } from "./config.js";
import { FEE_OPERATIONS, TIERED_OPERATIONS, amountRange, computeFee, rowToRule, validateRule, type FeeOperation, type FeeRule } from "./fees.js";
import { decryptField, encryptField, hashCardCode, verifyCardCode } from "./crypto.js";
import { clearStepUpFailures, recordStepUpFailure, stepUpLocked } from "./stepup.js";
import { cardCodeAttemptAllowed, resetCardCodeAttempts } from "./cardcode.js";
import { MAX_SUBSCRIPTIONS_PER_USER, isAllowedPushEndpoint, pushConfigured, pushPublicKey, sendTestPush, validPushKeys, validTimeZone } from "./push.js";
import { createSession, diditConfigured, getDecision, mapStatus } from "./didit.js";

export type Ctx = { userId: string; email: string; ip: string | null; ua: string | null; token?: string;
  /** The user has a verified TOTP factor. */ mfa?: boolean;
  /** Assurance level of the access token ("aal2" = 2FA code passed in this session). */ aal?: "aal1" | "aal2" };
type Handler = { schema: z.ZodTypeAny; run: (d: any, c: Ctx) => Promise<unknown> };

const provider = z.enum(["moncash", "natcash"]);
const providerName = (p: string) => (p === "moncash" ? "MonCash" : "NatCash");
const cardColor = z.enum(["mint", "sunset", "ocean", "gold", "midnight", "forest", "chrome"]);

// Exactly the card holder fields Freda Pay Issuing requires (POST /v1/cards/holders).
const holderSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
  idNumber: z.string().trim().min(3).max(40),
  phoneCode: z.string().trim().min(2).max(6),
  phone: z.string().trim().min(6).max(20),
  street: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  postalCode: z.string().trim().min(2).max(20),
});

async function loadProfile(userId: string) {
  const { data } = await L.db.from("profiles").select("*").eq("id", userId).single();
  return data;
}

const holderInput = holderSchema.extend({ email: z.string().trim().toLowerCase().email().max(120) });

/** Registers a holder with Freda and saves it for the user. Shared by createHolderFn and createCardFn (automatic holder). */
async function registerHolder(d: z.infer<typeof holderInput>, c: Ctx) {
  const mode = fredaMode();
  const age = (Date.now() - new Date(d.dob).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (!(age >= 18)) throw new L.AppError("The card holder must be at least 18 years old.");

  // Freda requires an official ID document (type, number, https image) for every holder; it comes from the Didit KYC.
  const identity = await L.getFredaIdentity(c.userId);
  let id: string | undefined;
  let already = false;
  try {
    const res: any = await freda.createHolder({
      ...(identity ? { identity } : {}),
      firstName: d.firstName, lastName: d.lastName, email: d.email, country: d.country, dob: d.dob,
      identificationNumber: d.idNumber, phoneShortCode: d.phoneCode, phoneNumber: d.phone.replace(/\D/g, ""),
      address: { street: d.street, city: d.city, state: d.state, postalCode: d.postalCode, country: d.country },
    });
    id = pickId(res); // `id` (mpc_...) is returned at the root; `already_existed: true` also returns the existing id
  } catch (e) {
    if (!L.holderExists(e)) throw e;
    already = true;
  }
  if (!id) {
    // The creation response may not include the id: read it from the holders list.
    const f = await L.findExistingHolder(d.email, d.idNumber);
    id = f.id;
    if (already && !f.id) {
      // Freda says this identity already exists (created earlier under another e-mail): reuse that enrolled holder.
      id = await L.findEnrolledHolderByName(d.firstName, d.lastName, c.userId);
      if (!id) {
        console.error("[holder] Freda reports a duplicate identity but no enrolled holder could be matched.");
        throw new L.AppError("We could not activate your card profile. Please contact support.");
      }
    }
  }

  if (id) {
    const { data: taken } = await L.db.from("card_holders").select("id, user_id").eq("freda_holder_id", id).eq("mode", mode).maybeSingle();
    if (taken && taken.user_id !== c.userId) throw new L.AppError("This card holder is already linked to another account.");
    if (taken) return { holderId: taken.id as string, fredaId: id, linked: true, warning: null as string | null };
  }

  const { data: row, error } = await L.db.from("card_holders").insert({
    user_id: c.userId, freda_holder_id: id ?? null, mode, email: d.email, first_name: d.firstName, last_name: d.lastName,
    dob: d.dob, country: d.country, id_number: encryptField(d.idNumber), phone_code: d.phoneCode, phone_number: d.phone.replace(/\D/g, ""),
    address_street: d.street, address_city: d.city, address_state: d.state, address_postal_code: d.postalCode, status: "enrolled", identity_sent: !!identity,
  }).select("id").single();
  if (error) throw error;

  // Remember the details on the profile for next time. A KYC-verified identity (name, birth date, ID) is never overwritten.
  const { data: prof } = await L.db.from("profiles").select("kyc_status").eq("id", c.userId).single();
  const contact = {
    phone_code: d.phoneCode, phone_number: d.phone.replace(/\D/g, ""), address_street: d.street, address_city: d.city,
    address_state: d.state, address_postal_code: d.postalCode,
  };
  await L.db.from("profiles").update(prof?.kyc_status === "verified" ? contact : {
    ...contact, first_name: d.firstName, last_name: d.lastName, display_name: `${d.firstName} ${d.lastName}`,
    date_of_birth: d.dob, country: d.country, id_number: encryptField(d.idNumber),
  }).eq("id", c.userId);

  return {
    holderId: row.id as string,
    fredaId: id,
    linked: !!id,
    warning: id ? null : "Holder registered. Its ID will be read from the card service when you create the card.",
  };
}

export const ADMIN_MFA_MESSAGE = "Turn on two-factor authentication to manage fees.";

/** Admin access also needs a verified TOTP factor AND an aal2 session (2FA code passed in this session). */
export function adminMfaOk(c: Pick<Ctx, "mfa" | "aal">): boolean {
  return c.mfa === true && c.aal === "aal2";
}

/** Only users listed in the `admins` table (server-only) may change fees, and only with 2FA. */
async function requireAdmin(c: Ctx) {
  if (!adminMfaOk(c)) throw new L.AppError(ADMIN_MFA_MESSAGE);
  const { data } = await L.db.from("admins").select("user_id").eq("user_id", c.userId).maybeSingle();
  if (!data) throw new L.AppError("You do not have access to this.");
}

/** Text of a Freda error body, only for matching (never logged or shown). */
const rawText = (raw: unknown) => { try { return JSON.stringify(raw ?? ""); } catch { return ""; } };

/** Client-chosen key that makes a send retry-safe: 8-64 chars, letters, digits, "_" and "-". */
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** True when a stored transfer_out row is the same transfer (same recipient and amount) as the one being requested. */
export function sameTransfer(prev: { amount: unknown; counterparty_id: unknown }, toId: string, amount: number): boolean {
  return prev.counterparty_id === toId && Math.abs(Math.abs(Number(prev.amount)) - amount) < 0.005;
}

const feeRuleInput = z.object({
  id: z.string().uuid().optional(),
  operation: z.enum(FEE_OPERATIONS),
  label: z.string().trim().max(80).default(""),
  feeType: z.enum(["flat", "percent"]),
  minAmount: z.number().min(0).max(100000).nullable().default(null),
  maxAmount: z.number().min(0).max(100000).nullable().default(null),
  feeValue: z.number().min(0).max(100000),
  active: z.boolean().default(true),
});

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
        minCardPrefundUsd: c.minCardPrefundUsd,
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

  // ---------------------------------------------------------------- admin: fee schedule
  adminStatus: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      const { data } = await L.db.from("admins").select("user_id").eq("user_id", c.userId).maybeSingle();
      return { isAdmin: !!data };
    },
  },

  /** Every fee rule, including inactive ones. */
  adminListFees: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      await requireAdmin(c);
      const { data, error } = await L.db.from("fee_rules").select("*").order("operation").order("min_amount", { nullsFirst: true });
      if (error) throw error;
      return { operations: FEE_OPERATIONS, tiered: TIERED_OPERATIONS, rules: (data ?? []).map(rowToRule) };
    },
  },

  /** Creates a rule (no id) or updates one (id). Password is checked by the step-up middleware. */
  adminSaveFee: {
    schema: feeRuleInput.extend({ confirmPassword: z.string().optional() }),
    run: async (d, c) => {
      await requireAdmin(c);
      const { data: all, error: listErr } = await L.db.from("fee_rules").select("*");
      if (listErr) throw listErr;
      const others: FeeRule[] = (all ?? []).map(rowToRule);
      const rule = {
        ...(d.id ? { id: d.id } : {}), operation: d.operation as FeeOperation, feeType: d.feeType,
        minAmount: d.minAmount, maxAmount: d.maxAmount, feeValue: Math.round(d.feeValue * 10000) / 10000, active: d.active,
      };
      if (d.id && !others.some((o) => o.id === d.id)) throw new L.AppError("Fee rule not found.");
      const problem = validateRule(rule, others);
      if (problem) throw new L.AppError(problem);
      const row = {
        operation: rule.operation, label: d.label, fee_type: rule.feeType, min_amount: rule.minAmount, max_amount: rule.maxAmount,
        fee_value: rule.feeValue, active: rule.active, updated_by: c.userId,
      };
      const { data, error } = d.id
        ? await L.db.from("fee_rules").update(row).eq("id", d.id).select("*").single()
        : await L.db.from("fee_rules").insert(row).select("*").single();
      if (error) throw error;
      await L.db.from("activity_log").insert({
        user_id: c.userId, event: "Fee rule changed", detail: `${rule.operation} ${rule.feeType} ${rule.feeValue} [${rule.minAmount ?? ""}-${rule.maxAmount ?? ""}] active=${rule.active}`,
        ip: c.ip, user_agent: c.ua,
      });
      return rowToRule(data);
    },
  },

  adminDeleteFee: {
    schema: z.object({ id: z.string().uuid(), confirmPassword: z.string().optional() }),
    run: async (d, c) => {
      await requireAdmin(c);
      const { data, error } = await L.db.from("fee_rules").delete().eq("id", d.id).select("operation");
      if (error) throw error;
      if (!data?.length) throw new L.AppError("Fee rule not found.");
      await L.db.from("activity_log").insert({ user_id: c.userId, event: "Fee rule deleted", detail: String(data[0].operation), ip: c.ip, user_agent: c.ua });
      return { ok: true };
    },
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
  /** Step 1 of card issuing: register the card holder with Freda (POST /v1/cards/holders). */
  createHolderFn: {
    schema: holderInput,
    run: (d, c) => registerHolder(d, c),
  },

  /** Step 2: issue a card for one of the user's holders. */
  createCardFn: {
    schema: z.object({
      label: z.string().trim().max(40).optional(),
      color: cardColor,
      brand: z.enum(["VISA", "MASTERCARD"]),
      amountUsd: z.number().positive().max(5000),
      holderId: z.string().uuid().optional(),
    }),
    run: async (d, c) => {
      const cfg = getConfig();
      const profile = await loadProfile(c.userId);
      if (cfg.requireKycForCards && profile?.kyc_status !== "verified") {
        throw new L.AppError("Verify your identity before creating a card.");
      }
      const amount = round2(d.amountUsd);
      if (amount < cfg.minCardPrefundUsd) throw new L.AppError(`Minimum prefund is $${cfg.minCardPrefundUsd}.`);
      const label = d.label?.trim() || "Kasho virtual debit";
      const fee = computeFee(await L.feeRules(), "card_creation", amount); // read before any holder / card is created

      const mode = fredaMode();
      // The customer never picks a card holder: the latest one for this account is used, or one is created automatically.
      const { data: holders } = await L.db.from("card_holders").select("*").eq("user_id", c.userId).eq("mode", mode)
        .order("created_at", { ascending: false }).limit(1);
      let holder = holders?.[0];
      if (!holder) {
        // No holder yet: create it automatically from the verified profile, sending everything Freda requires.
        const merged = {
          firstName: profile?.first_name, lastName: profile?.last_name, email: c.email, dob: profile?.date_of_birth,
          country: profile?.country, idNumber: decryptField(profile?.id_number),
          phoneCode: profile?.phone_code, phone: profile?.phone_number,
          street: profile?.address_street, city: profile?.address_city,
          state: profile?.address_state, postalCode: profile?.address_postal_code,
        };
        const parsedHolder = holderInput.safeParse(merged);
        if (!parsedHolder.success) {
          const names: Record<string, string> = { firstName: "first name", lastName: "last name", dob: "date of birth", country: "country", idNumber: "ID number",
            phoneCode: "phone code", phone: "phone number", street: "street address", city: "city", state: "state", postalCode: "postal code", email: "email" };
          const miss = [...new Set(parsedHolder.error.issues.map((i) => names[String(i.path[0])] ?? String(i.path[0])))];
          throw new L.AppError(`Please complete your profile: ${miss.join(", ")}.`);
        }
        await registerHolder(parsedHolder.data, c);
        const { data: created } = await L.db.from("card_holders").select("*").eq("user_id", c.userId).eq("mode", mode).order("created_at", { ascending: false }).limit(1);
        holder = created?.[0];
        if (!holder) throw new L.AppError("Could not create your card holder. Please try again.");
      }
      // The Freda account is shared by all Kasho users: never rely on its "latest holder" default,
      // always send the exact holder_id of THIS user's holder.
      // Find this user's ENROLLED holder id on Freda (`mpc_...`), in this order:
      //  1. the id stored on our holder row (GET /v1/cards/holders/:id), if it is still enrolled;
      //  2. the holders list (same e-mail or ID number, status enrolled);
      //  3. POST /v1/cards/holders again: no duplicate is created, Freda answers 200 `already_existed: true` with the id.
      let holderFredaId: string | undefined;
      {
        const idNumber = decryptField(holder.id_number);
        if (holder.freda_holder_id) {
          try {
            const g: any = await freda.getHolder(holder.freda_holder_id);
            const h = g?.holder ?? g;
            if (!h?.status || String(h.status).toLowerCase() === "enrolled") holderFredaId = holder.freda_holder_id;
            else console.error("[holder] stored holder is not enrolled, status:", h.status);
          } catch (e) {
            console.error("[holder] could not read stored holder:", (e as Error).message);
          }
        }
        if (!holderFredaId) holderFredaId = (await L.findExistingHolder(holder.email, idNumber)).id;
        if (!holderFredaId) {
          const again = holderInput.safeParse({
            firstName: holder.first_name, lastName: holder.last_name, email: holder.email, dob: String(holder.dob).slice(0, 10),
            country: holder.country, idNumber, phoneCode: holder.phone_code, phone: holder.phone_number,
            street: holder.address_street, city: holder.address_city, state: holder.address_state, postalCode: holder.address_postal_code,
          });
          if (!again.success) throw new L.AppError("Please complete your profile: phone number and full address.");
          const r = await registerHolder(again.data, c);
          holderFredaId = r.fredaId ?? (await L.findExistingHolder(holder.email, idNumber)).id;
          if (r.holderId !== holder.id) {
            await L.db.from("card_holders").delete().eq("id", holder.id); // replaced by the new row
            holder = { ...holder, id: r.holderId };
          }
        }
        if (!holderFredaId) throw new L.AppError("We could not register your card holder with the card service. Please try again or contact support.");
        if (!holder.identity_sent) {
          // Holders created before Freda required an ID document: re-send POST /v1/cards/holders with the same e-mail
          // plus `identity`. Freda upgrades the holder in place (no duplicate).
          const identity = await L.getFredaIdentity(c.userId);
          if (!identity) throw new L.AppError("Please complete your identity verification (ID document) before creating a card.");
          try {
            await freda.createHolder({
              firstName: holder.first_name, lastName: holder.last_name, email: holder.email, country: holder.country, dob: String(holder.dob).slice(0, 10),
              identificationNumber: idNumber, phoneShortCode: holder.phone_code, phoneNumber: String(holder.phone_number ?? "").replace(/\D/g, ""),
              address: { street: holder.address_street, city: holder.address_city, state: holder.address_state, postalCode: holder.address_postal_code, country: holder.country },
              identity,
            });
          } catch (e) {
            if (e instanceof FredaError) console.error("[holder] identity upgrade rejected", e.status, e.code, e.message);
            // Freda's own provider answers "customer is already enrolled" when the holder is upgraded: the holder
            // exists and is usable, so carry on to the card request (a failure there is refunded automatically).
            if (!(e instanceof FredaError && /already enrolled/i.test(`${e.message} ${rawText(e.raw)}`))) throw e;
          }
          await L.db.from("card_holders").update({ identity_sent: true }).eq("id", holder.id);
        }
        const { data: takenRows } = await L.db.from("card_holders").select("user_id").eq("freda_holder_id", holderFredaId).eq("mode", mode).neq("id", holder.id);
        if ((takenRows ?? []).some((r: any) => r.user_id !== c.userId)) throw new L.AppError("This card holder is already linked to another account.");
        if (holder.freda_holder_id !== holderFredaId) await L.db.from("card_holders").update({ freda_holder_id: holderFredaId }).eq("id", holder.id);
      }

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

      try {
        // Always send the exact holder_id of THIS user's enrolled holder (the account default may belong to another user).
        const cardReq = { reference, kind: "individual" as const, brand: d.brand, amount, holder_id: holderFredaId };
        let res: any;
        try {
          res = await freda.createCard(cardReq);
        } catch (e) {
          if (e instanceof FredaError) console.error("[card] Freda rejected POST /v1/cards", "mode:", mode, "->", e.status, e.code, e.message);
          throw e;
        }
        await L.db.from("cards").update({ freda_card_id: res.id ?? null }).eq("id", cardId);
        if (res?.status && L.normalizeCardStatus(res.status) !== "pending") {
          const { data: row } = await L.db.from("cards").select("*").eq("id", cardId).single();
          await L.applyCardStatus(row, res.status);
        }
      } catch (e) {
        if (!(e instanceof FredaError && e.ambiguous)) {
          await L.failTx(txId, "Provider rejected the card");
          await L.db.from("cards").update({ status: "failed" }).eq("id", cardId);
        }
        throw e;
      }
      return { cardId, transactionId: txId as string };
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
      try {
        // The ledger reference is the idempotency key, so a retry of the same request can never fund the card twice.
        await freda.fundCard(card.freda_card_id, amount, (await L.getTx(txId)).reference);
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

      // The ledger row exists BEFORE the provider call: if the server dies in between, reconcile() settles it.
      const tx = await L.insertTx({
        user_id: c.userId, kind: "card_withdraw", title: `Moved from ${card.label}`, category: "Card",
        method: `Card •••• ${card.last4 ?? ""}`.trim(), amount, fee, status: "pending", card_id: card.id, provider: "freda",
        meta: { freda_balance_before: before },
      });
      try {
        await freda.withdrawCard(card.freda_card_id, amount, tx.reference);
      } catch (e) {
        // Ambiguous (timeout/5xx): leave it pending, the reconcile loop compares balances and settles it.
        if (!(e instanceof FredaError && e.ambiguous)) await L.failTx(tx.id, "Provider rejected the withdrawal");
        throw e;
      }
      await L.completeTx(tx.id); // credits the wallet once
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
