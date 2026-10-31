// Web Push: transaction notifications + the morning greeting.
// Server-only. Never log endpoints, keys or message bodies (only counts and HTTP status codes).
import "./env.js";
import webpush from "web-push";
import { supabaseAdmin } from "./supabase.js";

const db: any = supabaseAdmin;

export const DEFAULT_TZ = "America/Port-au-Prince";
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MAX_FAILURES = 5;
const SEND_TIMEOUT_MS = 10_000;
const TTL_SECONDS = 24 * 3600;

// ------------------------------------------------------------------ VAPID setup
let configured = false;
let publicKey: string | null = null;

/** Reads the VAPID_* env vars. Missing or invalid keys silently disable push (one warning, logged at startup). */
export function initPush(): { configured: boolean; reason?: string } {
  const pub = (process.env["VAPID_PUBLIC_KEY"] ?? "").trim();
  const priv = (process.env["VAPID_PRIVATE_KEY"] ?? "").trim();
  const subject = (process.env["VAPID_SUBJECT"] ?? "").trim();
  configured = false;
  publicKey = null;
  if (!pub || !priv || !subject) return { configured: false, reason: "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not set" };
  try {
    webpush.setVapidDetails(subject, pub, priv);
  } catch {
    return { configured: false, reason: "invalid VAPID keys or subject (run `npm run vapid:generate`)" };
  }
  configured = true;
  publicKey = pub;
  return { configured: true };
}
initPush();

export const pushConfigured = () => configured;
export const pushPublicKey = (): string | null => (configured ? publicKey : null);

// ------------------------------------------------------------------ validation
const HOST_EXACT = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com", ".wns.windows.com"];

/** web-push POSTs to whatever endpoint it is given: only accept the real browser push services (SSRF protection). */
export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (HOST_EXACT.has(host)) return true;
  return HOST_SUFFIXES.some((s) => host.length > s.length && host.endsWith(s));
}

const B64URL = /^[A-Za-z0-9_-]+$/;
function b64urlLength(s: unknown): number {
  if (typeof s !== "string" || !B64URL.test(s) || s.length % 4 === 1) return -1;
  return Buffer.from(s, "base64url").length;
}
/** p256dh = uncompressed P-256 point (65 bytes, starts with 0x04); auth = 16-byte secret. */
export function validPushKeys(p256dh: unknown, auth: unknown): boolean {
  if (b64urlLength(p256dh) !== 65 || b64urlLength(auth) !== 16) return false;
  return Buffer.from(p256dh as string, "base64url")[0] === 0x04;
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// ------------------------------------------------------------------ French texts for the (English) notify() messages
type Rule = { title: string; fr: string; bodies: Array<[RegExp, (m: RegExpMatchArray) => string]> };
const AMT = "(\\$[\\d.,]+)";
const exact = (s: string, fr: string): [RegExp, () => string] => [new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), () => fr];

