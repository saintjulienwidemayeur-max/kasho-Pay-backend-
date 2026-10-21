-- Security hardening (run after 20261021000000_fee_rules.sql). Safe to run twice.
--
-- 1) The rolling 24h spending caps (transfers, withdrawals) were only checked in the API before the money moved, so
--    parallel requests could all pass the check and exceed the cap. They are now enforced inside the same database
--    transaction that holds the wallet row lock, so the check and the debit cannot be raced.
-- 2) The 4-digit card code lockout lived in server memory (lost on restart, not shared between instances). Failed
--    attempts are now counted in the database.
--
-- Order does not matter: the new parameters have defaults, so the previous backend release keeps working, and the
-- new release falls back to its in-memory lockout if the card code functions are not installed yet.

-- ---------------------------------------------------------------- 1a) kasho_transfer with an atomic daily cap
drop function if exists public.kasho_transfer(uuid, uuid, numeric, text, numeric);
create or replace function public.kasho_transfer(
  p_from uuid, p_to uuid, p_amount numeric, p_note text, p_fee numeric default 0, p_daily_limit numeric default 0
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

  insert into public.transactions (user_id, kind, title, category, method, amount, fee, status, counterparty_id, meta)
  values (p_from, 'transfer_out', coalesce(v_to_name, '@' || v_to_user), 'Transfer', 'Kasho transfer',
          -p_amount, v_fee, 'completed', p_to, jsonb_build_object('username', v_to_user, 'note', coalesce(p_note, '')))
  returning reference into v_ref;

  insert into public.transactions (user_id, kind, title, category, method, amount, status, counterparty_id, meta)
  values (p_to, 'transfer_in', coalesce(v_from_name, '@' || v_from_user), 'Transfer', 'Kasho transfer',
          p_amount, 'completed', p_from, jsonb_build_object('username', v_from_user, 'note', coalesce(p_note, '')));

  return v_ref;
end $$;
revoke all on function public.kasho_transfer(uuid, uuid, numeric, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.kasho_transfer(uuid, uuid, numeric, text, numeric, numeric) to service_role;

-- ---------------------------------------------------------------- 1b) kasho_debit with an atomic daily cap (same kind)
drop function if exists public.kasho_debit(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb);
create or replace function public.kasho_debit(
  p_user uuid, p_kind text, p_title text, p_category text, p_method text,
  p_amount numeric, p_fee numeric, p_status text, p_card uuid,
  p_provider text, p_meta jsonb, p_daily_limit numeric default 0
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_balance numeric;
  v_fee numeric := coalesce(p_fee, 0);
  v_used numeric;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 or v_fee < 0 then raise exception 'INVALID_AMOUNT'; end if;
  select balance into v_balance from public.wallets where user_id = p_user for update;
  if v_balance is null then raise exception 'NO_WALLET'; end if;
  if v_balance < p_amount + v_fee then raise exception 'INSUFFICIENT_FUNDS'; end if;

  if coalesce(p_daily_limit, 0) > 0 then
    select coalesce(sum(greatest(-amount, 0) + fee), 0) into v_used
    from public.transactions
    where user_id = p_user and kind = p_kind and status <> 'failed' and created_at > now() - interval '24 hours';
    if v_used + p_amount > p_daily_limit then raise exception 'DAILY_LIMIT'; end if;
  end if;

  update public.wallets set balance = balance - p_amount - v_fee, updated_at = now()
  where user_id = p_user;

  insert into public.transactions (user_id, kind, title, category, method, amount, fee, status, card_id, provider, meta)
  values (p_user, p_kind, p_title, p_category, coalesce(p_method, ''), -p_amount, v_fee,
          coalesce(p_status, 'pending'), p_card, p_provider, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.kasho_debit(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.kasho_debit(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb, numeric) to service_role;

-- ---------------------------------------------------------------- 2) card code attempts, counted in the database
alter table public.card_codes add column if not exists attempts int not null default 0;
alter table public.card_codes add column if not exists window_started timestamptz;

-- Called BEFORE a code is checked: it consumes one of the 5 attempts allowed per 15 minutes and says whether this attempt
-- may go ahead. Counting up front (under the row lock) means parallel guesses cannot exceed the limit.
create or replace function public.kasho_card_code_attempt(p_user uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_attempts int;
begin
  update public.card_codes
  set attempts = case when window_started is null or window_started <= now() - interval '15 minutes' then 1 else attempts + 1 end,
      window_started = case when window_started is null or window_started <= now() - interval '15 minutes' then now() else window_started end
  where user_id = p_user
  returning attempts into v_attempts;
  if not found then return true; end if; -- no code yet: the caller reports that
  return v_attempts <= 5;
end $$;

-- Called after a correct code, or when the owner sets a new code (which needs password + 2FA).
create or replace function public.kasho_card_code_reset(p_user uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.card_codes set attempts = 0, window_started = null where user_id = p_user;
$$;

revoke all on function public.kasho_card_code_attempt(uuid) from public, anon, authenticated;
revoke all on function public.kasho_card_code_reset(uuid) from public, anon, authenticated;
grant execute on function public.kasho_card_code_attempt(uuid) to service_role;
grant execute on function public.kasho_card_code_reset(uuid) to service_role;
