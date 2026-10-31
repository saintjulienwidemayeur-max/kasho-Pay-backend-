// Server-only helpers: wallet ledger (atomic Postgres functions), settlement of
// Freda operations, card synchronisation and user-facing error mapping.
import { supabaseAdmin } from "./supabase.js";
import { FredaError, describeFredaError, freda, fredaMode, pickArray, pickId, readClosure } from "./freda.js";
import { closureFee, round2 } from "./config.js";
import { FeeError, loadFeeRules, type FeeRule } from "./fees.js";
import { isSafeRemoteUrl } from "./security.js";
import { DiditError } from "./didit.js";
import { sendPushToUser } from "./push.js";
import { mentionsIdentityVerification, pickVerification, type Verification } from "./verification.js";

// supabaseAdmin is intentionally loosely typed here (rpc results, jsonb meta).
export const db: any = supabaseAdmin;

// ------------------------------------------------------------------ errors
export class AppError extends Error {}

const UNAVAILABLE = "This service is temporarily unavailable. Please try again later.";

/** Freda codes that are about OUR account (keys, balances, limits): users only see "unavailable". */
const PLATFORM_CODES = new Set([
  "NOT_CONFIGURED", "MISSING_API_KEY", "INVALID_API_KEY", "LIVE_NOT_ENABLED", "LIVE_NOT_ALLOWED", "ISSUING_LIVE_NOT_ENABLED",
  "INSUFFICIENT_BALANCE", "BELOW_MINIMUM_BALANCE", "CARD_LIMIT_REACHED", "ACCOUNT_SUSPENDED", "MERCHANT_NOT_FOUND",
  "CARD_PROVIDER_AUTH", "CARD_LIVE_NOT_CONFIGURED", "CARD_SERVICE_ERROR", "IDEMPOTENCY_MISMATCH",
]);

/** Safe, fixed user messages for the other known codes. Raw Freda text is never shown to users. */
const FREDA_USER_MESSAGES: Record<string, string> = {
  INVALID_RECIPIENT: "Enter a valid MonCash or NatCash number (e.g. 509 3700 1234).",
  INVALID_AMOUNT: "Enter a valid amount.",
  HOLDER_PROFILE_REQUIRED: "We could not verify your card profile. Please check your profile details (name, phone, address) and try again.",
  HOLDER_PROFILE_INCOMPLETE: "We could not verify your card profile. Please check your profile details (name, phone, address) and try again.",
  HOLDER_NOT_ENROLLED: "We could not verify your card profile. Please check your profile details (name, phone, address) and try again.",
  HOLDER_MODE_MISMATCH: "We could not verify your card profile. Please check your profile details (name, phone, address) and try again.",
  HOLDER_CREATION_FAILED: "We could not verify your card profile. Please check your profile details (name, phone, address) and try again.",
  CARD_FROZEN: "This card is frozen. Unfreeze it first.",
  CARD_NOT_READY: "Your card is not active yet. Please try again in a few seconds.",
  INSUFFICIENT_CARD_BALANCE: "That is more than the card balance.",
  AMOUNT_BELOW_FEE: "That amount is too small. Please try a larger amount.",
  AMOUNT_TOO_LOW: "That amount is too small. Please try a larger amount.",
  RATE_LIMITED: "Too many requests. Please wait a minute and try again.",
  NETWORK: "The payment network did not respond. Please try again in a moment.",
  PROVIDER_ERROR: "The payment network did not respond. Please try again in a moment.",
  NOT_FOUND: "We could not find this item. Refresh and try again.",
  // Small allow-list of other safe user-facing codes (fixed text, not Freda's).
  INVALID_BRAND: "That card type is not available. Choose another one.",
  INVALID_PHOTO: "We could not use your ID photo. Please verify your identity again.",
  MISSING_FIELDS: "Some details are missing. Please complete your profile and try again.",
  INDIVIDUAL_CARD_DETAILS_HIDDEN: "Card details are not available for this card.",
};
const GENERIC_FREDA = "We could not complete this request. Please try again or contact support.";
/** The card service wants the holder to complete an identity verification first (HOLDER_NOT_ENROLLED, or Freda's text says so). */
export const IDENTITY_VERIFICATION_MESSAGE = "The card service must verify your identity first. Please try again in a few minutes, or contact support if this continues.";

/** Codes a payment can come back with when the payer's mobile money account is short of funds. */
const PAYER_FUNDS_CODES = new Set(["INSUFFICIENT_FUNDS", "PAYMENT_FAILED", "PROVIDER_ERROR"]);

/** True only for the payment-time "the payer's mobile money account has too little money" case (never platform balances). */
export function isPayerInsufficientFunds(e: { code: string; status: number; message: string }): boolean {
  if (PLATFORM_CODES.has(e.code) || e.code === "INSUFFICIENT_CARD_BALANCE") return false;
  if (e.status >= 500 || !PAYER_FUNDS_CODES.has(e.code)) return false;
  return e.code === "INSUFFICIENT_FUNDS" || /insufficient (funds|balance)/i.test(e.message);
}

export function toUserError(e: any): Error {
  if (e instanceof AppError) return e;
  if (e instanceof FeeError) return new AppError(e.message);

  if (e instanceof FredaError) {
    console.error("[freda]", e.endpoint, e.status, e.code, e.message); // endpoint/code/status/message only: never the body
    if (e.code === "HOLDER_NOT_ENROLLED" || e.code === "HOLDER_NOT_VERIFIED" || mentionsIdentityVerification(e.message)) return new AppError(IDENTITY_VERIFICATION_MESSAGE);
    if (isPayerInsufficientFunds(e)) {
      return new AppError("The balance on your mobile money account is too low for this payment. Add funds and try again.");
    }
    if (PLATFORM_CODES.has(e.code)) return new AppError(UNAVAILABLE);
    const known = Object.prototype.hasOwnProperty.call(FREDA_USER_MESSAGES, e.code) ? FREDA_USER_MESSAGES[e.code] : undefined;
    if (known) return new AppError(known);
    return new AppError(e.status >= 500 ? UNAVAILABLE : GENERIC_FREDA);
  }

  if (e instanceof DiditError) {
    console.error("[didit]", e.status, e.message);
    return new AppError("Identity verification is unavailable right now. Please try again later.");
  }

  const msg = String(e?.message ?? "");
  if (msg.includes("INSUFFICIENT_FUNDS")) return new AppError("Not enough balance in your wallet.");
  if (msg.includes("RECIPIENT_NOT_FOUND")) return new AppError("We could not find that Kasho user.");
  if (msg.includes("SELF_TRANSFER")) return new AppError("You cannot send money to yourself.");
  if (msg.includes("INVALID_AMOUNT")) return new AppError("Enter a valid amount.");
  if (msg.includes("DAILY_LIMIT")) return new AppError("Daily limit reached. Please try again later.");

  console.error("[kasho]", String(e?.message ?? e).slice(0, 300));
  return new AppError("Something went wrong. Please try again.");
}

