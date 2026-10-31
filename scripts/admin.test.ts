// Run: npm test
// Admin panel: profit and loss, fee analysis, access rules, customer money adjustments, Freda funds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env["SUPABASE_URL"] ??= "http://localhost:1"; // ledger.ts builds a client at import time; nothing is called
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-key";
process.env["FREDA_API_KEY"] = "sk_test_unit";
const L: any = await import("../src/ledger.js");
const F = await import("../src/finance.js");
const A: any = await import("../src/admin.js");
const { freda } = await import("../src/freda.js");
const { rowToRule } = await import("../src/fees.js");
const { isSuspended, makeAdminSiteGuard } = await import("../src/security.js");
const { MFA_ENDPOINTS, STEP_UP } = await import("../src/stepup.js");
const { handlers } = await import("../src/routes.js");

const quiet = async <T>(fn: () => Promise<T> | T): Promise<T> => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 0.006, `${msg} ${a} !~ ${b}`);

// ------------------------------------------------------------------ Freda price list and costs
test("price presets follow Freda's list (Gateway + Issuing plans)", () => {
  const by = (g: any, i: any): Map<string, any> => new Map(F.presetRules(g, i).map((r: any) => [r.operation, r]));
  const s = by("standard", "startup");
  assert.deepEqual([s.get("deposit").percent, s.get("deposit").flatHtg], [6, 10]);
  assert.equal(s.get("withdrawal").percent, 5);
  assert.equal(s.get("card_creation").flatUsd, 5);
  assert.deepEqual([s.get("card_fund").flatUsd, s.get("card_fund").percent, s.get("card_fund").thresholdUsd], [1.6, 3, 100]);
  assert.equal(s.get("card_withdraw").flatUsd, 1.3);
  assert.equal(s.get("master_wallet_funding").percent, 4.5);
  assert.equal(s.get("card_closure").flatUsd, 0.5);
  const p = by("pro", "pro");
  assert.deepEqual([p.get("deposit").percent, p.get("card_creation").flatUsd, p.get("card_fund").flatUsd, p.get("card_fund").percent, p.get("card_withdraw").flatUsd, p.get("master_wallet_funding").percent], [4.2, 3.5, 1.25, 2, 1.15, 3]);
  const b = by("business", "premium");
  assert.deepEqual([b.get("deposit").percent, b.get("card_creation").flatUsd, b.get("card_withdraw").flatUsd, b.get("master_wallet_funding").percent], [4, 2.5, 1.1, 2.5]);
  assert.equal(F.presetRules("standard", "startup").length, F.PARTNER_OPERATIONS.length);
  assert.equal(F.monthlyPlanUsd("standard", "startup", 131), 0);
  assert.equal(F.monthlyPlanUsd("pro", "pro", 131), 157.63); // 150 USD + 1 000 HTG
  assert.equal(F.monthlyPlanUsd("business", "premium", 131), 538.17);
  assert.equal(F.isGatewayPlan("pro"), true); assert.equal(F.isGatewayPlan("startup"), false); assert.equal(F.isIssuingPlan("premium"), true);
});

test("partnerCostOf: percentage + flat, HTG flat converted, threshold rule, switched off", () => {
  const s: Map<string, any> = new Map(F.presetRules("standard", "startup").map((r: any) => [r.operation, r]));
  near(F.partnerCostOf(s.get("deposit"), 100, 131), 6 + 10 / 131);
  near(F.partnerCostOf(s.get("withdrawal"), 50, 131), 2.5);
  near(F.partnerCostOf(s.get("card_fund"), 100, 131), 1.6, "flat up to the threshold");
  near(F.partnerCostOf(s.get("card_fund"), 100.01, 131), 3.0003, "percentage above it");
  near(F.partnerCostOf(s.get("card_fund"), 250, 131), 7.5);
  near(F.partnerCostOf(s.get("card_creation"), 999, 131), 5, "creation is flat whatever the prefund");
  assert.equal(F.partnerCostOf(undefined, 10, 131), 0);
  assert.equal(F.partnerCostOf({ ...s.get("deposit"), active: false }, 10, 131), 0);
  near(F.partnerCostOf(s.get("withdrawal"), -50, 131), 2.5, "sign ignored");
  near(F.partnerCostOf(s.get("deposit"), 10, 0), 0.6, "no rate: the HTG part is skipped, not NaN");
});

test("financeOp: which ledger rows count", () => {
  assert.equal(F.financeOp({ kind: "deposit" }), "deposit");
  assert.equal(F.financeOp({ kind: "card_withdraw", meta: {} }), "card_withdraw");
  assert.equal(F.financeOp({ kind: "card_withdraw", meta: { terminate: true } }), "card_closure");
  assert.equal(F.financeOp({ kind: "transfer_out" }), "transfer");
  for (const k of ["transfer_in", "admin_credit", "admin_debit", "whatever"]) assert.equal(F.financeOp({ kind: k }), null, k);
});

const RULES = F.presetRules("standard", "startup");
const R: Map<any, any> = new Map(RULES.map((r: any) => [r.operation, r]));
const row = (kind: string, amount: number, fee: number, over: any = {}) => ({ kind, status: "completed", amount, fee, created_at: "2026-10-20T15:00:00Z", meta: {}, ...over });

test("rowPartnerCost: the figure Freda reported wins, otherwise the price rule", () => {
  const c = (op: any, r: any) => F.rowPartnerCost(op, r, R, 131);
  assert.deepEqual(c("deposit", row("deposit", 100, 2, { meta: { fee_htg: 786, rate: 131 } })), { cost: 6, real: true });
  near(c("deposit", row("deposit", 100, 2)).cost, 6 + 10 / 131); assert.equal(c("deposit", row("deposit", 100, 2)).real, false);
  assert.deepEqual(c("withdrawal", row("withdrawal", -50, 1.25, { meta: { payout_fee_htg: 327.5, rate: 131 } })), { cost: 2.5, real: true });
  assert.equal(c("withdrawal", row("withdrawal", -50, 1.25)).cost, 2.5);
  assert.deepEqual(c("card_fund", row("card_fund", -20, 2.3, { meta: { provider_fee_usd: 1.6 } })), { cost: 1.6, real: true });
  assert.equal(c("card_fund", row("card_fund", -20, 2.3)).cost, 1.6);
  assert.equal(c("card_withdraw", row("card_withdraw", 10, 2.15, { meta: { provider_fee_usd: 1.3 } })).cost, 1.3);
  assert.equal(c("card_creation", row("card_creation", -10, 10)).cost, 5);
  assert.equal(c("card_closure", row("card_withdraw", 12, 0.5, { meta: { terminate: true } })).cost, 0.5);
  assert.equal(c("card_closure", row("card_withdraw", 0.3, 0.3, { meta: { terminate: true } })).cost, 0.3, "never more than what was left");
  assert.deepEqual(c("transfer", row("transfer_out", -20, 0.3)), { cost: 0, real: true });
  assert.equal(c("deposit", row("deposit", 10, 0.8, { meta: { fee_htg: "x" } })).real, false, "garbage meta falls back to the rule");
  assert.equal(c("deposit", row("deposit", 10, 0.8, { meta: { fee_htg: -5, rate: 131 } })).real, false);
});

