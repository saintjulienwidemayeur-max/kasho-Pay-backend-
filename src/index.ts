import "./env.js";
import os from "node:os";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { supabaseAdmin } from "./supabase.js";
import * as L from "./ledger.js";
import { fredaConfigured, fredaMode, verifyWebhookSignature } from "./freda.js";
import { STEP_UP, clearStepUpFailures, hasVerifiedTotp, passwordIsValid, recordStepUpFailure, stepUpLocked, tokenAal } from "./stepup.js";
import { diditConfigured, verifyDiditWebhook } from "./didit.js";
import { handlers, type Ctx } from "./routes.js";
import { bearerToken, createRateLimiter, getHandler, isJsonRequest, makeOriginCheck, noStore, securityHeaders } from "./security.js";

const production = process.env["NODE_ENV"] === "production";
const app = express();
app.disable("x-powered-by");
// Only trust X-Forwarded-For when a known number of proxies sits in front (otherwise clients could fake their IP
// and escape the rate limits).
const hops = Number(process.env["TRUST_PROXY"] ?? 0);
app.set("trust proxy", Number.isInteger(hops) && hops > 0 ? hops : false);

const origins = (process.env["CORS_ORIGIN"] ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
// localhost / private-network origins (phone on the same Wi-Fi) are for testing only.
const allowLan = !production && (process.env["ALLOW_LAN_ORIGINS"] ?? "true").toLowerCase() !== "false";
const originOk = makeOriginCheck(origins, allowLan);

app.use(securityHeaders(production));
app.use(cors({
  origin: (origin: string | undefined, cb: any) => cb(null, originOk(origin)),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
}));

// Coarse limit per client IP for everything (health included).
app.use(createRateLimiter({ windowMs: 60_000, max: 300, key: (r) => `ip:${r.ip}` }));

// ---------------------------------------------------------------- health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "kasho-pay-backend", freda: fredaConfigured() ? fredaMode() : "not configured" });
});

// ---------------------------------------------------------------- Freda webhook (raw body needed for the signature)
app.post("/api/webhooks/freda", express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
  const secret = process.env["FREDA_WEBHOOK_SECRET"] ?? "";
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!secret || secret.includes("REPLACE_ME") || !verifyWebhookSignature(raw, req.header("x-freda-signature") ?? null, secret)) {
    return res.status(401).send("Invalid signature");
  }
  let evt: any;
  try {
    evt = JSON.parse(raw);
  } catch {
    return res.status(400).send("Bad JSON");
  }
  const eventId: string = req.header("x-freda-event-id") ?? evt?.id ?? "";
  const type: string = evt?.event ?? "";
  const d = evt?.data ?? {};

  // Duplicate deliveries are possible: process each event id only once.
  if (eventId) {
    const { error } = await L.db.from("webhook_events").insert({ id: eventId, event: type });
    if (error) {
      if (String(error.code) === "23505") return res.status(200).send("ok (duplicate)");
      console.error("[webhook] dedupe insert failed", error.message);
    }
  }

  // Docs: reply 200 quickly (Freda gives up after 8 s), process afterwards.
  // If processing fails, the reconciliation loop settles the transaction anyway.
  res.status(200).send("ok");
  void (async () => {
    try {
      if (type === "payment.succeeded" || type === "payment.failed" || type === "payout.succeeded" || type === "payout.failed") {
        let { data: tx } = await L.db.from("transactions").select("*").eq("provider_ref", d.id ?? "").maybeSingle();
        if (!tx && d.reference) ({ data: tx } = await L.db.from("transactions").select("*").eq("reference", d.reference).maybeSingle());
        if (tx) {
          if (!tx.provider_ref && d.id) {
            await L.patchTx(tx.id, { provider_ref: d.id });
            tx.provider_ref = d.id;
          }
          await L.settleTransaction(tx); // re-reads the real state from Freda instead of trusting the payload
        }
      } else if (type.startsWith("card.")) {
        const { data: card } = await L.db.from("cards").select("*").eq("freda_card_id", d.id ?? "").maybeSingle();
        const map: Record<string, string> = {
          "card.created": "active", "card.failed": "failed", "card.frozen": "disabled",
          "card.unfrozen": "active", "card.terminated": "terminated",
        };
        if (card && type === "card.terminated") await L.markCardGone(card);
        else if (card && map[type]) await L.applyCardStatus(card, map[type]!);
      }
    } catch (e) {
      console.error("[webhook] processing error", type, e);
      if (eventId) await L.db.from("webhook_events").delete().eq("id", eventId);
    }
  })();
  return;
});

