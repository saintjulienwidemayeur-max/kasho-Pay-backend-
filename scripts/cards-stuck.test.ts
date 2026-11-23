// Run: npm test
// A new card must never stay "in creation" for ever without a word. Whatever Freda answers (or does not answer), it ends active, or
// failed with the money back, or it is flagged for review and the customer is told what is going on (for example that the holder has
// to complete an identity verification: "Le titulaire doit d'abord compléter sa vérification d'identité").
// These tests run the real code (createCardFn, the webhook handler, the periodic sync) on an in-memory database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env["SUPABASE_URL"] ??= "http://localhost:1";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-key";
process.env["FREDA_API_KEY"] = "sk_test_unit";
process.env["DATA_ENCRYPTION_KEY"] ??= "11".repeat(32); // holders keep the ID number encrypted
const L: any = await import("../src/ledger.js");
const { freda, FredaError } = await import("../src/freda.js");
const { handlers } = await import("../src/routes.js");
const V = await import("../src/verification.js");
const H: any = await import("../src/holders.js");

const quiet = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  const e = console.error, l = console.log; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
};

// ------------------------------------------------------------------ a small in-memory database (the parts of supabase-js the code uses)
type Row = Record<string, any>;
const uuid = () => crypto.randomUUID();
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function memDb(seed: Record<string, Row[]> = {}, hooks: { failUpdate?: (table: string, patch: any) => string | null } = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const table = (n: string) => (tables[n] ??= []);
  let counter = 0;

  const from = (name: string) => {
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: any;
    const filters: ((r: Row) => boolean)[] = [];
    const orders: [string, boolean][] = [];
    let limit: number | null = null;
    let mode: "all" | "one" | "maybe" = "all";

    const run = (): { data: any; error: any } => {
      const matching = () => table(name).filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: uuid(), created_at: iso(), updated_at: iso(), ...p }));
        for (const r of list) {
          if (name === "cards" && table("cards").some((x) => x.reference === r.reference)) return { data: null, error: { code: "23505", message: "duplicate reference" } };
          if (name === "cards" && r.freda_card_id && table("cards").some((x) => x.freda_card_id === r.freda_card_id)) return { data: null, error: { code: "23505", message: "duplicate freda_card_id" } };
        }
        table(name).push(...list);
        return { data: list.map((r) => ({ ...r })), error: null };
      }
      if (op === "upsert") {
        const k = payload.key !== undefined ? "key" : "id";
        const hit = table(name).find((r) => r[k] === payload[k]);
        if (hit) Object.assign(hit, payload); else table(name).push({ id: uuid(), created_at: iso(), updated_at: iso(), ...payload });
        return { data: null, error: null };
      }
      if (op === "update") {
        const fail = hooks.failUpdate?.(name, payload);
        if (fail) return { data: null, error: { message: fail } };
        const hit = matching();
        for (const r of hit) Object.assign(r, payload, { updated_at: iso() });
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === "delete") {
        const hit = matching();
        tables[name] = table(name).filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      let out = matching().map((r) => ({ ...r }));
      for (const [c, asc] of [...orders].reverse()) out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    const finish = () => {
      const r = run();
      if (r.error || mode === "all") return r;
      const rows = (r.data ?? []) as Row[];
      if (mode === "maybe") return { data: rows[0] ?? null, error: null };
      return rows.length === 1 || (op !== "select" && rows.length >= 1) ? { data: rows[0], error: null } : { data: null, error: { message: `expected one row, got ${rows.length}` } };
    };

    const api: any = {
      select: () => api,
      insert: (p: any) => { op = "insert"; payload = p; return api; },
      update: (p: any) => { op = "update"; payload = p; return api; },
      upsert: (p: any) => { op = "upsert"; payload = p; return api; },
      delete: () => { op = "delete"; return api; },
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return api; },
      neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return api; },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return api; },
      lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return api; },
      gt: (c: string, v: any) => { filters.push((r) => r[c] > v); return api; },
      not: (c: string, o: string, v: any) => { if (o === "is" && v === null) filters.push((r) => r[c] !== null && r[c] !== undefined); return api; },
      order: (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return api; },
      limit: (n: number) => { limit = n; return api; },
      maybeSingle: async () => { mode = "maybe"; return finish(); },
      single: async () => { mode = "one"; return finish(); },
      then: (res: any, rej: any) => Promise.resolve(finish()).then(res, rej),
    };
    return api;
  };

  const rpc = async (name: string, a: any) => {
    const tx = (id: string) => table("transactions").find((x) => x.id === id);
    const wallet = (u: string) => table("wallets").find((x) => x.user_id === u);
    if (name === "kasho_debit") {
      const w = wallet(a.p_user);
      const total = Number(a.p_amount) + Number(a.p_fee ?? 0);
      if (!w || Number(w.balance) < total) return { data: null, error: { message: "INSUFFICIENT_FUNDS" } };
      w.balance = Math.round((Number(w.balance) - total) * 100) / 100;
      const row = { id: uuid(), reference: `KP-${++counter}`, user_id: a.p_user, kind: a.p_kind, title: a.p_title, category: a.p_category, method: a.p_method, amount: -Number(a.p_amount), fee: Number(a.p_fee ?? 0), status: a.p_status ?? "pending", card_id: a.p_card ?? null, provider: a.p_provider, meta: a.p_meta ?? {}, created_at: iso(), updated_at: iso() };
      table("transactions").push(row);
      return { data: row.id, error: null };
    }
    if (name === "kasho_complete_tx") {
      const t = tx(a.p_tx);
      if (!t || t.status !== "pending") return { data: false, error: null };
      t.status = "completed";
      if (t.amount > 0) wallet(t.user_id)!.balance += t.amount - t.fee;
      return { data: true, error: null };
    }
    if (name === "kasho_fail_tx") {
      const t = tx(a.p_tx);
      if (!t || t.status !== "pending") return { data: false, error: null };
      t.status = "failed";
      t.meta = { ...t.meta, failure_reason: a.p_reason };
      if (t.amount < 0) { const w = wallet(t.user_id)!; w.balance = Math.round((w.balance + -t.amount + t.fee) * 100) / 100; }
      return { data: true, error: null };
    }
    return { data: null, error: { message: `rpc ${name} is not faked` } };
  };
  return { tables, table, from, rpc };
}
type Mem = ReturnType<typeof memDb>;

// ------------------------------------------------------------------ the world: one verified customer with 100 USD and an enrolled holder
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const CTX = { userId: USER, email: "marie@example.com", ip: null, ua: null };
const holderRow = (o: Row = {}) => ({
  id: "h1", user_id: USER, freda_holder_id: "mpc_1", mode: "sandbox", email: "marie@example.com", first_name: "Marie", last_name: "Jean", dob: "1990-05-12", country: "HT",
  id_number: "ABC12345", phone_code: "+509", phone_number: "37001234", address_street: "12 Rue A", address_city: "Port-au-Prince", address_state: "Ouest",
  address_postal_code: "HT6110", status: "enrolled", identity_sent: true, created_at: iso(86_400_000),
  verification_status: "verified", program_enrolled_at: iso(86_400_000), last_attempt_at: iso(86_400_000), checked_at: iso(86_400_000), ...o,
});
function world(extra: Record<string, Row[]> = {}, hooks: Parameters<typeof memDb>[1] = {}): Mem {
  return memDb({
    profiles: [{ id: USER, kyc_status: "verified", first_name: "Marie", last_name: "Jean", date_of_birth: "1990-05-12", country: "HT", id_number: "ABC12345", phone_code: "+509", phone_number: "37001234",
      address_street: "12 Rue A", address_city: "Port-au-Prince", address_state: "Ouest", address_postal_code: "HT6110" }],
    wallets: [{ user_id: USER, balance: 100 }, { user_id: OTHER, balance: 50 }],
    fee_rules: [{ id: "f1", operation: "card_creation", label: "", fee_type: "flat", min_amount: null, max_amount: null, fee_value: 3, active: true }],
    card_holders: [holderRow()],
    ...extra,
  }, hooks);
}

