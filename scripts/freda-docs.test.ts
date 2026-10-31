// Run: npm test
// Covers the Freda Pay Issuing docs update of 30 Oct 2026: card closing fee, card.* webhook payloads,
// the Master Wallet endpoint and the back of the ID document (identity.imageBackUrl).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env["SUPABASE_URL"] ??= "http://localhost:1"; // ledger.ts / routes.ts build a client at import time; nothing is called
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-key";
const L: any = await import("../src/ledger.js");
const { freda, FredaError, readClosure, readMasterWallet } = await import("../src/freda.js");
const { closureFee, getConfig } = await import("../src/config.js");
const { handlers } = await import("../src/routes.js");

const quiet = async <T>(fn: () => Promise<T> | T): Promise<T> => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

// ------------------------------------------------------------------ a recording fake of the supabase client
type Rec = { table?: string; op: string; payload?: any; rpc?: string; args?: any };
function fakeDb(o: { tables?: Record<string, any>; singles?: Record<string, any[]>; flipped?: any[]; busy?: any[] } = {}) {
  const log: Rec[] = [];
  const queues: Record<string, any[]> = Object.fromEntries(Object.entries(o.singles ?? {}).map(([k, v]) => [k, [...v]]));
  const from = (table: string) => {
    const st: { op: string; payload?: any } = { op: "select" };
    const done = () => {
      if (table === "cards" && st.op === "update") return { data: o.flipped ?? [{ id: "c1" }], error: null };
      if (table === "transactions" && st.op === "select") return { data: o.busy ?? [], error: null };
      return { data: null, error: null };
    };
    const one = () => {
      const q = queues[table];
      if (q?.length) { const v = q.length > 1 ? q.shift() : q[0]; return v; }
      return { data: o.tables?.[table] ?? null, error: null };
    };
    const api: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "then") return (res: any) => res(done());
        if (prop === "single") return async () => (st.op === "insert" ? { data: { id: "tx-new", ...st.payload }, error: null } : one());
        if (prop === "maybeSingle") return async () => one();
        return (...args: any[]) => {
          if (prop === "insert" || prop === "update") { st.op = prop; st.payload = args[0]; log.push({ table, op: prop, payload: args[0] }); }
          else if (prop === "select" && table === "transactions" && st.op === "select") log.push({ table, op: "select" });
          else if (prop === "select" && table === "kyc_submissions") log.push({ table, op: "select" });
          return api;
        };
      },
    });
    return api;
  };
  const rpc = async (name: string, args: any) => { log.push({ op: "rpc", rpc: name, args }); return { data: true, error: null }; };
  return { log, from, rpc };
}

const saved = { from: L.db.from, rpc: L.db.rpc, get: freda.getCard, term: freda.terminateCard };
async function withFake(fake: ReturnType<typeof fakeDb>, fn: () => any): Promise<any> {
  L.db.from = fake.from; L.db.rpc = fake.rpc;
  try { return await fn(); } finally { L.db.from = saved.from; L.db.rpc = saved.rpc; freda.getCard = saved.get; freda.terminateCard = saved.term; }
}
const inserted = (f: ReturnType<typeof fakeDb>, table: string) => f.log.filter((r) => r.table === table && r.op === "insert").map((r) => r.payload);

// ------------------------------------------------------------------ pure helpers
test("closing fee: the flat fee, never more than what is left on the card", () => {
  assert.equal(closureFee(12), 0.5);
  assert.equal(closureFee(0.5), 0.5);
  assert.equal(closureFee(0.3), 0.3);
  assert.equal(closureFee(0), 0);
  assert.equal(closureFee(-4), 0);
  process.env["CARD_CLOSURE_FEE_USD"] = "1.25";
  try { assert.equal(closureFee(10), 1.25); assert.equal(getConfig().cardClosureFeeUsd, 1.25); } finally { delete process.env["CARD_CLOSURE_FEE_USD"]; }
  assert.equal(getConfig().cardClosureFeeUsd, 0.5);
});