// ---------------------------------------------------------------- Didit webhook (raw body needed for the signature)
app.post("/api/webhooks/didit", express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
  const secret = process.env["DIDIT_WEBHOOK_SECRET"] ?? "";
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (secret.includes("REPLACE_ME") || !verifyDiditWebhook(raw, {
    signature: req.header("x-signature"), signatureV2: req.header("x-signature-v2"), timestamp: req.header("x-timestamp"),
  }, secret)) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(req.header("x-timestamp")));
    console.error("[didit webhook] 401:", !secret || secret.includes("REPLACE_ME") ? "DIDIT_WEBHOOK_SECRET is not set"
      : !Number.isFinite(skew) || skew > 300 ? `timestamp too far from server time (${skew}s)` : "signature does not match DIDIT_WEBHOOK_SECRET (wrong secret?)");
    return res.status(401).send("Invalid signature");
  }
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return res.status(400).send("Bad JSON"); }
  const sessionId: string = evt?.session_id ?? "";
  if (!sessionId) return res.status(200).send("ok");
  res.status(200).send("ok");
  void (async () => {
    try {
      // Never trust the payload: re-read the decision from Didit, and match it to the user we created the session for.
      const { data: sub } = await L.db.from("kyc_submissions").select("user_id").eq("didit_session_id", sessionId).maybeSingle();
      if (sub) await L.applyKycDecision(sessionId, sub.user_id);
    } catch (e) {
      console.error("[didit webhook]", (e as Error).message);
    }
  })();
  return;
});

// ---------------------------------------------------------------- limits
// Per-user limits, stricter for sensitive actions. Counted by user id after authentication.
const byUser = (r: any) => `u:${r.ctx?.userId ?? r.ip}`;
const generalUserLimit = createRateLimiter({ windowMs: 60_000, max: 120, key: byUser });
const MIN = 60_000, HOUR = 3_600_000;
const endpointLimits: Record<string, { windowMs: number; max: number }> = {
  revealCardFn: { windowMs: MIN, max: 10 },
  searchUsers: { windowMs: MIN, max: 40 },
  sendMoney: { windowMs: MIN, max: 10 },
  startWithdrawal: { windowMs: MIN, max: 5 },
  startDeposit: { windowMs: MIN, max: 10 },
  createCardFn: { windowMs: MIN, max: 5 },
  createHolderFn: { windowMs: HOUR, max: 10 },
  fundCardFn: { windowMs: MIN, max: 10 },
  withdrawCardFn: { windowMs: MIN, max: 10 },
  terminateCardFn: { windowMs: MIN, max: 5 },
  changePassword: { windowMs: HOUR, max: 10 },
  changeEmail: { windowMs: HOUR, max: 5 },
  setCardCode: { windowMs: HOUR, max: 10 },
  createKycSession: { windowMs: HOUR, max: 10 },
  syncKyc: { windowMs: MIN, max: 12 },
  fileDisputeFn: { windowMs: HOUR, max: 20 },
  sendSupportMessage: { windowMs: HOUR, max: 5 },
  logActivity: { windowMs: MIN, max: 20 },
  adminSaveFee: { windowMs: MIN, max: 20 },
  adminDeleteFee: { windowMs: MIN, max: 20 },
};
const endpointLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();
for (const [name, l] of Object.entries(endpointLimits)) {
  endpointLimiters.set(name, createRateLimiter({ ...l, key: (r) => `${name}:${r.ctx?.userId ?? r.ip}` }));
}

