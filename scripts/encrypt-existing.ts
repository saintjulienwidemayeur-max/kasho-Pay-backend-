// One-off: encrypts ID numbers already stored in plaintext (profiles + card_holders). Safe to run twice.
import "../src/env.js";
import { db } from "../src/ledger.js";
import { encryptField, isEncrypted } from "../src/crypto.js";

for (const table of ["profiles", "card_holders"]) {
  const { data, error } = await db.from(table).select("id, id_number").not("id_number", "is", null);
  if (error) { console.error(table, error.message); process.exit(1); }
  let n = 0;
  for (const r of data ?? []) {
    if (!r.id_number || isEncrypted(r.id_number)) continue;
    const { error: e } = await db.from(table).update({ id_number: encryptField(r.id_number) }).eq("id", r.id);
    if (e) console.error(table, r.id, e.message); else n++;
  }
  console.log(`${table}: ${n} encrypted`);
}