test("buildPnl: revenue, Freda's share and profit per operation, funding, purchases and plan fees", () => {
  const rows = [
    row("deposit", 100, 2, { meta: { fee_htg: 786, rate: 131 }, created_at: "2026-10-20T03:00:00Z" }), // 23:00 on the 19th in Haiti
    row("deposit", 10, 0.8, { created_at: "2026-10-20T04:00:00Z" }), // 00:00 on the 20th
    row("withdrawal", -50, 1.25),
    row("card_creation", -10, 10),
    row("card_fund", -20, 2.3),
    row("card_withdraw", 10, 2.15, { meta: { provider_fee_usd: 1.3 } }),
    row("card_withdraw", 12, 0.5, { meta: { terminate: true } }),
    row("transfer_out", -20, 0.3),
    row("transfer_in", 20, 0),
    row("admin_credit", 5, 0),
    row("deposit", 50, 1.5, { status: "pending" }),
    row("withdrawal", -40, 1, { status: "failed" }),
  ];
  const pnl: any = F.buildPnl({ rows, rules: RULES, htgPerUsd: 131, purchases: [{ created_at: "2026-10-20T15:00:00Z" }, { created_at: "2026-10-20T16:00:00Z" }, { created_at: "2026-10-21T16:00:00Z" }], monthlyPlanUsd: 157.63, days: 15 });
  const L2: Map<string, any> = new Map(pnl.lines.map((l: any) => [l.operation, l]));
  const dep = L2.get("deposit");
  assert.deepEqual([dep.count, dep.volume, dep.revenue], [2, 110, 2.8]);
  near(dep.partnerCost, 6 + (0.6 + 10 / 131)); near(dep.profit, 2.8 - dep.partnerCost); assert.equal(dep.estimated, 1);
  const wd = L2.get("withdrawal"); assert.deepEqual([wd.count, wd.volume, wd.revenue, wd.partnerCost, wd.profit], [1, 50, 1.25, 2.5, -1.25]);
  const cc = L2.get("card_creation"); assert.deepEqual([cc.revenue, cc.partnerCost, cc.profit], [10, 5, 5]);
  const cf = L2.get("card_fund"); assert.deepEqual([cf.revenue, cf.partnerCost, cf.profit], [2.3, 1.6, 0.7]);
  const cw = L2.get("card_withdraw"); assert.deepEqual([cw.revenue, cw.partnerCost, cw.profit, cw.estimated], [2.15, 1.3, 0.85, 0]);
  const cl = L2.get("card_closure"); assert.deepEqual([cl.revenue, cl.partnerCost, cl.profit], [0.5, 0.5, 0]);
  const tr = L2.get("transfer"); assert.deepEqual([tr.count, tr.revenue, tr.partnerCost, tr.profit], [1, 0.3, 0, 0.3]);
  // card money added to the Master Wallet: 10 + 20 - 10 - 12 = 8 USD at 4.5 %
  const mw = L2.get("master_wallet_funding"); assert.deepEqual([mw.volume, mw.partnerCost, mw.revenue], [8, 0.36, 0]);
  const pu = L2.get("card_purchase"); assert.deepEqual([pu.count, pu.partnerCost], [3, 0.3]);
  assert.equal(L2.get("plans").partnerCost, 78.82, "monthly 157.63 for 15 days");
  const revenue = 2.8 + 1.25 + 10 + 2.3 + 2.15 + 0.5 + 0.3;
  near(pnl.totals.revenue, revenue);
  near(pnl.totals.partnerCost, dep.partnerCost + 2.5 + 5 + 1.6 + 1.3 + 0.5 + 0.36 + 0.3 + 78.82);
  near(pnl.totals.profit, pnl.totals.revenue - pnl.totals.partnerCost);
  near(pnl.totals.margin, pnl.totals.profit / pnl.totals.revenue);
  // days are Haiti calendar days (UTC-4 in summer, so 03:00Z is still the evening before)
  assert.deepEqual(pnl.daily.map((x: any) => x.date), ["2026-10-19", "2026-10-20", "2026-10-21"]);
  assert.equal(pnl.daily[0].revenue, 2);
  assert.equal(pnl.daily[2].partnerCost, 0.1, "a purchase on the 21st");
});

test("buildPnl: nothing to report", () => {
  const pnl: any = F.buildPnl({ rows: [], rules: RULES, htgPerUsd: 131, purchases: [], monthlyPlanUsd: 0, days: 30 });
  assert.deepEqual(pnl.totals, { revenue: 0, partnerCost: 0, profit: 0, margin: null });
  assert.equal(pnl.daily.length, 0);
  assert.ok(pnl.lines.every((l: any) => l.count === 0 || l.operation === "plans"));
});

const OUR = [
  { id: "1", operation: "wallet_deposit", feeType: "flat", minAmount: 5, maxAmount: 10, feeValue: 0.8 },
  { id: "2", operation: "wallet_deposit", feeType: "flat", minAmount: 10, maxAmount: 25, feeValue: 1.15 },
  { id: "3", operation: "wallet_deposit", feeType: "flat", minAmount: 25, maxAmount: 50, feeValue: 1.5 },
  { id: "4", operation: "wallet_deposit", feeType: "flat", minAmount: 50, maxAmount: 100, feeValue: 2 },
  { id: "5", operation: "wallet_withdrawal", feeType: "flat", minAmount: 5, maxAmount: 10, feeValue: 0.7 },
  { id: "6", operation: "wallet_withdrawal", feeType: "flat", minAmount: 10, maxAmount: 25, feeValue: 1 },
  { id: "7", operation: "wallet_withdrawal", feeType: "flat", minAmount: 25, maxAmount: 50, feeValue: 1.25 },
  { id: "8", operation: "wallet_withdrawal", feeType: "flat", minAmount: 50, maxAmount: 100, feeValue: 1.75 },
  { id: "9", operation: "card_creation", feeType: "flat", minAmount: null, maxAmount: null, feeValue: 10 },
  { id: "10", operation: "card_fund", feeType: "flat", minAmount: null, maxAmount: null, feeValue: 2.3 },
  { id: "11", operation: "card_withdraw", feeType: "flat", minAmount: null, maxAmount: null, feeValue: 2.15 },
  { id: "12", operation: "transfer", feeType: "percent", minAmount: null, maxAmount: null, feeValue: 1.5 },
].map((r: any) => ({ label: "", active: true, ...r }));

