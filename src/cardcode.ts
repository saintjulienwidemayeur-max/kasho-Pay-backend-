// Card code (4 digits) attempt counting in the database, so the lockout survives restarts and is shared by all instances.
// The in-memory lockout in stepup.ts stays as a second layer (and as the fallback if the SQL functions are not installed).

/**
 * Consumes one attempt (5 per 15 minutes per user) BEFORE the code is checked. Returns false when the user is locked.
 * Never throws: if the database function is missing or fails, it returns true and the in-memory lockout still applies.
 */
export async function cardCodeAttemptAllowed(db: any, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("kasho_card_code_attempt", { p_user: userId });
    if (error) {
      console.error("[card-code] attempt counter unavailable (run 20261021010000_security_hardening.sql):", error.message);
      return true;
    }
    return data !== false;
  } catch (e) {
    console.error("[card-code] attempt counter failed:", (e as Error).message);
    return true;
  }
}

/** Clears the attempt counter (correct code, or a new code set with password + 2FA). */
export async function resetCardCodeAttempts(db: any, userId: string): Promise<void> {
  try {
    const { error } = await db.rpc("kasho_card_code_reset", { p_user: userId });
    if (error) console.error("[card-code] reset failed:", error.message);
  } catch (e) {
    console.error("[card-code] reset failed:", (e as Error).message);
  }
}
