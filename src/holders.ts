// Card holders (Freda "titulaires") for the new card program: tokenized Visa / Mastercard cards that work with Apple Pay and Google Pay
// (https://issuing.fredapay.com/docs/nouveau-programme-cartes).
//
//  - As soon as Didit approves a customer's KYC, the holder is registered at Freda with the verified identity (name, birth date, ID number,
//    front AND back of the ID document, phone, address). Customers verified before the program are registered by a background pass.
//  - Freda has the holder accepted by the new program, which can take a few minutes in Live. The answer comes ONLY by webhook
//    (holder.verified / holder.rejected): GET /v1/cards/holders/:id says "enrolled" either way. While it is not accepted, a card would be
//    issued the old way (no Apple Pay / Google Pay), so the customer can only create a card after holder.verified.
//    card_holders.verification_status: "verified" (holder.verified received: ready), "failed", anything else: still waiting.
//  - Freda keeps one holder per e-mail: for a customer who already had one, POST /v1/cards/holder-profile with
//    `restart_verification: true` and the complete identity starts a new verification (same mpc_ id; Freda answers `restarted: true`).
//    POST /v1/cards/holders does NOT do that: it answers an existing e-mail "as is".
//  - Registering a holder is NOT enough: Freda keeps it "à vérifier" until the photo of the ID is SUBMITTED for verification
//    (dashboard, or POST /v1/cards/holder-profile with `restart_verification: true` and the photos). The result comes back at once
//    (holder.verified / holder.rejected). So every holder is registered, then its ID is submitted right away.
//  - verification_status "submitted": registered, but the ID photo was not confirmed as submitted yet ("à vérifier" at Freda);
//    "docs_sent": the ID was submitted (`restarted: true`), waiting for the decision.
//  - (old note) verification_status "submitted": sent by this version and waiting for the decision. "pending" (or "ready") on a holder that
//    existed before its program registration comes from an earlier version whose "restart" went to /v1/cards/holders and did nothing.
import { createHash } from "node:crypto";
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
/** A holder whose ID was not submitted (or not confirmed) is tried again after 30 minutes. */
const DOCS_RETRY_MS = 30 * 60_000;
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

/** The customer's real e-mail (an address tagged by a test version, name+kpxxxxxx@host, is turned back into it). */
export const realEmail = (e: unknown) => String(e ?? "").replace(/\+kp[a-f0-9]{6}@/i, "@");

/**
 * Freda keeps ONE holder per e-mail, so a customer who already has a holder cannot get a new one with the same address (it answers
 * "as is", or HOLDER_EMAIL_EXISTS). The holder for the new program is registered with a slightly different e-mail: 1 or 2 digits are
 * added after the name (marie@example.com -> marie7@example.com, marie42@example.com). HOLDER_EMAIL_TAG=false turns this off.
 * The digits come from the customer and the previous holder, so an attempt whose answer was lost is repeated with the SAME address
 * (`attempt` 0) and Freda answers with the holder it already made; if that address belongs to someone else, the next one is tried.
 */
export const holderEmailTagging = (v: string | undefined = process.env["HOLDER_EMAIL_TAG"]) => String(v ?? "").trim().toLowerCase() !== "false";
export function taggedEmail(real: string, userId: string, previousHolderId: string | null | undefined, attempt = 0): string {
  const at = real.lastIndexOf("@");
  if (at < 1) return real;
  const h = createHash("sha256").update(`${userId}:${previousHolderId ?? ""}`).digest().readUInt32BE(0);
  return `${real.slice(0, at)}${((h + attempt) % 99) + 1}${real.slice(at)}`; // 1 to 99: one or two digits
}
/** How many addresses are tried for one holder before giving up (an address can belong to another holder). */
const TAG_ATTEMPTS = 6;
/** True when the holder Freda answered with is this customer's (same name and birth date): an earlier attempt whose answer was lost. */
export function isSameHolder(h: any, p: Record<string, any>): boolean {
  const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const o = h?.holder ?? h?.profile ?? h ?? {};
  return norm(o.first_name) === norm(p["first_name"]) && norm(o.last_name) === norm(p["last_name"]) && String(o.dob ?? "").slice(0, 10) === String(p["date_of_birth"] ?? "").slice(0, 10);
}