test("feeAnalysis: where our schedule loses money against Freda's price list", () => {
  const rows: any[] = F.feeAnalysis(OUR, RULES, 131);
  const at = (op: string, a: number): any => rows.find((r: any) => r.operation === op && r.amount === a);
  assert.equal(rows.length, 5 * 5 + 5);
  // withdrawal of $100: we charge 1.75, Freda 5 % = 5.00
  assert.deepEqual([at("wallet_withdrawal", 100).ourFee, at("wallet_withdrawal", 100).partnerCost, at("wallet_withdrawal", 100).margin], [1.75, 5, -3.25]);
  // deposit of $10: 0.80 against 6 % + 10 HTG
  assert.equal(at("wallet_deposit", 10).ourFee, 0.8); near(at("wallet_deposit", 10).partnerCost, 0.68); near(at("wallet_deposit", 10).margin, 0.12);
  assert.ok(at("wallet_deposit", 100).margin < -3.9);
  // card creation with a $10 prefund: 10 - (5 + 4.5 % of 10 funding)
  assert.deepEqual([at("card_creation", 10).ourFee, at("card_creation", 10).partnerCost, at("card_creation", 10).margin], [10, 5.45, 4.55]);
  assert.equal(at("card_creation", 2).partnerCost, 5.09);
  // card top-up of $50: 2.30 against 1.60 + 4.5 % funding = 3.85
  assert.deepEqual([at("card_fund", 50).partnerCost, at("card_fund", 50).margin], [3.85, -1.55]);
  assert.deepEqual([at("card_withdraw", 25).partnerCost, at("card_withdraw", 25).margin], [1.3, 0.85]);
  assert.deepEqual([at("transfer", 100).ourFee, at("transfer", 100).partnerCost, at("transfer", 100).margin], [1.5, 0, 1.5]);
});

test("feeAnalysis: an amount outside the fee brackets has no customer fee, and a missing rule is fine", () => {
  const rows: any[] = F.feeAnalysis(OUR.filter((r: any) => r.operation !== "card_fund").map((r: any) => (r.operation === "wallet_deposit" && r.maxAmount === 100 ? { ...r, maxAmount: 60 } : r)), [], 131);
  assert.equal(rows.find((r: any) => r.operation === "wallet_deposit" && r.amount === 100).ourFee, null);
  assert.equal(rows.find((r: any) => r.operation === "wallet_deposit" && r.amount === 100).margin, null);
  assert.equal(rows.find((r: any) => r.operation === "card_fund" && r.amount === 10).ourFee, null, "no rule at all");
  assert.equal(rows.find((r: any) => r.operation === "wallet_withdrawal" && r.amount === 100).partnerCost, 0, "no partner rules: no cost");
  assert.equal(F.rowToPartnerRule({ operation: "deposit", percent: "6", flat_usd: "0", flat_htg: "10", threshold_usd: null, active: false }).active, false);
  assert.equal(F.rowToPartnerRule({ operation: "card_fund", percent: 3, flat_usd: 1.6, flat_htg: 0, threshold_usd: "100" }).thresholdUsd, 100);
});

// ------------------------------------------------------------------ a recording fake of the database
/** A value that changes with each read: the first call gets the first item, the last item repeats. */
class Seq { constructor(public items: any[]) {} }
const seq = (...items: any[]) => new Seq(items);
function fakeDb(o: { one?: Record<string, any>; list?: Record<string, any[]>; rpc?: Record<string, any>; rpcError?: Record<string, any>; error?: Record<string, any>; count?: number } = {}) {
  const calls: { table: string; method: string; args: any[] }[] = [];
  const rpcCalls: { name: string; args: any }[] = [];
  const from = (table: string) => {
    let op = "select";
    const api: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "then") return (res: any) => res({ data: o.list?.[table] ?? [], error: o.error?.[table] ?? null, count: o.count ?? (o.list?.[table]?.length ?? 0) });
        if (prop === "maybeSingle") return async () => {
          const v = o.one?.[table];
          return { data: v instanceof Seq ? (v.items.length > 1 ? v.items.shift() : v.items[0]) ?? null : v ?? null, error: o.error?.[table] ?? null };
        };
        if (prop === "single") return async () => ({ data: o.one?.[table] ?? null, error: o.error?.[table] ?? null });
        return (...args: any[]) => { if (["insert", "update", "upsert", "delete"].includes(prop)) op = prop; calls.push({ table, method: prop, args }); return api; };
      },
    });
    return api;
  };
  const rpc = async (name: string, args: any) => { rpcCalls.push({ name, args }); return { data: o.rpc?.[name] ?? null, error: o.rpcError?.[name] ?? null }; };
  return { calls, rpcCalls, from, rpc };
}
const saved = { from: L.db.from, rpc: L.db.rpc, masterWallet: freda.masterWallet, balance: freda.balance };
const authStub = (admin: any) => Object.defineProperty(L.db, "auth", { configurable: true, value: { admin } });
async function withFake(fake: ReturnType<typeof fakeDb>, fn: () => any): Promise<any> {
  L.db.from = fake.from; L.db.rpc = fake.rpc;
  A.resetFredaSnapshotCache();
  try { return await fn(); } finally { L.db.from = saved.from; L.db.rpc = saved.rpc; freda.masterWallet = saved.masterWallet; freda.balance = saved.balance; A.resetFredaSnapshotCache(); }
}
const inserts = (f: ReturnType<typeof fakeDb>, table: string) => f.calls.filter((c) => c.table === table && c.method === "insert").map((c) => c.args[0]);
const SUPER_ROW = { user_id: "admin-1", role: "super" };
const SUPER: any = { userId: "admin-1", email: "admin@kashopay.com", ip: "9.9.9.9", ua: "t", mfa: true, aal: "aal2" };