// ---------------------------------------------------------------- auth: verify the Supabase access token
type AuthedRequest = Request & { ctx?: Ctx; mfaRequired?: boolean; aal?: string };

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = bearerToken(req.header("authorization"));
  if (!token) return res.status(401).json({ error: { message: "Please log in." } });
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: { message: "Your session expired. Please log in again." } });
    // Money endpoints are only for users who confirmed their email.
    if (!data.user.email_confirmed_at) return res.status(403).json({ error: { message: "Please verify your email first." } });
    req.mfaRequired = hasVerifiedTotp(data.user);
    req.aal = tokenAal(token);
    req.ctx = {
      userId: data.user.id,
      email: data.user.email ?? "",
      token,
      ip: req.ip ?? null,
      ua: (req.header("user-agent") ?? "").slice(0, 300) || null,
    };
    return next();
  } catch (e) {
    console.error("[auth]", e);
    return res.status(503).json({ error: { message: "Authentication service unavailable." } });
  }
}

// Sensitive actions: re-check the password (and the 2FA code when 2FA is on) before running.
async function stepUp(req: AuthedRequest, res: Response, next: NextFunction) {
  const rule = Object.prototype.hasOwnProperty.call(STEP_UP, String(req.params["name"])) ? STEP_UP[String(req.params["name"])] : undefined;
  if (!rule) return next();
  const ctx = req.ctx!;
  if (req.mfaRequired && req.aal !== "aal2") {
    return res.status(403).json({ error: { message: "Enter your 2FA code to continue.", code: "MFA_REQUIRED" } });
  }
  if (!rule.field) return next(); // 2FA-only rule (card details): the card code is verified by the handler
  const pw = req.body?.[rule.field];
  if (typeof pw !== "string" || !pw || pw.length > 200) {
    return res.status(403).json({ error: { message: "Confirm your password to continue.", code: "PASSWORD_REQUIRED" } });
  }
  if (stepUpLocked(ctx.userId)) {
    return res.status(429).json({ error: { message: "Too many wrong passwords. Try again in 15 minutes." } });
  }
  try {
    if (!(await passwordIsValid(ctx.email, pw))) {
      recordStepUpFailure(ctx.userId);
      return res.status(403).json({ error: { message: "Incorrect password.", code: "PASSWORD_INVALID" } });
    }
  } catch (e) {
    console.error("[stepup]", (e as Error).message);
    return res.status(503).json({ error: { message: "Could not verify your password right now." } });
  }
  clearStepUpFailures(ctx.userId);
  if (rule.strip) delete req.body[rule.field];
  return next();
}

// ---------------------------------------------------------------- API
// Order matters: cheap checks first (content type, body size), then auth, then per-user limits.
app.use("/api", noStore);
app.post("/api/:name", (req: Request, res: Response, next: NextFunction) => {
  if (!isJsonRequest(req.header("content-type"))) return res.status(415).json({ error: { message: "Content-Type must be application/json." } });
  return next();
}, express.json({ limit: "100kb", strict: true }), requireAuth, generalUserLimit,
(req: AuthedRequest, res: Response, next: NextFunction) => {
  const lim = endpointLimiters.get(String(req.params["name"]));
  return lim ? lim(req, res, next) : next();
}, stepUp,
async (req: AuthedRequest, res: Response) => {
  const h = getHandler(handlers, req.params["name"]);
  if (!h) return res.status(404).json({ error: { message: "Unknown endpoint." } });
  const parsed = h.schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: { message: "Invalid request. Check the values you entered." } });
  try {
    const data = await h.run(parsed.data, req.ctx!);
    return res.json({ data });
  } catch (e) {
    const err = L.toUserError(e);
    return res.status(400).json({ error: { message: err.message } });
  }
});

app.use((_req, res) => res.status(404).json({ error: { message: "Not found." } }));

// Last resort: malformed JSON, oversized bodies, unexpected throws. Never leak stack traces.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err?.status === 413 || err?.type === "entity.too.large" ? 413 : err?.type === "entity.parse.failed" ? 400 : 500;
  if (status === 500) console.error("[unhandled]", err);
  res.status(status).json({ error: { message: status === 413 ? "Request too large." : status === 400 ? "Invalid JSON." : "Something went wrong." } });
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
  process.exit(1); // let the process manager restart a clean process
});