export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toUserError(e);
  }
}

// ------------------------------------------------------------------ small helpers
export async function notify(userId: string, title: string, body: string) {
  const { error } = await db.from("notifications").insert({ user_id: userId, title, body });
  if (error) console.error("[notify]", error.message);
  void sendPushToUser(userId, { title, body, url: "/", tag: "tx" }); // never throws, never blocks
}

async function rpc<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export const debit = (a: {
  user: string; kind: string; title: string; category: string; method: string;
  amount: number; fee?: number; status?: "pending" | "completed"; card?: string | null;
  provider?: string; meta?: Record<string, unknown>;
  /** Rolling 24h cap for this kind, enforced atomically in the database (0 = none). */
  dailyLimit?: number;
}) =>
  rpc<string>("kasho_debit", {
    p_user: a.user, p_kind: a.kind, p_title: a.title, p_category: a.category, p_method: a.method,
    p_amount: a.amount, p_fee: a.fee ?? 0, p_status: a.status ?? "pending", p_card: a.card ?? null,
    p_provider: a.provider ?? "freda", p_meta: a.meta ?? {}, p_daily_limit: a.dailyLimit ?? 0,
  });

/** Active fee rules (table fee_rules). Read on every request so an admin change applies immediately. */
export const feeRules = (): Promise<FeeRule[]> => loadFeeRules(db);

export const completeTx = (id: string) => rpc<boolean>("kasho_complete_tx", { p_tx: id });
export const failTx = (id: string, reason: string) => rpc<boolean>("kasho_fail_tx", { p_tx: id, p_reason: reason });

export async function getTx(id: string) {
  const { data, error } = await db.from("transactions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertTx(row: Record<string, unknown>) {
  const { data, error } = await db.from("transactions").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

export async function patchTx(id: string, patch: Record<string, unknown>) {
  const { error } = await db.from("transactions").update(patch).eq("id", id);
  if (error) throw error;
}

/**
 * Remembers what Freda really charged for a settled operation (kept for an exact report later).
 * Only finite, non-negative numbers are kept. Never blocks or fails the money flow it is called from.
 */
export async function recordProviderFee(txId: string, patch: Record<string, unknown>) {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(patch)) {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) clean[k] = n;
  }
  if (!Object.keys(clean).length) return;
  try {
    const t = await getTx(txId);
    if (t) await mergeTxMeta(t, clean);
  } catch (e) {
    console.error("[fees] could not record the provider fee:", (e as Error).message);
  }
}

/** Corrects the amounts of a row that is still pending (never a settled one: its money has already moved). */
export async function adjustPendingTx(id: string, patch: { amount?: number; fee?: number }) {
  const { error } = await db.from("transactions").update(patch).eq("id", id).eq("status", "pending");
  if (error) throw error;
}

export async function mergeTxMeta(tx: any, extra: Record<string, unknown>) {
  await patchTx(tx.id, { meta: { ...(tx.meta ?? {}), ...extra } });
}

/** True when a succeeded payment is smaller than the amount requested (0.001 tolerance). */
export function isUnderpaid(paidHtg: unknown, expectedHtg: number): boolean {
  return !!expectedHtg && typeof paidHtg === "number" && paidHtg + 0.001 < expectedHtg;
}
export const underpaidMeta = (paidHtg: number, expectedHtg: number) =>
  ({ underpaid: true, paid_htg: paidHtg, expected_htg: expectedHtg, needs_refund: true });

/** A card_fund whose Freda call had an unknown outcome may be replayed (same idempotency key) for this long. */
export const REPLAY_WINDOW_MS = 24 * 3600 * 1000;
/** Do not replay a card funding that has no needs_review flag before this age: the original request may still be running. */
export const FUND_REPLAY_MIN_AGE_MS = 3 * 60_000;
/** Do not replay a card creation younger than this: the original request may still be running. */
const CARD_REPLAY_MIN_AGE_MS = 60_000;

const money = (n: number) => `$${Number(n).toFixed(2)}`;

