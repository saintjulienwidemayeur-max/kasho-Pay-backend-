// Field encryption for sensitive personal data (ID numbers). AES-256-GCM, key in DATA_ENCRYPTION_KEY.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function key(): Buffer {
  const raw = process.env["DATA_ENCRYPTION_KEY"] ?? "";
  const k = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64). Generate: openssl rand -hex 32");
  return k;
}

export const isEncrypted = (v: unknown): boolean => typeof v === "string" && v.startsWith(PREFIX);

export function encryptField(plain: string): string {
  if (isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Legacy plaintext values (no prefix) are returned as they are. */
export function decryptField(v: string | null | undefined): string {
  if (!v) return "";
  if (!isEncrypted(v)) return v;
  const [iv, tag, ct] = v.slice(PREFIX.length).split(":");
  if (!iv || !tag || !ct) throw new Error("Corrupt encrypted field");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

// ------------------------------------------------------------ 4-digit card code (never stored in clear)
import { scryptSync, randomBytes as _rb, timingSafeEqual as _tse, createHmac } from "node:crypto";

const pepper = () => createHmac("sha256", key()).update("kasho-card-code").digest();

/** "scrypt:v1:<salt b64>:<hash b64>". The server key is mixed in, so a leaked table alone cannot be brute forced offline. */
export function hashCardCode(code: string): string {
  const salt = _rb(16);
  const h = scryptSync(Buffer.concat([Buffer.from(code, "utf8"), pepper()]), salt, 32);
  return `scrypt:v1:${salt.toString("base64")}:${h.toString("base64")}`;
}

export function verifyCardCode(code: string, stored: string | null | undefined): boolean {
  if (!stored || !/^\d{4}$/.test(code)) return false;
  const [alg, ver, salt, hash] = stored.split(":");
  if (alg !== "scrypt" || ver !== "v1" || !salt || !hash) return false;
  const h = scryptSync(Buffer.concat([Buffer.from(code, "utf8"), pepper()]), Buffer.from(salt, "base64"), 32);
  const expected = Buffer.from(hash, "base64");
  return h.length === expected.length && _tse(h, expected);
}
