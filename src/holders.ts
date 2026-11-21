// Card holders (Freda "titulaires") for the new card program: tokenized Visa / Mastercard cards that work with Apple Pay and Google Pay
// (https://issuing.fredapay.com/docs/nouveau-programme-cartes).
//
//  - As soon as Didit approves a customer's KYC, the holder is registered at Freda with the verified identity (name, birth date, ID number,
//    front AND back of the ID document, phone, address). Customers verified before the program are registered by a background pass.
//  - Freda verifies the holder with the new issuer, which can take a few minutes in Live. While it is not done, a card would be issued
//    the old way (no Apple Pay / Google Pay), so the customer can only create a card once the holder is "ready".
//  - Freda keeps one holder per e-mail: a customer who already had one is sent again with `restart_verification: true` (same mpc_ id),
//    which starts a new verification with the complete identity.
import * as L from "./ledger.js";
import { FredaError, freda, fredaConfigured, fredaMode, pickId } from "./freda.js";
import { decryptField, encryptField } from "./crypto.js";
import { supabaseAdmin } from "./supabase.js";
import { pickVerification } from "./verification.js";

export type HolderState = "needs_kyc" | "needs_profile" | "none" | "pending" | "ready" | "failed";
export type HolderInfo = {
  state: HolderState;
  /** Why the holder is not ready (shown to the customer), or null. */
  reason: string | null;
  /** Profile fields the customer still has to fill in (state "needs_profile"). */
  missing: string[];
  holderId: string | null;
  /** True when the customer may ask for a new verification now. */
  canRetry: boolean;
};

/** What enrollHolder reads outside the database (replaced in the tests). */
export const deps = {
  identity: (userId: string) => L.getFredaIdentity(userId),
  email: async (userId: string): Promise<string> => String((await supabaseAdmin.auth.admin.getUserById(userId)).data?.user?.email ?? ""),
};

/** Countries the card issuer does not accept (Freda: HOLDER_COUNTRY_UNSUPPORTED). */
export const UNSUPPORTED_COUNTRIES = new Set(["CU", "IR", "KP", "SY", "RU", "BY"]);
/** The background pass tries a customer again at most every 6 hours (Freda allows 5 verifications per 24 h). */
const AUTO_RETRY_MS = 6 * 3600_000;
/** A customer can ask for a new verification every 2 minutes at most. */
const CUSTOMER_RETRY_MS = 2 * 60_000;
/** A pending holder is asked again at Freda at most every 20 seconds, whatever the number of screens polling it. */
const RECHECK_MS = 20_000;

export const HOLDER_PENDING_MESSAGE =
  "Your card profile is being verified by the card issuer. This usually takes a few minutes. You can create your card as soon as it is done.";
const HOLDER_FAILED_MESSAGE = "The card issuer could not verify your identity. Please contact support.";

/** Freda refusals of POST /v1/cards/holders, in words a customer understands (never Freda's raw text). */
const HOLDER_ERRORS: Record<string, string> = {
  HOLDER_UNDERAGE: "The card holder must be at least 18 years old.",
  HOLDER_COUNTRY_UNSUPPORTED: "Cards cannot be issued for this country.",
  HOLDER_DOCUMENT_BACK_REQUIRED: "The card issuer needs the back of your ID document. Please contact support.",
  HOLDER_VERIFICATION_LIMIT: "Too many verification attempts today. Please try again tomorrow.",
  MISSING_FIELDS: "Some details of your profile are missing. Please complete your profile.",
  INVALID_PHOTO: "The photo of your ID document could not be used. Please contact support.",
  HOLDER_CREATION_FAILED: HOLDER_FAILED_MESSAGE,
};

const FIELD_NAMES: Record<string, string> = {
  first_name: "first name", last_name: "last name", date_of_birth: "date of birth", country: "country", id_number: "ID number",
  phone_number: "phone number", address_street: "street address", address_city: "city", address_state: "state", address_postal_code: "postal code",
};