const saved = { from: L.db.from, rpc: L.db.rpc, createCard: freda.createCard, getCard: freda.getCard, getHolder: freda.getHolder, createHolder: freda.createHolder, listHolders: freda.listHolders, restartHolderVerification: freda.restartHolderVerification };
async function inWorld<T>(db: Mem, fn: () => Promise<T>): Promise<T> {
  L.db.from = db.from; L.db.rpc = db.rpc;
  freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
  freda.restartHolderVerification = (async () => ({ restarted: true })) as any;
  try { return await quiet(fn); } finally {
    L.db.from = saved.from; L.db.rpc = saved.rpc;
    Object.assign(freda, { createCard: saved.createCard, getCard: saved.getCard, getHolder: saved.getHolder, createHolder: saved.createHolder, listHolders: saved.listHolders, restartHolderVerification: saved.restartHolderVerification });
  }
}
const fredaErr = (status: number, code: string, message: string, endpoint = "POST /v1/cards") => { const e = new FredaError(status, code, message); e.endpoint = endpoint; return e; };
const balance = (db: Mem, u = USER) => db.table("wallets").find((w) => w.user_id === u)!.balance;
const notifications = (db: Mem) => db.table("notifications").map((n) => `${n.title}`);
const NEW_CARD = { label: "My card", color: "mint", brand: "VISA", amountUsd: 5 } as const; // 5 + 3 fee = 8 USD
const later = () => new Promise((r) => setTimeout(r, 60)); // the Freda part of createCardFn runs after the answer
const createCard = () => (handlers as any).createCardFn.run({ ...NEW_CARD }, CTX);
/** A card that was asked for `ageMs` ago and is still pending (with or without the id Freda gave it). */
function pendingCard(ageMs: number, o: { fredaId?: string | null; txMeta?: Row } = {}) {
  const cardId = uuid(), txId = uuid();
  const created = iso(ageMs);
  return {
    cards: [{ id: cardId, user_id: USER, freda_card_id: o.fredaId === undefined ? "card_1" : o.fredaId, reference: `kasho_card_${cardId}`, label: "My card", color: "mint", brand: "VISA", status: "pending", last4: null, expiry: null, balance: 0, creation_tx_id: txId, created_at: created, updated_at: created }],
    transactions: [{ id: txId, reference: `KP-${txId.slice(0, 6)}`, user_id: USER, kind: "card_creation", title: "New card: My card", category: "Card", method: "Wallet", amount: -5, fee: 3, status: "pending", card_id: cardId, provider: "freda", meta: { holder_id: "mpc_1", ...(o.txMeta ?? {}) }, created_at: created, updated_at: created }],
    cardId, txId,
  };
}
const cardOf = (db: Mem, id?: string) => (id ? db.table("cards").find((c) => c.id === id)! : db.table("cards")[0]!);
const txOf = (db: Mem, id: string) => db.table("transactions").find((t) => t.id === id)!;

// ------------------------------------------------------------------ 1. what Freda can answer when the card is requested
test("Freda answers CARD_SERVICE_ERROR to POST /v1/cards: documented as 'nothing debited', so the money goes back at once (no card left in creation)", async () => {
  const db = world();
  await inWorld(db, async () => {
    freda.createCard = (async () => { throw fredaErr(502, "CARD_SERVICE_ERROR", "service de cartes indisponible"); }) as any;
    const out = await createCard();
    assert.ok(out.cardId, "the answer is immediate: the app waits for the card");
    await later();
  });
  assert.equal(cardOf(db).status, "failed");
  assert.equal(db.table("transactions")[0]!.status, "failed");
  assert.equal(balance(db), 100, "the 5 USD + 3 USD fee are back");
  assert.equal(db.table("transactions")[0]!.meta.card_problem.code, "CARD_SERVICE_ERROR", "Freda's reason is kept for support");
});

test("an unknown outcome (network cut) keeps the card pending, WITHOUT an error for the customer, and the periodic pass settles it with the SAME reference", async () => {
  const db = world();
  let first = "";
  await inWorld(db, async () => {
    freda.createCard = (async (b: any) => { first = b.reference; throw fredaErr(502, "NETWORK", "Could not reach the payment provider."); }) as any;
    const out = await createCard();
    assert.ok(out.cardId, "the request is accepted: the customer must not retry (that would charge twice)");
    await later();
  });
  assert.equal(cardOf(db).status, "pending");
  assert.equal(balance(db), 92, "charged once");
  assert.equal(db.table("transactions")[0]!.meta.card_problem.code, "NETWORK");

  // two minutes later Freda answers: the card is asked for again with the same reference and then read until it is active
  db.table("cards")[0]!.created_at = iso(120_000);
  db.table("transactions")[0]!.created_at = iso(120_000);
  const asked: string[] = [];
  await inWorld(db, async () => {
    freda.createCard = (async (b: any) => { asked.push(b.reference); return { id: "card_1", reference: b.reference, status: "pending" }; }) as any;
    freda.getCard = (async () => ({ id: "card_1", status: "active", masked_pan: "5399**8499" })) as any;
    await L.settlePendingCards(0);
  });
  assert.deepEqual(asked, [first], "one replay, same reference: never a second card");
  const card = cardOf(db);
  assert.deepEqual([card.status, card.freda_card_id, card.last4], ["active", "card_1", "8499"]);
  assert.equal(db.table("transactions")[0]!.status, "completed");
  assert.equal(balance(db), 92);
  assert.deepEqual(notifications(db), ["Card ready"]);
});

test("a rejection of POST /v1/cards (HOLDER_NOT_ENROLLED: the holder must complete the identity verification) refunds and says so to the customer", async () => {
  const db = world();
  let message = "";
  await inWorld(db, async () => {
    freda.createCard = (async () => { throw fredaErr(409, "HOLDER_NOT_ENROLLED", "Le titulaire doit d'abord compléter sa vérification d'identité."); }) as any;
    try { await createCard(); await later(); } catch (e: any) { message = L.toUserError(e).message; }
    message = message || L.toUserError(fredaErr(409, "HOLDER_NOT_ENROLLED", "Le titulaire doit d'abord compléter sa vérification d'identité.")).message;
  });
  assert.equal(message, L.IDENTITY_VERIFICATION_MESSAGE);
  assert.deepEqual(notifications(db), ["Card creation failed"]);
  assert.equal(db.table("card_holders")[0]!.verification_status, "pending", "the card page shows 'being verified' again");
  assert.equal(cardOf(db).status, "failed");
  assert.equal(balance(db), 100);
});