// ------------------------------------------------------------------ access rules
test("admin access: 2FA first, then the admins table, then the role", async () => {
  assert.equal(A.adminMfaOk({ mfa: true, aal: "aal2" }), true);
  assert.equal(A.adminMfaOk({ mfa: true, aal: "aal1" }), false);
  assert.equal(A.adminMfaOk({ mfa: false, aal: "aal2" }), false);
  await withFake(fakeDb({ one: { admins: { user_id: "admin-1", role: "super" } } }), async () => {
    await assert.rejects(() => A.requireAdmin({ ...SUPER, mfa: false }), { message: A.ADMIN_MFA_MESSAGE });
    await assert.rejects(() => A.requireAdmin({ ...SUPER, aal: "aal1" }), { message: A.ADMIN_MFA_MESSAGE });
    assert.equal(await A.requireAdmin(SUPER), "super");
    assert.equal(await A.requireAdmin(SUPER, "super"), "super");
  });
  await withFake(fakeDb(), async () => {
    await assert.rejects(() => A.requireAdmin(SUPER), { message: "You do not have access to this." });
  });
  await withFake(fakeDb({ one: { admins: { user_id: "admin-1", role: "admin" } } }), async () => {
    assert.equal(await A.requireAdmin(SUPER), "admin");
    await assert.rejects(() => A.requireAdmin(SUPER, "super"), { message: "Only a super administrator can do this." });
  });
  await withFake(fakeDb({ one: { admins: { user_id: "admin-1" } } }), async () => {
    assert.equal(await A.requireAdmin(SUPER), "admin", "a row without a role (before the migration) is a plain admin");
  });
});

test("adminStatus works without 2FA so the page can explain what is missing", async () => {
  await withFake(fakeDb({ one: { admins: { user_id: "admin-1", role: "super" } } }), async () => {
    assert.deepEqual(await A.adminHandlers.adminStatus.run({}, { ...SUPER, mfa: false, aal: "aal1" }),
      { isAdmin: true, role: "super", hasTotp: false, mfaOk: false, email: "admin@kashopay.com" });
    assert.equal((await A.adminHandlers.adminStatus.run({}, SUPER)).mfaOk, true);
  });
  await withFake(fakeDb(), async () => {
    assert.deepEqual(await A.adminHandlers.adminStatus.run({}, { ...SUPER, mfa: false }), { isAdmin: false, role: null, hasTotp: false, mfaOk: false, email: "admin@kashopay.com" });
  });
});

test("every admin endpoint asks for 2FA, and the money ones for the password again", () => {
  const names = Object.keys(A.adminHandlers);
  assert.equal(names.length, 16);
  for (const n of names) if (n !== "adminStatus") assert.ok(MFA_ENDPOINTS.has(n), `${n} must be in MFA_ENDPOINTS`);
  assert.ok(!MFA_ENDPOINTS.has("adminStatus"));
  for (const n of ["adminAdjustBalance", "adminSetUserBlocked", "adminSavePartnerCost", "adminApplyPartnerPlan", "adminSaveFee", "adminDeleteFee"]) {
    assert.deepEqual(STEP_UP[n], { field: "confirmPassword", strip: true }, n);
  }
  for (const n of names) assert.ok((handlers as any)[n], `${n} is served by the API`);
});

test("the admin tools only answer to the admin site, and the admin site only reaches them", () => {
  const ADMIN = "https://admin.kashopay.com", APP = "https://app.kashopay.com";
  const guard = makeAdminSiteGuard([ADMIN], true);
  for (const n of Object.keys(A.adminHandlers)) {
    assert.equal(guard(n, ADMIN), null, `${n} from the admin site`);
    assert.match(guard(n, APP)!, /only work on the Kasho Pay admin site/, `${n} from the customer app`);
    assert.match(guard(n, undefined)!, /only work on the Kasho Pay admin site/, `${n} without an Origin (a script)`);
    assert.match(guard(n, "https://admin.kashopay.com.evil.example")!, /admin site/, `${n} from a look-alike origin`);
  }
  assert.equal(guard("changePassword", ADMIN), null, "the administrator changes his password on the admin site");
  for (const n of ["sendMoney", "getIdentity", "revealCardFn", "startWithdrawal", "getPublicConfig"]) assert.match(guard(n, ADMIN)!, /not available from the admin site/, n);
  for (const n of ["sendMoney", "getPublicConfig", "changePassword"]) { assert.equal(guard(n, APP), null, n); assert.equal(guard(n, undefined), null, n); }
  // every endpoint whose name starts with "admin" is an admin tool (the guard keys on the name), and the other way round
  assert.deepEqual(Object.keys(handlers).filter((n) => n.startsWith("admin")).sort(), Object.keys(A.adminHandlers).sort());
  // not set up: production fails closed (clear message), development is open
  assert.match(makeAdminSiteGuard([], true)("adminStatus", ADMIN)!, /ADMIN_ORIGINS/);
  assert.equal(makeAdminSiteGuard([], false)("adminStatus", "http://localhost:5174"), null);
  assert.equal(makeAdminSiteGuard([], true)("sendMoney", APP), null, "customer endpoints are not affected");
  // several admin origins
  const two = makeAdminSiteGuard([ADMIN, "https://admin2.kashopay.com"], true);
  assert.equal(two("adminOverview", "https://admin2.kashopay.com"), null);
});

test("a suspended customer is recognised until the ban ends", () => {
  assert.equal(isSuspended({ banned_until: new Date(Date.now() + 3600_000).toISOString() }), true);
  assert.equal(isSuspended({ banned_until: new Date(Date.now() - 3600_000).toISOString() }), false);
  for (const u of [null, undefined, {}, { banned_until: null }, { banned_until: "garbage" }]) assert.equal(isSuspended(u as any), false);
});