export const PUSH_RULES: Rule[] = [
  { title: "Deposit not credited", fr: "Dépôt non crédité", bodies: [[
    /^We received (\S+) HTG instead of the (\S+) HTG you requested, so your wallet was not credited\. Our support team will contact you about the amount we received\.$/,
    (m) => `Nous avons reçu ${m[1]} HTG au lieu des ${m[2]} HTG demandés, votre portefeuille n'a donc pas été crédité. Notre équipe support vous contactera au sujet du montant reçu.`]] },
  { title: "Wallet funded", fr: "Portefeuille rechargé", bodies: [[new RegExp(`^${AMT} added via (.+)$`), (m) => `${m[1]} ajoutés via ${m[2]}`]] },
  { title: "Deposit failed", fr: "Dépôt échoué", bodies: [[/^Your (.+) payment did not go through\.$/, (m) => `Votre paiement ${m[1]} n'a pas abouti.`]] },
  { title: "Withdrawal sent", fr: "Retrait envoyé", bodies: [[new RegExp(`^${AMT} sent to (.+)$`), (m) => `${m[1]} envoyés vers ${m[2]}`]] },
  { title: "Withdrawal failed", fr: "Retrait échoué", bodies: [exact("Your withdrawal could not be sent. The money is back in your wallet.",
    "Votre retrait n'a pas pu être envoyé. L'argent est de retour dans votre portefeuille.")] },
  { title: "Card funding failed", fr: "Rechargement de carte échoué", bodies: [exact("We could not add money to your card. The money is back in your wallet.",
    "Nous n'avons pas pu recharger votre carte. L'argent est de retour dans votre portefeuille.")] },
  { title: "Card funded", fr: "Carte rechargée", bodies: [[new RegExp(`^${AMT} added to (.+)\\.$`), (m) => `${m[1]} ajoutés à ${m[2]}.`]] },
  { title: "Card creation failed", fr: "Création de carte échouée", bodies: [exact("We could not create your card. The money is back in your wallet.",
    "Nous n'avons pas pu créer votre carte. L'argent est de retour dans votre portefeuille.")] },
  { title: "Card withdrawal completed", fr: "Retrait de carte effectué", bodies: [[new RegExp(`^${AMT} returned to your wallet\\.$`), (m) => `${m[1]} remis dans votre portefeuille.`]] },
  { title: "Identity verification needed", fr: "Vérification d'identité requise", bodies: [
    exact("The card service must verify your identity before it can issue your card. Open Cards to continue. Your money is back in your wallet.",
      "Le service de cartes doit vérifier votre identité avant de pouvoir émettre votre carte. Ouvrez Cartes pour continuer. Votre argent est de retour dans votre portefeuille."),
    exact("The card service could not verify your identity, so your card was not issued. Please contact support. Your money is back in your wallet.",
      "Le service de cartes n'a pas pu vérifier votre identité : votre carte n'a donc pas été émise. Contactez le support. Votre argent est de retour dans votre portefeuille."),
    exact("The card service must verify your identity before it can issue your card. Open Cards to continue.",
      "Le service de cartes doit vérifier votre identité avant de pouvoir émettre votre carte. Ouvrez Cartes pour continuer.")] },
  { title: "Your card is taking longer than usual", fr: "Votre carte prend plus de temps que prévu", bodies: [exact("We are still creating your card. Your money is safe: if the card cannot be created, it goes back to your wallet.",
    "Nous créons toujours votre carte. Votre argent est en sécurité : si la carte ne peut pas être créée, il retourne dans votre portefeuille.")] },
  { title: "Card ready", fr: "Carte prête", bodies: [[/^(.+) is active and ready to use\.$/, (m) => `${m[1]} est active et prête à l'emploi.`]] },
  { title: "Card closed", fr: "Carte fermée", bodies: [
    [/^(.+) was closed and can no longer be used\.$/, (m) => `${m[1]} a été fermée et ne peut plus être utilisée.`],
    [/^(.+) was closed permanently\.$/, (m) => `${m[1]} a été fermée définitivement.`]] },
  { title: "Identity verified", fr: "Identité vérifiée", bodies: [exact("Your identity has been confirmed.", "Votre identité a été confirmée.")] },
  { title: "Verification declined", fr: "Vérification refusée", bodies: [exact("We could not verify your identity. You can try again.",
    "Nous n'avons pas pu vérifier votre identité. Vous pouvez réessayer.")] },
  { title: "Email change requested", fr: "Changement d'e-mail demandé", bodies: [exact(
    "Confirm the change from the link we emailed you. If this was not you, change your password now.",
    "Confirmez le changement avec le lien envoyé par e-mail. Si ce n'était pas vous, changez votre mot de passe maintenant.")] },
  { title: "Password changed", fr: "Mot de passe modifié", bodies: [exact("Your password was changed. If this was not you, contact support now.",
    "Votre mot de passe a été modifié. Si ce n'était pas vous, contactez le support maintenant.")] },
  { title: "Balance adjusted", fr: "Solde ajusté", bodies: [
    [new RegExp(`^${AMT} was added to your wallet by Kasho Pay\\.$`), (m) => `${m[1]} ont été ajoutés à votre portefeuille par Kasho Pay.`],
    [new RegExp(`^${AMT} was removed from your wallet by Kasho Pay\\.$`), (m) => `${m[1]} ont été retirés de votre portefeuille par Kasho Pay.`]] },
  { title: "Money received", fr: "Argent reçu", bodies: [[new RegExp(`^(.+) sent you ${AMT}$`), (m) => `${m[1]} vous a envoyé ${m[2]}`]] },
  { title: "Money sent", fr: "Argent envoyé", bodies: [[new RegExp(`^${AMT} sent to (.+?)(?: \\(fee ${AMT}\\))?$`),
    (m) => `${m[1]} envoyés à ${m[2]}${m[3] ? ` (frais ${m[3]})` : ""}`]] },
  { title: "Dispute submitted", fr: "Litige soumis", bodies: [[/^(\S+) for (.+)$/, (m) => `${m[1]} pour ${m[2]}`]] },
  // The test notification (sendTestPush) is not a notify() call but is translated here too.
];