test("readClosure: refunded_usd + closure_fee_usd from the API answer or the webhook body", () => {
  assert.deepEqual(readClosure({ id: "card_1", status: "terminated", refunded_usd: 9.5, closure_fee_usd: 0.5 }), { refunded: 9.5, fee: 0.5 });
  assert.deepEqual(readClosure({ id: "card_1", refunded_usd: "9.50", closure_fee_usd: "0.5" }), { refunded: 9.5, fee: 0.5 });
  assert.deepEqual(readClosure({ event: "card.terminated", data: { refunded_usd: 0, closure_fee_usd: 0.3 } }), { refunded: 0, fee: 0.3 });
  for (const bad of [null, undefined, {}, { refunded_usd: 5 }, { closure_fee_usd: 0.5 }, { refunded_usd: -1, closure_fee_usd: 0.5 }, { refunded_usd: "x", closure_fee_usd: 0.5 }, { refunded_usd: NaN, closure_fee_usd: 0.5 }]) {
    assert.equal(readClosure(bad), null, JSON.stringify(bad));
  }
});

test("readMasterWallet: spendable = balance minus the locked guarantee deposit", () => {
  assert.deepEqual(readMasterWallet({ mode: "live", balance: 320.5, guarantee_usd: 50, spendable_usd: 270.5, reserved_on_cards_usd: 140, active_cards: 6, low_balance: false }),
    { balance: 320.5, guarantee: 50, spendable: 270.5, low: false, reservedOnCards: 140, activeCards: 6, mode: "live" });
  assert.equal(readMasterWallet({ balance: 60, guarantee_usd: 50, spendable_usd: 10, low_balance: true })?.low, true);
  assert.equal(readMasterWallet({ balance: 60 }), null);
  assert.equal(readMasterWallet(null), null);
});

test("card failure details: reason trimmed, only an https re-verification link is kept", () => {
  const long = "x".repeat(500);
  assert.deepEqual(L.cardFailureMeta({ reason: "  image illisible " }), { card_failure_reason: "image illisible" });
  assert.equal((L.cardFailureMeta({ reason: long }).card_failure_reason as string).length, 300);
  assert.deepEqual(L.cardFailureMeta({ link: "https://verify.example.com/s/abc", linkExpiresAt: "2026-11-02T10:00:00Z" }),
    { verification_link: "https://verify.example.com/s/abc", verification_link_expires_at: "2026-11-02T10:00:00Z" });
  for (const bad of ["http://verify.example.com/s", "javascript:alert(1)", "not a url", `https://a.com/${"x".repeat(600)}`, 7, null]) {
    assert.deepEqual(L.cardFailureMeta({ link: bad }), {}, String(bad));
  }
  assert.deepEqual(L.cardFailureMeta({}), {});
});

// ------------------------------------------------------------------ closing a card
const activeCard = (over: any = {}) => ({ id: "c1", user_id: "u1", freda_card_id: "card_9", status: "active", label: "Kasho Visa", last4: "4821", balance: 12, ...over });

test("card closed on Freda's side (webhook): the wallet gets what Freda really returned, fee on the row", async () => {
  const f = fakeDb();
  await withFake(f, async () => {
    await L.markCardGone(activeCard(), { refunded: 9.5, fee: 0.5 }); // stale local balance 12, Freda says 10 left
  });
  const [row] = inserted(f, "transactions");
  assert.equal(row.amount, 10);
  assert.equal(row.fee, 0.5);
  assert.equal(row.kind, "card_withdraw");
  assert.deepEqual(row.meta, { terminate: true, closed_by_provider: true });
  assert.ok(f.log.some((r) => r.rpc === "kasho_complete_tx"), "credited once, net of the fee, by kasho_complete_tx (amount - fee)");
});

test("card closed without figures (404 / status sync): last known balance minus the closing fee", async () => {
  const f1 = fakeDb();
  await withFake(f1, async () => { await L.markCardGone(activeCard({ balance: 12 })); });
  assert.deepEqual([inserted(f1, "transactions")[0].amount, inserted(f1, "transactions")[0].fee], [12, 0.5]);

  const f2 = fakeDb();
  await withFake(f2, async () => { await L.markCardGone(activeCard({ balance: 0.3 })); });
  assert.deepEqual([inserted(f2, "transactions")[0].amount, inserted(f2, "transactions")[0].fee], [0.3, 0.3], "fee never exceeds the balance");

  const f3 = fakeDb();
  await withFake(f3, async () => { await L.markCardGone(activeCard({ balance: 0 })); });
  assert.equal(inserted(f3, "transactions").length, 0, "an empty card moves no money");
});