// ------------------------------------------------------------------ settlement
/** Ask Freda for the real state of a pending operation and settle the ledger accordingly. Idempotent. */
export async function settleTransaction(tx: any): Promise<"pending" | "completed" | "failed"> {
  if (!tx || tx.status !== "pending") return tx?.status ?? "failed";

  if (tx.kind === "deposit") {
    if (!tx.provider_ref) return "pending";
    const p: any = await freda.getPayment(tx.provider_ref);
    if (p?.status === "succeeded") {
      const expectedHtg = Number(tx.meta?.amount_htg ?? 0);
      if (isUnderpaid(p.amount, expectedHtg)) {
        // The user paid LESS than requested: never credit the wallet. Keep the transaction failed but flag it so support
        // can refund / top up the difference by hand (nothing is lost: paid_htg is recorded).
        console.error("[deposit] UNDERPAID, needs refund:", tx.reference, "paid_htg", p.amount, "expected_htg", expectedHtg);
        try { await mergeTxMeta(tx, underpaidMeta(p.amount, expectedHtg)); } catch (e) { console.error("[deposit] could not flag underpayment:", (e as Error).message); }
        if (await failTx(tx.id, "Amount mismatch")) {
          await notify(tx.user_id, "Deposit not credited",
            `We received ${Number(p.amount)} HTG instead of the ${expectedHtg} HTG you requested, so your wallet was not credited. Our support team will contact you about the amount we received.`);
        }
        return "failed";
      }
      await mergeTxMeta(tx, { fee_htg: p.fee ?? null, net_htg: p.net_amount ?? null });
      if (await completeTx(tx.id)) {
        await notify(tx.user_id, "Wallet funded", `${money(Number(tx.amount) - Number(tx.fee ?? 0))} added via ${tx.method}`);
      }
      return "completed";
    }
    if (p?.status === "failed") {
      if (await failTx(tx.id, "Payment failed")) {
        await notify(tx.user_id, "Deposit failed", `Your ${tx.method} payment did not go through.`);
      }
      return "failed";
    }
    return "pending";
  }

  if (tx.kind === "withdrawal") {
    let payout: any;
    if (tx.provider_ref) {
      payout = await freda.getPayout(tx.provider_ref);
    } else {
      // The first request may have timed out. Re-sending the same reference is idempotent
      // on Freda's side: it returns the existing payout instead of paying twice.
      payout = await freda.createPayout({
        amount: Number(tx.meta?.amount_htg),
        method: tx.meta?.provider,
        recipient: tx.meta?.recipient,
        reference: tx.reference,
      });
      if (payout?.id) await patchTx(tx.id, { provider_ref: payout.id });
    }
    if (payout?.status === "success") {
      await recordProviderFee(tx.id, { payout_fee_htg: payout?.fee }); // Freda's 5 % payout fee, for the profit report
      if (await completeTx(tx.id)) {
        await notify(tx.user_id, "Withdrawal sent", `${money(Math.abs(tx.amount))} sent to ${tx.method}`);
      }
      return "completed";
    }
    if (payout?.status === "failed") {
      if (await failTx(tx.id, payout?.failure_reason ?? "Payout failed")) {
        await notify(tx.user_id, "Withdrawal failed", "Your withdrawal could not be sent. The money is back in your wallet.");
      }
      return "failed";
    }
    return "pending";
  }

  if (tx.kind === "card_fund" && tx.card_id) {
    // Ambiguous Freda answer (needs_review), or the server died after the wallet debit and before/while calling Freda
    // (no flag, so only after FUND_REPLAY_MIN_AGE_MS). Replaying POST /fund with the SAME reference is safe: Freda answers
    // with the original result (idempotent_replay) and never moves the money twice.
    const age = Date.now() - new Date(tx.created_at).getTime();
    if (!tx.meta?.needs_review && age < FUND_REPLAY_MIN_AGE_MS) return "pending";
    if (age > REPLAY_WINDOW_MS) {
      console.error("[card_fund] still needs manual review after 24h:", tx.reference);
      return "pending";
    }
    const { data: card } = await db.from("cards").select("*").eq("id", tx.card_id).maybeSingle();
    if (!card?.freda_card_id) return "pending";
    const amount = Math.abs(Number(tx.amount));
    let res: any;
    try {
      res = await freda.fundCard(card.freda_card_id, amount, tx.reference);
    } catch (e) {
      if (e instanceof FredaError && e.ambiguous) return "pending"; // still unknown: try again next round
      if (e instanceof FredaError) {
        console.error("[card_fund] replay rejected:", tx.reference, e.status, e.code);
        if (await failTx(tx.id, "Provider rejected the funding")) {
          await notify(tx.user_id, "Card funding failed", "We could not add money to your card. The money is back in your wallet.");
        }
        return "failed";
      }
      throw e;
    }
    if (await completeTx(tx.id)) {
      await recordProviderFee(tx.id, { provider_fee_usd: res?.fee });
      const real = readCardDetails(res).balance;
      await db.from("cards").update({ balance: real ?? round2(Number(card.balance ?? 0) + amount) }).eq("id", card.id);
      await notify(tx.user_id, "Card funded", `${money(amount)} added to ${card.label}.`);
    }
    return "completed";
  }

  if (tx.kind === "card_creation" && tx.card_id) {
    let { data: card } = await db.from("cards").select("*").eq("id", tx.card_id).maybeSingle();
    if (card && !card.freda_card_id && card.status === "pending") {
      // createCard had an unknown outcome: replaying the same `reference` returns the existing card (never a second one).
      if (Date.now() - new Date(tx.created_at).getTime() < CARD_REPLAY_MIN_AGE_MS) return "pending";
      const holderId = await holderFredaIdFor(tx, card);
      if (!holderId) {
        console.error("[card_creation] cannot replay, holder unknown:", tx.reference);
        return "pending";
      }
      let res: any;
      try {
        res = await freda.createCard({ reference: card.reference, kind: "individual", brand: card.brand, amount: Math.abs(Number(tx.amount)), holder_id: holderId });
      } catch (e) {
        if (e instanceof FredaError && e.ambiguous) {
          await trackPendingCard(card, { error: e }); // still unknown: say why it does not move, and try again next round
          return "pending";
        }
        if (e instanceof FredaError) {
          console.error("[card_creation] replay rejected:", tx.reference, e.status, e.code);
          await rememberCardProblem(tx.id, e);
          await db.from("cards").update({ status: "failed" }).eq("id", card.id);
          if (await failTx(tx.id, "Provider rejected the card")) {
            await notify(tx.user_id, "Card creation failed", "We could not create your card. The money is back in your wallet.");
          }
          return "failed";
        }
        throw e;
      }
      if (!res?.id) {
        console.error("[card_creation] replay answered without a card id:", tx.reference, Object.keys(res ?? {}).join(","));
        return "pending";
      }
      await db.from("cards").update({ freda_card_id: res.id }).eq("id", card.id);
      card = { ...card, freda_card_id: res.id };
      if (res?.status && normalizeCardStatus(res.status) !== "pending") card = await applyCardStatus(card, res.status);
    }
    if (card) await syncCardRow(card);
    const fresh = await getTx(tx.id);
    return fresh?.status ?? "pending";
  }

  if (tx.kind === "card_withdraw" && tx.card_id && (tx.meta?.freda_balance_before !== undefined || tx.meta?.terminate)) {
    // Crash-safe settlement: the ledger row was written BEFORE calling Freda, so after a crash we compare
    // the real Freda card state with what we recorded, instead of asking for manual review.
    const { data: card } = await db.from("cards").select("*").eq("id", tx.card_id).maybeSingle();
    if (!card?.freda_card_id) return "pending";
    // A terminated card can disappear from Freda (404): for a terminate, that means it is closed.
    let d: ReturnType<typeof readCardDetails>;
    try {
      d = readCardDetails(await freda.getCard(card.freda_card_id));
    } catch (e) {
      if (tx.meta?.terminate && e instanceof FredaError && e.status === 404) d = readCardDetails({ status: "terminated" });
      else throw e;
    }
    const ageMs = Date.now() - new Date(tx.created_at).getTime();
    const amount = Math.abs(Number(tx.amount));
    let moved: boolean | null = null; // null = cannot tell
    if (tx.meta?.terminate) moved = normalizeCardStatus(d.status) === "terminated";
    else if (d.balance !== undefined) moved = d.balance <= Number(tx.meta.freda_balance_before) - amount + 0.005;
    if (moved === true) {
      if (await completeTx(tx.id)) {
        await db.from("cards").update(tx.meta?.terminate ? { status: "terminated", balance: 0 } : { balance: d.balance }).eq("id", card.id);
        await notify(tx.user_id, "Card withdrawal completed", `${money(amount - Number(tx.fee ?? 0))} returned to your wallet.`);
      }
      return "completed";
    }
    // Nothing moved on Freda after 10 minutes: safe to close it without crediting.
    if (moved === false && ageMs > 10 * 60_000) {
      await failTx(tx.id, "Provider did not execute the withdrawal");
      return "failed";
    }
    return "pending";
  }

  return "pending";
}