/** French text for an English notification; the English text is the fallback when no pattern matches. */
export function pushText(title: string, body: string, lang: string): { title: string; body: string } {
  if (lang !== "fr") return { title, body };
  const rule = PUSH_RULES.find((r) => r.title === title);
  if (!rule) return { title, body };
  for (const [re, build] of rule.bodies) {
    const m = body.match(re);
    if (m) return { title: rule.fr, body: build(m) };
  }
  return { title, body };
}

// ------------------------------------------------------------------ morning greeting
function localParts(now: Date, tz: string) {
  const zone = validTimeZone(tz) ? tz : DEFAULT_TZ;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

/** Local calendar date (YYYY-MM-DD) in the given zone (invalid zone -> Haiti). */
export const localDate = (now: Date, tz: string) => localParts(now, tz).date;

/** True between 08:00 and 10:59 local time when this subscription was not greeted today. */
export function shouldGreet(a: { now: Date; tz: string; lastGreetingOn: string | null }): boolean {
  const p = localParts(a.now, a.tz);
  if (!(p.hour >= 8 && p.hour <= 10)) return false;
  return p.date !== a.lastGreetingOn;
}

/** No balance or amount on purpose: lock screens are visible to other people. */
export function buildGreeting(lang: string, name: string | null | undefined): PushMessage {
  const n = (name ?? "").trim().slice(0, 40);
  if (lang === "en") {
    return { title: n ? `Good morning ${n} 👋` : "Good morning 👋", body: "Have a great day! Open Kasho Pay to see your wallet.", url: "/", tag: "morning" };
  }
  return { title: n ? `Bonjour ${n} 👋` : "Bonjour 👋", body: "Bonne journée ! Ouvrez Kasho Pay pour voir votre portefeuille.", url: "/", tag: "morning" };
}

export type PushMessage = { title: string; body: string; url?: string; tag?: string };
type Sub = { id: string; endpoint: string; p256dh: string; auth: string; failures?: number | null };

// ------------------------------------------------------------------ sending
/** Sends one message to the given subscriptions. Cleans up dead ones. Never throws. Returns the number delivered. */
async function sendToSubs(subs: Sub[], msg: PushMessage): Promise<number> {
  if (!configured || subs.length === 0) return 0;
  const payload = JSON.stringify({
    title: msg.title.slice(0, 120), body: msg.body.slice(0, 400), url: msg.url ?? "/", tag: msg.tag ?? "kasho",
  });
  let sent = 0, gone = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      if (!isAllowedPushEndpoint(s.endpoint)) { gone += 1; await db.from("push_subscriptions").delete().eq("id", s.id); return; }
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { TTL: TTL_SECONDS, timeout: SEND_TIMEOUT_MS, urgency: "normal" });
      sent += 1;
      if (s.failures) await db.from("push_subscriptions").update({ failures: 0 }).eq("id", s.id);
    } catch (e: any) {
      const status = Number(e?.statusCode);
      try {
        if (status === 404 || status === 410) {
          gone += 1;
          await db.from("push_subscriptions").delete().eq("id", s.id);
        } else {
          failed += 1;
          const next = Number(s.failures ?? 0) + 1;
          if (next >= MAX_FAILURES) await db.from("push_subscriptions").delete().eq("id", s.id);
          else await db.from("push_subscriptions").update({ failures: next }).eq("id", s.id);
        }
      } catch { /* cleanup is best effort */ }
    }
  }));
  if (gone || failed) console.warn(`[push] sent=${sent} removed=${gone} failed=${failed}`);
  return sent;
}

const SUB_COLS = "id, endpoint, p256dh, auth, lang, failures";

