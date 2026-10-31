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
const L: any = await import("../src/ledger.js");
const { freda, FredaError } = await import("../src/freda.js");
const { handlers } = await import("../src/routes.js");
const V = await import("../src/verification.js");

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
    let op: "select" | "insert" | "update" | "delete" = "select";
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
  address_postal_code: "HT6110", status: "enrolled", identity_sent: true, created_at: iso(86_400_000), ...o,
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

const saved = { from: L.db.from, rpc: L.db.rpc, createCard: freda.createCard, getCard: freda.getCard, getHolder: freda.getHolder, createHolder: freda.createHolder, listHolders: freda.listHolders };
async function inWorld<T>(db: Mem, fn: () => Promise<T>): Promise<T> {
  L.db.from = db.from; L.db.rpc = db.rpc;
  freda.getHolder = (async () => ({ holder: { status: "enrolled" } })) as any;
  try { return await quiet(fn); } finally {
    L.db.from = saved.from; L.db.rpc = saved.rpc;
    Object.assign(freda, { createCard: saved.createCard, getCard: saved.getCard, getHolder: saved.getHolder, createHolder: saved.createHolder, listHolders: saved.listHolders });
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
  assert.equal(cardOf(db).status, "failed");
  assert.equal(balance(db), 100);
});

test("a holder that the card service is still verifying ends in a refund, no second holder and no card request", async () => {
  const db = world();
  await inWorld(db, async () => {
    freda.getHolder = (async () => ({ holder: { status: "pending" } })) as any;
    freda.listHolders = (async () => ({ holders: [] })) as any;
    freda.createHolder = (async () => { throw new Error("no second holder must be created"); }) as any;
    freda.createCard = (async () => { throw new Error("no card must be requested"); }) as any;
    await createCard();
    await later();
  });
  assert.equal(balance(db), 100, "charged, then given back");
  assert.equal(cardOf(db).status, "failed");
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