/**
 * What GET /v1/cards/holders/:id (or the POST answer) can tell: only that the registration FAILED. Whether the new program accepted the
 * holder is never in it (it says "enrolled" either way): that only comes by the holder.verified / holder.rejected webhooks.
 */
export function readHolderState(h: any): { state: "pending" | "failed"; reason: string | null } {
  const status = String(h?.status ?? "").toLowerCase();
  const v = h?.verification;
  const vStatus = String(v?.status ?? "").toLowerCase();
  const reason = (h?.failure_reason as string | undefined) || pickVerification(v ?? {}).reason || null;
  if (status === "failed" || ["failed", "declined", "rejected"].includes(vStatus)) return { state: "failed", reason };
  return { state: "pending", reason };
}

/**
 * What GET /v1/cards/holders/:id can say about the NEW PROGRAM, when Freda gives it (a field whose name mentions the program: "program",
 * "new_program", "program_status"...): accepted / refused. Only an explicit word counts: "enrolled" or the old issuer's
 * `verification.ready_for_cards` say nothing about the new program. Null when the answer has no such field.
 */
export function readProgramDecision(h: any): { verified: boolean; reason: string | null } | null {
  const seen = new Set<unknown>();
  let found: { verified: boolean; reason: string | null } | null = null;
  const word = (v: unknown): boolean | null => {
    if (typeof v === "boolean") return v;
    const t = String(v ?? "").toLowerCase();
    if (/(^|[^a-z])(accept|approved|verified|valid|ok|ready|enrolled)/.test(t) && !/(not|non|un|in)[ _-]?(accept|approved|verified|valid)/.test(t)) return true;
    if (/refus|reject|declin|denied|fail|datanot|not[ _-]?(accept|approved|verified)|invalid/.test(t)) return false;
    return null;
  };
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 2 || found) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (found) return;
      if (/program/i.test(k) && !/(reason|error|message|at|date|id|name)$/i.test(k)) {
        if (v && typeof v === "object") {
          const inner: any = v;
          const w = word(inner.status ?? inner.state ?? inner.result ?? inner.decision ?? inner.accepted ?? inner.verified);
          if (w !== null) { found = { verified: w, reason: w ? null : String(inner.reason ?? inner.failure_reason ?? inner.error ?? "").slice(0, 200) || null }; return; }
        } else {
          const w = word(v);
          if (w !== null) { found = { verified: w, reason: w ? null : String(o[`${k}_reason`] ?? o["program_reason"] ?? o["failure_reason"] ?? "").slice(0, 200) || null }; return; }
        }
      }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(h, 0);
  return found;
}

/** card_holders.verification_status -> what the customer sees. Only holder.verified makes a holder ready. */
export function stateOfRow(status: unknown): "pending" | "ready" | "failed" {
  return status === "verified" ? "ready" : status === "failed" ? "failed" : "pending";
}