/** Freda holder id to use when replaying a card creation: stored on the transaction, else the user's latest holder. */
async function holderFredaIdFor(tx: any, card: any): Promise<string | undefined> {
  if (typeof tx.meta?.holder_id === "string" && tx.meta.holder_id) return tx.meta.holder_id;
  const { data } = await db.from("card_holders").select("freda_holder_id").eq("user_id", card.user_id)
    .not("freda_holder_id", "is", null).order("created_at", { ascending: false }).limit(1);
  return data?.[0]?.freda_holder_id ?? undefined;
}

// ------------------------------------------------------------------ cards
export function normalizeCardStatus(raw: unknown): "pending" | "active" | "disabled" | "failed" | "terminated" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "active") return "active";
  if (s === "disabled" || s === "frozen" || s === "inactive") return "disabled";
  if (s === "terminated" || s === "closed") return "terminated";
  if (s === "failed" || s === "error") return "failed";
  // "pending" is the documented in-progress state. Anything else is a status this code does not know: it stays "pending" (a card is
  // never assumed to work) but it is said once in the log, so a new Freda status is noticed instead of leaving cards "in creation".
  if (s && s !== "pending" && !warnedStatuses.has(s)) {
    warnedStatuses.add(s);
    console.error("[card] unknown Freda card status, kept as pending:", s.slice(0, 40));
  }
  return "pending";
}
const warnedStatuses = new Set<string>();

export function readCardDetails(c: any) {
  const src = c?.card ?? c ?? {};
  const pan = src.masked_pan ?? src.maskedPan ?? src.masked_number;
  const last4 = pan ? String(pan).replace(/\D/g, "").slice(-4) : undefined;
  let balance: number | undefined;
  const b = src.balance ?? src.available_balance;
  if (typeof b === "number") balance = b;
  else if (typeof b === "string" && b.trim() !== "" && !Number.isNaN(Number(b))) balance = Number(b);
  else if (b && typeof b === "object") {
    const v = b.available ?? b.amount ?? b.balance;
    if (v !== undefined && !Number.isNaN(Number(v))) balance = Number(v);
  }
  let expiry: string | undefined;
  const mm = src.expiry_month ?? src.expiryMonth;
  const yy = src.expiry_year ?? src.expiryYear;
  if (mm && yy) expiry = `${String(mm).padStart(2, "0")}/${String(yy).slice(-2)}`;
  else if (typeof src.expiry === "string") expiry = src.expiry;
  return { status: normalizeCardStatus(src.status), last4, balance, expiry };
}

/** Why Freda could not create a card (card.failed webhook). Kept for support: users only see a fixed, translated message. */
export type CardFailure = { reason?: unknown; link?: unknown; linkExpiresAt?: unknown };

export function cardFailureMeta(f: CardFailure): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof f.reason === "string" && f.reason.trim()) out["card_failure_reason"] = f.reason.trim().slice(0, 300);
  // A re-verification link Freda offers the holder: only a plain https URL is kept.
  if (typeof f.link === "string" && f.link.length <= 500) {
    try {
      if (new URL(f.link).protocol === "https:") {
        out["verification_link"] = f.link;
        if (typeof f.linkExpiresAt === "string" && f.linkExpiresAt.length <= 40) out["verification_link_expires_at"] = f.linkExpiresAt;
      }
    } catch { /* not a URL */ }
  }
  return out;
}

/** Apply a Freda card status to our row and settle the creation charge on the first transition. */
export async function applyCardStatus(card: any, status: string, extra: Record<string, unknown> = {}, failure?: CardFailure) {
  const next = normalizeCardStatus(status);
  // A card that failed (its money is already back in the customer's wallet) is never brought back to life by a later answer: that would
  // be a card nobody paid for. It is said in the log, so someone looks at the card that Freda still has.
  if (card.status === "failed" && next !== "failed") {
    console.error("[card] ignoring the status", next, "for a card that already failed (money returned):", card.reference);
    return card;
  }
  const patch: Record<string, unknown> = { status: next, ...extra };
  Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
  const { error } = await db.from("cards").update(patch).eq("id", card.id);
  if (error) throw error;

  if (card.creation_tx_id && card.status === "pending") {
    if (next === "active") {
      if (await completeTx(card.creation_tx_id)) {
        await notify(card.user_id, "Card ready", `${card.label} is active and ready to use.`);
      }
    } else if (next === "failed") {
      if (await failTx(card.creation_tx_id, "Card creation failed")) {
        const why = failure ? cardFailureMeta(failure) : {};
        if (Object.keys(why).length) {
          console.error("[card] creation failed:", card.id, why["card_failure_reason"] ?? "(no reason given)", why["verification_link"] ? "(re-verification link saved)" : "");
          const t = await getTx(card.creation_tx_id);
          if (t) await mergeTxMeta(t, why);
        }
        if (why["verification_link"]) {
          await notify(card.user_id, "Identity verification needed", "The card service must verify your identity before it can issue your card. Open Cards to continue. Your money is back in your wallet.");
        } else if (mentionsIdentityVerification(why["card_failure_reason"])) {
          await notify(card.user_id, "Identity verification needed", "The card service could not verify your identity, so your card was not issued. Please contact support. Your money is back in your wallet.");
        } else {
          await notify(card.user_id, "Card creation failed", "We could not create your card. The money is back in your wallet.");
        }
      }
    }
  }
  return { ...card, ...patch };
}

/**
 * The card was closed (or deleted) on the Freda side. Block it here, and give the last known
 * balance back to the user's wallet once (Freda returns it to our master wallet on closure).
 */
export async function markCardGone(card: any, closure?: { refunded: number; fee: number } | null) {
  if (card.status === "terminated") return card;
  // Atomic: only the caller that flips the status may credit the wallet.
  const { data: flipped } = await db.from("cards").update({ status: "terminated", balance: 0 })
    .eq("id", card.id).neq("status", "terminated").select("id");
  if (!flipped?.length) return { ...card, status: "terminated", balance: 0 };
  // Freda keeps a closing fee out of what is left on the card. Use its own figures when it told us (card.terminated
  // webhook), else our last known balance and the documented fee. The user gets what comes back, no more.
  const left = closure ? round2(closure.refunded + closure.fee) : Number(card.balance ?? 0);
  const fee = closure ? closure.fee : closureFee(left);
  if (left > 0 && card.status !== "pending" && card.status !== "failed") {
    const { data: busy } = await db.from("transactions").select("id").eq("card_id", card.id)
      .eq("kind", "card_withdraw").eq("status", "pending").limit(1);
    if (!busy?.length) {
      const tx = await insertTx({
        user_id: card.user_id, kind: "card_withdraw", title: `${card.label} closed`, category: "Card",
        method: `Card •••• ${card.last4 ?? ""}`.trim(), amount: left, fee, status: "pending", card_id: card.id, provider: "freda",
        meta: { terminate: true, closed_by_provider: true },
      });
      if (tx) await completeTx(tx.id);
    }
  }
  await notify(card.user_id, "Card closed", `${card.label} was closed and can no longer be used.`);
  return { ...card, status: "terminated", balance: 0 };
}

