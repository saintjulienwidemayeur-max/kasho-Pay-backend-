// Service-role Supabase client. It bypasses RLS: use it only here on the server.
import "./env.js";
import { createClient } from "@supabase/supabase-js";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const isNewKey = (v: string) => v.startsWith("sb_publishable_") || v.startsWith("sb_secret_");

// New-format Supabase keys are opaque strings, not JWTs: they must not be sent as a Bearer token.
const customFetch: typeof fetch = (input, init) => {
  const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  if (isNewKey(key) && headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
  headers.set("apikey", key);
  return fetch(input, { ...init, headers });
};

export const supabaseAdmin = createClient(url, key, {
  global: { fetch: customFetch },
  auth: { persistSession: false, autoRefreshToken: false },
});