// ---------------------------------------------------------------- reconciliation loop
// Settles pending deposits / withdrawals / card creations even without webhooks.
const DAY = 24 * 3600 * 1000;
let reconciling = false;
let tick = 0;
async function reconcile() {
  if (reconciling || !fredaConfigured()) return;
  reconciling = true;
  tick += 1;
  try {
    const { data: rows } = await L.db.from("transactions").select("*")
      .eq("status", "pending").in("kind", ["deposit", "withdrawal", "card_creation", "card_withdraw"])
      .gt("created_at", new Date(Date.now() - 3 * DAY).toISOString())
      .lt("created_at", new Date(Date.now() - 15_000).toISOString())
      .order("created_at").limit(25);
    for (const tx of rows ?? []) {
      // Docs: 100 requests/min per key, and stop polling a payment after ~10 min.
      // Older deposits are re-checked only every ~10 minutes.
      const age = Date.now() - new Date(tx.created_at).getTime();
      if (tx.kind === "deposit" && age > 15 * 60_000 && tick % 20 !== 0) continue;
      try {
        const status = await L.settleTransaction(tx);
        // A deposit nobody paid for within 24h is abandoned: no money moved, so closing it is safe.
        if (status === "pending" && tx.kind === "deposit" && Date.now() - new Date(tx.created_at).getTime() > DAY) {
          await L.failTx(tx.id, "Expired");
        }
      } catch (e) {
        console.error("[reconcile]", tx.reference, (e as Error).message);
      }
    }
    // Every ~2 minutes, check live cards: a card closed on the Freda side gets blocked here too.
    if (tick % 4 === 0) {
      const { data: cards } = await L.db.from("cards").select("*").in("status", ["active", "disabled"])
        .not("freda_card_id", "is", null).order("updated_at").limit(20);
      for (const card of cards ?? []) {
        try { await L.syncCardRow(card); } catch (e) { console.error("[card-sync]", card.id, (e as Error).message); }
      }
    }
  } catch (e) {
    console.error("[reconcile]", (e as Error).message);
  } finally {
    reconciling = false;
  }
}

// ---------------------------------------------------------------- start
const port = Number(process.env["PORT"] ?? 4000);
app.listen(port, () => {
  console.log(`Kasho Pay backend running on http://localhost:${port}`);
  console.log(`  CORS origins : ${origins.join(", ")}`);
  console.log(`  Freda        : ${fredaConfigured() ? fredaMode() : "NOT CONFIGURED (set FREDA_API_KEY)"}`);
  console.log(`  Environment  : ${production ? "production" : "development"}${allowLan ? " (LAN origins allowed)" : ""}`);
  const wh = process.env["FREDA_WEBHOOK_SECRET"] ?? "";
  if (!wh || wh.includes("REPLACE_ME")) console.warn("  WARNING: FREDA_WEBHOOK_SECRET not set, webhooks are rejected (polling still settles payments).");
  if (production) {
    if (fredaConfigured() && fredaMode() === "sandbox") console.warn("  WARNING: production server is using a sandbox Freda key.");
    if (origins.some((o) => /localhost|127\.0\.0\.1/.test(o))) console.warn("  WARNING: CORS_ORIGIN still lists localhost.");
    if (!hops) console.warn("  WARNING: TRUST_PROXY=0. Behind a reverse proxy set it to the number of proxies so rate limits see real IPs.");
  }
  console.log(`  Webhook URL  : POST /api/webhooks/freda`);
  console.log(`  Didit        : ${diditConfigured() ? "configured" : "NOT CONFIGURED (set DIDIT_API_KEY and DIDIT_WORKFLOW_ID)"}  webhook: POST /api/webhooks/didit`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) console.log(`  On your network: http://${i.address}:${port}/health`);
  }
  setInterval(reconcile, 30_000);
});