test("a holder that the issuer is still verifying: nothing is charged, no card is asked for, the customer is told to wait", async () => {
  const db = world({ card_holders: [holderRow({ verification_status: "pending" })] });
  let message = "";
  await inWorld(db, async () => {
    freda.getHolder = (async () => ({ holder: { status: "enrolled", verification: { ready_for_cards: false } } })) as any;
    freda.createHolder = (async () => { throw new Error("no second holder must be created"); }) as any;
    freda.createCard = (async () => { throw new Error("no card must be requested"); }) as any;
    try { await createCard(); } catch (e: any) { message = e.message; }
  });
  assert.equal(message, H.HOLDER_PENDING_MESSAGE);
  assert.equal(balance(db), 100, "nothing charged");
  assert.equal(db.table("cards").length, 0);
  assert.equal(db.table("card_holders")[0]!.verification_status, "pending");
});

test("the card exists at Freda but recording its id here fails: the customer is NOT refunded (the periodic pass finishes the job)", async () => {
  const db = world({}, { failUpdate: (t, p) => (t === "cards" && "freda_card_id" in p ? "boom" : null) });
  await inWorld(db, async () => {
    freda.createCard = (async (b: any) => ({ id: "card_1", reference: b.reference, status: "pending" })) as any;
    const out = await createCard();
    assert.ok(out.cardId);
  });
  assert.equal(cardOf(db).status, "pending");
  assert.equal(db.table("transactions")[0]!.status, "pending");
  assert.equal(balance(db), 92);
});

// ------------------------------------------------------------------ 2. the card is pending: what the periodic pass and the webhooks do
test("the identity verification link: a card Freda reports as failed is refunded, the customer is told and the app can show the link", async () => {
  const w = pendingCard(120_000);
  const db = world({ cards: w.cards, transactions: w.transactions });
  const link = "https://verify.example.com/s/abc";
  await inWorld(db, async () => {
    freda.getCard = (async () => ({ id: "card_1", status: "failed", failure_reason: "Le titulaire doit d'abord compléter sa vérification d'identité.", verification_link: link, verification_link_expires_at: new Date(Date.now() + 3_600_000).toISOString() })) as any;
    await L.settlePendingCards(0);
    assert.equal(cardOf(db).status, "failed");
    assert.equal(txOf(db, w.txId).status, "failed");
    assert.equal(balance(db), 108, "the money is back");
    assert.deepEqual(notifications(db), ["Identity verification needed"]);
    const out: any = await (handlers as any).cardVerificationFn.run({}, CTX);
    assert.deepEqual([out.state, out.link, out.cardStatus], ["link", link, "failed"]);
  });
});

test("a card that waits for the identity verification stays pending, the link reaches the customer once, and nothing is refunded while Freda says pending", async () => {
  const w = pendingCard(120_000);
  const db = world({ cards: w.cards, transactions: w.transactions });
  const link = "https://verify.example.com/s/xyz";
  await inWorld(db, async () => {
    freda.getCard = (async () => ({ id: "card_1", status: "pending", failure_reason: "Le titulaire doit d'abord compléter sa vérification d'identité.", verification_link: link })) as any;
    await L.settlePendingCards(0);
    await L.settlePendingCards(0);
    assert.equal(cardOf(db).status, "pending");
    assert.equal(txOf(db, w.txId).status, "pending");
    assert.equal(balance(db), 100, "this test world did not debit: nothing is given back either");
    assert.deepEqual(notifications(db), ["Identity verification needed"], "told once, not at every pass");
    const out: any = await (handlers as any).cardVerificationFn.run({}, CTX);
    assert.deepEqual([out.state, out.link, out.cardStatus], ["link", link, "pending"]);
    assert.equal(txOf(db, w.txId).meta.card_freda_status, "pending");
  });
});

test("a pending card whose reason names the identity verification but gives no link: the app is told to wait / contact support", async () => {
  const w = pendingCard(120_000);
  const db = world({ cards: w.cards, transactions: w.transactions });
  await inWorld(db, async () => {
    freda.getCard = (async () => ({ id: "card_1", status: "pending", failure_reason: "Le titulaire doit d'abord compléter sa vérification d'identité." })) as any;
    await L.settlePendingCards(0);
    const out: any = await (handlers as any).cardVerificationFn.run({}, CTX);
    assert.deepEqual([out.state, out.link, out.cardId], ["waiting", null, w.cardId]);
  });
});

test("cardVerificationFn: only the customer's own cards, only a valid https link", async () => {
  const mine = pendingCard(60_000, { txMeta: { verification_link: "https://verify.example.com/old", verification_link_expires_at: iso(1000) } }); // expired
  const other = pendingCard(60_000, { txMeta: { verification_link: "https://verify.example.com/theirs" } });
  other.transactions[0]!.user_id = OTHER;
  const insecure = pendingCard(30_000, { txMeta: { verification_link: "http://verify.example.com/plain" } });
  const db = world({ cards: [...mine.cards, ...other.cards, ...insecure.cards], transactions: [...mine.transactions, ...other.transactions, ...insecure.transactions] });
  await inWorld(db, async () => {
    const out: any = await (handlers as any).cardVerificationFn.run({}, CTX);
    assert.equal(out.state, null);
    assert.equal(out.link, null);
  });
});

test("card events are matched by the Freda card id, else by OUR reference (the event can arrive before the id was saved); an unknown card is said in the log", async () => {
  const w = pendingCard(5_000, { fredaId: null });
  const db = world({ cards: w.cards, transactions: w.transactions });
  const reference = w.cards[0]!.reference;
  await inWorld(db, async () => {
    await L.handleCardEvent("card.created", { id: "card_77", reference, status: "active" });
  });
  const card = cardOf(db);
  assert.deepEqual([card.status, card.freda_card_id], ["active", "card_77"], "found by reference, and its id is remembered");
  assert.equal(txOf(db, w.txId).status, "completed");

  const lines: string[] = [];
  const e = console.error; console.error = (...a: any[]) => { lines.push(a.join(" ")); };
  try { await L.handleCardEvent("card.failed", { id: "card_nope", reference: "kasho_card_nope" }); } finally { console.error = e; }
  assert.match(lines.join("\n"), /card event for a card we do not know: card\.failed card_nope kasho_card_nope/);
});

test("a late card.created never brings back a card that failed (its money is already back in the wallet)", async () => {
  const w = pendingCard(60_000);
  const db = world({ cards: w.cards, transactions: w.transactions });
  await inWorld(db, async () => {
    await L.handleCardEvent("card.failed", { id: "card_1", failure_reason: "image illisible" });
    await L.handleCardEvent("card.created", { id: "card_1", status: "active" });
  });
  assert.equal(cardOf(db).status, "failed");
  assert.equal(txOf(db, w.txId).status, "failed");
});

test("a new card is not starved by older deposits waiting in the same table (it has its own pass)", async () => {
  const w = pendingCard(120_000);
  const deposits = Array.from({ length: 40 }, (_, i) => ({ id: uuid(), reference: `KP-DEP-${i}`, user_id: OTHER, kind: "deposit", status: "pending", amount: 10, fee: 1, meta: {}, created_at: iso(7_200_000 + i * 1000) }));
  const db = world({ cards: w.cards, transactions: [...deposits, ...w.transactions] });
  await inWorld(db, async () => {
    freda.getCard = (async () => ({ id: "card_1", status: "active", masked_pan: "5399**1234" })) as any;
    await L.settlePendingCards(0);
  });
  assert.equal(cardOf(db).status, "active");
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index, /\.in\("kind", \[[^\]]*"card_creation"/, "card creations are no longer in the shared, oldest-first 25 row query");
  assert.match(index, /await L\.settlePendingCards\(tick\)/);
});

