// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env["SUPABASE_URL"] ??= "http://localhost:1"; // ledger.ts / routes.ts build a client at import time; nothing is called
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-key";
const L: any = await import("../src/ledger.js");
const { FredaError, freda } = await import("../src/freda.js");
const { DiditError } = await import("../src/didit.js");
const { adminMfaOk, ADMIN_MFA_MESSAGE, idempotencyKey, sameTransfer } = await import("../src/routes.js");
const { enforceMfaAll, mfaBlocked, mfaEndpointRequired, MFA_REQUIRED_ERROR, MFA_ENDPOINTS, STEP_UP } = await import("../src/stepup.js");

const UNAVAILABLE = "This service is temporarily unavailable. Please try again later.";
const quiet = <T>(fn: () => T): T => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

test("admin needs a verified TOTP factor and an aal2 session", () => {
  assert.equal(adminMfaOk({ mfa: true, aal: "aal2" }), true);
  assert.equal(adminMfaOk({ mfa: true, aal: "aal1" }), false);
  assert.equal(adminMfaOk({ mfa: false, aal: "aal2" }), false);
  assert.equal(adminMfaOk({}), false);
  assert.equal(ADMIN_MFA_MESSAGE, "Turn on two-factor authentication to manage fees.");
});

test("MFA is enforced by default and gives one consistent MFA_REQUIRED error", () => {
  assert.equal(enforceMfaAll(undefined), true);
  assert.equal(enforceMfaAll(""), true);
  assert.equal(enforceMfaAll("true"), true);
  assert.equal(enforceMfaAll("false"), false);
  assert.equal(enforceMfaAll(" FALSE "), false);
  assert.equal(mfaEndpointRequired("sendMoney", enforceMfaAll(undefined)), true);
  assert.equal(mfaBlocked(true, "aal1"), true);
  assert.equal(mfaBlocked(true, "aal2"), false);
  assert.equal(mfaBlocked(false, "aal1"), false, "users without 2FA are unaffected");
  assert.equal(MFA_REQUIRED_ERROR.error.code, "MFA_REQUIRED");
  assert.ok(MFA_ENDPOINTS.has("getIdentity"));
});

test("getIdentity requires the password step-up", () => {
  assert.deepEqual(STEP_UP["getIdentity"], { field: "confirmPassword", strip: true });
});

test("freda errors: no raw messages for users", () => {
  const raw = "internal: merchant mpc_123 wallet 0x9 has a problem";
  const u = (status: number, code: string, msg = raw) => quiet(() => L.toUserError(new FredaError(status, code, msg)).message);
  assert.equal(u(400, "SOMETHING_NEW"), "We could not complete this request. Please try again or contact support.");
  assert.equal(u(502, "SOMETHING_NEW"), UNAVAILABLE);
  assert.equal(u(400, "INVALID_AMOUNT", "amount doit être un nombre positif."), "Enter a valid amount.");
  assert.equal(u(400, "INVALID_BRAND"), "That card type is not available. Choose another one.");
  assert.equal(u(400, "constructor"), "We could not complete this request. Please try again or contact support.");
  for (const m of [u(400, "X"), u(400, "INVALID_AMOUNT"), u(500, "Y")]) assert.ok(!m.includes("mpc_123"));
});

test("insufficient funds shortcut: payer case only, never platform or card balances", () => {
  const payer = "The balance on your mobile money account is too low for this payment. Add funds and try again.";
  const u = (status: number, code: string, msg: string) => quiet(() => L.toUserError(new FredaError(status, code, msg)).message);
  assert.equal(u(400, "INSUFFICIENT_FUNDS", "payer has insufficient funds"), payer);
  assert.equal(u(400, "PROVIDER_ERROR", "Insufficient funds in customer wallet"), payer);
  assert.equal(u(402, "INSUFFICIENT_BALANCE", "Insufficient balance on master wallet"), UNAVAILABLE);
  assert.equal(u(400, "BELOW_MINIMUM_BALANCE", "insufficient balance"), UNAVAILABLE);
  assert.equal(u(400, "INSUFFICIENT_CARD_BALANCE", "insufficient card balance"), "That is more than the card balance.");
  assert.equal(u(500, "PROVIDER_ERROR", "insufficient funds"), "The payment network did not respond. Please try again in a moment.");
  assert.equal(u(400, "OTHER", "insufficient stuff"), "We could not complete this request. Please try again or contact support.");
});

test("didit errors are generic for users", () => {
  const m = quiet(() => L.toUserError(new DiditError(400, "Workflow wf_123 not found for app abc")).message);
  assert.equal(m, "Identity verification is unavailable right now. Please try again later.");
});

