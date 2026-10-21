// Step-up authentication for sensitive actions: password re-check, plus TOTP (2FA) when the user enabled it.

/** Endpoint -> body field holding the password to re-check. */
export const STEP_UP: Record<string, { field: string; strip: boolean }> = {
  // revealCardFn: the 4-digit card code is checked in the handler; here only 2FA (if enabled) is enforced.
  revealCardFn: { field: "", strip: false },
  setCardCode: { field: "currentPassword", strip: false },
  startWithdrawal: { field: "confirmPassword", strip: true },
  changePassword: { field: "currentPassword", strip: false },
  changeEmail: { field: "currentPassword", strip: false },
  // Returns the decrypted ID number. The frontend MUST send `confirmPassword` with this call (it is removed here
  // before the handler runs).
  getIdentity: { field: "confirmPassword", strip: true },
  // Changing fees moves money for every user: re-check the admin's password.
  adminSaveFee: { field: "confirmPassword", strip: true },
  adminDeleteFee: { field: "confirmPassword", strip: true },
};

/**
 * Endpoints that move money or expose personal data. With ENFORCE_MFA_ALL=true, a user who enabled 2FA must hold an
 * aal2 session (2FA code passed) for ALL of them, not only the ones in STEP_UP. On by default (set ENFORCE_MFA_ALL=false
 * to turn it off). Users without a verified TOTP factor are never affected; the web app retries after asking for the
 * code when it receives the MFA_REQUIRED error code.
 */
export const MFA_ENDPOINTS: ReadonlySet<string> = new Set([
  "sendMoney", "startDeposit", "startWithdrawal", "createCardFn", "createHolderFn", "fundCardFn", "withdrawCardFn",
  "terminateCardFn", "freezeCardFn", "removeCardFn", "updateCardFn", "setCardCode", "revealCardFn", "getIdentity",
  "changePassword", "changeEmail", "createKycSession", "adminListFees", "adminSaveFee", "adminDeleteFee",
]);

/** Defaults to TRUE: only an explicit "false" turns the wide enforcement off. */
export function enforceMfaAll(value: string | undefined = process.env["ENFORCE_MFA_ALL"]): boolean {
  return String(value ?? "").trim().toLowerCase() !== "false";
}

export function mfaEndpointRequired(name: string, enforceAll = enforceMfaAll()): boolean {
  return enforceAll && MFA_ENDPOINTS.has(name);
}

/** The one error body (HTTP 403) every endpoint that needs a 2FA-verified session answers with. */
export const MFA_REQUIRED_ERROR = { error: { message: "Enter your 2FA code to continue.", code: "MFA_REQUIRED" } } as const;

/** True when the request must be refused with MFA_REQUIRED: the user has 2FA but the session is not aal2. */
export function mfaBlocked(hasTotp: boolean, aal: string | undefined): boolean {
  return hasTotp && aal !== "aal2";
}

/** Reads the `aal` claim ("aal1" | "aal2") of an already verified access token. */
export function tokenAal(token: string): "aal1" | "aal2" {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return p?.aal === "aal2" ? "aal2" : "aal1";
  } catch {
    return "aal1";
  }
}

/** True when the user has a verified TOTP factor (so the session must be aal2 for sensitive actions). */
export function hasVerifiedTotp(user: any): boolean {
  return (user?.factors ?? []).some((f: any) => f?.factor_type === "totp" && f?.status === "verified");
}

// Wrong passwords: 5 failures per 15 minutes per user, then locked until the window ends.
const fails = new Map<string, { n: number; resetAt: number }>();
const MAX_FAILS = 5, WINDOW = 15 * 60_000;
export function stepUpLocked(userId: string, now = Date.now()): boolean {
  const f = fails.get(userId);
  return !!f && f.resetAt > now && f.n >= MAX_FAILS;
}
export function recordStepUpFailure(userId: string, now = Date.now()) {
  const f = fails.get(userId);
  if (!f || f.resetAt <= now) fails.set(userId, { n: 1, resetAt: now + WINDOW });
  else f.n += 1;
}
export const clearStepUpFailures = (userId: string) => void fails.delete(userId);

/** Checks the password with a throwaway client (no session is stored, the real session is untouched). */
export async function passwordIsValid(email: string, password: string): Promise<boolean> {
  const url = process.env["SUPABASE_URL"] ?? "";
  const anon = process.env["SUPABASE_ANON_KEY"] ?? "";
  if (!anon) throw new Error("SUPABASE_ANON_KEY is not set in .env");
  const { createClient } = await import("@supabase/supabase-js");
  const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  return !error;
}