test("still pending after 15 minutes: flagged for review, the customer is told ONCE, the money stays where it is (Freda still says pending)", async () => {
  const w = pendingCard(20 * 60_000);
  const db = world({ cards: w.cards, transactions: w.transactions });
  await inWorld(db, async () => {
    freda.getCard = (async () => ({ id: "card_1", status: "pending" })) as any;
    await L.settlePendingCards(0);
    await L.settlePendingCards(1);
  });
  const t = txOf(db, w.txId);
  assert.equal(t.meta.needs_review, true);
  assert.equal(t.meta.delay_notified, true);
  assert.equal(t.meta.card_freda_status, "pending");
  assert.equal(t.status, "pending");
  assert.equal(cardOf(db).status, "pending");
  assert.deepEqual(notifications(db), ["Your card is taking longer than usual"]);
});

test("Freda does not know the card (404): it is recorded for the administrator, the card is NOT closed and nothing is refunded", async () => {
  const w = pendingCard(20 * 60_000);
  const db = world({ cards: w.cards, transactions: w.transactions });
  await inWorld(db, async () => {
    freda.getCard = (async () => { throw fredaErr(404, "NOT_FOUND", "Card not found", "GET /v1/cards/card_1"); }) as any;
    await L.settlePendingCards(0);
  });
  const t = txOf(db, w.txId);
  assert.equal(t.meta.card_problem.code, "NOT_FOUND");
  assert.equal(t.meta.needs_review, true);
  assert.equal(cardOf(db).status, "pending");
  assert.equal(t.status, "pending");
});

test("a Freda status this code does not know is said once in the log and the card stays pending", async () => {
  const lines: string[] = [];
  const e = console.error; console.error = (...a: any[]) => { lines.push(a.join(" ")); };
  try {
    assert.equal(L.normalizeCardStatus("awaiting_holder_verification"), "pending");
    assert.equal(L.normalizeCardStatus("awaiting_holder_verification"), "pending");
    assert.equal(L.normalizeCardStatus("pending"), "pending");
    assert.equal(L.normalizeCardStatus("ACTIVE"), "active");
  } finally { console.error = e; }
  assert.equal(lines.filter((l) => /unknown Freda card status/.test(l)).length, 1);
});

// ------------------------------------------------------------------ 3. which Freda errors are "unknown outcome" (and so kept pending)
test("FredaError.ambiguous: only the really unknown outcomes are kept pending", () => {
  const e = (status: number, code: string, endpoint: string) => fredaErr(status, code, "x", endpoint).ambiguous;
  assert.equal(e(502, "NETWORK", "POST /v1/cards"), true, "timeout / network cut");
  assert.equal(e(500, "INTERNAL_ERROR", "POST /v1/cards"), true);
  assert.equal(e(502, "PROVIDER_ERROR", "POST /v1/payouts"), true);
  assert.equal(e(503, "NOT_CONFIGURED", "POST /v1/cards"), false, "nothing was sent");
  assert.equal(e(503, "CARD_PROVIDER_AUTH", "POST /v1/cards"), false);
  assert.equal(e(503, "CARD_LIVE_NOT_CONFIGURED", "POST /v1/cards"), false);
  assert.equal(e(502, "CARD_SERVICE_ERROR", "POST /v1/cards"), false, "documented: nothing debited, or refunded at once");
  assert.equal(e(502, "CARD_SERVICE_ERROR", "POST /v1/cards/card_1/fund"), true, "a card top-up with this error stays unknown");
  assert.equal(e(409, "HOLDER_NOT_ENROLLED", "POST /v1/cards"), false);
  assert.equal(e(400, "BELOW_MINIMUM_BALANCE", "POST /v1/cards"), false);
});

// ------------------------------------------------------------------ 4. the verification link, wherever Freda puts it
test("pickVerification finds the link, its expiry and the reason, at any of a few levels, and only keeps a plain https link", () => {
  const p = V.pickVerification({ data: { id: "card_1", failure_reason: "face manquante", verification_link: "https://verify.example.com/s/1", verification_link_expires_at: "2026-11-02T10:00:00Z" } });
  assert.deepEqual(p, { link: "https://verify.example.com/s/1", expiresAt: "2026-11-02T10:00:00Z", reason: "face manquante" });
  assert.equal(V.pickVerification({ holder: { verificationUrl: "https://v.example.com/x" } }).link, "https://v.example.com/x");
  assert.equal(V.pickVerification({ kyc_link: "https://v.example.com/y" }).link, "https://v.example.com/y");
  for (const bad of ["http://v.example.com/x", "javascript:alert(1)", "https://user:pw@v.example.com/x", `https://v.example.com/${"a".repeat(600)}`, "not a url", 42]) {
    assert.equal(V.pickVerification({ verification_link: bad }).link, undefined, String(bad).slice(0, 40));
  }
  assert.deepEqual(V.pickVerification(null), {});
  assert.deepEqual(V.pickVerification("text"), {});
  assert.equal(V.mentionsIdentityVerification("Le titulaire doit d'abord compléter sa vérification d'identité."), true);
  assert.equal(V.mentionsIdentityVerification("The holder must complete the identity verification"), true);
  assert.equal(V.mentionsIdentityVerification("image illisible"), false);
  assert.equal(V.linkStillValid(undefined), true);
  assert.equal(V.linkStillValid("2000-01-01T00:00:00Z"), false);
  assert.equal(V.linkStillValid(new Date(Date.now() + 60_000).toISOString()), true);
});

// ------------------------------------------------------------------ 4. card holders in the new card program
const IDENTITY = { type: "NIN", number: "ABC12345", imageUrl: "data:image/jpeg;base64,AAAA", imageBackUrl: "data:image/jpeg;base64,BBBB", country: "HT" };
async function withDeps<T>(o: { identity?: any; email?: string }, fn: () => Promise<T>): Promise<T> {
  const before = { ...H.deps };
  H.deps.identity = async () => (o.identity === undefined ? IDENTITY : o.identity);
  H.deps.email = async () => o.email ?? "marie@example.com";
  try { return await fn(); } finally { Object.assign(H.deps, before); }
}

test("GET holder can only say 'failed': acceptance by the new program comes by webhook (holder.verified)", () => {
  assert.equal(H.readHolderState({ status: "enrolled" }).state, "pending", "enrolled is NOT accepted by the program");
  assert.equal(H.readHolderState({ status: "pending" }).state, "pending");
  assert.deepEqual(H.readHolderState({ status: "failed", failure_reason: "photo coupée" }), { state: "failed", reason: "photo coupée" });
  assert.equal(H.stateOfRow("verified"), "ready");
  assert.equal(H.stateOfRow("ready"), "pending", "a row an earlier version marked ready without the webhook waits for it");
  assert.equal(H.stateOfRow("failed"), "failed");
  assert.equal(H.rejectedMessage("Photo coupée."), "The card issuer did not accept your ID document: Photo coupée. Try again, or contact support.");
  assert.equal(H.rejectedMessage(null), "The card issuer did not accept your ID document. Try again, or contact support.");
});