/** An e-mail that an earlier version tagged (name+kxxxx@host) is turned back into the customer's real one. */
export const realEmail = (e: unknown) => String(e ?? "").replace(/\+k[a-z0-9]{5,}@/i, "@");

/** What Freda says about a holder (GET /v1/cards/holders/:id or the POST answer) -> pending / ready / failed. */
export function readHolderState(h: any): { state: "pending" | "ready" | "failed"; reason: string | null } {
  const status = String(h?.status ?? "").toLowerCase();
  const v = h?.verification;
  const vStatus = String(v?.status ?? "").toLowerCase();
  const reason = (h?.failure_reason as string | undefined) || pickVerification(v ?? {}).reason || null;
  if (status === "failed" || ["failed", "declined", "rejected"].includes(vStatus)) return { state: "failed", reason };
  // "enrolled" is ready unless the new issuer says it has not finished verifying the identity yet.
  if (status === "enrolled" && !(v && v.ready_for_cards === false)) return { state: "ready", reason: null };
  return { state: "pending", reason };
}

/** Required profile fields that are empty (names as shown to the customer). */
export function missingProfileFields(p: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const k of Object.keys(FIELD_NAMES)) {
    const v = k === "id_number" ? decryptField(p?.[k] as string | null) : p?.[k];
    if (!String(v ?? "").trim()) out.push(FIELD_NAMES[k]!);
  }
  return out;
}

export function ageYears(dob: unknown, now = Date.now()): number {
  const t = Date.parse(String(dob ?? ""));
  return Number.isFinite(t) ? (now - t) / (365.25 * 24 * 3600_000) : NaN;
}