/** The customer's words for holder.rejected (Freda's reason, when it gives one, is added as it is). */
export function rejectedMessage(reason: string | null | undefined): string {
  const r = String(reason ?? "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 200);
  return `The card issuer did not accept your ID document${r ? `: ${r}` : ""}. Try again, or contact support.`;
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
  const was = stateOfRow(before);
  if (was === after) return;
  if (after === "ready") await L.notify(userId, "Card profile verified", "You can now create your card. It works with Apple Pay and Google Pay.");
  else if (after === "failed") await L.notify(userId, "Card profile not verified", "The card issuer could not verify your identity. Open Cards to see what to do.");
}

/**
 * Registers (or registers again) the customer's holder at Freda with the verified identity. Never throws for a Freda refusal:
 * the outcome is saved on the card_holders row and returned. `why` is only for the logs.
 */
export async function enrollHolder(userId: string, why: "kyc" | "backfill" | "customer", opts: { fresh?: boolean } = {}): Promise<HolderInfo> {
  const none = (state: HolderState, reason: string | null, missing: string[] = []): HolderInfo => ({ state, reason, missing, holderId: null, canRetry: false });
  if (!fredaConfigured()) return none("failed", "The card service is not available right now.");
  const mode = fredaMode();
  const { data: p } = await L.db.from("profiles").select("*").eq("id", userId).single();
  if (p?.kyc_status !== "verified") return none("needs_kyc", "Verify your identity before creating a card.");
  const row = await latestRow(userId, mode);
  const now = new Date().toISOString();
  const missing = missingProfileFields(p);
  if (missing.length) {
    console.error("[holder] NOT sent to Freda (", why, "):", userId.slice(0, 8), "- profile incomplete:", missing.join(", "));
    await saveRow(row, userId, mode, { last_attempt_at: now, verification_status: "needs_profile", failure_reason: null });
    return none("needs_profile", `Please complete your profile: ${missing.join(", ")}.`, missing);
  }
  const fail = async (reason: string, holderId: string | null = row?.freda_holder_id ?? null): Promise<HolderInfo> => {
    // Nothing (more) was sent to Freda: say it, with the reason, so the logs always tell whether a holder went out.
    console.error("[holder] NOT sent to Freda (", why, "):", userId.slice(0, 8), "-", reason.slice(0, 200));
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

  // What goes to Freda, in kinds and sizes only (never the images): Freda refuses cut-off, blurry or screenshot photos.
  const kind = (u: unknown) => (typeof u !== "string" ? "none" : u.startsWith("data:") ? `base64 ${Math.round(u.length / 1024)} KB` : "https link");
  console.log("[holder] ID document to send (", why, "):", userId.slice(0, 8), identity.type, "| front:", kind(identity.imageUrl), "| back:", kind(identity.imageBackUrl));
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
  // A customer who already has a holder gets a NEW holder for the new program, registered with a slightly different e-mail (see
  // taggedEmail). `fresh: false` (a retry after a refusal, a decision that never came) restarts the verification of the holder it has instead.
  const tagging = holderEmailTagging();
  const hadHolder = !!row?.freda_holder_id;
  const fresh = hadHolder && tagging && opts.fresh !== false;
  let restart = false;
  let restarted: boolean | null = null;
  let docsSent = false;
  let tagged = false;
  let res: any;
  /** Submits the ID photos for verification (POST /v1/cards/holder-profile + restart_verification): Freda answers `restarted: true`. */
  const submitDocs = async (mail: string) => {
    const r: any = await freda.restartHolderVerification({ ...body, email: mail });
    const ok = r?.restarted === true;
    if (!ok) console.error("[holder] POST /v1/cards/holder-profile did not answer restarted: true (", why, "):", userId.slice(0, 8), "fields:", Object.keys(r ?? {}).join(","));
    return { r, ok };
  };
  const restartIt = async (mail: string) => {
    restart = true;
    const { r, ok } = await submitDocs(mail);
    restarted = ok;
    docsSent = ok;
    return r;
  };
  /**
   * A new holder with a slightly different e-mail (digits after the name). Freda answering with a holder that is this customer's is the
   * answer to a repeated attempt; an address that belongs to someone else (HOLDER_EMAIL_EXISTS, or another person's holder) moves on to the next.
   */
  const createTagged = async () => {
    tagged = true;
    let last: unknown = null;
    for (let k = 0; k < TAG_ATTEMPTS; k++) {
      body["email"] = taggedEmail(email, userId, row?.freda_holder_id, k);
      try {
        const r: any = await freda.createHolder(body);
        if (r?.already_existed === true && !isSameHolder(r, p)) { last = r; continue; }
        return r;
      } catch (e) {
        if (e instanceof FredaError && e.code === "HOLDER_EMAIL_EXISTS") { last = e; continue; }
        throw e;
      }
    }
    if (last instanceof Error) throw last;
    throw new FredaError(409, "HOLDER_EMAIL_EXISTS", "No free e-mail address for the holder.");
  };
  try {
    if (fresh) res = await createTagged();
    else if (hadHolder) res = await restartIt(String(row.email || email)); // the address this holder has at Freda
    else {
      try {
        res = await freda.createHolder(body);
      } catch (e) {
        if (!(e instanceof FredaError && e.code === "HOLDER_EMAIL_EXISTS")) throw e;
        res = tagging ? await createTagged() : await restartIt(email);
      }
      // Answered with a holder that already existed (same e-mail), verifying nothing: a holder for the new program is made apart.
      if (res?.already_existed === true && !tagged) {
        if (tagging) res = await createTagged();
        else res = { ...(await restartIt(email)), id: pickId(res) };
      }
    }
  } catch (e) {
    if (e instanceof FredaError && e.ambiguous) {
      await saveRow(row, userId, mode, { last_attempt_at: now });
      console.error("[holder] the outcome of POST /v1/cards/holders is unknown, it will be tried again:", userId.slice(0, 8), e.code);
      return { state: "pending", reason: HOLDER_PENDING_MESSAGE, missing: [], holderId: row?.freda_holder_id ?? null, canRetry: false };
    }
    const fe = e instanceof FredaError ? e : null;
    if (fe?.code === "HOLDER_VERIFICATION_LIMIT" && hadHolder) {
      // Freda allows 5 verifications per 24 h: the holder is fine, it is tried again later.
      await saveRow(row, userId, mode, { last_attempt_at: now });
      console.error("[holder] verification limit reached for", userId.slice(0, 8), "(5 per 24 h): tried again later");
      return { state: "pending", reason: HOLDER_PENDING_MESSAGE, missing: [], holderId: row?.freda_holder_id ?? null, canRetry: false };
    }
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
  // A holder that was just registered (not restarted) stays "à vérifier" until its ID is submitted: do it now.
  if (!restart && holderId) {
    try {
      docsSent = (await submitDocs(String(body["email"]))).ok;
    } catch (e) {
      const fe = e instanceof FredaError ? e : null;
      console.error("[holder] the ID of", holderId, "was NOT submitted (", why, "):", fe?.status, fe?.code, String(fe?.message ?? (e as Error).message).slice(0, 200), "- it is tried again later");
    }
  }
  // The POST answer may not say yet what the new issuer thinks: read the holder.
  let h: any = res?.holder ?? res?.profile ?? null;
  if (holderId) h = (await freda.getHolder(holderId).catch(() => null))?.holder ?? h;
  let st: { state: "pending" | "ready" | "failed"; reason: string | null } = holderId ? readHolderState(h ?? {}) : { state: "pending", reason: null };
  // holder.verified / holder.rejected can arrive before this row was saved: it was kept aside.
  const early = holderId ? takeEarly(holderId) : null;
  if (early && st.state !== "failed") st = early.verified ? { state: "ready", reason: null } : { state: "failed", reason: rejectedMessage(early.reason) };
  const saved = await saveRow(row, userId, mode, {
    freda_holder_id: holderId, email: String(body["email"]), first_name: p.first_name, last_name: p.last_name, dob: p.date_of_birth, country, id_number: encryptField(idNumber),
    phone_code: phoneCode, phone_number: phone, address_street: p.address_street, address_city: p.address_city, address_state: p.address_state,
    address_postal_code: p.address_postal_code, status: String(h?.status ?? "pending"), identity_sent: true,
    verification_status: st.state === "ready" ? "verified" : st.state === "pending" ? (docsSent ? "docs_sent" : "submitted") : st.state, failure_reason: st.state === "failed" ? (st.reason ?? HOLDER_FAILED_MESSAGE) : null,
    program_enrolled_at: now, last_attempt_at: now, checked_at: now,
  });
  // A holder.verified / holder.rejected that arrived while the row was being saved (the webhook can come before Freda's answer is back).
  const late = holderId ? takeEarly(holderId) : null;
  if (late && st.state !== "failed") {
    const next = late.verified ? "verified" : "failed";
    await L.db.from("card_holders").update({ verification_status: next, failure_reason: late.verified ? null : rejectedMessage(late.reason) }).eq("id", saved.id);
    st = late.verified ? { state: "ready", reason: null } : { state: "failed", reason: rejectedMessage(late.reason) };
  }
  console.log("[holder]", restart ? (restarted ? "ID submitted (verification restarted)" : "restart NOT confirmed by Freda") : `${tagged ? "registered with a tagged e-mail" : "registered"}, ID ${docsSent ? "submitted" : "NOT submitted yet"}`, `(${why})`, String(holderId ?? "?"), "->", st.state, st.reason ? String(st.reason).slice(0, 160) : "");
  await announce(userId, row?.verification_status, st.state);
  return {
    state: st.state, reason: st.state === "ready" ? null : st.state === "failed" ? saved.failure_reason : HOLDER_PENDING_MESSAGE,
    missing: [], holderId, canRetry: st.state === "failed",
  };
}

const lastSeenFields = new Map<string, string>();

/** Reads the holder again at Freda (pending holders) and saves what changed. */
async function recheck(row: any, userId: string): Promise<any> {
  const g: any = await freda.getHolder(row.freda_holder_id);
  const st = readHolderState(g?.holder ?? g);
  const patch: Record<string, unknown> = { checked_at: new Date().toISOString(), status: String((g?.holder ?? g)?.status ?? row.status) };
  // Once per holder and change: the fields Freda gives (names, and the short values that look like a status), to see whether GET says
  // that the program accepted the holder. Never the personal data.
  const ho = g?.holder ?? g ?? {};
  const seen = Object.entries(ho).filter(([k, v]) => /program|verif|tier|kyc|state|status|accept|ready/i.test(k) && (v === null || ["string", "number", "boolean"].includes(typeof v) || typeof v === "object")).map(([k, v]) => `${k}=${typeof v === "object" && v ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 40)}`);
  const sig = `${row.freda_holder_id}|${seen.join(",")}`;
  if (lastSeenFields.get(String(row.freda_holder_id)) !== sig) {
    lastSeenFields.set(String(row.freda_holder_id), sig);
    console.log("[holder] Freda says about", row.freda_holder_id, "- fields:", Object.keys(ho).join(","), "| status fields:", seen.join(", ") || "-");
  }
  // GET says that the holder failed, and (when Freda gives a program field) whether the new program accepted it. Otherwise only the
  // holder.verified / holder.rejected webhook says it, and nothing else is changed here.
  const program = row.verification_status === "verified" ? null : readProgramDecision(ho);
  if (program?.verified) {
    patch["verification_status"] = "verified";
    patch["failure_reason"] = null;
  } else if ((program && !program.verified) || (st.state === "failed" && row.verification_status !== "failed")) {
    patch["verification_status"] = "failed";
    patch["failure_reason"] = program && !program.verified ? rejectedMessage(program.reason) : (st.reason ?? HOLDER_FAILED_MESSAGE);
  }
  const { data, error } = await L.db.from("card_holders").update(patch).eq("id", row.id).select("*").single();
  if (error) throw error;
  if (patch["verification_status"]) {
    const next = String(patch["verification_status"]);
    console.log("[holder]", row.freda_holder_id, row.verification_status, "->", next, "(read at Freda)", st.reason ? String(st.reason).slice(0, 160) : "");
    await announce(userId, row.verification_status, next === "verified" ? "ready" : next);
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
  const state: HolderState = stateOfRow(row.verification_status);
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
  return enrollHolder(userId, "customer", { fresh: false });
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
  const { data, error } = await L.db.from("card_holders").select("*").eq("mode", fredaMode()).in("verification_status", ["pending", "submitted", "docs_sent"])
    .not("freda_holder_id", "is", null).order("checked_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) { if (!/verification_status|checked_at/.test(error.message)) console.error("[holder] could not list pending holders:", error.message); return; }
  for (const row of data ?? []) {
    try { await recheck(row, row.user_id); } catch (e) { console.error("[holder] pending holder", row.freda_holder_id, (e as Error).message); }
  }
}

let warnedMigration = false;
/**
 * Sends to the new card program, a few per round, the customers who need it:
 *  1. holders registered but whose ID photo was never submitted ("à vérifier" at Freda: every holder registered before this version,
 *     and any whose submission failed): the ID is submitted for verification, tried again after 30 minutes if it did not work;
 *  2. customers whose KYC is verified but who were never registered (everyone verified before the program);
 *  3. holders whose ID was submitted but whose decision never came, 6 hours later: submitted again.
 * Freda allows 5 verifications per 24 h per holder.
 */
export async function enrollMissingHolders(limit = 3) {
  if (!fredaConfigured()) return;
  const mode = fredaMode();
  const { data: rows, error } = await L.db.from("card_holders").select("user_id, freda_holder_id, program_enrolled_at, last_attempt_at, verification_status").eq("mode", mode);
  if (error) {
    if (!warnedMigration) { warnedMigration = true; console.error("[holder] run supabase/migrations/20261121000000_card_program.sql:", error.message); }
    return;
  }
  const ago = (iso: unknown) => (iso ? Date.now() - Date.parse(String(iso)) : Infinity);
  const enrolled = new Set<string>();
  const recent = new Set<string>();
  const needDocs: string[] = [];
  const stale: string[] = [];
  for (const r of rows ?? []) {
    const id = String(r.user_id);
    if (r.program_enrolled_at) enrolled.add(id);
    const hasHolder = !!r.program_enrolled_at && !!r.freda_holder_id;
    if (hasHolder && ["ready", "pending", "submitted"].includes(String(r.verification_status))) {
      if (ago(r.last_attempt_at) >= DOCS_RETRY_MS) needDocs.push(id); else recent.add(id);
      continue;
    }
    if (ago(r.last_attempt_at) < AUTO_RETRY_MS) { recent.add(id); continue; }
    if (hasHolder && r.verification_status === "docs_sent" && ago(r.program_enrolled_at) >= AUTO_RETRY_MS) stale.push(id);
  }
  const { data: verified } = await L.db.from("profiles").select("id").eq("kyc_status", "verified").order("updated_at", { ascending: false }).limit(2000);
  const never = (verified ?? []).map((v: any) => String(v.id)).filter((id: string) => !enrolled.has(id) && !recent.has(id));
  const all = [...new Set([...needDocs, ...never, ...stale])];
  const neverSet = new Set(never);
  const todo = all.slice(0, limit);
  if (all.length) console.log(`[holder] backfill round: ${all.length} to send (ID not submitted yet ${needDocs.length}, never registered ${never.length}, waiting over 6 h ${stale.length}), sending ${todo.length} now, ${recent.size} tried recently`);
  for (const id of todo) {
    // A holder of the program gets its ID submitted (restart); a customer who never had one gets a new holder (its ID is submitted at once).
    try { await enrollHolder(id, "backfill", { fresh: neverSet.has(id) }); } catch (e) { console.error("[holder] backfill", id.slice(0, 8), (e as Error).message); }
  }
}

// ------------------------------------------------------------------ holder.verified / holder.rejected webhooks
/** Decisions that arrived before the holder id was saved here (POST answered, row not written yet). Kept one hour. */
const earlyDecisions = new Map<string, { verified: boolean; reason: string | null; at: number }>();
function takeEarly(holderId: string) {
  const e = earlyDecisions.get(holderId);
  earlyDecisions.delete(holderId);
  return e && Date.now() - e.at < 3600_000 ? e : null;
}

/**
 * holder.verified for a holder that no row has: read it at Freda and give it to the customer it belongs to (same e-mail, else same
 * name and birth date, and exactly one customer), so that customer's card holder becomes this verified one. Returns true when linked.
 */
async function linkVerifiedHolder(holderId: string): Promise<boolean> {
  if (!fredaConfigured()) return false;
  const g: any = await freda.getHolder(holderId).catch((e: unknown) => { console.error("[holder] could not read", holderId, (e as Error).message); return null; });
  const h = g?.holder ?? g;
  if (!h?.email && !h?.first_name) return false;
  const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
  const mode = fredaMode();
  const { data: all, error } = await L.db.from("card_holders").select("*").eq("mode", mode);
  if (error) throw error;
  const same = (r: any) => (!!h.email && norm(r.email) === norm(h.email))
    || (!!h.first_name && norm(r.first_name) === norm(h.first_name) && norm(r.last_name) === norm(h.last_name) && String(r.dob ?? "").slice(0, 10) === String(h.dob ?? "").slice(0, 10));
  const matches = (all ?? []).filter(same);
  const users = [...new Set(matches.map((r: any) => String(r.user_id)))];
  if (users.length !== 1) {
    console.log("[holder] holder.verified", holderId, "matches", users.length, "customers: not linked");
    return false;
  }
  const row = matches.filter((r: any) => String(r.user_id) === users[0]).sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const { error: upErr } = await L.db.from("card_holders").update({
    freda_holder_id: holderId, email: h.email ?? row.email, status: String(h.status ?? "enrolled"), verification_status: "verified", failure_reason: null,
    program_enrolled_at: row.program_enrolled_at ?? new Date().toISOString(), checked_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (upErr) throw upErr;
  console.log("[holder] holder.verified", holderId, "linked to the customer", String(row.user_id).slice(0, 8), "(its holder was", row.freda_holder_id ?? "-", ", now", holderId, ") -> verified");
  await announce(String(row.user_id), row.verification_status, "ready");
  return true;
}

/**
 * holder.verified: the new card program accepted the holder (data.id = mpc_ id): its next cards are program cards, the customer can
 * create one. holder.rejected: not accepted (data.reason); the customer sees why and can ask for a new verification.
 * The event is signed by Freda (checked before this runs) and GET /v1/cards/holders/:id does not carry this decision, so it is applied as is.
 */
export async function handleHolderEvent(type: string, d: any) {
  if (type !== "holder.verified" && type !== "holder.rejected") return;
  const holderId = String(d?.id ?? d?.holder_id ?? "");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(holderId)) { console.error("[holder]", type, "without a usable holder id"); return; }
  const verified = type === "holder.verified";
  const reason = verified ? null : String(d?.reason ?? d?.failure_reason ?? "").slice(0, 300) || null;
  const { data: rows, error } = await L.db.from("card_holders").select("*").eq("freda_holder_id", holderId);
  if (error) throw error;
  if (!rows?.length) {
    // A customer can have several holders at Freda (the first one, a new one with another e-mail, an ID sent again): the one it
    // verified is not always the one saved here. It is matched to the customer by its e-mail, else by name and birth date.
    if (verified && (await linkVerifiedHolder(holderId))) return;
    earlyDecisions.set(holderId, { verified, reason, at: Date.now() });
    console.log("[holder]", type, "for a holder not saved here yet, kept for its registration:", holderId);
    return;
  }
  for (const row of rows) {
    const next = verified ? "verified" : "failed";
    const { error: upErr } = await L.db.from("card_holders").update({
      verification_status: next, failure_reason: verified ? null : rejectedMessage(reason), checked_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (upErr) throw upErr;
    console.log("[holder]", type, holderId, row.verification_status ?? "-", "->", next, reason ? String(reason).slice(0, 160) : "");
    await announce(String(row.user_id), row.verification_status, verified ? "ready" : "failed");
  }
}

// ------------------------------------------------------------------ what the admin site shows
export type HolderOverviewRow = {
  userId: string; name: string; holderId: string | null; email: string | null;
  /** none (never sent), needs_profile, registered (at Freda, ID not submitted), submitted (ID submitted, waiting), verified, failed */
  status: string; reason: string | null; sentAt: string | null; lastAttemptAt: string | null; checkedAt: string | null;
};

/** Every customer whose KYC is verified, with where their card holder is. Newest KYC first, at most 500. */
export async function holderOverview(): Promise<{ mode: string; total: number; counts: Record<string, number>; items: HolderOverviewRow[] }> {
  const mode = fredaConfigured() ? fredaMode() : "sandbox";
  const { data: profiles, error } = await L.db.from("profiles").select("id, display_name, first_name, last_name, username").eq("kyc_status", "verified").order("updated_at", { ascending: false }).limit(500);
  if (error) throw error;
  const { data: holders, error: hErr } = await L.db.from("card_holders").select("*").eq("mode", mode).order("created_at", { ascending: false });
  if (hErr) throw hErr;
  const byUser = new Map<string, any>();
  for (const h of holders ?? []) if (!byUser.has(h.user_id)) byUser.set(h.user_id, h);
  const items: HolderOverviewRow[] = (profiles ?? []).map((p: any) => {
    const h = byUser.get(p.id);
    const sent = !!h?.program_enrolled_at && !!h?.freda_holder_id;
    const vs = String(h?.verification_status ?? "");
    // registered = at Freda but the ID photo was not submitted ("à vérifier"); submitted = the ID was submitted, waiting for the decision
    const status = !h ? "none" : vs === "verified" ? "verified" : vs === "failed" ? "failed" : vs === "needs_profile" ? "needs_profile" : !sent ? "none" : vs === "docs_sent" ? "submitted" : "registered";
    return {
      userId: String(p.id), name: String(p.display_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || `@${p.username}`),
      holderId: h?.freda_holder_id ?? null, email: h?.email ?? null, status, reason: h?.failure_reason ?? null,
      sentAt: h?.program_enrolled_at ?? null, lastAttemptAt: h?.last_attempt_at ?? null, checkedAt: h?.checked_at ?? null,
    };
  });
  const counts: Record<string, number> = { none: 0, needs_profile: 0, registered: 0, submitted: 0, verified: 0, failed: 0 };
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  return { mode, total: items.length, counts, items };
}
