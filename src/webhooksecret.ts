// The secret of Freda's webhook (whsec_...). It normally comes from FREDA_WEBHOOK_SECRET, but registering the webhook again (to point
// it at this server) gives a NEW secret that is shown only once: the backend keeps it itself (app_settings, server-only: no policy,
// never read by the browser), so nobody has to copy it into the environment. Both are accepted.
import * as L from "./ledger.js";

const KEY = "freda_webhook_secret";
let stored: string | null = null;

const usable = (s: unknown): s is string => typeof s === "string" && /^whsec_[A-Za-z0-9]{8,}$/.test(s);

/** Reads the saved secret into memory (at startup, and again after a registration). A missing table or row means none. */
export async function loadStoredWebhookSecret(): Promise<void> {
  try {
    const { data, error } = await L.db.from("app_settings").select("value").eq("key", KEY).maybeSingle();
    if (error) return;
    const v = (data?.value as any)?.secret ?? data?.value;
    stored = usable(v) ? v : null;
  } catch { /* keep what we have */ }
}

export async function saveWebhookSecret(secret: string, userId: string): Promise<void> {
  if (!usable(secret)) throw new L.AppError("Freda did not return a usable webhook secret.");
  const { error } = await L.db.from("app_settings").upsert({ key: KEY, value: { secret }, updated_at: new Date().toISOString(), updated_by: userId });
  if (error) throw error;
  stored = secret;
}

/** Every secret a webhook may be signed with: the environment one and the one saved by the last registration. */
export function webhookSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = String(env["FREDA_WEBHOOK_SECRET"] ?? "").trim();
  return [...new Set([stored, fromEnv && !fromEnv.includes("REPLACE_ME") ? fromEnv : null].filter((s): s is string => !!s))];
}

export const hasStoredWebhookSecret = () => stored !== null;