test("card closed twice or while our own closure is pending: nothing is credited twice", async () => {
  const f1 = fakeDb({ flipped: [] }); // another request already flipped the status
  await withFake(f1, async () => { await L.markCardGone(activeCard(), { refunded: 9.5, fee: 0.5 }); });
  assert.equal(inserted(f1, "transactions").length, 0);
  const f2 = fakeDb({ busy: [{ id: "t-ours" }] }); // our terminateCardFn row is still pending
  await withFake(f2, async () => { await L.markCardGone(activeCard(), { refunded: 9.5, fee: 0.5 }); });
  assert.equal(inserted(f2, "transactions").length, 0);
  const f3 = fakeDb();
  await withFake(f3, async () => { await L.markCardGone(activeCard({ status: "terminated" })); });
  assert.equal(f3.log.length, 0);
});

const ctx: any = { userId: "u1" };
const terminate = (f: ReturnType<typeof fakeDb>, answer: any, before: any = { status: "active", balance: 12 }) => withFake(f, async () => {
  const seq = [before, { status: "terminated" }];
  freda.getCard = (async () => seq.shift() ?? { status: "terminated" }) as any;
  freda.terminateCard = (async () => answer) as any;
  return (handlers as any).terminateCardFn.run({ cardId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }, ctx);
});

test("terminateCardFn: the user is credited balance minus the closing fee", async () => {
  const f = fakeDb({ tables: { cards: activeCard() } });
  const res = await terminate(f, { id: "card_9", status: "terminated", refunded_usd: 11.5, closure_fee_usd: 0.5 });
  assert.deepEqual(res, { refunded: 11.5, fee: 0.5 });
  const [row] = inserted(f, "transactions");
  assert.deepEqual([row.amount, row.fee, row.status], [12, 0.5, "pending"], "row written before the provider call, with the fee");
  assert.equal(f.log.filter((r) => r.table === "transactions" && r.op === "update").length, 0, "Freda agreed: nothing to adjust");
  assert.ok(f.log.some((r) => r.rpc === "kasho_complete_tx"));
});

test("terminateCardFn: when Freda reports other figures, the pending row follows Freda", async () => {
  const f = fakeDb({ tables: { cards: activeCard() } });
  const res = await terminate(f, { id: "card_9", status: "terminated", refunded_usd: 10.5, closure_fee_usd: 1 });
  assert.deepEqual(res, { refunded: 10.5, fee: 1 });
  const adj = f.log.find((r) => r.table === "transactions" && r.op === "update");
  assert.deepEqual(adj?.payload, { amount: 11.5, fee: 1 });
});

test("terminateCardFn: an answer without figures keeps the documented fee; an empty card has no row and no fee", async () => {
  const f1 = fakeDb({ tables: { cards: activeCard() } });
  assert.deepEqual(await terminate(f1, { id: "card_9", status: "terminated" }), { refunded: 11.5, fee: 0.5 });
  const f2 = fakeDb({ tables: { cards: activeCard({ balance: 0 }) } });
  assert.deepEqual(await terminate(f2, { id: "card_9", status: "terminated" }, { status: "active", balance: 0 }), { refunded: 0, fee: 0 });
  assert.equal(inserted(f2, "transactions").length, 0);
  const f3 = fakeDb({ tables: { cards: activeCard({ balance: 0.3 }) } });
  assert.deepEqual(await terminate(f3, { id: "card_9", status: "terminated" }, { status: "active", balance: 0.3 }), { refunded: 0, fee: 0.3 });
});

test("terminateCardFn: a rejected closure refunds nothing and the row is failed", async () => {
  const f = fakeDb({ tables: { cards: activeCard() } });
  await assert.rejects(() => withFake(f, async () => {
    freda.getCard = (async () => ({ status: "active", balance: 12 })) as any;
    freda.terminateCard = (async () => { throw new FredaError(409, "CARD_FROZEN", "nope"); }) as any;
    return (handlers as any).terminateCardFn.run({ cardId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }, ctx);
  }));
  assert.ok(f.log.some((r) => r.rpc === "kasho_fail_tx"));
  assert.ok(!f.log.some((r) => r.rpc === "kasho_complete_tx"));
});

test("terminateCardFn: card already gone on Freda (404) is closed with the fee taken", async () => {
  const f = fakeDb({ tables: { cards: activeCard() } });
  const res = await withFake(f, async () => {
    freda.getCard = (async () => { throw new FredaError(404, "NOT_FOUND", "gone"); }) as any;
    return (handlers as any).terminateCardFn.run({ cardId: "7f1b7f3e-8d0e-4e52-9a53-0a9f2d6d8a11" }, ctx);
  });
  assert.deepEqual(res, { refunded: 11.5, fee: 0.5 });
  assert.deepEqual([inserted(f, "transactions")[0].amount, inserted(f, "transactions")[0].fee], [12, 0.5]);
});