/** Keeps one row per card movement (Freda charges per purchase, so the profit report counts them). A replay is ignored. */
async function recordCardEvent(card: any, d: any) {
  const id = typeof d?.id === "string" ? d.id.slice(0, 80) : "";
  if (!id) return;
  const amount = Math.abs(Number(d?.amount));
  try {
    const { error } = await db.from("card_events").upsert({
      id, card_id: card.id, user_id: card.user_id, type: String(d?.type ?? "").slice(0, 30), amount: Number.isFinite(amount) ? round2(amount) : 0,
    }, { onConflict: "id", ignoreDuplicates: true });
    if (error) console.error("[card-events]", error.message); // table missing until 20261101000000_admin_panel.sql is run
  } catch (e) {
    console.error("[card-events]", (e as Error).message);
  }
}

/**
 * A card.* webhook event (Freda docs, Notifications). Statuses come from the event; money-moving details do not:
 *  - card.terminated: refunded_usd + closure_fee_usd say what really came back, the wallet gets exactly that;
 *  - card.failed: failure_reason / verification_link are kept on the creation transaction (users see a fixed message);
 *  - card.balance_updated, card.transaction: the real card is re-read from Freda instead of trusting the payload.
 */
export async function handleCardEvent(type: string, d: any) {
  const card = await findCardForEvent(type, d);
  if (!card) {
    // Said in the log (an event that matches no card used to vanish silently); the periodic sync settles the card anyway.
    console.error("[webhook] card event for a card we do not know:", type, String(type === "card.transaction" ? d?.card_id : d?.id ?? "").slice(0, 60), String(d?.reference ?? "").slice(0, 80));
    return;
  }
  switch (type) {
    case "card.terminated": await markCardGone(card, readClosure(d)); break;
    case "card.failed": {
      const v = pickVerification(d);
      await applyCardStatus(card, "failed", {}, { reason: v.reason ?? d?.failure_reason, link: v.link ?? d?.verification_link, linkExpiresAt: v.expiresAt ?? d?.verification_link_expires_at });
      break;
    }
    case "card.balance_updated": await syncCardRow(card); break;
    case "card.transaction": await recordCardEvent(card, d); await syncCardRow(card); break;
    case "card.created": await applyCardStatus(card, "active"); break;
    case "card.frozen": await applyCardStatus(card, "disabled"); break;
    case "card.unfrozen": await applyCardStatus(card, "active"); break;
    default: break; // card.funded / card.withdrawn: settled by our own calls and the periodic card sync
  }
}

/**
 * The card a webhook event is about: by the Freda card id, else by the `reference` we sent when we asked for the card.
 * Freda answers POST /v1/cards with 202 and creates the card in the background, so card.created can arrive before we have saved the
 * card id; the reference is ours, so the card is still found, and its id is remembered from then on.
 */
export async function findCardForEvent(type: string, d: any): Promise<any | null> {
  // card.transaction names the card in `card_id` (its `id` is the movement); the other card events use `id`.
  const fredaCardId = type === "card.transaction" ? d?.card_id : d?.id;
  const id = typeof fredaCardId === "string" && fredaCardId ? fredaCardId : "";
  if (id) {
    const { data } = await db.from("cards").select("*").eq("freda_card_id", id).maybeSingle();
    if (data) return data;
  }
  const ref = typeof d?.reference === "string" ? d.reference.slice(0, 100) : "";
  if (!ref) return null;
  const { data } = await db.from("cards").select("*").eq("reference", ref).maybeSingle();
  if (!data) return null;
  if (!data.freda_card_id && id) {
    const { error } = await db.from("cards").update({ freda_card_id: id }).eq("id", data.id);
    if (!error) data.freda_card_id = id;
  }
  return data;
}

/** A card that is still "pending" after this long is flagged for review, and the customer is told (once). */
export const CARD_PENDING_REVIEW_MS = 15 * 60_000;

/**
 * Keeps on the creation ledger row what Freda last said about a card that is still pending, or why we could not read it, so an
 * administrator can see why it does not move. After CARD_PENDING_REVIEW_MS the row is flagged `needs_review` and the customer is told
 * once that it takes longer than usual. Never throws: bookkeeping must not break the sync it is called from.
 */
export async function trackPendingCard(card: any, seen: { fredaStatus?: string; error?: unknown; verification?: Verification }) {
  try {
    if (!card?.creation_tx_id) return;
    const tx = await getTx(card.creation_tx_id);
    if (!tx || tx.status !== "pending") return;
    const now = Date.now();
    const patch: Record<string, unknown> = {};
    let changed = false;
    if (seen.fredaStatus !== undefined) {
      changed = tx.meta?.card_freda_status !== seen.fredaStatus || !!tx.meta?.card_problem;
      patch["card_freda_status"] = seen.fredaStatus;
      patch["card_problem"] = null;
    }
    if (seen.error !== undefined) {
      const problem = describeFredaError(seen.error);
      changed = changed || tx.meta?.card_problem?.code !== problem.code || tx.meta?.card_problem?.status !== problem.status;
      patch["card_problem"] = problem;
    }
    // The card service waits for the holder to complete an identity verification: keep the reason and the link, and tell the customer once.
    const ver = seen.verification;
    if (ver && (ver.link || ver.reason)) {
      const why = cardFailureMeta({ reason: ver.reason, link: ver.link, linkExpiresAt: ver.expiresAt });
      for (const [k, v] of Object.entries(why)) if (tx.meta?.[k] !== v) { changed = true; patch[k] = v; }
      if (ver.link && !tx.meta?.verification_notified) {
        patch["verification_notified"] = true;
        await notify(card.user_id, "Identity verification needed", "The card service must verify your identity before it can issue your card. Open Cards to continue.");
      }
    }
    const age = now - Date.parse(String(card.created_at));
    const late = Number.isFinite(age) && age > CARD_PENDING_REVIEW_MS && !tx.meta?.needs_review;
    if (late) {
      patch["needs_review"] = true;
      const problem = seen.error !== undefined ? describeFredaError(seen.error) : tx.meta?.card_problem;
      console.error(`[card] still pending after ${Math.round(age / 60_000)} min: ${card.reference} freda id: ${card.freda_card_id ?? "(none yet)"} freda status: ${seen.fredaStatus ?? tx.meta?.card_freda_status ?? "(unknown)"}${problem?.code ? ` last error: ${problem.code} ${problem.status}` : ""}`);
      if (!tx.meta?.delay_notified) {
        patch["delay_notified"] = true;
        await notify(card.user_id, "Your card is taking longer than usual", "We are still creating your card. Your money is safe: if the card cannot be created, it goes back to your wallet.");
      }
    }
    // Nothing new and checked a moment ago: no need to write the row again (the customer's app asks every few seconds).
    const lastCheck = Date.parse(String(tx.meta?.card_checked_at ?? "")) || 0;
    if (!changed && !late && now - lastCheck < 60_000) return;
    patch["card_checked_at"] = new Date(now).toISOString();
    await mergeTxMeta(tx, patch);
  } catch (e) {
    console.error("[card] could not record the state of a pending card:", (e as Error).message);
  }
}