async function latestRow(userId: string, mode: string): Promise<any | null> {
  const { data } = await L.db.from("card_holders").select("*").eq("user_id", userId).eq("mode", mode).order("created_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function saveRow(row: any | null, userId: string, mode: string, patch: Record<string, unknown>): Promise<any> {
  if (row) {
    const { data, error } = await L.db.from("card_holders").update(patch).eq("id", row.id).select("*").single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await L.db.from("card_holders").insert({ user_id: userId, mode, email: "", first_name: "", last_name: "", ...patch }).select("*").single();
  if (error) throw error;
  return data;
}

/** Tells the customer once when the holder becomes ready or fails (the card page also shows it). */
async function announce(userId: string, before: string | null | undefined, after: string) {
  if (before === after) return;
  if (after === "ready") await L.notify(userId, "Card profile verified", "You can now create your card. It works with Apple Pay and Google Pay.");
  else if (after === "failed" && before === "pending") await L.notify(userId, "Card profile not verified", "The card issuer could not verify your identity. Open Cards to see what to do.");
}

/**
 * Registers (or registers again) the customer's holder at Freda with the verified identity. Never throws for a Freda refusal:
 * the outcome is saved on the card_holders row and returned. `why` is only for the logs.
 */
export async function enrollHolder(userId: string, why: "kyc" | "backfill" | "customer"): Promise<HolderInfo> {
  const none = (state: HolderState, reason: string | null, missing: string[] = []): HolderInfo => ({ state, reason, missing, holderId: null, canRetry: false });
  if (!fredaConfigured()) return none("failed", "The card service is not available right now.");
  const mode = fredaMode();
  const { data: p } = await L.db.from("profiles").select("*").eq("id", userId).single();
  if (p?.kyc_status !== "verified") return none("needs_kyc", "Verify your identity before creating a card.");
  const row = await latestRow(userId, mode);
  const now = new Date().toISOString();
  const missing = missingProfileFields(p);
  if (missing.length) {
    await saveRow(row, userId, mode, { last_attempt_at: now, verification_status: "needs_profile", failure_reason: null });
    return none("needs_profile", `Please complete your profile: ${missing.join(", ")}.`, missing);
  }
  const fail = async (reason: string, holderId: string | null = row?.freda_holder_id ?? null): Promise<HolderInfo> => {
    await saveRow(row, userId, mode, { last_attempt_at: now, verification_status: "failed", failure_reason: reason });
    await announce(userId, row?.verification_status, "failed");
    return { state: "failed", reason, missing: [], holderId, canRetry: true };
  };
  if (!(ageYears(p.date_of_birth) >= 18)) return fail(HOLDER_ERRORS["HOLDER_UNDERAGE"]!);
  const country = String(p.country ?? "").toUpperCase();
  if (UNSUPPORTED_COUNTRIES.has(country)) return fail(HOLDER_ERRORS["HOLDER_COUNTRY_UNSUPPORTED"]!);

  const identity = await deps.identity(userId);
  if (!identity) return fail("We could not read your ID document. Please contact support.");
  // The new issuer needs the back of every ID document except a passport.
  if (identity.type !== "PASSPORT" && !identity.imageBackUrl) return fail(HOLDER_ERRORS["HOLDER_DOCUMENT_BACK_REQUIRED"]!);

  const email = realEmail(await deps.email(userId)).trim().toLowerCase();
  if (!email) return fail(HOLDER_FAILED_MESSAGE);
  const idNumber = decryptField(p.id_number);
  const phone = String(p.phone_number ?? "").replace(/\D/g, "");
  const phoneCode = String(p.phone_code ?? "+509").trim() || "+509";
  const body: Record<string, unknown> = {
    firstName: p.first_name, lastName: p.last_name, email, country, dob: String(p.date_of_birth).slice(0, 10),
    identificationNumber: idNumber, phoneShortCode: phoneCode.startsWith("+") ? phoneCode : `+${phoneCode}`, phoneNumber: phone,
    address: { street: p.address_street, city: p.address_city, state: p.address_state, postalCode: p.address_postal_code, country },
    identity,
  };
  // A customer who already has a holder at Freda (same e-mail) gets a NEW verification with the complete identity, same mpc_ id.
  let restart = !!row?.freda_holder_id;
  let res: any;
  try {
    try {
      res = await freda.createHolder(restart ? { ...body, restart_verification: true } : body);
    } catch (e) {
      if (!(e instanceof FredaError && e.code === "HOLDER_EMAIL_EXISTS") || restart) throw e;
      restart = true;
      res = await freda.createHolder({ ...body, restart_verification: true });
    }
    // Answered with the holder that already existed (same e-mail), without verifying it again: start the new verification.
    if (res?.already_existed === true && !restart) {
      restart = true;
      res = await freda.createHolder({ ...body, restart_verification: true });
    }
  } catch (e) {
    if (e instanceof FredaError && e.ambiguous) {
      await saveRow(row, userId, mode, { last_attempt_at: now });
      console.error("[holder] the outcome of POST /v1/cards/holders is unknown, it will be tried again:", userId.slice(0, 8), e.code);
      return { state: "pending", reason: HOLDER_PENDING_MESSAGE, missing: [], holderId: row?.freda_holder_id ?? null, canRetry: false };
    }
    const fe = e instanceof FredaError ? e : null;
    console.error("[holder] POST /v1/cards/holders refused (", why, "):", userId.slice(0, 8), fe?.status, fe?.code, String(fe?.message ?? (e as Error).message).slice(0, 200));
    return fail((fe && HOLDER_ERRORS[fe.code]) || HOLDER_FAILED_MESSAGE);
  }

  const holderId = pickId(res) ?? row?.freda_holder_id ?? null;
  if (holderId) {
    // One Freda holder belongs to one customer: never link it to a second account.
    const { data: taken } = await L.db.from("card_holders").select("user_id").eq("freda_holder_id", holderId).eq("mode", mode).neq("user_id", userId).limit(1);
    if (taken?.length) {
      console.error("[holder] Freda answered with a holder already linked to another account:", holderId);
      return fail(HOLDER_FAILED_MESSAGE, null);
    }
  }
  // The POST answer may not say yet what the new issuer thinks: read the holder.
  let h: any = res?.holder ?? res?.profile ?? null;
  if (holderId) h = (await freda.getHolder(holderId).catch(() => null))?.holder ?? h;
  const st = holderId ? readHolderState(h ?? {}) : { state: "pending" as const, reason: null };
  const saved = await saveRow(row, userId, mode, {
    freda_holder_id: holderId, email, first_name: p.first_name, last_name: p.last_name, dob: p.date_of_birth, country, id_number: encryptField(idNumber),
    phone_code: phoneCode, phone_number: phone, address_street: p.address_street, address_city: p.address_city, address_state: p.address_state,
    address_postal_code: p.address_postal_code, status: String(h?.status ?? "pending"), identity_sent: true,
    verification_status: st.state, failure_reason: st.state === "failed" ? (st.reason ?? HOLDER_FAILED_MESSAGE) : null,
    program_enrolled_at: now, last_attempt_at: now, checked_at: now,
  });
  console.log("[holder]", restart ? "verification restarted" : "registered", `(${why})`, String(holderId ?? "?"), "->", st.state, st.reason ? String(st.reason).slice(0, 160) : "");
  await announce(userId, row?.verification_status, st.state);
  return {
    state: st.state, reason: st.state === "ready" ? null : st.state === "failed" ? saved.failure_reason : HOLDER_PENDING_MESSAGE,
    missing: [], holderId, canRetry: st.state === "failed",
  };
}

/** Reads the holder again at Freda (pending holders) and saves what changed. */
async function recheck(row: any, userId: string): Promise<any> {
  const g: any = await freda.getHolder(row.freda_holder_id);
  const st = readHolderState(g?.holder ?? g);
  const patch: Record<string, unknown> = { checked_at: new Date().toISOString(), status: String((g?.holder ?? g)?.status ?? row.status) };
  if (st.state !== row.verification_status) {
    patch["verification_status"] = st.state;
    patch["failure_reason"] = st.state === "failed" ? (st.reason ?? HOLDER_FAILED_MESSAGE) : null;
  }
  const { data, error } = await L.db.from("card_holders").update(patch).eq("id", row.id).select("*").single();
  if (error) throw error;
  if (patch["verification_status"]) {
    console.log("[holder]", row.freda_holder_id, row.verification_status, "->", st.state, st.reason ? String(st.reason).slice(0, 160) : "");
    await announce(userId, row.verification_status, st.state);
  }
  return data;
}

/** Where the customer's holder is. `refresh` asks Freda again about a holder that is not ready (or before a card is created). */
export async function holderInfo(userId: string, opts: { refresh?: boolean; force?: boolean } = {}): Promise<HolderInfo> {
  const { data: p } = await L.db.from("profiles").select("*").eq("id", userId).single();
  if (p?.kyc_status !== "verified") return { state: "needs_kyc", reason: "Verify your identity before creating a card.", missing: [], holderId: null, canRetry: false };
  if (!fredaConfigured()) return { state: "failed", reason: "The card service is not available right now.", missing: [], holderId: null, canRetry: false };
  let row = await latestRow(userId, fredaMode());
  const sinceAttempt = row?.last_attempt_at ? Date.now() - Date.parse(row.last_attempt_at) : Infinity;
  const missing = missingProfileFields(p);
  if (missing.length) return { state: "needs_profile", reason: `Please complete your profile: ${missing.join(", ")}.`, missing, holderId: null, canRetry: true };
  if (!row?.program_enrolled_at || !row.freda_holder_id) {
    if (row?.verification_status === "failed") return { state: "failed", reason: row.failure_reason ?? HOLDER_FAILED_MESSAGE, missing: [], holderId: null, canRetry: sinceAttempt > CUSTOMER_RETRY_MS };
    return { state: "none", reason: null, missing: [], holderId: null, canRetry: sinceAttempt > CUSTOMER_RETRY_MS };
  }
  const stale = !row.checked_at || Date.now() - Date.parse(row.checked_at) > RECHECK_MS;
  if (opts.refresh && (opts.force || (row.verification_status !== "ready" && stale))) {
    try { row = await recheck(row, userId); } catch (e) { console.error("[holder] could not read the holder:", (e as Error).message); }
  }
  const state = (["pending", "ready", "failed"].includes(row.verification_status) ? row.verification_status : "pending") as HolderState;
  return {
    state, holderId: row.freda_holder_id, missing: [],
    reason: state === "ready" ? null : state === "failed" ? (row.failure_reason ?? HOLDER_FAILED_MESSAGE) : HOLDER_PENDING_MESSAGE,
    canRetry: state === "failed" && sinceAttempt > CUSTOMER_RETRY_MS,
  };
}

/** The customer asks for a (new) verification: after completing the profile, or after a refusal. */
export async function retryHolder(userId: string): Promise<HolderInfo> {
  const cur = await holderInfo(userId);
  if (cur.state === "needs_kyc" || cur.state === "needs_profile" || cur.state === "ready" || cur.state === "pending") return cur;
  if (!cur.canRetry) throw new L.AppError("Please wait a few minutes before trying again.");
  return enrollHolder(userId, "customer");
}

/** The card was refused because the holder is not ready after all: show "being verified" again and let the background pass check it. */
export async function markHolderPending(userId: string) {
  const row = fredaConfigured() ? await latestRow(userId, fredaMode()) : null;
  if (row) await L.db.from("card_holders").update({ verification_status: "pending", checked_at: null }).eq("id", row.id);
}

// ------------------------------------------------------------------ background passes (reconcile loop)
/** Asks Freda about holders that are still being verified (oldest check first). */
export async function refreshPendingHolders(limit = 10) {
  if (!fredaConfigured()) return;
  const { data, error } = await L.db.from("card_holders").select("*").eq("mode", fredaMode()).eq("verification_status", "pending")
    .not("freda_holder_id", "is", null).order("checked_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) { if (!/verification_status|checked_at/.test(error.message)) console.error("[holder] could not list pending holders:", error.message); return; }
  for (const row of data ?? []) {
    try { await recheck(row, row.user_id); } catch (e) { console.error("[holder] pending holder", row.freda_holder_id, (e as Error).message); }
  }
}

let warnedMigration = false;
/**
 * Customers whose KYC is verified but who are not registered in the new card program yet (everyone verified before it, and anyone whose
 * registration failed for a reason that can pass later): a few per round, each at most every 6 hours.
 */
export async function enrollMissingHolders(limit = 3) {
  if (!fredaConfigured()) return;
  const mode = fredaMode();
  const { data: rows, error } = await L.db.from("card_holders").select("user_id, program_enrolled_at, last_attempt_at, verification_status").eq("mode", mode);
  if (error) {
    if (!warnedMigration) { warnedMigration = true; console.error("[holder] run supabase/migrations/20261121000000_card_program.sql:", error.message); }
    return;
  }
  const done = new Set<string>();
  const recent = new Set<string>();
  for (const r of rows ?? []) {
    if (r.program_enrolled_at) done.add(r.user_id);
    if (r.last_attempt_at && Date.now() - Date.parse(r.last_attempt_at) < AUTO_RETRY_MS) recent.add(r.user_id);
  }
  const { data: verified } = await L.db.from("profiles").select("id").eq("kyc_status", "verified").order("updated_at", { ascending: false }).limit(2000);
  const todo = (verified ?? []).map((v: any) => String(v.id)).filter((id: string) => !done.has(id) && !recent.has(id)).slice(0, limit);
  for (const id of todo) {
    try { await enrollHolder(id, "backfill"); } catch (e) { console.error("[holder] backfill", id.slice(0, 8), (e as Error).message); }
  }
}