test("the app is told the closing fee through getPublicConfig", async () => {
  const f = fakeDb();
  const cfg = await withFake(f, () => (handlers as any).getPublicConfig.run({}, ctx)); // no fee rules in the fake: fine here
  assert.equal(cfg.cardClosureFeeUsd, 0.5);
});

// ------------------------------------------------------------------ card.* webhook events
test("webhook card.terminated: uses refunded_usd + closure_fee_usd from the event", async () => {
  const f = fakeDb({ tables: { cards: activeCard() } });
  await withFake(f, async () => {
    await L.handleCardEvent("card.terminated", { id: "card_9", refunded_usd: 9.5, closure_fee_usd: 0.5 });
  });
  assert.deepEqual([inserted(f, "transactions")[0].amount, inserted(f, "transactions")[0].fee], [10, 0.5]);
});

test("webhook card.failed: the reason and the re-verification link are kept on the creation transaction", async () => {
  const card = activeCard({ status: "pending", creation_tx_id: "t-create" });
  const f = fakeDb({ tables: { cards: card, transactions: { id: "t-create", meta: { holder_id: "mpc_1" } } } });
  await quiet(() => withFake(f, async () => {
    await L.handleCardEvent("card.failed", {
      id: "card_9", failure_reason: "face manquante", verification_link: "https://verify.example.com/s/abc", verification_link_expires_at: "2026-11-02T10:00:00Z",
    });
  }));
  assert.ok(f.log.some((r) => r.rpc === "kasho_fail_tx" && r.args.p_tx === "t-create"), "the creation charge is refunded");
  const upd = f.log.filter((r) => r.table === "transactions" && r.op === "update").map((r) => r.payload);
  assert.deepEqual(upd, [{ meta: {
    holder_id: "mpc_1", card_failure_reason: "face manquante",
    verification_link: "https://verify.example.com/s/abc", verification_link_expires_at: "2026-11-02T10:00:00Z",
  } }]);
  // The customer is told what to do (the link itself is shown in the app by cardVerificationFn, never put in a notification text).
  assert.deepEqual(inserted(f, "notifications")[0], { user_id: "u1", title: "Identity verification needed", body: "The card service must verify your identity before it can issue your card. Open Cards to continue. Your money is back in your wallet." },
    "with a verification link the customer is told to complete the identity verification (fixed, translated text)");
});

test("webhook card.failed with a reason but no link keeps the fixed message, unless the reason is about the identity verification", async () => {
  const run = async (reason: string) => {
    const f = fakeDb({ tables: { cards: activeCard({ status: "pending", creation_tx_id: "t-create" }), transactions: { id: "t-create", meta: {} } } });
    await quiet(() => withFake(f, async () => { await L.handleCardEvent("card.failed", { id: "card_9", failure_reason: reason }); }));
    return inserted(f, "notifications")[0];
  };
  assert.equal((await run("image illisible")).title, "Card creation failed");
  const n = await run("Le titulaire doit d'abord compléter sa vérification d'identité.");
  assert.equal(n.title, "Identity verification needed");
  assert.match(n.body, /contact support/);
});

test("webhook card.failed without details behaves as before", async () => {
  const f = fakeDb({ tables: { cards: activeCard({ status: "pending", creation_tx_id: "t-create" }) } });
  await withFake(f, async () => { await L.handleCardEvent("card.failed", { id: "card_9" }); });
  assert.ok(f.log.some((r) => r.rpc === "kasho_fail_tx"));
  assert.equal(f.log.filter((r) => r.table === "transactions" && r.op === "update").length, 0);
});

test("webhook card.transaction: the card is found by card_id (its id is the movement) and re-read from Freda", async () => {
  const card = activeCard({ balance: 20 });
  const f = fakeDb({ tables: { cards: card } });
  let asked = "";
  await withFake(f, async () => {
    freda.getCard = (async (id: string) => { asked = id; return { status: "active", balance: 7.5, masked_pan: "**** **** **** 4821" }; }) as any;
    await L.handleCardEvent("card.transaction", { id: "ctx_1", card_id: "card_9", type: "DEBIT", amount: 12.5, card_balance: 7.5, merchant_name: "NETFLIX" });
  });
  assert.equal(asked, "card_9");
  const upd = f.log.find((r) => r.table === "cards" && r.op === "update");
  assert.equal(upd?.payload.balance, 7.5);
});