/** Keeps Freda's refusal on the creation ledger row (code, status, short message), for support. Never throws. */
export async function rememberCardProblem(txId: string, e: unknown) {
  try {
    const tx = await getTx(txId);
    if (tx) await mergeTxMeta(tx, { card_problem: describeFredaError(e) });
  } catch (err) {
    console.error("[card] could not record the problem of a card request:", (err as Error).message);
  }
}

export async function syncCardRow(card: any) {
  if (!card.freda_card_id || card.status === "terminated") return card; // nothing left to sync
  let c: any;
  try {
    c = await freda.getCard(card.freda_card_id);
  } catch (e) {
    // Freda no longer knows this card: it was closed there, so block it here too.
    if (e instanceof FredaError && e.status === 404 && card.status !== "pending") return markCardGone(card);
    if (card.status === "pending") await trackPendingCard(card, { error: e }); // why a new card does not move
    throw e;
  }
  const d = readCardDetails(c);
  if (d.status === "terminated") return markCardGone(card);
  const src = c?.card ?? c ?? {};
  // GET /v1/cards/:id carries `failure_reason` when the creation failed, and may carry the identity verification link the holder has
  // to open: keep both, like the card.failed webhook does.
  const ver = pickVerification(c);
  const next = await applyCardStatus(card, d.status, { last4: d.last4, expiry: d.expiry, balance: d.balance }, d.status === "failed" ? { reason: ver.reason ?? src.failure_reason, link: ver.link, linkExpiresAt: ver.expiresAt } : undefined);
  if (card.status === "pending" && d.status === "pending") await trackPendingCard(card, { fredaStatus: String(src.status ?? "pending").slice(0, 40), verification: ver });
  return next;
}

/**
 * Settles the cards that are still "pending", on their own and newest first. They used to share one query with the deposits and
 * withdrawals (oldest first, 25 rows): enough old unpaid deposits and a new card was never looked at again.
 * Cards older than an hour are looked at every ~5 minutes (tick % 10), those older than 14 days no longer.
 */
export async function settlePendingCards(tick: number) {
  const now = Date.now();
  const { data: cards, error } = await db.from("cards").select("*").eq("status", "pending")
    .gt("created_at", new Date(now - 14 * 24 * 3600_000).toISOString())
    .lt("created_at", new Date(now - 10_000).toISOString())
    .order("created_at", { ascending: false }).limit(40);
  if (error) { console.error("[card-sync] could not list the pending cards:", error.message); return; }
  for (const card of cards ?? []) {
    if (now - Date.parse(String(card.created_at)) > 3600_000 && tick % 10 !== 0) continue;
    try {
      const tx = card.creation_tx_id ? await getTx(card.creation_tx_id) : null;
      if (tx?.status === "pending") await settleTransaction(tx); // asks for the card again when its id was never saved, else reads its state
      else if (tx?.status === "failed") await db.from("cards").update({ status: "failed" }).eq("id", card.id).eq("status", "pending"); // money already back
      else await syncCardRow(card);
    } catch (e) {
      console.error("[card-sync] pending card", card.reference, (e as Error).message);
    }
  }
}

export const holderExists = (e: unknown) => e instanceof FredaError && /existe d[ée]j[àa]|already exist/i.test(e.message);

/**
 * Look for an ENROLLED holder on Freda (same email, or same ID number). Only `enrolled` holders can receive a card;
 * `pending` and `failed` ones are ignored (a failed holder must be created again). The id is the `id` field (`mpc_...`)
 * of GET /v1/cards/holders, newest first.
 */
export async function findExistingHolder(email: string, idNumber: string): Promise<{ found: boolean; id?: string }> {
  const all: any[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const res: any = await freda.listHolders(page);
      all.push(...pickArray(res, ["holders", "data", "items", "results"]));
      if (!res?.pagination?.has_more) break;
    }
  } catch (e) {
    console.error("[holder] could not list holders:", (e as Error).message);
    return { found: false };
  }
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const when = (h: any) => Date.parse(h?.created_at ?? h?.createdAt ?? "") || 0;
  const newestFirst = (list: any[]) => [...list].sort((x, y) => when(y) - when(x));
  const mine = all.filter((h) => norm(h?.email) === norm(email) ||
    (idNumber && norm(h?.identificationNumber ?? h?.identification_number ?? h?.id_number) === norm(idNumber)));
  const enrolled = newestFirst(mine.filter((h) => !h?.status || norm(h.status) === "enrolled"));
  // The holder already exists at Freda: take its id (the newest one of this user), whatever its status says. Creating another one
  // is refused ("already exists"), and the id is what the card request needs.
  const hit = enrolled[0] ?? newestFirst(mine)[0];
  if (!hit) {
    console.error("[holder] no holder on Freda for this user.");
    return { found: false };
  }
  if (!enrolled[0]) console.error("[holder] using the existing holder although its status is", String(hit.status ?? "?"), String(hit.failure_reason ?? "").slice(0, 120));
  const id = pickId(hit);
  if (!id) console.error("[holder] enrolled holder without id (status=" + String(hit?.status ?? "") + ")");
  return { found: true, ...(id ? { id } : {}) };
}

/**
 * Last resort when Freda refuses to create a holder because the identity "already exists" but no enrolled holder
 * matches our e-mail: the holder was created earlier under another e-mail. Look for an enrolled holder with the same
 * first and last name that is not already linked to another Kasho account. Only used after Freda itself reported a duplicate.
 */