test("underpaid deposits: detection and metadata", () => {
  assert.equal(L.isUnderpaid(1000, 1310), true);
  assert.equal(L.isUnderpaid(1310, 1310), false);
  assert.equal(L.isUnderpaid(1310.0004, 1310), false);
  assert.equal(L.isUnderpaid(2000, 1310), false);
  assert.equal(L.isUnderpaid("1000", 1310), false);
  assert.equal(L.isUnderpaid(1000, 0), false);
  assert.deepEqual(L.underpaidMeta(1000, 1310), { underpaid: true, paid_htg: 1000, expected_htg: 1310, needs_refund: true });
});

// A tiny fake of the supabase client used by settleTransaction.
function fakeDb(tables: Record<string, any>) {
  const calls: { rpc: [string, any][]; updates: [string, any][] } = { rpc: [], updates: [] };
  const q = (table: string) => {
    const api: any = {
      select: () => api, eq: () => api, not: () => api, order: () => api, limit: () => api, neq: () => api,
      maybeSingle: async () => ({ data: tables[table] ?? null }),
      then: (res: any) => res({ data: tables[table] ? [].concat(tables[table]) : [] }),
      update: (patch: any) => { calls.updates.push([table, patch]); return { eq: async () => ({ error: null }) }; },
      insert: async () => ({ error: null }),
    };
    return api;
  };
  return { calls, from: q, rpc: async (name: string, args: any) => { calls.rpc.push([name, args]); return { data: true, error: null }; } };
}
const withFake = async (fake: any, fn: () => Promise<void>) => {
  const saved = { from: L.db.from, rpc: L.db.rpc, fund: freda.fundCard, create: freda.createCard, get: freda.getCard };
  L.db.from = fake.from; L.db.rpc = fake.rpc;
  try { await fn(); } finally { L.db.from = saved.from; L.db.rpc = saved.rpc; freda.fundCard = saved.fund; freda.createCard = saved.create; freda.getCard = saved.get; }
};
const fundTx = (over: any = {}) => ({ id: "t1", user_id: "u1", kind: "card_fund", status: "pending", card_id: "c1", reference: "KP-1", amount: -20, fee: 2.3,
  created_at: new Date(Date.now() - 3600_000).toISOString(), meta: { needs_review: true }, ...over });

test("card_fund needs_review: replay with the same reference completes the tx and updates the balance", async () => {
  const fake = fakeDb({ cards: { id: "c1", freda_card_id: "card_9", balance: 5, label: "L" }, notifications: null });
  let args: any[] = [];
  freda.fundCard = (async (...a: any[]) => { args = a; return { idempotent_replay: true, balance: 25 }; }) as any;
  await withFake(fake, async () => {
    assert.equal(await L.settleTransaction(fundTx()), "completed");
    assert.deepEqual(args, ["card_9", 20, "KP-1"]);
    assert.ok(fake.calls.rpc.some(([n]) => n === "kasho_complete_tx"));
    assert.ok(fake.calls.updates.some(([t, p]) => t === "cards" && p.balance === 25));
  });
});

