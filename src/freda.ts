// Server-side client for the Freda Pay Issuing API (https://issuing.fredapay.com/docs).
// The secret key (sk_test_... / sk_live_...) lives in FREDA_API_KEY and never reaches the browser.
import { createHmac, timingSafeEqual } from "node:crypto";

export class FredaError extends Error {
  status: number;
  code: string;
  /** Raw JSON body returned by Freda (may contain details/fields that explain the rejection). */
  raw?: unknown;
  /** "POST /v1/payments": which call failed (for logs; never contains the body). */
  endpoint = "";
  constructor(status: number, code: string, message: string, raw?: unknown) {
    super(message);
    this.raw = raw;
    this.name = "FredaError";
    this.status = status;
    this.code = code;
  }
  /**
   * True when we cannot know whether Freda executed the request (timeout, network cut, 5xx).
   * For money-moving calls we must NOT refund the user in that case; we leave the
   * transaction pending and reconcile later (webhook / sync) to avoid paying twice.
   */
  get ambiguous(): boolean {
    if (this.code === "NETWORK") return true;
    // 503 CARD_PROVIDER_AUTH / CARD_LIVE_NOT_CONFIGURED are documented as "nothing was debited".
    if (this.code === "CARD_PROVIDER_AUTH" || this.code === "CARD_LIVE_NOT_CONFIGURED") return false;
    return this.status >= 500;
  }
}

function apiKey(): string {
  const k = process.env["FREDA_API_KEY"];
  if (!k || k.includes("REPLACE_ME")) {
    throw new FredaError(503, "NOT_CONFIGURED", "FREDA_API_KEY is not set in .env");
  }
  return k;
}

function baseUrl(): string {
  return (process.env["FREDA_API_BASE"] ?? "https://api.fredapay.com").replace(/\/+$/, "");
}

export function fredaMode(): "sandbox" | "live" {
  return apiKey().startsWith("sk_live_") ? "live" : "sandbox";
}

export function fredaConfigured(): boolean {
  const k = process.env["FREDA_API_KEY"];
  return !!k && !k.includes("REPLACE_ME");
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const key = apiKey();
  // Docs: 100 requests/min per key. A 429 is rejected before processing, so one retry after
  // `Retry-After` (capped at 5 s) is safe for every method.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Math.max(Number(res.headers.get("retry-after")) || 2, 1), 5);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) {
        const err = json?.error;
        const fe = new FredaError(res.status, err?.code ?? "PROVIDER_ERROR", err?.message ?? `Freda request failed (${res.status})`, json ?? text.slice(0, 500));
        fe.endpoint = `${method} ${path.split("?")[0]}`;
        throw fe;
      }
      return json as T;
    } catch (e) {
      if (e instanceof FredaError) throw e;
      throw new FredaError(502, "NETWORK", "Could not reach the payment provider.");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FredaError(429, "RATE_LIMITED", "Too many requests.");
}

export const freda = {
  // Gateway
  createPayment: (b: { amount: number; method: string; reference: string; currency?: string; phone?: string }) =>
    call("POST", "/v1/payments", b),
  getPayment: (id: string) => call("GET", `/v1/payments/${encodeURIComponent(id)}`),
  createPayout: (b: { amount: number; method: "moncash" | "natcash"; recipient: string; reference: string }) =>
    call("POST", "/v1/payouts", b),
  getPayout: (id: string) => call("GET", `/v1/payouts/${encodeURIComponent(id)}`),
  balance: () => call("GET", "/v1/balance"),
  /** Cards issuer wallet: balance, guarantee deposit (always locked), spendable, low_balance. */
  masterWallet: () => call("GET", "/v1/master-wallet"),

  // Cards
  createHolder: (b: Record<string, unknown>) => call("POST", "/v1/cards/holders", b),
  listHolders: (page = 1) => call("GET", `/v1/cards/holders?page=${page}&page_size=100`),
  getHolder: (id: string) => call("GET", `/v1/cards/holders/${encodeURIComponent(id)}`),
  createCard: (b: { reference: string; amount: number; kind?: "individual" | "business"; brand?: string; holder_id?: string; business_name?: string }) =>
    call("POST", "/v1/cards", b),
  getCard: (id: string) => call("GET", `/v1/cards/${encodeURIComponent(id)}`),
  cardTransactions: (id: string) => call("GET", `/v1/cards/${encodeURIComponent(id)}/transactions?page_size=50`),
  // `reference` is Freda's idempotency key (max 64 chars: letters, digits . _ : -). Replaying the same key after a
  // timeout does not move the money twice (the answer has `idempotent_replay: true`); another amount gives 409 IDEMPOTENCY_MISMATCH.
  fundCard: (id: string, amount: number, reference?: string) =>
    call("POST", `/v1/cards/${encodeURIComponent(id)}/fund`, { amount, ...(reference ? { reference } : {}) }),
  withdrawCard: (id: string, amount: number, reference?: string) =>
    call("POST", `/v1/cards/${encodeURIComponent(id)}/withdraw`, { amount, ...(reference ? { reference } : {}) }),
  freezeCard: (id: string) => call("POST", `/v1/cards/${encodeURIComponent(id)}/freeze`),
  unfreezeCard: (id: string) => call("POST", `/v1/cards/${encodeURIComponent(id)}/unfreeze`),
  terminateCard: (id: string) => call("POST", `/v1/cards/${encodeURIComponent(id)}/terminate`),
  revealCard: (id: string) => call("POST", `/v1/cards/${encodeURIComponent(id)}/reveal`),
};

const usdOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
};

/**
 * What a card closure really did on Freda's side: POST /cards/:id/terminate and the card.terminated webhook both
 * carry `refunded_usd` (sent back to the Master Wallet) and `closure_fee_usd` (kept by Freda). Null when absent.
 */
export function readClosure(o: any): { refunded: number; fee: number } | null {
  const src = o?.data ?? o ?? {};
  const refunded = usdOrNull(src.refunded_usd);
  const fee = usdOrNull(src.closure_fee_usd);
  return refunded === null || fee === null ? null : { refunded, fee };
}

/** Master Wallet figures from GET /v1/master-wallet (the guarantee deposit is always locked: only `spendable` can be used). */
export function readMasterWallet(o: any): { balance: number; guarantee: number; spendable: number; low: boolean } | null {
  const balance = usdOrNull(o?.balance);
  const spendable = usdOrNull(o?.spendable_usd);
  if (balance === null || spendable === null) return null;
  return { balance, guarantee: usdOrNull(o?.guarantee_usd) ?? 0, spendable, low: o?.low_balance === true };
}

/** X-Freda-Signature: sha256=<hex HMAC-SHA256 of the RAW body with the whsec_ secret> */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = header.replace(/^sha256=/, "").trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Freda's response shapes for some endpoints are not fully documented, so read defensively.
export function pickId(o: any): string | undefined {
  const v = o?.id ?? o?.holder_id ?? o?.profile?.id ?? o?.holder?.id ?? o?.data?.id;
  return typeof v === "string" && v ? v : undefined;
}

export function pickArray(o: any, keys: string[]): any[] {
  if (Array.isArray(o)) return o;
  for (const k of keys) if (Array.isArray(o?.[k])) return o[k];
  return [];
}