export async function findEnrolledHolderByName(firstName: string, lastName: string, userId: string): Promise<string | undefined> {
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const all: any[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const res: any = await freda.listHolders(page);
      all.push(...pickArray(res, ["holders", "data", "items", "results"]));
      if (!res?.pagination?.has_more) break;
    }
  } catch { return undefined; }
  const hits = all.filter((h) => norm(h?.status) === "enrolled" && norm(h?.first_name) === norm(firstName) && norm(h?.last_name) === norm(lastName));
  for (const h of hits) {
    const id = pickId(h);
    if (!id) continue;
    const { data: links } = await db.from("card_holders").select("user_id").eq("freda_holder_id", id);
    if ((links ?? []).every((r: any) => r.user_id === userId)) {
      console.log("[holder] linked existing enrolled holder by name:", id);
      return id;
    }
  }
  return undefined;
}

/** Money that left the user's wallet through the given transaction kinds in the last 24 hours. */
export async function spentLast24h(userId: string, kinds: string[]): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await db.from("transactions").select("amount, fee")
    .eq("user_id", userId).in("kind", kinds).neq("status", "failed").gt("created_at", since);
  if (error) throw error;
  return (data ?? []).reduce((sum: number, r: any) => sum + Math.max(0, -Number(r.amount)) + Number(r.fee ?? 0), 0);
}

/** True when another closing row (card_withdraw with meta.terminate) of this card is older than `tx` and still counts (pending or completed). */
export async function hasOlderTerminateTx(cardId: string, tx: { id: string; created_at: string }): Promise<boolean> {
  const { data, error } = await db.from("transactions").select("id, created_at")
    .eq("card_id", cardId).eq("kind", "card_withdraw").eq("meta->>terminate", "true").neq("id", tx.id).neq("status", "failed");
  if (error) throw error;
  return (data ?? []).some((o: any) => o.created_at < tx.created_at || (o.created_at === tx.created_at && o.id < tx.id));
}

export async function getOwnedCard(userId: string, cardId: string) {
  const { data, error } = await db.from("cards").select("*").eq("id", cardId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError("Card not found.");
  return data;
}

// Map a raw Freda card transaction into a display row. Fields are read defensively.
/** Freda may send ISO strings or unix timestamps (seconds or ms); always return a valid ISO string. */
function normalizeDate(v: unknown): string {
  let d: Date;
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,13}$/.test(v.trim()))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    d = new Date(typeof v === "string" ? v : NaN);
  }
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function mapCardTransaction(t: any, i: number) {
  const type = String(t?.type ?? "").toUpperCase();
  const mode = String(t?.mode ?? "").toUpperCase();
  const raw = Number(t?.amount ?? 0);
  const amount = Math.abs(raw);
  const credit = mode === "CREDIT" || raw > 0 && mode !== "DEBIT";
  const merchant = t?.merchant?.name ?? t?.merchant_name ?? t?.merchant ?? t?.description ?? type.replace(/_/g, " ");
  return {
    id: String(t?.id ?? t?.reference ?? `ct_${i}`),
    title: typeof merchant === "string" && merchant ? merchant : "Card activity",
    type,
    amount: credit ? amount : -amount,
    status: String(t?.status ?? "").toLowerCase(),
    createdAt: normalizeDate(t?.created_at ?? t?.createdAt),
  };
}

// ---------------------------------------------------------------- Didit KYC
import { getDecision, mapStatus } from "./didit.js";
import { decryptField, encryptField } from "./crypto.js";

/**
 * Didit does not always send its webhook, so the decision is asked for whenever it matters: if this user is not verified here yet but has a
 * Didit session, read the decision now (the same step as syncKyc). Never throws: a Didit problem must not break the request it helps.
 */
export async function refreshKycFromDidit(userId: string): Promise<void> {
  try {
    const { data: prof } = await db.from("profiles").select("kyc_status").eq("id", userId).single();
    if (prof?.kyc_status === "verified") return;
    const { data: sub } = await db.from("kyc_submissions").select("didit_session_id").eq("user_id", userId)
      .not("didit_session_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (sub?.didit_session_id) await applyKycDecision(sub.didit_session_id, userId);
  } catch (e) {
    console.error("[kyc] could not read the Didit decision:", (e as Error).message);
  }
}

/** Reads the Didit decision for a session and applies it to the user's profile. Returns the Kasho status. */
export async function applyKycDecision(sessionId: string, userId: string): Promise<string> {
  const dec = await getDecision(sessionId);
  // The session must belong to this user (vendor_data was set to the user id when we created it).
  if (dec?.vendor_data && String(dec.vendor_data) !== userId) throw new AppError("Session mismatch.");
  const status = mapStatus(dec?.status);
  const { data: cur } = await db.from("profiles").select("kyc_status").eq("id", userId).single();
  if (cur?.kyc_status === "verified") return "verified"; // never downgrade
  await db.from("kyc_submissions").update({
    status, reviewed_at: status === "pending" ? null : new Date().toISOString(),
  }).eq("didit_session_id", sessionId);
  if (status === "verified") {
    const idv = Array.isArray(dec?.id_verifications) ? dec.id_verifications[0] : null;
    const patch: Record<string, unknown> = { kyc_status: "verified" };
    if (idv?.first_name) patch["first_name"] = String(idv.first_name).slice(0, 60);
    if (idv?.last_name) patch["last_name"] = String(idv.last_name).slice(0, 60);
    if (idv?.date_of_birth && /^\d{4}-\d{2}-\d{2}$/.test(idv.date_of_birth)) patch["date_of_birth"] = idv.date_of_birth;
    const docNo = idv?.document_number ?? idv?.personal_number;
    if (docNo && String(docNo).length >= 3) patch["id_number"] = encryptField(String(docNo).slice(0, 40));
    const iso2 = String(idv?.issuing_state ?? idv?.nationality ?? "");
    if (/^[A-Za-z]{2}$/.test(iso2)) patch["country"] = iso2.toUpperCase();
    else if (iso2.toUpperCase() === "HTI") patch["country"] = "HT";
    else if (iso2.toUpperCase() === "USA") patch["country"] = "US";
    else if (iso2.toUpperCase() === "DOM") patch["country"] = "DO";
    else if (iso2.toUpperCase() === "FRA") patch["country"] = "FR";
    else if (iso2.toUpperCase() === "CAN") patch["country"] = "CA";
    Object.assign(patch, await storeKycDocument(userId, idv));
    await updateProfile(userId, patch);
    await notify(userId, "Identity verified", "Your identity has been confirmed.");
  } else if (status === "rejected" && cur?.kyc_status !== "rejected") {
    await db.from("profiles").update({ kyc_status: "rejected" }).eq("id", userId);
    await notify(userId, "Verification declined", "We could not verify your identity. You can try again.");
  }
  return status;
}


// ---------------------------------------------------------------- ID document for Freda card holders
const KYC_BUCKET = "kyc-docs";
export type FredaIdentity = {
  type: "NIN" | "PASSPORT" | "VOTERS_CARD" | "DRIVERS_LICENSE"; number: string; imageUrl: string; country?: string;
  /** Back of the document: required for some countries, optional for the others (Freda docs, holders). */
  imageBackUrl?: string;
};

/** Didit document_type -> Freda identity.type */
export function mapDocType(t: unknown): FredaIdentity["type"] {
  const v = String(t ?? "").toLowerCase();
  if (v.includes("passport")) return "PASSPORT";
  if (v.includes("driv")) return "DRIVERS_LICENSE";
  if (v.includes("vot")) return "VOTERS_CARD";
  return "NIN"; // national identity card
}

/** Downloads one Didit ID image into the private bucket and returns its path, or undefined when it could not be stored. */
async function storeIdImage(userId: string, url: unknown, side: "front" | "back"): Promise<string | undefined> {
  if (!isSafeRemoteUrl(url)) return undefined;
  try {
    const res = await fetch(url as string, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) throw new Error(`bad size ${buf.length}`);
    const ct = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const path = `${userId}/id-${side}.${ext}`;
    await db.storage.createBucket(KYC_BUCKET, { public: false }).catch(() => {}); // already exists is fine
    const { error } = await db.storage.from(KYC_BUCKET).upload(path, buf, { contentType: ct, upsert: true });
    if (error) throw error;
    return path;
  } catch (e) {
    console.error(`[kyc] could not store the ID image (${side}):`, (e as Error).message);
    return undefined;
  }
}

/**
 * Copies the Didit ID images into a private bucket (Didit links expire) and returns the profile fields to save.
 * `kyc_doc_back_path` is "" when Didit has no back image for this document (a passport): that means "checked, none".
 */
export async function storeKycDocument(userId: string, idv: any): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (!idv) return out;
  out["kyc_doc_type"] = mapDocType(idv.document_type);
  const front = await storeIdImage(userId, idv.full_front_image ?? idv.front_image, "front"); // the whole photo, not a crop
  if (front) out["kyc_doc_path"] = front;
  const backUrl = idv.full_back_image ?? idv.back_image;
  if (!backUrl) out["kyc_doc_back_path"] = "";
  else {
    const back = await storeIdImage(userId, backUrl, "back");
    if (back) out["kyc_doc_back_path"] = back;
  }
  return out;
}