// ------------------------------------------------------------------ moving customer money
const ADJ = { userId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11", direction: "credit", amountUsd: 25.5, note: "Refund of order 123" };
const adj = (f: ReturnType<typeof fakeDb>, over: any = {}, ctx: any = SUPER) => withFake(f, () => A.adminHandlers.adminAdjustBalance.run({ ...ADJ, ...over }, ctx));

test("adminAdjustBalance: one atomic database call, the customer is told", async () => {
  // first read of `admins` = the caller (super), second read = the customer (not an admin)
  const f = fakeDb({ one: { admins: seq(SUPER_ROW, null) }, rpc: { kasho_admin_adjust: { reference: "KP-1", balance_before: 50, balance_after: 75.5 } } });
  assert.deepEqual(await adj(f), { reference: "KP-1", balanceBefore: 50, balanceAfter: 75.5 });
  assert.deepEqual(f.rpcCalls, [{ name: "kasho_admin_adjust", args: { p_admin: "admin-1", p_user: ADJ.userId, p_credit: true, p_amount: 25.5, p_note: "Refund of order 123", p_ip: "9.9.9.9" } }]);
  assert.deepEqual(inserts(f, "notifications")[0], { user_id: ADJ.userId, title: "Balance adjusted", body: "$25.50 was added to your wallet by Kasho Pay." });

  const f2 = fakeDb({ one: { admins: seq(SUPER_ROW, null) }, rpc: { kasho_admin_adjust: { reference: "KP-2", balance_before: 50, balance_after: 39.74 } } });
  await adj(f2, { direction: "debit", amountUsd: 10.255 });
  assert.equal(f2.rpcCalls[0]!.args.p_credit, false);
  assert.equal(f2.rpcCalls[0]!.args.p_amount, 10.26, "rounded to cents");
  assert.equal(inserts(f2, "notifications")[0].body, "$10.26 was removed from your wallet by Kasho Pay.");
});

test("adminAdjustBalance: only a super admin, never on yourself, never above the limit", async () => {
  const plain = fakeDb({ one: { admins: { user_id: "admin-1", role: "admin" } } });
  await assert.rejects(() => adj(plain), { message: "Only a super administrator can do this." });
  assert.equal(plain.rpcCalls.length, 0);
  const sup = () => fakeDb({ one: { admins: { user_id: "admin-1", role: "super" } } });
  const self = sup();
  await assert.rejects(() => adj(self, { userId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }, { ...SUPER, userId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }), { message: "You cannot adjust your own account." });
  const big = sup();
  await assert.rejects(() => adj(big, { amountUsd: 10000.01 }), { message: "One adjustment is limited to $10000.00." });
  await assert.rejects(() => adj(sup(), { amountUsd: 0.001 }), { message: "Enter an amount of at least $0.01." });
  assert.equal(big.rpcCalls.length + self.rpcCalls.length, 0, "nothing reaches the database");
  const toAdmin = sup(); // the customer is an administrator too: the same row answers both reads
  await assert.rejects(() => adj(toAdmin), { message: "Administrator accounts cannot be adjusted here." });
  assert.equal(toAdmin.rpcCalls.length, 0);
  process.env["ADMIN_MAX_ADJUST_USD"] = "50";
  try { await assert.rejects(() => adj(sup(), { amountUsd: 60 }), { message: "One adjustment is limited to $50.00." }); } finally { delete process.env["ADMIN_MAX_ADJUST_USD"]; }
  // the form's field limits
  const schema = A.adminHandlers.adminAdjustBalance.schema;
  assert.equal(schema.safeParse({ ...ADJ }).success, true);
  for (const bad of [{ note: "ab" }, { note: "x".repeat(201) }, { amountUsd: 0 }, { amountUsd: -5 }, { direction: "set" }, { userId: "nope" }]) assert.equal(schema.safeParse({ ...ADJ, ...bad }).success, false, JSON.stringify(bad));
});

test("adminAdjustBalance: database refusals become clear messages", async () => {
  const sup = (msg: string, code?: string) => fakeDb({ one: { admins: seq(SUPER_ROW, null) }, rpcError: { kasho_admin_adjust: { message: msg, ...(code ? { code } : {}) } } });
  const cases: [string, string][] = [
    ["INSUFFICIENT_FUNDS", "That is more than the customer's balance."], ["NO_WALLET", "Customer not found."], ["SELF_ADJUST", "You cannot adjust your own account."],
    ["NOT_ALLOWED", "Only a super administrator can do this."], ["NOTE_REQUIRED", "Write a reason (at least 3 characters)."], ["INVALID_AMOUNT", "Enter a valid amount."],
  ];
  for (const [msg, out] of cases) await assert.rejects(() => adj(sup(msg)), { message: out }, msg);
  await assert.rejects(() => adj(sup("function public.kasho_admin_adjust does not exist", "42883")), (e: any) => /admin_panel\.sql/.test(e.message));
});

test("adminSetUserBlocked: ban or lift the ban, never yourself or an administrator", async () => {
  const updates: any[] = [];
  authStub({ updateUserById: async (id: string, attrs: any) => { updates.push([id, attrs]); return { error: null }; } });
  const U = "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11";
  const run = (f: ReturnType<typeof fakeDb>, d: any, c: any = SUPER) => withFake(f, () => A.adminHandlers.adminSetUserBlocked.run(d, c));
  // first read of `admins` = the caller (super), second read = the customer (not an admin)
  const f = fakeDb({ one: { admins: seq(SUPER_ROW, null) } });
  assert.deepEqual(await run(f, { userId: U, blocked: true }), { blocked: true });
  assert.deepEqual(updates[0], [U, { ban_duration: "876000h" }]);
  assert.equal(inserts(f, "admin_audit")[0].action, "user_suspended");
  assert.equal(inserts(f, "admin_audit")[0].target_user, U);
  assert.deepEqual(await run(fakeDb({ one: { admins: seq(SUPER_ROW, null) } }), { userId: U, blocked: false }), { blocked: false });
  assert.deepEqual(updates[1], [U, { ban_duration: "none" }]);
  await assert.rejects(() => run(fakeDb({ one: { admins: SUPER_ROW } }), { userId: U, blocked: true }, { ...SUPER, userId: U }), { message: "You cannot suspend your own account." });
  await assert.rejects(() => run(fakeDb({ one: { admins: SUPER_ROW } }), { userId: U, blocked: true }), { message: "Administrators cannot be suspended here." }); // the customer is an admin too
  assert.equal(updates.length, 2, "nothing was banned in the refused cases");
  authStub({ updateUserById: async () => ({ error: { message: "boom" } }) });
  await quiet(() => assert.rejects(() => run(fakeDb({ one: { admins: seq(SUPER_ROW, null) } }), { userId: U, blocked: true }), { message: "Could not update this customer. Try again." }));
  await withFake(fakeDb({ one: { admins: { user_id: "admin-1", role: "admin" } } }), async () => {
    await assert.rejects(() => A.adminHandlers.adminSetUserBlocked.run({ userId: U, blocked: true }, SUPER), { message: "Only a super administrator can do this." });
  });
});

// ------------------------------------------------------------------ overview with Freda funds
const OVERVIEW_ROWS = {
  transactions: [
    row("deposit", 100, 2, { meta: { fee_htg: 786, rate: 131 } }), row("withdrawal", -50, 1.25), row("card_creation", -10, 10), row("transfer_out", -20, 0.3),
  ],
  card_events: [{ id: "c1", type: "DEBIT", created_at: "2026-10-20T15:00:00Z" }, { id: "c2", type: "CREDIT", created_at: "2026-10-20T16:00:00Z" }, { id: "c3", type: "decline", created_at: "2026-10-20T16:30:00Z" }],
  app_settings: [{ key: "partner_gateway_plan", value: "standard" }, { key: "partner_issuing_plan", value: "startup" }],
  partner_costs: [] as any[],
};
const STATS = { users_total: 12, users_new: 3, users_verified: 5, users_kyc_pending: 1, wallets_total: 200, wallets_funded: 7, cards_total: 4, cards_active: 3, cards_balance: 80, tx_pending: 2, tx_pending_old: 1, tx_failed: 1, adjust_credits: 5, adjust_debits: 0, card_purchases: 1, card_events_since: "2026-10-01T00:00:00Z" };
const FREDA_OK = () => {
  freda.masterWallet = (async () => ({ mode: "live", balance: 320.5, guarantee_usd: 50, spendable_usd: 270.5, reserved_on_cards_usd: 140, active_cards: 6, low_balance: false })) as any;
  freda.balance = (async () => ({ gateway: { available: 26200, currency: "HTG" }, gateway_usd: { available: 10, currency: "USD" }, master_wallet: { available: 320.5, currency: "USD" } })) as any;
};

test("adminOverview: Master Wallet and Gateway balances, profit, and what we owe against what Freda holds", async () => {
  FREDA_OK();
  const f = fakeDb({ one: { admins: SUPER_ROW }, list: OVERVIEW_ROWS, rpc: { kasho_admin_stats: STATS } });
  const out = await withFake(f, () => A.adminHandlers.adminOverview.run({ days: 30 }, SUPER));
  assert.deepEqual(out.freda.master, { balance: 320.5, guarantee: 50, spendable: 270.5, low: false, reservedOnCards: 140, activeCards: 6, mode: "live" });
  assert.deepEqual(out.freda.gateway, { htg: 26200, usd: 10 });
  assert.equal(out.freda.ok, true); assert.equal(out.freda.mode, "sandbox"); // the key in this test is sk_test_
  assert.equal(out.stats.walletsTotal, 200); assert.equal(out.stats.usersNew, 3); assert.equal(out.stats.cardsBalance, 80);
  assert.equal(out.period.days, 30);
  // 26 200 HTG / 131 = 200, plus 10 USD = 210 held against 200 owed
  assert.deepEqual(out.funds, { owedToUsers: 200, heldAtFreda: 210, coverage: 1.05, rate: 131 });
  assert.deepEqual(out.plans, { gateway: "standard", issuing: "startup" });
  const L2: Map<string, any> = new Map(out.pnl.lines.map((l: any) => [l.operation, l]));
  assert.equal(L2.get("deposit").partnerCost, 6, "the fee Freda reported for the deposit");
  assert.equal(L2.get("card_purchase").count, 1, "credits and declines are not purchases");
  assert.equal(out.pnl.totals.revenue, 13.55);
  assert.equal(out.truncated, false);
  const rpc = f.rpcCalls[0]!;
  assert.equal(rpc.name, "kasho_admin_stats");
  assert.equal(Date.parse(rpc.args.p_to) - Date.parse(rpc.args.p_from), 30 * 86_400_000);
});

test("adminOverview: Freda unreachable still shows the rest, with a plain message", async () => {
  freda.masterWallet = (async () => { throw new Error("network"); }) as any;
  freda.balance = (async () => { throw new Error("network"); }) as any;
  const out = await quiet(() => withFake(fakeDb({ one: { admins: SUPER_ROW }, list: OVERVIEW_ROWS, rpc: { kasho_admin_stats: STATS } }), () => A.adminHandlers.adminOverview.run({ days: 7 }, SUPER)));
  assert.equal(out.freda.ok, false); assert.equal(out.freda.master, null); assert.equal(out.freda.message, "Could not reach Freda right now. Try again in a moment.");
  assert.equal(out.funds.heldAtFreda, null); assert.equal(out.funds.coverage, null);
  assert.equal(out.stats.usersTotal, 12);
});

test("Freda funds are cached for a few seconds (100 calls a minute is the limit), and a partial answer is kept", async () => {
  let calls = 0;
  freda.masterWallet = (async () => { calls += 1; throw new Error("nope"); }) as any;
  freda.balance = (async () => ({ gateway: { available: 100 }, gateway_usd: { available: 0 }, master_wallet: { available: 55.5 } })) as any;
  await quiet(async () => await withFake(fakeDb(), async () => {
    const a = await A.fredaSnapshot();
    const b = await A.fredaSnapshot();
    assert.equal(calls, 1); assert.equal(a, b);
    assert.equal(a.ok, true);
    assert.deepEqual(a.master, { balance: 55.5, guarantee: 0, spendable: 55.5, low: false, reservedOnCards: 0, activeCards: 0, mode: "sandbox" }, "master wallet taken from /v1/balance when /v1/master-wallet fails");
    assert.deepEqual(a.gateway, { htg: 100, usd: 0 });
  }));
});

test("adminOverview refuses a non-admin and a missing migration says what to run", async () => {
  await withFake(fakeDb(), async () => { await assert.rejects(() => A.adminHandlers.adminOverview.run({ days: 30 }, SUPER), { message: "You do not have access to this." }); });
  FREDA_OK();
  const f = fakeDb({ one: { admins: SUPER_ROW }, list: OVERVIEW_ROWS, rpcError: { kasho_admin_stats: { message: "Could not find the function public.kasho_admin_stats", code: "PGRST202" } } });
  await withFake(f, async () => { await assert.rejects(() => A.adminHandlers.adminOverview.run({ days: 30 }, SUPER), (e: any) => /20261101000000_admin_panel\.sql/.test(e.message)); });
  assert.equal(A.missingAdminObject({ code: "42P01" }), true);
  assert.equal(A.missingAdminObject({ message: 'relation "public.admin_audit" does not exist' }), true);
  assert.equal(A.missingAdminObject({ message: "permission denied" }), false);
  const schema = A.adminHandlers.adminOverview.schema;
  assert.equal(schema.parse({}).days, 30); assert.equal(schema.safeParse({ days: 0 }).success, false); assert.equal(schema.safeParse({ days: 400 }).success, false);
});

// ------------------------------------------------------------------ partner prices
test("adminPartnerCosts: prices, plans and the margin table together", async () => {
  const f = fakeDb({ one: { admins: SUPER_ROW }, list: { app_settings: [{ key: "partner_gateway_plan", value: "pro" }, { key: "partner_issuing_plan", value: "premium" }], partner_costs: [], fee_rules: [] } });
  const out = await withFake(f, () => A.adminHandlers.adminPartnerCosts.run({}, SUPER));
  assert.deepEqual(out.plans, { gateway: "pro", issuing: "premium" });
  assert.equal(out.rules.length, 8, "an empty table falls back to the price list of the plans");
  assert.equal(out.rules.find((r: any) => r.operation === "card_creation").flatUsd, 2.5);
  assert.equal(out.monthlyPlanUsd, 507.63);
  assert.deepEqual(out.options.gateway, ["standard", "pro", "business"]);
  assert.equal(out.analysis.length, 30);
});

test("adminSavePartnerCost / adminApplyPartnerPlan: super admin only, stored and logged", async () => {
  const d = { operation: "withdrawal", percent: 4.5, flatUsd: 0, flatHtg: 0, thresholdUsd: null, active: true, note: "negotiated" };
  const f = fakeDb({ one: { admins: SUPER_ROW, partner_costs: { label: "MonCash / NatCash payout" } } });
  await withFake(f, () => A.adminHandlers.adminSavePartnerCost.run(d, SUPER));
  const up = f.calls.find((c) => c.table === "partner_costs" && c.method === "upsert")!;
  assert.deepEqual(up.args[0], { operation: "withdrawal", percent: 4.5, flat_usd: 0, flat_htg: 0, threshold_usd: null, active: true, note: "negotiated", updated_by: "admin-1", label: "MonCash / NatCash payout" });
  assert.equal(up.args[1].onConflict, "operation");
  assert.equal(inserts(f, "admin_audit")[0].action, "partner_cost_saved");
  const plain = fakeDb({ one: { admins: { user_id: "admin-1", role: "admin" } } });
  await withFake(plain, async () => { await assert.rejects(() => A.adminHandlers.adminSavePartnerCost.run(d, SUPER), { message: "Only a super administrator can do this." }); });
  assert.equal(plain.calls.filter((c) => c.method === "upsert").length, 0);
  for (const bad of [{ percent: 101 }, { percent: -1 }, { flatUsd: -1 }, { operation: "transfer" }, { note: "x".repeat(121) }]) assert.equal(A.adminHandlers.adminSavePartnerCost.schema.safeParse({ ...d, ...bad }).success, false, JSON.stringify(bad));

  const g = fakeDb({ one: { admins: SUPER_ROW } });
  await withFake(g, () => A.adminHandlers.adminApplyPartnerPlan.run({ gateway: "business", issuing: "pro" }, SUPER));
  const ups = g.calls.filter((c) => c.method === "upsert");
  assert.equal(ups[0]!.table, "partner_costs"); assert.equal(ups[0]!.args[0].length, 8);
  assert.equal(ups[0]!.args[0].find((r: any) => r.operation === "deposit").percent, 4);
  assert.equal(ups[0]!.args[0].find((r: any) => r.operation === "card_creation").flat_usd, 3.5);
  assert.deepEqual(ups[1]!.args[0].map((r: any) => [r.key, r.value]), [["partner_gateway_plan", "business"], ["partner_issuing_plan", "pro"]]);
  assert.equal(inserts(g, "admin_audit")[0].action, "partner_plan_applied");
  assert.equal(A.adminHandlers.adminApplyPartnerPlan.schema.safeParse({ gateway: "startup", issuing: "pro" }).success, false);
});

// ------------------------------------------------------------------ customers, transactions, audit
test("adminListUsers: maps the search function's rows and paging", async () => {
  const rows = [{ id: "u1", email: "marie@example.com", display_name: "Marie Jean", username: "kp1", kasho_id: "KP-001001", phone: "+50937001234", kyc_status: "verified", balance: "65.24", cards: 2, created_at: "2026-10-01T00:00:00Z", last_sign_in_at: null, banned: true, admin_role: null, total: 41 }];
  const f = fakeDb({ one: { admins: SUPER_ROW }, rpc: { kasho_admin_users: rows } });
  const out = await withFake(f, () => A.adminHandlers.adminListUsers.run({ q: " marie ", page: 3, pageSize: 10 }, SUPER));
  assert.deepEqual(f.rpcCalls[0], { name: "kasho_admin_users", args: { p_q: "marie", p_limit: 10, p_offset: 20 } });
  assert.equal(out.total, 41); assert.equal(out.users[0].balance, 65.24); assert.equal(out.users[0].banned, true); assert.equal(out.users[0].name, "Marie Jean");
});

test("adminGetUser: profile, wallet, cards and the latest transactions, without identity documents", async () => {
  authStub({ getUserById: async () => ({ data: { user: { email: "marie@example.com", created_at: "2026-10-01T00:00:00Z", last_sign_in_at: "2026-10-30T10:00:00Z", banned_until: null } }, error: null }) });
  const f = fakeDb({
    one: { admins: seq(SUPER_ROW, null), profiles: { display_name: "Marie Jean", username: "kp1", kasho_id: "KP-001001", first_name: "Marie", last_name: "Jean", phone_code: "+509", phone_number: "37001234", country: "HT", kyc_status: "verified" }, wallets: { balance: "65.24" } },
    list: { cards: [{ id: "c1", label: "Kasho Visa", brand: "VISA", last4: "4821", status: "active", balance: "12", created_at: "2026-10-05T00:00:00Z" }],
      transactions: [{ id: "t1", reference: "KP-1", kind: "admin_credit", title: "Added by Kasho Pay", category: "Adjustment", method: "Kasho Pay", amount: "25.50", fee: "0", status: "completed", created_at: "2026-10-30T12:00:00Z", meta: { note: "Refund" } }] },
  });
  const out = await withFake(f, () => A.adminHandlers.adminGetUser.run({ userId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }, SUPER));
  assert.equal(out.email, "marie@example.com"); assert.equal(out.balance, 65.24); assert.equal(out.profile.phone, "+50937001234"); assert.equal(out.banned, false);
  assert.deepEqual(out.cards[0], { id: "c1", label: "Kasho Visa", brand: "VISA", last4: "4821", status: "active", balance: 12, createdAt: "2026-10-05T00:00:00Z" });
  assert.equal(out.transactions[0].amount, 25.5); assert.equal(out.transactions[0].note, "Refund");
  const asked = f.calls.filter((c) => c.table === "profiles" && c.method === "select")[0]!.args[0] as string;
  assert.ok(!/id_number|date_of_birth|address|kyc_doc/.test(asked), "no identity documents or ID numbers in the admin view");
  authStub({ getUserById: async () => ({ data: null, error: { message: "not found" } }) });
  await withFake(fakeDb({ one: { admins: SUPER_ROW } }), async () => { await assert.rejects(() => A.adminHandlers.adminGetUser.run({ userId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }, SUPER), { message: "Customer not found." }); });
});

test("adminListTransactions: filters, safe search text, customer names", async () => {
  const f = fakeDb({ one: { admins: SUPER_ROW }, count: 120, list: {
    transactions: [{ id: "t1", reference: "KP-261031-AAAAAA", user_id: "u1", kind: "deposit", title: "Top-up via MonCash", category: "Top-up", method: "MonCash", amount: "10", fee: "0.8", status: "completed", provider_ref: "pay_1", created_at: "2026-10-30T12:00:00Z", meta: { failure_reason: "x" } }],
    profiles: [{ id: "u1", display_name: "Marie Jean", username: "kp1", kasho_id: "KP-001001" }],
  } });
  const out = await withFake(f, () => A.adminHandlers.adminListTransactions.run({ q: "KP-26,1)(", kind: "deposit", status: "completed", userId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11", page: 2, pageSize: 10 }, SUPER));
  assert.equal(out.total, 120); assert.equal(out.items[0].customer, "Marie Jean"); assert.equal(out.items[0].fee, 0.8); assert.equal(out.items[0].note, "x");
  const t = f.calls.filter((c) => c.table === "transactions");
  assert.ok(t.some((c) => c.method === "eq" && c.args[0] === "kind" && c.args[1] === "deposit"));
  assert.ok(t.some((c) => c.method === "eq" && c.args[0] === "status" && c.args[1] === "completed"));
  assert.ok(t.some((c) => c.method === "range" && c.args[0] === 10 && c.args[1] === 19));
  const or = t.find((c) => c.method === "or")!.args[0] as string;
  assert.equal(or, "reference.ilike.%KP-261%,title.ilike.%KP-261%,provider_ref.ilike.%KP-261%", "commas and brackets are stripped from the search text");
  assert.equal(A.adminHandlers.adminListTransactions.schema.safeParse({ kind: "dep;osit" }).success, false);
});

test("adminListAudit and adminListSupport", async () => {
  const f = fakeDb({ one: { admins: SUPER_ROW }, count: 2, list: { admin_audit: [{ id: "a1", admin_email: "admin@kashopay.com", action: "balance_credit", target_user: "u1", details: { amount: 25.5 }, ip: "1.1.1.1", created_at: "2026-10-30T12:00:00Z" }],
    profiles: [{ id: "u1", display_name: "Marie Jean", username: "kp1", kasho_id: "KP-001001" }],
    disputes: [{ id: "d1", user_id: "u1", transaction_ref: "KP-1", title: "x", amount: "5", reason: "Not me", note: "", reference: "DP-1", created_at: "2026-10-30T12:00:00Z" }],
    support_messages: [{ id: "m1", user_id: "u1", email: "marie@example.com", message: "Help", created_at: "2026-10-30T12:00:00Z" }] } });
  const au = await withFake(f, () => A.adminHandlers.adminListAudit.run({ page: 1, pageSize: 50 }, SUPER));
  assert.equal(au.total, 2); assert.equal(au.items[0].target, "Marie Jean"); assert.equal(au.items[0].action, "balance_credit");
  const su = await withFake(f, () => A.adminHandlers.adminListSupport.run({}, SUPER));
  assert.equal(su.disputes[0].amount, 5); assert.equal(su.disputes[0].customer, "Marie Jean"); assert.equal(su.messages[0].message, "Help");
  const missing = fakeDb({ one: { admins: SUPER_ROW }, error: { admin_audit: { code: "42P01", message: 'relation "public.admin_audit" does not exist' } } });
  await withFake(missing, async () => { await assert.rejects(() => A.adminHandlers.adminListAudit.run({ page: 1, pageSize: 50 }, SUPER), (e: any) => /admin_panel\.sql/.test(e.message)); });
});

test("fee schedule edits by an admin are logged in the audit trail", async () => {
  const f = fakeDb({ one: { admins: { user_id: "admin-1", role: "admin" }, fee_rules: { id: "r1", operation: "card_fund", label: "", fee_type: "flat", min_amount: null, max_amount: null, fee_value: "2.3", active: true } }, list: { fee_rules: [] } });
  await withFake(f, () => A.adminHandlers.adminSaveFee.run({ operation: "card_fund", label: "", feeType: "flat", minAmount: null, maxAmount: null, feeValue: 2.3, active: true }, SUPER));
  assert.equal(inserts(f, "admin_audit")[0].action, "fee_rule_saved");
  assert.equal(inserts(f, "activity_log")[0].event, "Fee rule changed");
});

// ------------------------------------------------------------------ SQL
test("migration: admin tables are server-only, the audit log is append-only, money functions are service-role only", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261101000000_admin_panel.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.admins add column if not exists role text not null default 'admin'/);
  assert.match(sql, /grant select, insert on public\.admin_audit to service_role/);
  assert.match(sql, /revoke update, delete, truncate on public\.admin_audit from service_role/);
  for (const t of ["admin_audit", "app_settings", "partner_costs", "card_events"]) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`), t);
    assert.match(sql, new RegExp(`revoke all on public\\.${t} from anon, authenticated`), t);
  }
  for (const fn of ["kasho_admin_adjust\\(uuid, uuid, boolean, numeric, text, text\\)", "kasho_admin_stats\\(timestamptz, timestamptz\\)", "kasho_admin_users\\(text, integer, integer\\)"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated`), fn);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role`), fn);
  }
  assert.match(sql, /if not exists \(select 1 from public\.admins where user_id = p_admin and role = 'super'\) then raise exception 'NOT_ALLOWED'/);
  assert.match(sql, /if p_admin = p_user then raise exception 'SELF_ADJUST'/);
  assert.match(sql, /select balance into v_before from public\.wallets where user_id = p_user for update/);
  assert.match(sql, /if not p_credit and v_before < v_amount then raise exception 'INSUFFICIENT_FUNDS'/);
  assert.equal((sql.match(/security definer set search_path/g) ?? []).length, 3);
});
