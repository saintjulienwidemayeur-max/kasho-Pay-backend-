// The card service (Freda Pay Issuing) sometimes asks the card HOLDER to complete an identity verification before a card can be
// issued: "Le titulaire doit d'abord compléter sa vérification d'identité". The documented way it hands us the link to pass to the
// holder is the card.failed webhook (data.verification_link + data.verification_link_expires_at). Where else it appears (the answer
// of POST /v1/cards, GET /v1/cards/:id, the holder) is not documented, so it is looked for defensively, in every Freda answer.
// Pure functions, no I/O.

export type Verification = { link?: string; expiresAt?: string; reason?: string };

const LINK_KEY = /verif.*(link|url)|(link|url).*verif|kyc.*(link|url)/i; // verification_link, verificationUrl, kyc_link...
const EXPIRES_KEY = /expire/i;
const REASON_KEYS = ["failure_reason", "failureReason", "status_reason", "reason"];
/** The refusals that mean "the holder has to complete the identity verification first" (Freda's French and English wording). */
const IDENTITY_TEXT = /restart_verification|d[ée]j[àa] [ée]t[ée] refus[ée]|document.*(declined|refus)|v[ée]rification d['’]identit[ée]|identity verification|verify (your|the holder'?s?) identity|face verification|v[ée]rification faciale/i;

const MAX_DEPTH = 3;

/** A plain https link of reasonable size: the only kind that is ever kept and shown to a customer. */
export function safeHttpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 500) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** True when a Freda text (failure reason, error message) says the holder has to complete an identity verification. */
export const mentionsIdentityVerification = (text: unknown): boolean => typeof text === "string" && IDENTITY_TEXT.test(text);

/** Looks through a Freda answer or webhook body (`data` included, a few levels deep) for the verification link, its expiry and the reason. */
export function pickVerification(o: unknown): Verification {
  const out: Verification = {};
  const seen = new Set<unknown>();
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > MAX_DEPTH) return;
    seen.add(node);
    const entries = Array.isArray(node) ? node.slice(0, 5).map((v, i) => [String(i), v] as const) : Object.entries(node);
    if (!out.link) {
      for (const [k, v] of entries) {
        const url = LINK_KEY.test(k) ? safeHttpsUrl(v) : undefined;
        if (!url) continue;
        out.link = url;
        const exp = entries.find(([ek, ev]) => EXPIRES_KEY.test(ek) && typeof ev === "string" && ev.length <= 40);
        if (exp) out.expiresAt = String(exp[1]);
        break;
      }
    }
    if (!out.reason) {
      for (const [k, v] of entries) {
        if (REASON_KEYS.includes(k) && typeof v === "string" && v.trim()) { out.reason = v.trim().slice(0, 300); break; }
      }
    }
    for (const [, v] of entries) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(o, 0);
  return out;
}

/** True when the link is still usable (no expiry known counts as usable). */
export function linkStillValid(expiresAt: unknown, now = Date.now()): boolean {
  if (typeof expiresAt !== "string" || !expiresAt) return true;
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || t > now;
}