/**
 * Saves profile fields. If the database has not received the `kyc_doc_back_path` migration yet, that one field is
 * dropped instead of losing the whole update (KYC approval must never depend on it).
 */
async function updateProfile(userId: string, patch: Record<string, unknown>) {
  let { error } = await db.from("profiles").update(patch).eq("id", userId);
  if (error && "kyc_doc_back_path" in patch && /kyc_doc_back_path/.test(error.message)) {
    const { kyc_doc_back_path: _omit, ...rest } = patch;
    ({ error } = Object.keys(rest).length ? await db.from("profiles").update(rest).eq("id", userId) : { error: null });
  }
  if (error) console.error("[kyc] profile update failed:", error.message);
}

/**
 * Builds the `identity` object Freda requires on POST /v1/cards/holders from the user's Didit KYC.
 * Users verified before this feature are refreshed from their Didit decision (front image, and the back when it was never fetched).
 */
export async function getFredaIdentity(userId: string): Promise<FredaIdentity | null> {
  const load = async () => {
    let r = await db.from("profiles").select("id_number, country, kyc_doc_type, kyc_doc_path, kyc_doc_back_path").eq("id", userId).single();
    // Migration 20261031000000_kyc_doc_back.sql not run yet: carry on without the back of the document
    // ("" = nothing to fetch, so Didit is not asked again on every call until the column exists).
    if (r.error && /kyc_doc_back_path/.test(r.error.message)) {
      r = await db.from("profiles").select("id_number, country, kyc_doc_type, kyc_doc_path").eq("id", userId).single();
      if (r.data) r = { ...r, data: { ...r.data, kyc_doc_back_path: "" } };
    }
    return r.data;
  };
  let prof = await load();
  // `kyc_doc_back_path` null = never fetched. "" = fetched, the document has no back.
  if (prof && (!prof.kyc_doc_path || prof.kyc_doc_back_path == null)) {
    try {
      const { data: sub } = await db.from("kyc_submissions").select("didit_session_id").eq("user_id", userId)
        .not("didit_session_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (sub?.didit_session_id) {
        const dec = await getDecision(sub.didit_session_id);
        const idv = Array.isArray(dec?.id_verifications) ? dec.id_verifications[0] : null;
        const patch = await storeKycDocument(userId, idv);
        if (Object.keys(patch).length) await updateProfile(userId, patch);
        prof = await load();
      }
    } catch (e) {
      console.error("[kyc] could not refresh the ID document from Didit:", (e as Error).message);
    }
  }
  const number = decryptField(prof?.id_number);
  if (!prof?.kyc_doc_path || !number) return null;
  const sign = async (path: string) => {
    const { data: signed, error } = await db.storage.from(KYC_BUCKET).createSignedUrl(path, 24 * 3600);
    if (error || !signed?.signedUrl) console.error("[kyc] could not sign the ID image URL:", error?.message);
    return signed?.signedUrl as string | undefined;
  };
  // Freda's documented format is Base64 (data:image/jpeg;base64,...), about 700 KB at most. A larger image goes as a signed https link,
  // which Freda downloads and converts itself.
  const asData = async (path: string): Promise<string | undefined> => {
    try {
      const { data: blob, error } = await db.storage.from(KYC_BUCKET).download(path);
      if (error || !blob) return undefined;
      const buf = Buffer.from(await blob.arrayBuffer());
      if (buf.length === 0 || buf.length > 700 * 1024) return undefined;
      const t = String(blob.type || "").split(";")[0];
      const mime = /^image\/(jpeg|png|webp)$/.test(t) ? t : path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch (e) {
      console.error("[kyc] could not read the ID image as Base64:", (e as Error).message);
      return undefined;
    }
  };
  const image = async (path: string) => (await asData(path)) ?? (await sign(path));
  const imageUrl = await image(prof.kyc_doc_path);
  if (!imageUrl) return null;
  const imageBackUrl = prof.kyc_doc_back_path ? await image(prof.kyc_doc_back_path) : undefined;
  const country = /^[A-Za-z]{2}$/.test(prof.country ?? "") ? String(prof.country).toUpperCase() : undefined;
  return { type: mapDocType(prof.kyc_doc_type), number: String(number), imageUrl, ...(imageBackUrl ? { imageBackUrl } : {}), country };
}