test("webhook card.balance_updated: the mirror is refreshed from the real card", async () => {
  const f = fakeDb({ tables: { cards: activeCard({ balance: 20 }) } });
  await withFake(f, async () => {
    freda.getCard = (async () => ({ status: "active", balance: 18 })) as any;
    await L.handleCardEvent("card.balance_updated", { id: "card_9", reference: "r1", balance: 18, previous_balance: 20, reason: "aligned" });
  });
  assert.equal(f.log.find((r) => r.table === "cards" && r.op === "update")?.payload.balance, 18);
});

test("webhook card events: unknown card or missing id do nothing, status events keep their mapping", async () => {
  const f0 = fakeDb(); // no card in the database
  await withFake(f0, async () => {
    await L.handleCardEvent("card.terminated", { id: "card_unknown", refunded_usd: 5, closure_fee_usd: 0.5 });
    await L.handleCardEvent("card.transaction", { id: "ctx_1" }); // no card_id
    await L.handleCardEvent("card.terminated", {});
  });
  assert.equal(f0.log.filter((r) => r.op === "insert").length, 0);
  const f1 = fakeDb({ tables: { cards: activeCard({ status: "active" }) } });
  await withFake(f1, async () => { await L.handleCardEvent("card.frozen", { id: "card_9" }); });
  assert.equal(f1.log.find((r) => r.table === "cards" && r.op === "update")?.payload.status, "disabled");
  const f2 = fakeDb({ tables: { cards: activeCard({ status: "disabled" }) } });
  await withFake(f2, async () => { await L.handleCardEvent("card.unfrozen", { id: "card_9" }); });
  assert.equal(f2.log.find((r) => r.table === "cards" && r.op === "update")?.payload.status, "active");
  const f3 = fakeDb({ tables: { cards: activeCard() } });
  await withFake(f3, async () => { await L.handleCardEvent("card.funded", { id: "card_9", amount: 5 }); });
  assert.equal(f3.log.length, 0, "card.funded is settled by our own call");
});

// ------------------------------------------------------------------ back of the ID document
const stubStorage = (uploads: string[], missing = new Set<string>()) => {
  Object.defineProperty(L.db, "storage", { configurable: true, value: {
    createBucket: async () => ({}),
    from: () => ({
      upload: async (path: string) => { uploads.push(path); return { error: null }; },
      createSignedUrl: async (path: string) => missing.has(path) ? { data: null, error: { message: "nope" } } : { data: { signedUrl: `https://signed.example.com/${path}?t=1` }, error: null },
    }),
  } });
};
const realFetch = globalThis.fetch;
const stubFetch = (fail: (url: string) => boolean = () => false) => {
  globalThis.fetch = (async (url: any) => fail(String(url))
    ? new Response("x", { status: 500 })
    : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })) as any;
};

test("storeKycDocument keeps both sides of a national ID, and marks a passport as having no back", async () => {
  const uploads: string[] = [];
  stubStorage(uploads); stubFetch();
  try {
    const both = await L.storeKycDocument("u1", { document_type: "Identity Card", front_image: "https://cdn.didit.me/f.jpg", back_image: "https://cdn.didit.me/b.jpg" });
    assert.deepEqual(both, { kyc_doc_type: "NIN", kyc_doc_path: "u1/id-front.jpg", kyc_doc_back_path: "u1/id-back.jpg" });
    const passport = await L.storeKycDocument("u1", { document_type: "Passport", front_image: "https://cdn.didit.me/f.jpg" });
    assert.deepEqual(passport, { kyc_doc_type: "PASSPORT", kyc_doc_path: "u1/id-front.jpg", kyc_doc_back_path: "" });
    assert.deepEqual(await L.storeKycDocument("u1", null), {});
  } finally { globalThis.fetch = realFetch; }
});