test("card_fund needs_review: non-ambiguous error fails (refunds), ambiguous stays pending, >24h is left alone", async () => {
  const card = { id: "c1", freda_card_id: "card_9", balance: 5, label: "L" };
  await withFake(fakeDb({ cards: card }), async () => {
    freda.fundCard = (async () => { throw new FredaError(409, "CARD_FROZEN", "frozen"); }) as any;
    assert.equal(await L.settleTransaction(fundTx()), "failed");
  });
  const f2 = fakeDb({ cards: card });
  await withFake(f2, async () => {
    freda.fundCard = (async () => { throw new FredaError(502, "NETWORK", "x"); }) as any;
    assert.equal(await L.settleTransaction(fundTx()), "pending");
    assert.equal(f2.calls.rpc.length, 0);
  });
  const f3 = fakeDb({ cards: card });
  await withFake(f3, async () => {
    let called = false;
    freda.fundCard = (async () => { called = true; return {}; }) as any;
    const old = fundTx({ created_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    assert.equal(await quiet(() => L.settleTransaction(old)), "pending");
    assert.equal(called, false);
    assert.equal(f3.calls.rpc.length, 0);
  });
});

test("card_creation without freda_card_id: replay createCard with the same reference", async () => {
  const tx = { id: "t2", user_id: "u1", kind: "card_creation", status: "pending", card_id: "c1", reference: "KP-2", amount: -25, fee: 10,
    created_at: new Date(Date.now() - 600_000).toISOString(), meta: { holder_id: "mpc_1" } };
  const card = { id: "c1", user_id: "u1", reference: "kasho_card_c1", brand: "VISA", status: "pending", label: "L", creation_tx_id: "t2" };
  let sent: any;
  await withFake(fakeDb({ cards: card, transactions: { ...tx, status: "pending" } }), async () => {
    freda.createCard = (async (b: any) => { sent = b; return { id: "card_new", status: "pending" }; }) as any;
    freda.getCard = (async () => ({ status: "pending" })) as any;
    assert.equal(await L.settleTransaction(tx), "pending");
    assert.deepEqual(sent, { reference: "kasho_card_c1", kind: "individual", brand: "VISA", amount: 25, holder_id: "mpc_1" });
  });
  const f = fakeDb({ cards: card });
  await withFake(f, async () => {
    freda.createCard = (async () => { throw new FredaError(400, "INVALID_BRAND", "bad"); }) as any;
    assert.equal(await quiet(() => L.settleTransaction(tx)), "failed");
    assert.ok(f.calls.updates.some(([t, p]) => t === "cards" && p.status === "failed"));
    assert.ok(f.calls.rpc.some(([n]) => n === "kasho_fail_tx"));
  });
  const f2 = fakeDb({ cards: card });
  await withFake(f2, async () => {
    freda.createCard = (async () => { throw new FredaError(504, "NETWORK", "t"); }) as any;
    assert.equal(await L.settleTransaction(tx), "pending");
    assert.equal(f2.calls.rpc.length, 0);
  });
});

test("sendMoney idempotency key format and replay matching", () => {
  for (const ok of ["abcdefgh", "a1_B2-c3d4", "x".repeat(64)]) assert.equal(idempotencyKey.safeParse(ok).success, true, ok);
  for (const bad of ["short", "x".repeat(65), "has space 123", "semi;colon1", "emoji😀12345", ""]) assert.equal(idempotencyKey.safeParse(bad).success, false, bad);
  assert.equal(sameTransfer({ amount: "-12.50", counterparty_id: "b" }, "b", 12.5), true);
  assert.equal(sameTransfer({ amount: -12.5, counterparty_id: "b" }, "c", 12.5), false);
  assert.equal(sameTransfer({ amount: -12.5, counterparty_id: "b" }, "b", 13), false);
});

test("migration: idempotent kasho_transfer, legacy kyc policies dropped, service_role only", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261021020000_remaining_fixes.sql", import.meta.url), "utf8");
  assert.match(sql, /add column if not exists idempotency_key text/);
  assert.match(sql, /create unique index if not exists \S+\s+on public\.transactions \(user_id, idempotency_key\) where idempotency_key is not null/);
  assert.match(sql, /drop function if exists public\.kasho_transfer\(uuid, uuid, numeric, text, numeric, numeric\)/);
  assert.match(sql, /raise exception 'DAILY_LIMIT'/);
  assert.match(sql, /security definer set search_path = public, pg_temp/);
  assert.match(sql, /revoke all on function public\.kasho_transfer\(uuid, uuid, numeric, text, numeric, numeric, text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.kasho_transfer\(uuid, uuid, numeric, text, numeric, numeric, text\) to service_role/);
  assert.match(sql, /drop policy if exists "kyc_upload_own_folder" on storage\.objects/);
  assert.match(sql, /drop policy if exists "kyc_read_own_folder" on storage\.objects/);
});

test("card_fund without a flag (server crashed after the debit): replayed only after 3 minutes", async () => {
  const card = { id: "c1", freda_card_id: "card_9", balance: 5, label: "L" };
  const fresh = fundTx({ meta: {}, created_at: new Date(Date.now() - 60_000).toISOString() });
  const f1 = fakeDb({ cards: card });
  await withFake(f1, async () => {
    let called = false;
    freda.fundCard = (async () => { called = true; return {}; }) as any;
    assert.equal(await L.settleTransaction(fresh), "pending");
    assert.equal(called, false, "the original request may still be running");
  });
  const f2 = fakeDb({ cards: card, notifications: null });
  await withFake(f2, async () => {
    let args: any[] = [];
    freda.fundCard = (async (...a: any[]) => { args = a; return { balance: 25 }; }) as any;
    const crashed = fundTx({ meta: {}, created_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    assert.equal(await L.settleTransaction(crashed), "completed");
    assert.deepEqual(args, ["card_9", 20, "KP-1"]);
  });
});