test("after the KYC a new customer is registered, then the ID (front AND back) is submitted for verification; the customer is told when the program verified it", async () => {
  const db = world({ card_holders: [] });
  const sent: any[] = [];
  const docs: any[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async (b: any) => { sent.push(b); return { id: "mpc_new", already_existed: false, holder: { id: "mpc_new", status: "enrolled" } }; }) as any;
    freda.restartHolderVerification = (async (b: any) => { docs.push(b); return { id: "mpc_new", restarted: true }; }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    const info = await H.enrollHolder(USER, "kyc");
    assert.deepEqual([info.state, info.holderId], ["pending", "mpc_new"], "enrolled at Freda, but not accepted by the program yet");
    await H.refreshPendingHolders();
    assert.equal(db.table("card_holders")[0]!.verification_status, "docs_sent", "the ID was submitted; polling never makes it ready");
    await H.handleHolderEvent("holder.verified", { id: "mpc_new" });
    assert.equal((await H.holderInfo(USER)).state, "ready");
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].restart_verification, undefined, "the registration itself is a plain creation");
  assert.equal(sent[0].identity.imageBackUrl, IDENTITY.imageBackUrl, "the back of the ID is sent");
  assert.equal(docs.length, 1, "the ID photos are submitted for verification right after (Freda keeps the holder 'à vérifier' otherwise)");
  assert.equal(docs[0].identity.imageBackUrl, IDENTITY.imageBackUrl);
  assert.equal(docs[0].identity.imageUrl, IDENTITY.imageUrl);
  assert.equal(docs[0].email, "marie@example.com");
  assert.deepEqual([sent[0].email, sent[0].phoneShortCode, sent[0].phoneNumber, sent[0].address.postalCode], ["marie@example.com", "+509", "37001234", "HT6110"]);
  const row = db.table("card_holders")[0]!;
  assert.deepEqual([row.freda_holder_id, row.verification_status], ["mpc_new", "verified"]);
  assert.ok(row.program_enrolled_at);
  assert.deepEqual(notifications(db), ["Card profile verified"], "told once, when it became ready");
});

test("a registration whose ID could not be submitted stays 'à vérifier' (submitted) and is tried again after 30 minutes", async () => {
  const db = world({ card_holders: [] });
  let attempts = 0;
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async () => ({ id: "mpc_x", holder: { id: "mpc_x", status: "enrolled" } })) as any;
    freda.restartHolderVerification = (async () => { attempts++; if (attempts === 1) throw fredaErr(502, "CARD_SERVICE_ERROR", "down", "POST /v1/cards/holder-profile"); return { restarted: true }; }) as any;
    const info = await H.enrollHolder(USER, "kyc");
    assert.equal(info.state, "pending");
    assert.equal(db.table("card_holders")[0]!.verification_status, "submitted", "registered, ID not submitted");
    await H.enrollMissingHolders();
    assert.equal(attempts, 1, "not tried again right away");
    db.table("card_holders")[0]!.last_attempt_at = iso(31 * 60_000);
    await H.enrollMissingHolders();
  }));
  assert.equal(attempts, 2);
  assert.equal(db.table("card_holders")[0]!.verification_status, "docs_sent");
});

test("tagged e-mail: same mailbox, stable for a repeated attempt, different for the next holder; the real one is recovered", () => {
  const t1 = H.taggedEmail("marie@example.com", USER, "mpc_1");
  assert.match(t1, /^marie[1-9][0-9]?@example\.com$/, "1 or 2 digits after the name, no + tag");
  assert.equal(H.taggedEmail("marie@example.com", USER, "mpc_1"), t1, "an attempt whose answer was lost is repeated with the same address");
  assert.notEqual(H.taggedEmail("marie@example.com", USER, "mpc_2"), t1, "the next holder of the same customer gets another address");
  assert.notEqual(H.taggedEmail("marie@example.com", USER, "mpc_1", 1), t1, "the next address is tried when one belongs to someone else");
  assert.ok(!t1.includes("+"));
  assert.equal(H.realEmail(t1), t1, "the real e-mail comes from the account, never from the holder");
  assert.equal(H.realEmail("marie@example.com"), "marie@example.com");
  assert.equal(H.holderEmailTagging("false"), false);
  assert.equal(H.holderEmailTagging(undefined), true);
});

test("a customer who only has an old holder (never in the program) gets a NEW holder with a slightly different e-mail, and its ID is submitted", async () => {
  const db = world({ card_holders: [holderRow({ verification_status: null, program_enrolled_at: null, last_attempt_at: null, checked_at: null })] });
  const sent: any[] = [];
  const docsFor: string[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async (b: any) => { sent.push(b); return { id: "mpc_new", already_existed: false, holder: { id: "mpc_new", status: "enrolled" } }; }) as any;
    freda.restartHolderVerification = (async (b: any) => { docsFor.push(b.email); return { restarted: true }; }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    await H.enrollMissingHolders();
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, H.taggedEmail("marie@example.com", USER, "mpc_1"));
  assert.equal(sent[0].identity.imageBackUrl, IDENTITY.imageBackUrl, "with the complete identity, front and back");
  assert.deepEqual(docsFor, [sent[0].email], "the ID is submitted for the NEW holder, with its e-mail");
  const row = db.table("card_holders")[0]!;
  assert.deepEqual([row.freda_holder_id, row.verification_status, row.email], ["mpc_new", "docs_sent", sent[0].email], "the new id and e-mail replace the old ones on the same row");
});

test("Freda answers with the holder that already existed (same e-mail) without verifying it: a holder is made with the tagged e-mail", async () => {
  const db = world({ card_holders: [] });
  const emails: string[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async (b: any) => { emails.push(b.email); return b.email === "marie@example.com" ? { id: "mpc_9", already_existed: true, holder: { id: "mpc_9", status: "enrolled" } } : { id: "mpc_10", already_existed: false, holder: { id: "mpc_10", status: "enrolled" } }; }) as any;
    freda.restartHolderVerification = (async () => { throw new Error("not used"); }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    const info = await H.enrollHolder(USER, "backfill");
    assert.deepEqual([info.state, info.holderId], ["pending", "mpc_10"]);
  }));
  assert.equal(emails[0], "marie@example.com");
  assert.match(emails[1]!, /^marie[1-9][0-9]?@example\.com$/);
});

test("an e-mail already used by a holder (HOLDER_EMAIL_EXISTS): the new holder is made with the tagged e-mail", async () => {
  const db = world({ card_holders: [] });
  const emails: string[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async (b: any) => { emails.push(b.email); if (emails.length === 1) throw fredaErr(409, "HOLDER_EMAIL_EXISTS", "email", "POST /v1/cards/holders"); return { id: "mpc_7", holder: { id: "mpc_7", status: "enrolled" } }; }) as any;
    freda.restartHolderVerification = (async () => { throw new Error("not used"); }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    assert.equal((await H.enrollHolder(USER, "kyc")).holderId, "mpc_7");
  }));
  assert.equal(emails.length, 2);
  assert.match(emails[1]!, /^marie[1-9][0-9]?@example\.com$/);
});

test("with HOLDER_EMAIL_TAG=false (or a retry after a refusal) the verification of the holder it has is restarted instead, with the e-mail that holder has", async () => {
  const tagged = H.taggedEmail("marie@example.com", USER, "mpc_0");
  const db = world({ card_holders: [holderRow({ email: tagged, verification_status: "failed", last_attempt_at: iso(3_600_000), program_enrolled_at: iso(7_200_000) })] });
  const restarted: any[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async () => { throw new Error("no new holder for a retry"); }) as any;
    freda.restartHolderVerification = (async (b: any) => { restarted.push(b); return { id: "mpc_1", restarted: true }; }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    await H.retryHolder(USER);
  }));
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0].email, tagged, "the holder is found by the address it has at Freda");
});