/** Push to all of a user's devices. Respects notification_prefs.push (missing = enabled). Never throws. */
export async function sendPushToUser(userId: string, msg: PushMessage, opts: { translate?: boolean; force?: boolean } = {}): Promise<number> {
  try {
    if (!configured) return 0;
    if (!opts.force) {
      const { data: prof } = await db.from("profiles").select("notification_prefs").eq("id", userId).maybeSingle();
      if (prof?.notification_prefs?.push === false) return 0;
    }
    const { data: subs } = await db.from("push_subscriptions").select(SUB_COLS).eq("user_id", userId);
    if (!subs?.length) return 0;
    // Each device gets the text in its own language.
    let sent = 0;
    for (const lang of ["fr", "en"]) {
      const group = (subs as any[]).filter((s) => s.lang === lang);
      if (!group.length) continue;
      const t = opts.translate === false ? { title: msg.title, body: msg.body } : pushText(msg.title, msg.body, lang);
      sent += await sendToSubs(group, { ...msg, ...t });
    }
    return sent;
  } catch (e) {
    console.error("[push] send failed", (e as Error)?.message?.slice(0, 120));
    return 0;
  }
}

/** Test notification for the caller's own devices (ignores the push preference: the user asked for it). */
export function testMessageFor(lang: string): PushMessage {
  return lang === "en"
    ? { title: "Kasho Pay 🔔", body: "Notifications are working on this device.", url: "/", tag: "test" }
    : { title: "Kasho Pay 🔔", body: "Les notifications fonctionnent sur cet appareil.", url: "/", tag: "test" };
}
export async function sendTestPush(userId: string): Promise<number> {
  try {
    if (!configured) return 0;
    const { data: subs } = await db.from("push_subscriptions").select(SUB_COLS).eq("user_id", userId);
    let sent = 0;
    for (const lang of ["fr", "en"]) {
      const group = ((subs ?? []) as any[]).filter((s) => s.lang === lang);
      if (group.length) sent += await sendToSubs(group, testMessageFor(lang));
    }
    return sent;
  } catch (e) {
    console.error("[push] test failed", (e as Error)?.message?.slice(0, 120));
    return 0;
  }
}

// ------------------------------------------------------------------ morning greeting scheduler
let greeting = false;
/** Greets each device once per local day between 08:00 and 10:59. Safe to run on several instances. */
export async function runMorningGreetings(now: Date = new Date()): Promise<number> {
  if (!configured || greeting) return 0;
  greeting = true;
  let total = 0;
  try {
    let after = "";
    for (let page = 0; page < 200; page += 1) {
      const { data: rows, error } = await db.from("push_subscriptions")
        .select("id, user_id, endpoint, p256dh, auth, lang, tz, failures, last_greeting_on")
        .gt("id", after).order("id").limit(500);
      if (error || !rows?.length) break;
      after = rows[rows.length - 1].id;
      const due = (rows as any[]).filter((r) => shouldGreet({ now, tz: r.tz, lastGreetingOn: r.last_greeting_on }));
      if (due.length) {
        const ids = [...new Set(due.map((r) => r.user_id))];
        const { data: profs } = await db.from("profiles").select("id, first_name, display_name, notification_prefs").in("id", ids);
        const byId = new Map<string, any>((profs ?? []).map((p: any) => [p.id, p]));
        for (const r of due) {
          const prof = byId.get(r.user_id);
          if (!prof || prof.notification_prefs?.push === false) continue;
          const today = localDate(now, r.tz);
          // Claim the greeting BEFORE sending: a restart or a second instance can never greet twice.
          const { data: claimed } = await db.from("push_subscriptions").update({ last_greeting_on: today })
            .eq("id", r.id).or(`last_greeting_on.is.null,last_greeting_on.neq.${today}`).select("id");
          if (!claimed?.length) continue;
          const name = (prof.first_name || String(prof.display_name ?? "").replace(/^@/, "").split(/\s+/)[0] || "").trim();
          total += await sendToSubs([r], buildGreeting(r.lang, name));
        }
      }
      if (rows.length < 500) break;
    }
  } catch (e) {
    console.error("[push] greeting run failed", (e as Error)?.message?.slice(0, 120));
  } finally {
    greeting = false;
  }
  return total;
}
