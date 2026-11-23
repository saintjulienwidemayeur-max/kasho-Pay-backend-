// Is Freda's webhook really reaching this server? Everything about a card holder's decision (holder.verified / holder.rejected) comes
// ONLY by webhook, while payments and cards are also settled by polling, so a webhook that is refused (wrong secret, other URL, inactive)
// goes unnoticed for them and blocks the holders. This asks Freda for the registered endpoint and makes Freda send a signed test event
// (POST /v1/webhooks/test: it says whether this server answered 2xx), at startup and every 6 hours, and says it loudly in the logs.
import { FredaError, freda, fredaConfigured, fredaMode } from "./freda.js";

export type WebhookCheck = {
  checkedAt: string; mode: "live" | "sandbox" | null;
  /** The URL Freda sends to (null: none registered), and the URL this server expects. */
  url: string | null; active: boolean | null; expectedUrl: string | null;
  /** The signed test event: did this server answer 2xx? */
  test: { sent: boolean; httpStatus: number | null; reason: string | null } | null;
  ok: boolean;
  /** What is wrong, in one sentence (null when everything works). */
  problem: string | null;
};

let last: WebhookCheck | null = null;
export const lastWebhookCheck = () => last;

/** The public address of this server (Render sets RENDER_EXTERNAL_URL), or null. */
export function expectedWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = String(env["PUBLIC_URL"] ?? env["KEEP_ALIVE_URL"] ?? env["RENDER_EXTERNAL_URL"] ?? "").trim().replace(/\/+$/, "");
  return base.startsWith("https://") ? `${base}/api/webhooks/freda` : null;
}

/** What is wrong with the webhook, from Freda's answers (pure, for the tests). */
export function webhookProblem(c: Pick<WebhookCheck, "url" | "active" | "expectedUrl" | "test">): string | null {
  if (!c.url) return "Freda has no webhook registered for this key: holder.verified / holder.rejected can never arrive. Run `npm run webhook:register -- https://<backend>` with this key and put the new whsec_ in FREDA_WEBHOOK_SECRET.";
  if (c.active === false) return "Freda's webhook is switched off.";
  if (c.expectedUrl && c.url !== c.expectedUrl) return `Freda sends to ${c.url} but this server is ${c.expectedUrl}.`;
  const t = c.test;
  if (!t) return "Freda's test event could not be started.";
  if (!t.sent || (t.httpStatus !== null && (t.httpStatus < 200 || t.httpStatus >= 300))) {
    if (t.httpStatus === 401) return "This server REFUSED Freda's signed test (HTTP 401): FREDA_WEBHOOK_SECRET is not the secret of this webhook (it changes every time the webhook is registered again, or with `rotate-secret`). Put the current whsec_ in FREDA_WEBHOOK_SECRET.";
    return `Freda's test event was not accepted by this server (HTTP ${t.httpStatus ?? "no answer"}${t.reason ? `, ${String(t.reason).slice(0, 120)}` : ""}).`;
  }
  return null;
}

export async function checkFredaWebhook(): Promise<WebhookCheck | null> {
  if (!fredaConfigured()) return null;
  const out: WebhookCheck = { checkedAt: new Date().toISOString(), mode: fredaMode(), url: null, active: null, expectedUrl: expectedWebhookUrl(), test: null, ok: false, problem: null };
  try {
    const e: any = (await freda.webhookEndpoint())?.endpoint ?? null;
    out.url = e?.url ? String(e.url) : null;
    out.active = e ? e.active !== false : null;
    if (out.url && out.active !== false) {
      try {
        const t: any = await freda.testWebhook();
        out.test = { sent: t?.sent === true, httpStatus: typeof t?.http_status === "number" ? t.http_status : null, reason: t?.reason ? String(t.reason) : null };
      } catch (err) {
        if (err instanceof FredaError && err.status === 429) out.test = last?.test ?? null; // 10 tests a minute: keep the last answer
        else throw err;
      }
    }
    out.problem = webhookProblem(out);
    out.ok = out.problem === null;
  } catch (e) {
    out.problem = `Freda's webhook could not be checked: ${String((e as Error).message).slice(0, 160)}`;
  }
  last = out;
  if (out.ok) console.log(`[webhook] Freda -> this server works (${out.url}, test answered ${out.test?.httpStatus ?? "?"})`);
  else console.error("[webhook] PROBLEM:", out.problem);
  return out;
}

/** At startup (after the server is up) and every 6 hours. */
export function startWebhookWatch() {
  setTimeout(() => { void checkFredaWebhook(); }, 25_000).unref();
  setInterval(() => { void checkFredaWebhook(); }, 6 * 3600_000).unref();
}