test("no holder is sent without the back of a national ID card, nor for an incomplete profile; a passport needs no back", async () => {
  const noBack = world({ card_holders: [] });
  await inWorld(noBack, () => withDeps({ identity: { ...IDENTITY, imageBackUrl: undefined } }, async () => {
    freda.createHolder = (async () => { throw new Error("must not be called"); }) as any;
    const info = await H.enrollHolder(USER, "kyc");
    assert.equal(info.state, "failed");
    assert.match(info.reason, /back of your ID/);
  }));
  const passport = world({ card_holders: [] });
  let called = 0;
  await inWorld(passport, () => withDeps({ identity: { ...IDENTITY, type: "PASSPORT", imageBackUrl: undefined } }, async () => {
    freda.createHolder = (async () => { called++; return { id: "mpc_p", holder: { status: "enrolled" } }; }) as any;
    assert.equal((await H.enrollHolder(USER, "kyc")).state, "pending");
  }));
  assert.equal(called, 1);
  const incomplete = world({ card_holders: [] });
  incomplete.table("profiles")[0]!.address_postal_code = "";
  await inWorld(incomplete, () => withDeps({}, async () => {
    freda.createHolder = (async () => { throw new Error("must not be called"); }) as any;
    const info = await H.enrollHolder(USER, "kyc");
    assert.deepEqual([info.state, info.missing], ["needs_profile", ["postal code"]]);
  }));
});

test("a Freda refusal is kept on the holder in the customer's words, and the background pass does not try again before 6 hours", async () => {
  const db = world({ card_holders: [] });
  let calls = 0;
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async () => { calls++; throw fredaErr(400, "HOLDER_UNDERAGE", "Titulaire mineur", "POST /v1/cards/holders"); }) as any;
    const info = await H.enrollHolder(USER, "kyc");
    assert.deepEqual([info.state, info.reason], ["failed", "The card holder must be at least 18 years old."]);
    await H.enrollMissingHolders();
  }));
  assert.equal(calls, 1, "not sent again right away");
  assert.equal(db.table("card_holders")[0]!.verification_status, "failed");
});

test("a customer whose KYC is not verified is never registered", async () => {
  const db = world({ card_holders: [] });
  db.table("profiles")[0]!.kyc_status = "pending";
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async () => { throw new Error("must not be called"); }) as any;
    assert.equal((await H.enrollHolder(USER, "kyc")).state, "needs_kyc");
    await H.enrollMissingHolders();
  }));
  assert.equal(db.table("card_holders").length, 0);
});

test("holder.rejected: the customer sees why and is told; a new verification can be asked for", async () => {
  const db = world({ card_holders: [holderRow({ verification_status: "pending", last_attempt_at: iso(3_600_000) })] });
  await inWorld(db, async () => {
    await H.handleHolderEvent("holder.rejected", { id: "mpc_1", reason: "Photo coupée" });
    const info = await H.holderInfo(USER);
    assert.deepEqual([info.state, info.reason, info.canRetry], ["failed", "The card issuer did not accept your ID document: Photo coupée. Try again, or contact support.", true]);
  });
  assert.deepEqual(notifications(db), ["Card profile not verified"]);
});

test("a verified holder is never brought back to 'waiting' by polling, and the card can be created", async () => {
  const db = world();
  await inWorld(db, async () => {
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    assert.equal((await H.holderInfo(USER, { refresh: true, force: true })).state, "ready");
  });
  assert.equal(db.table("card_holders")[0]!.verification_status, "verified");
});

test("holder.verified that arrives before the holder id was saved is applied when the registration finishes", async () => {
  const db = world({ card_holders: [] });
  await inWorld(db, () => withDeps({}, async () => {
    await H.handleHolderEvent("holder.verified", { id: "mpc_fast" });
    freda.createHolder = (async () => ({ id: "mpc_fast", holder: { id: "mpc_fast", status: "enrolled" } })) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    assert.equal((await H.enrollHolder(USER, "kyc")).state, "ready");
  }));
  assert.equal(db.table("card_holders")[0]!.verification_status, "verified");
  assert.deepEqual(notifications(db), ["Card profile verified"]);
});

test("holders registered without their ID ('à vérifier' at Freda) get the ID submitted at once, without a new holder; once a decision is waited for 6 hours, it is submitted again", async () => {
  const unsent = holderRow({ verification_status: "submitted", last_attempt_at: iso(3_600_000), program_enrolled_at: iso(3_600_000) });
  const oldReady = holderRow({ id: "h2", user_id: OTHER, freda_holder_id: "mpc_2", email: "jean@example.com", verification_status: "ready", created_at: iso(86_400_000), program_enrolled_at: iso(3_600_000), last_attempt_at: iso(3_600_000) });
  const db = world({ card_holders: [unsent, oldReady] });
  db.table("profiles").push({ ...db.table("profiles")[0]!, id: OTHER });
  const docs: string[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async () => { throw new Error("no new holder: only the ID is submitted"); }) as any;
    freda.restartHolderVerification = (async (b: any) => { docs.push(b.email); return { restarted: true }; }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    await H.enrollMissingHolders();
    await H.enrollMissingHolders(); // the second round does not send them again
  }));
  assert.deepEqual(docs.sort(), ["jean@example.com", "marie@example.com"]);
  assert.deepEqual(db.table("card_holders").map((r) => r.verification_status), ["docs_sent", "docs_sent"], "they wait for holder.verified");

  const waiting = world({ card_holders: [holderRow({ verification_status: "docs_sent", created_at: iso(7 * 3_600_000), program_enrolled_at: iso(7 * 3_600_000), last_attempt_at: iso(7 * 3_600_000) })] });
  const fresh = world({ card_holders: [holderRow({ verification_status: "docs_sent", created_at: iso(3_600_000), program_enrolled_at: iso(3_600_000), last_attempt_at: iso(3_600_000) })] });
  let again = 0;
  for (const db2 of [waiting, fresh]) {
    await inWorld(db2, () => withDeps({}, async () => {
      freda.createHolder = (async () => { throw new Error("no new holder"); }) as any;
      freda.restartHolderVerification = (async () => { again++; return { restarted: true }; }) as any;
      await H.enrollMissingHolders();
    }));
  }
  assert.equal(again, 1, "only the holder that waits for more than 6 hours is submitted again");
});

test("Freda's limit of 5 verifications per 24 h does not make a holder 'failed': it is tried again later", async () => {
  const db = world({ card_holders: [holderRow({ verification_status: "submitted", last_attempt_at: iso(3_600_000), program_enrolled_at: iso(3_600_000) })] });
  await inWorld(db, () => withDeps({}, async () => {
    freda.restartHolderVerification = (async () => { throw fredaErr(429, "HOLDER_VERIFICATION_LIMIT", "limit", "POST /v1/cards/holder-profile"); }) as any;
    const info = await H.enrollHolder(USER, "backfill", { fresh: false });
    assert.equal(info.state, "pending");
  }));
  assert.equal(db.table("card_holders")[0]!.verification_status, "submitted", "not refused, only not submitted yet");
});