test("storeKycDocument: a back image that fails to download is left unset so it is tried again later", async () => {
  stubStorage([]); stubFetch((u) => u.includes("b.jpg"));
  try {
    const r = await quiet(() => L.storeKycDocument("u1", { document_type: "Identity Card", front_image: "https://cdn.didit.me/f.jpg", back_image: "https://cdn.didit.me/b.jpg" }));
    assert.deepEqual(r, { kyc_doc_type: "NIN", kyc_doc_path: "u1/id-front.jpg" });
    assert.ok(!("kyc_doc_back_path" in r), "null stays null = not fetched");
  } finally { globalThis.fetch = realFetch; }
});

const profile = (over: any = {}) => ({ id_number: "HT-1234567", country: "ht", kyc_doc_type: "NIN", kyc_doc_path: "u1/id-front.jpg", kyc_doc_back_path: "u1/id-back.jpg", ...over });

test("getFredaIdentity sends imageBackUrl when the back is stored", async () => {
  stubStorage([]);
  const f = fakeDb({ tables: { profiles: profile() } });
  const id = await withFake(f, () => L.getFredaIdentity("u1"));
  assert.deepEqual(id, {
    type: "NIN", number: "HT-1234567", imageUrl: "https://signed.example.com/u1/id-front.jpg?t=1",
    imageBackUrl: "https://signed.example.com/u1/id-back.jpg?t=1", country: "HT",
  });
  assert.ok(!f.log.some((r) => r.table === "kyc_submissions"), "nothing to refresh from Didit");
});

test("getFredaIdentity: no back for a passport and no repeated Didit calls once that is known", async () => {
  stubStorage([]);
  const f = fakeDb({ tables: { profiles: profile({ kyc_doc_type: "PASSPORT", kyc_doc_back_path: "" }) } });
  const id = await withFake(f, () => L.getFredaIdentity("u1"));
  assert.equal(id?.type, "PASSPORT");
  assert.ok(!("imageBackUrl" in (id ?? {})));
  assert.ok(!f.log.some((r) => r.table === "kyc_submissions"));
});

test("getFredaIdentity: users verified before the back was stored are refreshed from Didit once", async () => {
  stubStorage([]);
  const f = fakeDb({ tables: { profiles: profile({ kyc_doc_back_path: null }) } }); // no kyc_submissions row: nothing to fetch
  const id = await quiet(() => withFake(f, () => L.getFredaIdentity("u1")));
  assert.ok(f.log.some((r) => r.table === "kyc_submissions"), "a refresh was attempted");
  assert.equal(id?.imageUrl, "https://signed.example.com/u1/id-front.jpg?t=1", "the front is still sent");
  assert.ok(!("imageBackUrl" in (id ?? {})));
});

test("getFredaIdentity still works before the kyc_doc_back_path migration is run", async () => {
  stubStorage([]);
  const f = fakeDb({ singles: { profiles: [
    { data: null, error: { message: "column profiles.kyc_doc_back_path does not exist" } },
    { data: profile({ kyc_doc_back_path: undefined }), error: null },
  ] } });
  const id = await quiet(() => withFake(f, () => L.getFredaIdentity("u1")));
  assert.equal(id?.imageUrl, "https://signed.example.com/u1/id-front.jpg?t=1");
  assert.ok(!f.log.some((r) => r.table === "kyc_submissions"), "Didit is not asked again on every call while the column is missing");
});

test("getFredaIdentity: no ID number or no signed URL means no identity", async () => {
  stubStorage([], new Set(["u1/id-front.jpg"]));
  assert.equal(await quiet(() => withFake(fakeDb({ tables: { profiles: profile() } }), () => L.getFredaIdentity("u1"))), null);
  stubStorage([]);
  assert.equal(await withFake(fakeDb({ tables: { profiles: profile({ id_number: null }) } }), () => L.getFredaIdentity("u1")), null);
});

test("migration: kyc_doc_back_path is added idempotently", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261031000000_kyc_doc_back.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.profiles add column if not exists kyc_doc_back_path text/);
});

test("Freda client: Master Wallet endpoint", async () => {
  process.env["FREDA_API_KEY"] = "sk_test_x";
  const realFetch2 = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (u: any) => { url = String(u); return new Response(JSON.stringify({ balance: 100, spendable_usd: 50, guarantee_usd: 50, low_balance: false }), { status: 200 }); }) as any;
  try {
    assert.deepEqual(readMasterWallet(await freda.masterWallet()), { balance: 100, guarantee: 50, spendable: 50, low: false, reservedOnCards: 0, activeCards: 0, mode: null });
    assert.ok(url.endsWith("/v1/master-wallet"));
  } finally { globalThis.fetch = realFetch2; }
});
