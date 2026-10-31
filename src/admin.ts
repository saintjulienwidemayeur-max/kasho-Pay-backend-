// Admin panel API. Every endpoint needs: an entry in the `admins` table, a verified 2FA factor and an aal2 session.
// Moving customer money, suspending customers and changing Freda's price list need the 'super' role and re-check the
// password (see STEP_UP in stepup.ts). Money adjustments and suspensions are written to the append-only admin_audit log.
import { z } from "zod";
import * as L from "./ledger.js";
import { freda, fredaConfigured, fredaMode, readFredaBalances, readMasterWallet, type MasterWallet } from "./freda.js";
import { getConfig, round2 } from "./config.js";
import { FEE_OPERATIONS, TIERED_OPERATIONS, rowToRule, validateRule, type FeeOperation, type FeeRule } from "./fees.js";
import {
  GATEWAY_PLANS, ISSUING_PLANS, PARTNER_OPERATIONS, buildPnl, feeAnalysis, isGatewayPlan, isIssuingPlan, monthlyPlanUsd, presetRules,
  rowToPartnerRule, type GatewayPlan, type IssuingPlan, type PartnerRule,
} from "./finance.js";
import type { Ctx, Handler } from "./types.js";

export const ADMIN_MFA_MESSAGE = "Turn on two-factor authentication to use the admin tools.";
const NEEDS_MIGRATION = "The admin tables are not installed yet. Run supabase/migrations/20261101000000_admin_panel.sql in the Supabase SQL editor.";
export type AdminRole = "super" | "admin";

/** Admin access also needs a verified TOTP factor AND an aal2 session (2FA code passed in this session). */
export function adminMfaOk(c: Pick<Ctx, "mfa" | "aal">): boolean {
  return c.mfa === true && c.aal === "aal2";
}

/**
 * Only users listed in the `admins` table (server-only) get in, and only with 2FA. `need: "super"` is for the actions
 * that move customer money or change Freda's price list. A row without a role (before the migration) is a plain admin.
 */
export async function requireAdmin(c: Ctx, need: AdminRole = "admin"): Promise<AdminRole> {
  if (!adminMfaOk(c)) throw new L.AppError(ADMIN_MFA_MESSAGE);
  const { data } = await L.db.from("admins").select("*").eq("user_id", c.userId).maybeSingle();
  if (!data) throw new L.AppError("You do not have access to this.");
  const role: AdminRole = data.role === "super" ? "super" : "admin";
  if (need === "super" && role !== "super") throw new L.AppError("Only a super administrator can do this.");
  return role;
}

/** True when a database error means "the admin migration has not been run". */
export function missingAdminObject(e: any): boolean {
  const code = String(e?.code ?? "");
  return code === "42P01" || code === "42883" || code === "PGRST205" || code === "PGRST202"
    || /does not exist|schema cache|could not find the (table|function)/i.test(String(e?.message ?? ""));
}

/** Awaits a Supabase query and returns its data; a missing admin table or function becomes the "run the SQL" message. */
async function q<T = any>(query: PromiseLike<{ data: T | null; error: any }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) {
    if (missingAdminObject(error)) throw new L.AppError(NEEDS_MIGRATION);
    throw error;
  }
  return data;
}