test("an address of the tagged kind that belongs to ANOTHER holder is skipped; one that is this customer's (a repeated attempt) is accepted", async () => {
  const db = world({ card_holders: [holderRow({ verification_status: null, program_enrolled_at: null, last_attempt_at: null, checked_at: null })] });
  const tried: string[] = [];
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async (b: any) => {
      tried.push(b.email);
      if (tried.length === 1) return { id: "mpc_other", already_existed: true, holder: { id: "mpc_other", first_name: "Paul", last_name: "Louis", dob: "1980-01-01" } };
      if (tried.length === 2) throw fredaErr(409, "HOLDER_EMAIL_EXISTS", "email", "POST /v1/cards/holders");
      return { id: "mpc_mine", already_existed: true, holder: { id: "mpc_mine", first_name: "Marie", last_name: "Jean", dob: "1990-05-12" } };
    }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    const info = await H.enrollHolder(USER, "backfill");
    assert.equal(info.holderId, "mpc_mine");
  }));
  assert.equal(tried.length, 3);
  assert.equal(new Set(tried).size, 3, "a different address each time");
  assert.equal(db.table("card_holders")[0]!.email, tried[2]);
});

test("holder overview for the admin: never sent, waiting, verified, refused; and the send-now button really sends", async () => {
  const OTHER2 = "33333333-3333-3333-3333-333333333333";
  const db = world({ card_holders: [holderRow({ verification_status: "submitted", program_enrolled_at: iso(3_600_000) })] });
  db.table("profiles").push({ id: OTHER, kyc_status: "verified", first_name: "Jean", last_name: "Paul", display_name: "Jean Paul" });
  db.table("profiles").push({ id: OTHER2, kyc_status: "pending", first_name: "Luc", last_name: "Remy" });
  const ov: any = await inWorld(db, () => H.holderOverview());
  assert.equal(ov.total, 2, "only customers with a verified KYC");
  assert.deepEqual(ov.counts, { none: 1, needs_profile: 0, registered: 1, submitted: 0, verified: 0, failed: 0 });
  assert.equal(ov.items.find((i: any) => i.userId === USER)!.status, "registered", "at Freda, ID not submitted");
  assert.equal(ov.items.find((i: any) => i.userId === OTHER)!.status, "none");

  const sent: any[] = [];
  const info = await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async (b: any) => { sent.push(b); return { id: "mpc_btn", holder: { id: "mpc_btn", status: "enrolled" } }; }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    return H.enrollHolder(USER, "customer", { fresh: true });
  }));
  assert.equal(sent.length, 1);
  assert.deepEqual([info.state, info.holderId], ["pending", "mpc_btn"]);
});

test("holder.verified for a holder that no row has (the customer's other holder at Freda): it is linked to the customer by e-mail, else name and birth date", async () => {
  const OTHER3 = "44444444-4444-4444-4444-444444444444";
  const db = world({ card_holders: [
    holderRow({ verification_status: "docs_sent", freda_holder_id: "mpc_old", email: "marie@example.com" }),
    holderRow({ id: "h9", user_id: OTHER3, freda_holder_id: "mpc_o3", email: "paul@example.com", first_name: "Paul", last_name: "Louis", dob: "1980-01-01", verification_status: "docs_sent" }),
  ] });
  await inWorld(db, async () => {
    freda.getHolder = (async () => ({ holder: { id: "mpc_other_one", status: "enrolled", email: "marie7@example.com", first_name: "Marie", last_name: "Jean", dob: "1990-05-12" } })) as any;
    await H.handleHolderEvent("holder.verified", { id: "mpc_other_one" });
  });
  const mine = db.table("card_holders").find((r) => r.user_id === USER)!;
  assert.deepEqual([mine.freda_holder_id, mine.email, mine.verification_status], ["mpc_other_one", "marie7@example.com", "verified"], "the verified holder is now the customer's holder");
  assert.equal(db.table("card_holders").find((r) => r.user_id === OTHER3)!.verification_status, "docs_sent", "nobody else is touched");
  assert.deepEqual(notifications(db), ["Card profile verified"]);

  // a holder that matches nobody (or two customers) is kept aside, never given to a customer
  const db2 = world({ card_holders: [holderRow()] });
  await inWorld(db2, async () => {
    freda.getHolder = (async () => ({ holder: { id: "mpc_x", status: "enrolled", email: "stranger@example.com", first_name: "Zoe", last_name: "Blanc", dob: "2000-02-02" } })) as any;
    await H.handleHolderEvent("holder.verified", { id: "mpc_x" });
  });
  assert.equal(db2.table("card_holders")[0]!.freda_holder_id, "mpc_1");
});

test("a holder.verified that arrives while the registration is being saved is not lost", async () => {
  const db = world({ card_holders: [] });
  await inWorld(db, () => withDeps({}, async () => {
    freda.createHolder = (async () => ({ id: "mpc_race", holder: { id: "mpc_race", status: "enrolled" } })) as any;
    // the webhook comes while Freda's answer to the ID submission is still on its way back
    freda.restartHolderVerification = (async () => { await H.handleHolderEvent("holder.verified", { id: "mpc_race" }); return { restarted: true }; }) as any;
    freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
    assert.equal((await H.enrollHolder(USER, "kyc")).state, "ready");
  }));
  assert.equal(db.table("card_holders")[0]!.verification_status, "verified");
});

test("the program decision is read from Freda's GET only when a field names the program with an explicit word", () => {
  assert.deepEqual(H.readProgramDecision({ status: "enrolled", program_status: "accepted" }), { verified: true, reason: null });
  assert.deepEqual(H.readProgramDecision({ status: "enrolled", new_program: { status: "Accepté" } }), { verified: true, reason: null });
  assert.deepEqual(H.readProgramDecision({ program: { status: "rejected", reason: "dataNotReadable" } }), { verified: false, reason: "dataNotReadable" });
  assert.equal(H.readProgramDecision({ program_status: "pending" }), null);
  assert.equal(H.readProgramDecision({ status: "enrolled", verification: { ready_for_cards: true, tier: 2 } }), null, "the old issuer's verification says nothing about the new program");
  assert.equal(H.readProgramDecision({ status: "enrolled" }), null);
  assert.equal(H.readProgramDecision({ program_status: "not accepted" })!.verified, false);
});

test("holders waiting for the decision are asked at Freda every round; a program field that says accepted makes them verified at once, without the webhook", async () => {
  const db = world({ card_holders: [holderRow({ verification_status: "docs_sent", checked_at: iso(120_000) })] });
  let reads = 0;
  await inWorld(db, async () => {
    freda.getHolder = (async () => { reads++; return { holder: { id: "mpc_1", status: "enrolled" } }; }) as any;
    await H.refreshPendingHolders();
    assert.equal(db.table("card_holders")[0]!.verification_status, "docs_sent", "GET without a program field changes nothing");
    freda.getHolder = (async () => { reads++; return { holder: { id: "mpc_1", status: "enrolled", program_status: "accepted" } }; }) as any;
    await H.refreshPendingHolders();
  });
  assert.equal(reads, 2, "a docs_sent holder is polled");
  assert.equal(db.table("card_holders")[0]!.verification_status, "verified");
  assert.deepEqual(notifications(db), ["Card profile verified"]);
});

