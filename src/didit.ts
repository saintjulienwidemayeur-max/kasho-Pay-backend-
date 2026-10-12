// Server-side client for Didit identity verification (https://docs.didit.me).
// The API key lives in DIDIT_API_KEY and never reaches the browser.
import { createHmac, timingSafeEqual } from "node:crypto";

export class DiditError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DiditError";
    this.status = status;
  }
}

const base = () => (process.env["DIDIT_API_BASE"] ?? "https://verification.didit.me").replace(/\/+$/, "");

export function diditConfigured(): boolean {
  const k = process.env["DIDIT_API_KEY"] ?? "";
  const w = process.env["DIDIT_WORKFLOW_ID"] ?? "";
  return !!k && !!w && !k.includes("REPLACE_ME") && !w.includes("REPLACE_ME");
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const key = process.env["DIDIT_API_KEY"] ?? "";
  if (!key || key.includes("REPLACE_ME")) throw new DiditError(503, "Identity verification is not configured yet.");
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DiditError(503, "Cannot reach the verification service. Please try again.");
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    console.error("[didit]", res.status, path, text.slice(0, 300));
    throw new DiditError(res.status, json?.detail ?? json?.message ?? "Verification service error.");
  }
  return json;
}

/** POST /v3/session/ : creates a hosted verification session (document + liveness + face match, per your workflow). */
export async function createSession(opts: { userId: string; callback: string; email?: string }) {
  const s = await call("POST", "/v3/session/", {
    workflow_id: process.env["DIDIT_WORKFLOW_ID"],
    vendor_data: opts.userId, // lets the webhook map the result back to our user
    callback: opts.callback,
  });
  if (!s?.session_id || !s?.url) throw new DiditError(502, "Unexpected response from the verification service.");
  return { sessionId: String(s.session_id), url: String(s.url), status: String(s.status ?? "Not Started") };
}

/** GET /v3/session/{id}/decision/ : the authoritative result. */
export async function getDecision(sessionId: string): Promise<any> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) throw new DiditError(400, "Invalid session.");
  return call("GET", `/v3/session/${encodeURIComponent(sessionId)}/decision/`);
}

export type KycStatus = "pending" | "verified" | "rejected";

/** Didit status -> Kasho status. Anything not final stays pending. */
export function mapStatus(s: unknown): KycStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "approved") return "verified";
  if (v === "declined" || v === "rejected" || v === "expired" || v === "abandoned") return "rejected";
  return "pending";
}

// ------------------------------------------------------------ webhook signatures
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.keys(v).sort().reduce((o: any, k) => ((o[k] = sortKeys(v[k])), o), {});
  return v;
}
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

/**
 * Verifies a Didit webhook: timestamp within 5 minutes, then HMAC-SHA256 (hex) with the webhook secret.
 * Accepts the raw-body signature (X-Signature) or the canonical-JSON signature (X-Signature-V2).
 */
export function verifyDiditWebhook(
  raw: string,
  h: { signature?: string | null; signatureV2?: string | null; timestamp?: string | null },
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !raw) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  if (h.signature && safeEq(hmac(secret, raw), h.signature.trim().toLowerCase())) return true;
  if (h.signatureV2) {
    try {
      const canon = JSON.stringify(sortKeys(JSON.parse(raw)));
      if (safeEq(hmac(secret, canon), h.signatureV2.trim().toLowerCase())) return true;
    } catch { /* bad json */ }
  }
  return false;
}