async function audit(c: Ctx, action: string, details: Record<string, unknown>, target?: string) {
  const { error } = await L.db.from("admin_audit").insert({
    admin_id: c.userId, admin_email: c.email || null, action, target_user: target ?? null, details, ip: c.ip,
  });
  if (error && !missingAdminObject(error)) console.error("[admin-audit]", error.message);
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;

// ------------------------------------------------------------------ Freda funds (Master Wallet and Gateway)
export type FredaSnapshot = {
  configured: boolean; mode: "live" | "sandbox" | null; ok: boolean; message?: string; fetchedAt: string;
  master: MasterWallet | null; gateway: { htg: number | null; usd: number | null } | null;
};
const SNAPSHOT_TTL_MS = 15_000; // Freda allows 100 calls a minute per key: a refresh button must not burn them
let snapshotCache: { at: number; mode: string | null; value: FredaSnapshot } | null = null;
export const resetFredaSnapshotCache = () => { snapshotCache = null; };

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

export async function fredaSnapshot(): Promise<FredaSnapshot> {
  if (!fredaConfigured()) return { configured: false, mode: null, ok: false, message: "Freda is not configured (FREDA_API_KEY).", fetchedAt: new Date().toISOString(), master: null, gateway: null };
  const mode = fredaMode();
  if (snapshotCache && snapshotCache.mode === mode && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.value;
  const [mw, bal] = await Promise.allSettled([withTimeout(freda.masterWallet(), 10_000), withTimeout(freda.balance(), 10_000)]);
  const master = mw.status === "fulfilled" ? readMasterWallet(mw.value) : null;
  const balances = bal.status === "fulfilled" ? readFredaBalances(bal.value) : null;
  for (const r of [mw, bal]) if (r.status === "rejected") console.error("[admin] Freda balance:", (r.reason as Error)?.message);
  const value: FredaSnapshot = {
    configured: true, mode, ok: !!master || !!balances, fetchedAt: new Date().toISOString(),
    master: master ?? (balances?.masterWallet != null ? { balance: balances.masterWallet, guarantee: 0, spendable: balances.masterWallet, low: false, reservedOnCards: 0, activeCards: 0, mode } : null),
    gateway: balances ? { htg: balances.gatewayHtg, usd: balances.gatewayUsd } : null,
    ...(master || balances ? {} : { message: "Could not reach Freda right now. Try again in a moment." }),
  };
  snapshotCache = { at: Date.now(), mode, value };
  return value;
}

// ------------------------------------------------------------------ partner price list and plans
async function loadPlans(): Promise<{ gateway: GatewayPlan; issuing: IssuingPlan }> {
  const rows = (await q<any[]>(L.db.from("app_settings").select("key, value").in("key", ["partner_gateway_plan", "partner_issuing_plan"]))) ?? [];
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    gateway: isGatewayPlan(get("partner_gateway_plan")) ? get("partner_gateway_plan") : "standard",
    issuing: isIssuingPlan(get("partner_issuing_plan")) ? get("partner_issuing_plan") : "startup",
  };
}

async function loadPartnerRules(plans: { gateway: GatewayPlan; issuing: IssuingPlan }): Promise<PartnerRule[]> {
  const rows = (await q<any[]>(L.db.from("partner_costs").select("*"))) ?? [];
  if (!rows.length) return presetRules(plans.gateway, plans.issuing); // never leave the report without prices
  const byOp = new Map(rows.map((r) => [r.operation, rowToPartnerRule(r)] as const));
  return PARTNER_OPERATIONS.map((op) => byOp.get(op)).filter((r): r is PartnerRule => !!r);
}

// ------------------------------------------------------------------ reading many rows
/** Reads a query page by page (the API returns at most 1000 rows per call), up to `cap` rows. */
async function fetchPaged<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, cap = 50_000) {
  const rows: T[] = [];
  let truncated = false;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) {
      if (missingAdminObject(error)) throw new L.AppError(NEEDS_MIGRATION);
      throw error;
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    if (rows.length >= cap) { truncated = true; break; }
  }
  return { rows, truncated };
}

/** Customer names for a list of user ids (no e-mails: those are read one customer at a time). */
async function namesFor(ids: string[]): Promise<Map<string, { name: string; kashoId: string | null }>> {
  const out = new Map<string, { name: string; kashoId: string | null }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const rows = (await q<any[]>(L.db.from("profiles").select("id, display_name, username, kasho_id").in("id", uniq))) ?? [];
  for (const r of rows) out.set(r.id, { name: String(r.display_name || `@${r.username}`), kashoId: r.kasho_id ?? null });
  return out;
}

const uuid = z.string().uuid();
const feeRuleInput = z.object({
  id: uuid.optional(),
  operation: z.enum(FEE_OPERATIONS),
  label: z.string().trim().max(80).default(""),
  feeType: z.enum(["flat", "percent"]),
  minAmount: z.number().min(0).max(100000).nullable().default(null),
  maxAmount: z.number().min(0).max(100000).nullable().default(null),
  feeValue: z.number().min(0).max(100000),
  active: z.boolean().default(true),
});
/** Free text from the browser that goes into a PostgREST filter: letters, digits and a few separators only. */
const safeSearch = (s: string | undefined) => (s ?? "").replace(/[^A-Za-z0-9 _.@-]/g, "").trim().slice(0, 60);