test("webhook check: no webhook, another URL, a refused test (401) and a working one are told apart", async () => {
  const W = await import("../src/webhookcheck.js");
  const ok = { url: "https://k.onrender.com/api/webhooks/freda", active: true, expectedUrl: "https://k.onrender.com/api/webhooks/freda", test: { sent: true, httpStatus: 200, reason: null } };
  assert.equal(W.webhookProblem(ok), null);
  assert.match(W.webhookProblem({ ...ok, url: null })!, /no webhook registered/);
  assert.match(W.webhookProblem({ ...ok, active: false })!, /switched off/);
  assert.match(W.webhookProblem({ ...ok, url: "https://old.example.com/api/webhooks/freda" })!, /sends to https:\/\/old/);
  assert.match(W.webhookProblem({ ...ok, test: { sent: false, httpStatus: 401, reason: "Invalid signature" } })!, /REFUSED.*FREDA_WEBHOOK_SECRET/);
  assert.match(W.webhookProblem({ ...ok, test: { sent: false, httpStatus: 502, reason: null } })!, /HTTP 502/);
  assert.equal(W.expectedWebhookUrl({ RENDER_EXTERNAL_URL: "https://k.onrender.com/" } as any), "https://k.onrender.com/api/webhooks/freda");
  assert.equal(W.expectedWebhookUrl({} as any), null);
});

test("webhook secrets: the environment one and the one kept by the last registration are both accepted; none, or a wrong one, is refused", async () => {
  const S = await import("../src/webhooksecret.js");
  const { verifyWebhookSignature } = await import("../src/freda.js");
  const { createHmac } = await import("node:crypto");
  assert.deepEqual(S.webhookSecrets({ FREDA_WEBHOOK_SECRET: "whsec_REPLACE_ME" } as any), []);
  assert.deepEqual(S.webhookSecrets({ FREDA_WEBHOOK_SECRET: "whsec_envsecret1234" } as any), ["whsec_envsecret1234"]);
  const db = world();
  await inWorld(db, async () => {
    await S.saveWebhookSecret("whsec_savedsecret5678", USER);
    const all = S.webhookSecrets({ FREDA_WEBHOOK_SECRET: "whsec_envsecret1234" } as any);
    assert.deepEqual(all.sort(), ["whsec_envsecret1234", "whsec_savedsecret5678"]);
    const body = JSON.stringify({ event: "holder.verified", data: { id: "mpc_1" } });
    const sig = "sha256=" + createHmac("sha256", "whsec_savedsecret5678").update(body).digest("hex");
    assert.ok(all.some((s) => verifyWebhookSignature(body, sig, s)), "signed with the saved secret");
    assert.ok(!["whsec_envsecret1234"].some((s) => verifyWebhookSignature(body, sig, s)), "not with a stale one");
    await assert.rejects(() => S.saveWebhookSecret("not-a-secret", USER), /usable webhook secret/);
  });
  assert.equal(db.table("app_settings")[0]!.key, "freda_webhook_secret");
});

test("pointing the webhook at this server saves the new secret, checks it, and the holders that wait are submitted again", async () => {
  const W = await import("../src/webhookcheck.js");
  const db = world({ card_holders: [holderRow({ verification_status: "docs_sent" })] });
  process.env["RENDER_EXTERNAL_URL"] = "https://kasho-pay-backend.onrender.com";
  const registered: string[] = [];
  let endpoint: any = { url: "https://kasho-pay-1.onrender.com/api/webhooks/freda", active: true };
  const before = { we: freda.webhookEndpoint, rw: freda.registerWebhook, tw: freda.testWebhook };
  try {
    await inWorld(db, async () => {
      freda.webhookEndpoint = (async () => ({ endpoint })) as any;
      freda.registerWebhook = (async (url: string) => { registered.push(url); endpoint = { url, active: true }; return { id: "wh_1", url, secret: "whsec_brandnewsecret99" }; }) as any;
      freda.testWebhook = (async () => ({ sent: true, http_status: 200, reason: null })) as any;
      const wrong = await W.checkFredaWebhook();
      assert.match(wrong!.problem!, /sends to https:\/\/kasho-pay-1/, "the old address is named");
      const fixed = await W.fixFredaWebhook(USER);
      assert.equal(fixed.ok, true);
      assert.equal(await H.resubmitWaitingHolders(), 1);
    });
  } finally { Object.assign(freda, { webhookEndpoint: before.we, registerWebhook: before.rw, testWebhook: before.tw }); delete process.env["RENDER_EXTERNAL_URL"]; }
  assert.deepEqual(registered, ["https://kasho-pay-backend.onrender.com/api/webhooks/freda"]);
  assert.equal(db.table("card_holders")[0]!.verification_status, "submitted", "it will be submitted again, so Freda sends its decision to the right address");
  assert.equal(db.table("app_settings").find((r) => r.key === "freda_webhook_secret")!.value.secret, "whsec_brandnewsecret99");
});

test("a holder whose ID could not be submitted keeps what Freda said (shown in the admin); one Freda says is already verified becomes verified; an error never makes an existing holder 'refused'", async () => {
  assert.equal(H.saysAlreadyVerified(fredaErr(409, "HOLDER_ALREADY_VERIFIED", "x")), true);
  assert.equal(H.saysAlreadyVerified(fredaErr(400, "X", "Le titulaire est déjà vérifié")), true);
  assert.equal(H.saysAlreadyVerified(fredaErr(400, "X", "photo coupée")), false);
  assert.match(H.describeAnswer({ restarted: false, message: "nothing to do" }), /message=nothing to do/);

  // 1) a refusal Freda words its own way: the holder stays waiting, the note is kept
  const db = world({ card_holders: [holderRow({ verification_status: "submitted", last_attempt_at: iso(3_600_000), program_enrolled_at: iso(3_600_000) })] });
  await inWorld(db, () => withDeps({}, async () => {
    freda.restartHolderVerification = (async () => { throw fredaErr(409, "HOLDER_BUSY", "verification in progress", "POST /v1/cards/holder-profile"); }) as any;
    assert.equal((await H.enrollHolder(USER, "backfill", { fresh: false })).state, "pending");
  }));
  const row = db.table("card_holders")[0]!;
  assert.deepEqual([row.verification_status, row.failure_reason], ["submitted", "409 HOLDER_BUSY: verification in progress"]);
  assert.equal((await inWorld(db, () => H.holderOverview()) as any).items[0].reason, "409 HOLDER_BUSY: verification in progress", "the admin sees it");

  // 2) Freda says it is already verified
  const db2 = world({ card_holders: [holderRow({ verification_status: "submitted", last_attempt_at: iso(3_600_000), program_enrolled_at: iso(3_600_000) })] });
  await inWorld(db2, () => withDeps({}, async () => {
    freda.restartHolderVerification = (async () => { throw fredaErr(409, "HOLDER_ALREADY_VERIFIED", "already verified", "POST /v1/cards/holder-profile"); }) as any;
    assert.equal((await H.enrollHolder(USER, "backfill", { fresh: false })).state, "ready");
  }));
  assert.equal(db2.table("card_holders")[0]!.verification_status, "verified");
  assert.deepEqual(notifications(db2), ["Card profile verified"]);

  // 3) an answer without restarted: true is kept as a note too
  const db3 = world({ card_holders: [holderRow({ verification_status: "submitted", last_attempt_at: iso(3_600_000), program_enrolled_at: iso(3_600_000) })] });
  await inWorld(db3, () => withDeps({}, async () => {
    freda.restartHolderVerification = (async () => ({ restarted: false, message: "no change" })) as any;
    await H.enrollHolder(USER, "backfill", { fresh: false });
  }));
  assert.match(db3.table("card_holders")[0]!.failure_reason, /message=no change/);
});
