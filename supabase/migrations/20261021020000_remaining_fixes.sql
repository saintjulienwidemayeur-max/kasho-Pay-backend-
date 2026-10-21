-- Remaining security / reliability fixes (run after 20261021010000_security_hardening.sql). Safe to run twice.
--
-- 1) Retry-safe transfers: transactions.idempotency_key + unique (user_id, key), set inside kasho_transfer.
-- 2) The legacy `kyc-documents` storage policies are dropped (the backend uses the private `kyc-docs` bucket, which
--    only the service role can read or write).

-- ---------------------------------------------------------------- 1) idempotent transfers
alter table public.transactions add column if not exists idempotency_key text;
create unique index if not exists transactions_user_idempotency_key_uidx
  on public.transactions (user_id, idempotency_key) where idempotency_key is not null;

-- Same logic as 20261021010000_security_hardening.sql (fee + atomic daily cap) plus p_idempotency_key. A second call with
-- the same key for the same sender fails with unique_violation (23505) BEFORE any balance is changed (the whole function
-- rolls back); the API then looks up and returns the original reference.
drop function if exists public.kasho_transfer(uuid, uuid, numeric, text, numeric, numeric);
create or replace function public.kasho_transfer(
  p_from uuid, p_to uuid, p_amount numeric, p_note text, p_fee numeric default 0, p_daily_limit numeric default 0,
  p_idempotency_key text default null
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance numeric;
  v_fee numeric := coalesce(p_fee, 0);
  v_used numeric;
  v_ref text;
  v_from_name text; v_from_user text;
  v_to_name text; v_to_user text;
begin
  if p_from = p_to then raise exception 'SELF_TRANSFER'; end if;
  if p_amount is null or p_amount <= 0 or v_fee < 0 then raise exception 'INVALID_AMOUNT'; end if;

  perform 1 from public.wallets where user_id in (p_from, p_to) order by user_id for update;
  if not exists (select 1 from public.wallets where user_id = p_to) then
    raise exception 'RECIPIENT_NOT_FOUND';
  end if;
  select balance into v_balance from public.wallets where user_id = p_from;
  if v_balance is null or v_balance < p_amount + v_fee then raise exception 'INSUFFICIENT_FUNDS'; end if;

  -- The sender's wallet row is locked above, so concurrent transfers of the same sender are serialized here.
  if coalesce(p_daily_limit, 0) > 0 then
    select coalesce(sum(greatest(-amount, 0) + fee), 0) into v_used
    from public.transactions
    where user_id = p_from and kind = 'transfer_out' and status <> 'failed' and created_at > now() - interval '24 hours';
    if v_used + p_amount > p_daily_limit then raise exception 'DAILY_LIMIT'; end if;
  end if;

  select nullif(trim(display_name), ''), username into v_from_name, v_from_user from public.profiles where id = p_from;
  select nullif(trim(display_name), ''), username into v_to_name, v_to_user from public.profiles where id = p_to;

  update public.wallets set balance = balance - p_amount - v_fee, updated_at = now() where user_id = p_from;
  update public.wallets set balance = balance + p_amount, updated_at = now() where user_id = p_to;

  insert into public.transactions (user_id, kind, title, category, method, amount, fee, status, counterparty_id, meta, idempotency_key)
  values (p_from, 'transfer_out', coalesce(v_to_name, '@' || v_to_user), 'Transfer', 'Kasho transfer',
          -p_amount, v_fee, 'completed', p_to, jsonb_build_object('username', v_to_user, 'note', coalesce(p_note, '')),
          nullif(p_idempotency_key, ''))
  returning reference into v_ref;

  insert into public.transactions (user_id, kind, title, category, method, amount, status, counterparty_id, meta)
  values (p_to, 'transfer_in', coalesce(v_from_name, '@' || v_from_user), 'Transfer', 'Kasho transfer',
          p_amount, 'completed', p_from, jsonb_build_object('username', v_from_user, 'note', coalesce(p_note, '')));

  return v_ref;
end $$;
revoke all on function public.kasho_transfer(uuid, uuid, numeric, text, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.kasho_transfer(uuid, uuid, numeric, text, numeric, numeric, text) to service_role;

-- ---------------------------------------------------------------- 2) drop the legacy kyc-documents policies
-- The identity photos now live in the private `kyc-docs` bucket, written and read only by the backend (service role).
-- Nothing uploads from the browser any more, so the per-user policies on the old bucket only widen the attack surface.
drop policy if exists "kyc_upload_own_folder" on storage.objects;
drop policy if exists "kyc_read_own_folder" on storage.objects;