export const adminHandlers: Record<string, Handler> = {
  // ---------------------------------------------------------------- who am I (no 2FA needed: the page explains what is missing)
  adminStatus: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      const { data } = await L.db.from("admins").select("*").eq("user_id", c.userId).maybeSingle();
      return {
        isAdmin: !!data,
        role: data ? ((data.role === "super" ? "super" : "admin") as AdminRole) : null,
        hasTotp: c.mfa === true,
        mfaOk: adminMfaOk(c),
        email: c.email,
      };
    },
  },

  // ---------------------------------------------------------------- overview: Freda funds, customers, profit
  adminOverview: {
    schema: z.object({ days: z.number().int().min(1).max(366).default(30) }),
    run: async (d, c) => {
      await requireAdmin(c);
      const to = new Date();
      const from = new Date(to.getTime() - d.days * 86_400_000);
      const cfg = getConfig();
      const plans = await loadPlans();
      const [stats, tx, purchases, rules, snapshot] = await Promise.all([
        q<any>(L.db.rpc("kasho_admin_stats", { p_from: from.toISOString(), p_to: to.toISOString() })),
        fetchPaged<any>((a, b) => L.db.from("transactions").select("id, kind, status, amount, fee, created_at, meta")
          .eq("status", "completed").in("kind", ["deposit", "withdrawal", "card_creation", "card_fund", "card_withdraw", "transfer_out"])
          .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).order("created_at").order("id").range(a, b)),
        fetchPaged<any>((a, b) => L.db.from("card_events").select("id, type, created_at")
          .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).order("created_at").order("id").range(a, b)),
        loadPartnerRules(plans),
        fredaSnapshot(),
      ]);
      const buys = purchases.rows.filter((p) => !/^(CREDIT|REFUND|REVERSAL|DECLINE|DECLINED)$/i.test(String(p.type ?? "")));
      const pnl = buildPnl({
        rows: tx.rows, rules, htgPerUsd: cfg.htgPerUsd, purchases: buys, monthlyPlanUsd: monthlyPlanUsd(plans.gateway, plans.issuing, cfg.htgPerUsd), days: d.days,
      });

      // Money owed to customers against money held at Freda (indicative: the HTG balance is converted at our fixed rate).
      const owed = Number(stats?.wallets_total ?? 0);
      const gHtg = snapshot.gateway?.htg ?? null;
      const gUsd = snapshot.gateway?.usd ?? null;
      const held = gHtg === null && gUsd === null ? null : round2((gHtg ?? 0) / cfg.htgPerUsd + (gUsd ?? 0));
      return {
        period: { from: from.toISOString(), to: to.toISOString(), days: d.days },
        freda: snapshot,
        stats: {
          usersTotal: Number(stats?.users_total ?? 0), usersNew: Number(stats?.users_new ?? 0), usersVerified: Number(stats?.users_verified ?? 0),
          usersKycPending: Number(stats?.users_kyc_pending ?? 0), walletsTotal: owed, walletsFunded: Number(stats?.wallets_funded ?? 0),
          cardsTotal: Number(stats?.cards_total ?? 0), cardsActive: Number(stats?.cards_active ?? 0), cardsBalance: Number(stats?.cards_balance ?? 0),
          txPending: Number(stats?.tx_pending ?? 0), txPendingOld: Number(stats?.tx_pending_old ?? 0), txFailed: Number(stats?.tx_failed ?? 0),
          adjustCredits: Number(stats?.adjust_credits ?? 0), adjustDebits: Number(stats?.adjust_debits ?? 0),
          cardPurchases: Number(stats?.card_purchases ?? 0), cardEventsSince: (stats?.card_events_since as string | null) ?? null,
        },
        pnl,
        funds: { owedToUsers: owed, heldAtFreda: held, coverage: held !== null && owed > 0 ? Math.round((held / owed) * 1000) / 1000 : null, rate: cfg.htgPerUsd },
        plans,
        truncated: tx.truncated || purchases.truncated,
      };
    },
  },

  /** Fresh Master Wallet and Gateway balances (the overview refresh button). */
  adminFredaFunds: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => { await requireAdmin(c); return fredaSnapshot(); },
  },

  // ---------------------------------------------------------------- customer fees (the schedule users pay)
  /** Every fee rule, including inactive ones. */
  adminListFees: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      await requireAdmin(c);
      const { data, error } = await L.db.from("fee_rules").select("*").order("operation").order("min_amount", { nullsFirst: true });
      if (error) throw error;
      return { operations: FEE_OPERATIONS, tiered: TIERED_OPERATIONS, rules: (data ?? []).map(rowToRule) };
    },
  },

  /** Creates a rule (no id) or updates one (id). Password is checked by the step-up middleware. */
  adminSaveFee: {
    schema: feeRuleInput.extend({ confirmPassword: z.string().optional() }),
    run: async (d, c) => {
      await requireAdmin(c);
      const { data: all, error: listErr } = await L.db.from("fee_rules").select("*");
      if (listErr) throw listErr;
      const others: FeeRule[] = (all ?? []).map(rowToRule);
      const rule = {
        ...(d.id ? { id: d.id } : {}), operation: d.operation as FeeOperation, feeType: d.feeType,
        minAmount: d.minAmount, maxAmount: d.maxAmount, feeValue: Math.round(d.feeValue * 10000) / 10000, active: d.active,
      };
      if (d.id && !others.some((o) => o.id === d.id)) throw new L.AppError("Fee rule not found.");
      const problem = validateRule(rule, others);
      if (problem) throw new L.AppError(problem);
      const row = {
        operation: rule.operation, label: d.label, fee_type: rule.feeType, min_amount: rule.minAmount, max_amount: rule.maxAmount,
        fee_value: rule.feeValue, active: rule.active, updated_by: c.userId,
      };
      const { data, error } = d.id
        ? await L.db.from("fee_rules").update(row).eq("id", d.id).select("*").single()
        : await L.db.from("fee_rules").insert(row).select("*").single();
      if (error) throw error;
      const detail = `${rule.operation} ${rule.feeType} ${rule.feeValue} [${rule.minAmount ?? ""}-${rule.maxAmount ?? ""}] active=${rule.active}`;
      await L.db.from("activity_log").insert({ user_id: c.userId, event: "Fee rule changed", detail, ip: c.ip, user_agent: c.ua });
      await audit(c, "fee_rule_saved", { operation: rule.operation, feeType: rule.feeType, feeValue: rule.feeValue, minAmount: rule.minAmount, maxAmount: rule.maxAmount, active: rule.active, created: !d.id });
      return rowToRule(data);
    },
  },

  adminDeleteFee: {
    schema: z.object({ id: uuid, confirmPassword: z.string().optional() }),
    run: async (d, c) => {
      await requireAdmin(c);
      const { data, error } = await L.db.from("fee_rules").delete().eq("id", d.id).select("operation");
      if (error) throw error;
      if (!data?.length) throw new L.AppError("Fee rule not found.");
      await L.db.from("activity_log").insert({ user_id: c.userId, event: "Fee rule deleted", detail: String(data[0].operation), ip: c.ip, user_agent: c.ua });
      await audit(c, "fee_rule_deleted", { operation: String(data[0].operation) });
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------- what Freda charges us, and the margin per operation
  adminPartnerCosts: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      await requireAdmin(c);
      const cfg = getConfig();
      const plans = await loadPlans();
      const [rules, ourRules] = await Promise.all([loadPartnerRules(plans), L.feeRules()]);
      return {
        plans, options: { gateway: GATEWAY_PLANS, issuing: ISSUING_PLANS }, rules, rate: cfg.htgPerUsd,
        monthlyPlanUsd: monthlyPlanUsd(plans.gateway, plans.issuing, cfg.htgPerUsd),
        analysis: feeAnalysis(ourRules, rules, cfg.htgPerUsd),
      };
    },
  },

  adminSavePartnerCost: {
    schema: z.object({
      operation: z.enum(PARTNER_OPERATIONS),
      percent: z.number().min(0).max(100),
      flatUsd: z.number().min(0).max(1000),
      flatHtg: z.number().min(0).max(1_000_000),
      thresholdUsd: z.number().min(0).max(1_000_000).nullable().default(null),
      active: z.boolean().default(true),
      note: z.string().trim().max(120).default(""),
      confirmPassword: z.string().optional(),
    }),
    run: async (d, c) => {
      await requireAdmin(c, "super");
      const row = {
        operation: d.operation, percent: Math.round(d.percent * 10000) / 10000, flat_usd: Math.round(d.flatUsd * 10000) / 10000,
        flat_htg: round2(d.flatHtg), threshold_usd: d.thresholdUsd === null ? null : round2(d.thresholdUsd), active: d.active, note: d.note, updated_by: c.userId,
      };
      // keep the label that is already stored (the form does not edit it)
      const existing = await q<any>(L.db.from("partner_costs").select("label").eq("operation", d.operation).maybeSingle());
      const label = existing?.label || presetRules("standard", "startup").find((r) => r.operation === d.operation)?.label || d.operation;
      await q(L.db.from("partner_costs").upsert({ ...row, label }, { onConflict: "operation" }));
      await audit(c, "partner_cost_saved", { operation: d.operation, percent: row.percent, flatUsd: row.flat_usd, flatHtg: row.flat_htg, thresholdUsd: row.threshold_usd, active: row.active });
      return { ok: true };
    },
  },

  /** Replaces the partner price list with Freda's public prices for the chosen plans. */
  adminApplyPartnerPlan: {
    schema: z.object({ gateway: z.enum(GATEWAY_PLANS), issuing: z.enum(ISSUING_PLANS), confirmPassword: z.string().optional() }),
    run: async (d, c) => {
      await requireAdmin(c, "super");
      const rules = presetRules(d.gateway, d.issuing);
      await q(L.db.from("partner_costs").upsert(rules.map((r) => ({
        operation: r.operation, label: r.label, percent: r.percent, flat_usd: r.flatUsd, flat_htg: r.flatHtg, threshold_usd: r.thresholdUsd,
        active: r.active, note: r.note, updated_by: c.userId,
      })), { onConflict: "operation" }));
      await q(L.db.from("app_settings").upsert([
        { key: "partner_gateway_plan", value: d.gateway, updated_by: c.userId },
        { key: "partner_issuing_plan", value: d.issuing, updated_by: c.userId },
      ], { onConflict: "key" }));
      await audit(c, "partner_plan_applied", { gateway: d.gateway, issuing: d.issuing });
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------- customers
  adminListUsers: {
    schema: z.object({ q: z.string().max(80).optional(), page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(5).max(50).default(25) }),
    run: async (d, c) => {
      await requireAdmin(c);
      const rows = (await q<any[]>(L.db.rpc("kasho_admin_users", { p_q: (d.q ?? "").trim(), p_limit: d.pageSize, p_offset: (d.page - 1) * d.pageSize }))) ?? [];
      return {
        total: Number(rows[0]?.total ?? 0), page: d.page, pageSize: d.pageSize,
        users: rows.map((r) => ({
          id: r.id as string, email: (r.email ?? "") as string, name: (r.display_name || `@${r.username}`) as string, username: r.username as string,
          kashoId: (r.kasho_id ?? null) as string | null, phone: String(r.phone ?? ""), kycStatus: r.kyc_status as string, balance: Number(r.balance ?? 0),
          cards: Number(r.cards ?? 0), createdAt: r.created_at as string, lastSignInAt: (r.last_sign_in_at ?? null) as string | null,
          banned: r.banned === true, adminRole: (r.admin_role ?? null) as AdminRole | null,
        })),
      };
    },
  },

  adminGetUser: {
    schema: z.object({ userId: uuid }),
    run: async (d, c) => {
      await requireAdmin(c);
      const { data: au, error: auErr } = await L.db.auth.admin.getUserById(d.userId);
      if (auErr || !au?.user) throw new L.AppError("Customer not found.");
      const [profile, wallet, cards, txs, role] = await Promise.all([
        q<any>(L.db.from("profiles").select("display_name, username, kasho_id, first_name, last_name, phone_code, phone_number, country, kyc_status, created_at").eq("id", d.userId).maybeSingle()),
        q<any>(L.db.from("wallets").select("balance").eq("user_id", d.userId).maybeSingle()),
        q<any[]>(L.db.from("cards").select("id, label, brand, last4, status, balance, created_at").eq("user_id", d.userId).neq("status", "failed").order("created_at", { ascending: false }).limit(20)),
        q<any[]>(L.db.from("transactions").select("id, reference, kind, title, category, method, amount, fee, status, created_at, meta").eq("user_id", d.userId).order("created_at", { ascending: false }).limit(50)),
        q<any>(L.db.from("admins").select("*").eq("user_id", d.userId).maybeSingle()),
      ]);
      if (!profile) throw new L.AppError("Customer not found.");
      const u = au.user;
      return {
        id: d.userId, email: u.email ?? "", createdAt: u.created_at, lastSignInAt: u.last_sign_in_at ?? null,
        banned: !!u.banned_until && Date.parse(u.banned_until) > Date.now(), adminRole: role ? (role.role === "super" ? "super" : "admin") : null,
        profile: {
          name: profile.display_name || `@${profile.username}`, username: profile.username, kashoId: profile.kasho_id ?? null,
          firstName: profile.first_name ?? "", lastName: profile.last_name ?? "", phone: `${profile.phone_code ?? ""}${profile.phone_number ?? ""}`,
          country: profile.country ?? "", kycStatus: profile.kyc_status,
        },
        balance: Number(wallet?.balance ?? 0),
        cards: (cards ?? []).map((k) => ({ id: k.id, label: k.label, brand: k.brand, last4: k.last4 ?? "", status: k.status, balance: Number(k.balance ?? 0), createdAt: k.created_at })),
        transactions: (txs ?? []).map((t) => ({
          id: t.id, reference: t.reference, kind: t.kind, title: t.title, category: t.category, method: t.method,
          amount: Number(t.amount), fee: Number(t.fee), status: t.status, createdAt: t.created_at, note: (t.meta?.note ?? null) as string | null,
        })),
      };
    },
  },

  /** Adds money to / removes money from a customer wallet. Atomic, logged in the ledger and the audit log, the customer is told. */
  adminAdjustBalance: {
    schema: z.object({
      userId: uuid, direction: z.enum(["credit", "debit"]), amountUsd: z.number().positive().max(1_000_000),
      note: z.string().trim().min(3).max(200), confirmPassword: z.string().optional(),
    }),
    run: async (d, c) => {
      await requireAdmin(c, "super");
      const amount = round2(d.amountUsd);
      const max = getConfig().adminMaxAdjustUsd;
      if (amount < 0.01) throw new L.AppError("Enter an amount of at least $0.01.");
      if (max > 0 && amount > max) throw new L.AppError(`One adjustment is limited to ${money(max)}.`);
      if (d.userId === c.userId) throw new L.AppError("You cannot adjust your own account.");
      // Administrators are not customers: no money is moved on their accounts from the panel (same rule as suspending).
      if (await q<any>(L.db.from("admins").select("*").eq("user_id", d.userId).maybeSingle())) throw new L.AppError("Administrator accounts cannot be adjusted here.");
      const credit = d.direction === "credit";
      const { data, error } = await L.db.rpc("kasho_admin_adjust", {
        p_admin: c.userId, p_user: d.userId, p_credit: credit, p_amount: amount, p_note: d.note, p_ip: c.ip,
      });
      if (error) {
        const m = String(error.message ?? "");
        if (missingAdminObject(error)) throw new L.AppError(NEEDS_MIGRATION);
        if (m.includes("INSUFFICIENT_FUNDS")) throw new L.AppError("That is more than the customer's balance.");
        if (m.includes("NO_WALLET")) throw new L.AppError("Customer not found.");
        if (m.includes("SELF_ADJUST")) throw new L.AppError("You cannot adjust your own account.");
        if (m.includes("NOT_ALLOWED")) throw new L.AppError("Only a super administrator can do this.");
        if (m.includes("NOTE_REQUIRED")) throw new L.AppError("Write a reason (at least 3 characters).");
        if (m.includes("INVALID_AMOUNT")) throw new L.AppError("Enter a valid amount.");
        throw error;
      }
      await L.notify(d.userId, "Balance adjusted", credit ? `${money(amount)} was added to your wallet by Kasho Pay.` : `${money(amount)} was removed from your wallet by Kasho Pay.`);
      return {
        reference: String(data?.reference ?? ""), balanceBefore: Number(data?.balance_before ?? 0), balanceAfter: Number(data?.balance_after ?? 0),
      };
    },
  },

  /** Suspends / reactivates a customer: the API refuses their requests at once and they cannot sign in again. */
  adminSetUserBlocked: {
    schema: z.object({ userId: uuid, blocked: z.boolean(), confirmPassword: z.string().optional() }),
    run: async (d, c) => {
      await requireAdmin(c, "super");
      if (d.userId === c.userId) throw new L.AppError("You cannot suspend your own account.");
      const target = await q<any>(L.db.from("admins").select("*").eq("user_id", d.userId).maybeSingle());
      if (target) throw new L.AppError("Administrators cannot be suspended here.");
      const { error } = await L.db.auth.admin.updateUserById(d.userId, { ban_duration: d.blocked ? "876000h" : "none" });
      if (error) {
        console.error("[admin] suspend:", error.message);
        throw new L.AppError("Could not update this customer. Try again.");
      }
      await audit(c, d.blocked ? "user_suspended" : "user_reactivated", {}, d.userId);
      return { blocked: d.blocked };
    },
  },

  // ---------------------------------------------------------------- transactions, support, audit
  adminListTransactions: {
    schema: z.object({
      q: z.string().max(60).optional(), kind: z.string().regex(/^[a-z_]{1,30}$/).optional(), status: z.enum(["pending", "completed", "failed"]).optional(),
      userId: uuid.optional(), page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(10).max(100).default(30),
    }),
    run: async (d, c) => {
      await requireAdmin(c);
      let query = L.db.from("transactions")
        .select("id, reference, user_id, kind, title, category, method, amount, fee, status, provider_ref, created_at, meta", { count: "exact" })
        .order("created_at", { ascending: false }).order("id");
      if (d.kind) query = query.eq("kind", d.kind);
      if (d.status) query = query.eq("status", d.status);
      if (d.userId) query = query.eq("user_id", d.userId);
      const text = safeSearch(d.q);
      if (text) query = query.or(`reference.ilike.%${text}%,title.ilike.%${text}%,provider_ref.ilike.%${text}%`);
      const from = (d.page - 1) * d.pageSize;
      const { data, error, count } = await query.range(from, from + d.pageSize - 1);
      if (error) throw error;
      const names = await namesFor((data ?? []).map((t: any) => t.user_id));
      return {
        total: count ?? 0, page: d.page, pageSize: d.pageSize,
        items: (data ?? []).map((t: any) => ({
          id: t.id, reference: t.reference, userId: t.user_id, customer: names.get(t.user_id)?.name ?? "", kashoId: names.get(t.user_id)?.kashoId ?? null,
          kind: t.kind, title: t.title, category: t.category, method: t.method, amount: Number(t.amount), fee: Number(t.fee), status: t.status,
          providerRef: t.provider_ref ?? null, createdAt: t.created_at, note: (t.meta?.note ?? t.meta?.failure_reason ?? null) as string | null,
        })),
      };
    },
  },

  adminListSupport: {
    schema: z.object({}).passthrough(),
    run: async (_d, c) => {
      await requireAdmin(c);
      const [disputes, messages] = await Promise.all([
        q<any[]>(L.db.from("disputes").select("id, user_id, transaction_ref, title, amount, reason, note, reference, created_at").order("created_at", { ascending: false }).limit(100)),
        q<any[]>(L.db.from("support_messages").select("id, user_id, email, message, created_at").order("created_at", { ascending: false }).limit(100)),
      ]);
      const names = await namesFor([...(disputes ?? []), ...(messages ?? [])].map((r) => r.user_id));
      return {
        disputes: (disputes ?? []).map((r) => ({ ...r, amount: Number(r.amount), customer: names.get(r.user_id)?.name ?? "" })),
        messages: (messages ?? []).map((r) => ({ ...r, customer: names.get(r.user_id)?.name ?? "" })),
      };
    },
  },

  adminListAudit: {
    schema: z.object({ page: z.number().int().min(1).max(100000).default(1), pageSize: z.number().int().min(10).max(100).default(50) }),
    run: async (d, c) => {
      await requireAdmin(c);
      const from = (d.page - 1) * d.pageSize;
      const { data, error, count } = await L.db.from("admin_audit").select("id, admin_email, action, target_user, details, ip, created_at", { count: "exact" })
        .order("created_at", { ascending: false }).order("id").range(from, from + d.pageSize - 1);
      if (error) {
        if (missingAdminObject(error)) throw new L.AppError(NEEDS_MIGRATION);
        throw error;
      }
      const names = await namesFor((data ?? []).map((r: any) => r.target_user));
      return {
        total: count ?? 0, page: d.page, pageSize: d.pageSize,
        items: (data ?? []).map((r: any) => ({ ...r, target: names.get(r.target_user)?.name ?? null })),
      };
    },
  },
};
