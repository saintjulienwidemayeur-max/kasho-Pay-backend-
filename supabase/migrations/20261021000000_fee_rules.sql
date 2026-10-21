-- Fee schedule (KASHOPAY LLC billing), stored in the database so an admin page can change it.
-- Run in Supabase > SQL Editor. Safe to run twice (the default fees are only inserted when the table is empty).

-- ---------------------------------------------------------------- admins
-- Who may change fees. Server-only table: add the first admin by hand:
--   insert into public.admins (user_id) values ('<auth user uuid>');
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
grant all on public.admins to service_role;

-- ---------------------------------------------------------------- fee_rules
-- One row per fee. Operations with amount brackets (wallet_deposit, wallet_withdrawal) have one row per bracket;
-- the others have a single row with min_amount / max_amount left empty.
--   fee_type 'flat'    -> fee_value is a USD amount
--   fee_type 'percent' -> fee_value is a percentage of the amount (1.5 = 1.5 %)
-- A bracket matches when min_amount <= amount <= max_amount; where two brackets share a boundary
-- (10 is in both 5-10 and 10-25) the lower bracket wins.
create table if not exists public.fee_rules (
  id uuid primary key default gen_random_uuid(),
  operation text not null check (operation in (
    'card_creation', 'wallet_deposit', 'wallet_withdrawal', 'card_fund', 'card_withdraw', 'transfer'
  )),
  label text not null default '',
  fee_type text not null default 'flat' check (fee_type in ('flat', 'percent')),
  min_amount numeric(14,2) check (min_amount is null or min_amount >= 0),
  max_amount numeric(14,2),
  fee_value numeric(14,4) not null check (fee_value >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  check (fee_type <> 'percent' or fee_value <= 100),
  check ((min_amount is null) = (max_amount is null)),
  check (max_amount is null or max_amount >= min_amount)
);
create index if not exists fee_rules_operation_idx on public.fee_rules(operation, min_amount);

drop trigger if exists fee_rules_set_updated_at on public.fee_rules;
create trigger fee_rules_set_updated_at before update on public.fee_rules
  for each row execute function public.set_updated_at();

-- Server-only: users read the schedule through the API (getPublicConfig), admins change it through the admin endpoints.
alter table public.fee_rules enable row level security;
revoke all on public.fee_rules from anon, authenticated;
grant all on public.fee_rules to service_role;

insert into public.fee_rules (operation, label, fee_type, min_amount, max_amount, fee_value)
select * from (values
  ('card_creation',     'Card creation',            'flat',    null::numeric, null::numeric, 10.00::numeric),

  ('wallet_deposit',    'Wallet top-up $5 - $10',   'flat',    5::numeric,    10::numeric,   0.80::numeric),
  ('wallet_deposit',    'Wallet top-up $10 - $25',  'flat',    10::numeric,   25::numeric,   1.15::numeric),
  ('wallet_deposit',    'Wallet top-up $25 - $50',  'flat',    25::numeric,   50::numeric,   1.50::numeric),
  ('wallet_deposit',    'Wallet top-up $50 - $100', 'flat',    50::numeric,   100::numeric,  2.00::numeric),

  ('wallet_withdrawal', 'Wallet withdrawal $5 - $10',   'flat', 5::numeric,    10::numeric,   0.70::numeric),
  ('wallet_withdrawal', 'Wallet withdrawal $10 - $25',  'flat', 10::numeric,   25::numeric,   1.00::numeric),
  ('wallet_withdrawal', 'Wallet withdrawal $25 - $50',  'flat', 25::numeric,   50::numeric,   1.25::numeric),
  ('wallet_withdrawal', 'Wallet withdrawal $50 - $100', 'flat', 50::numeric,   100::numeric,  1.75::numeric),

  ('card_fund',         'Virtual card top-up',      'flat',    null::numeric, null::numeric, 2.30::numeric),
  ('card_withdraw',     'Virtual card withdrawal',  'flat',    null::numeric, null::numeric, 2.15::numeric),
  ('transfer',          'Kasho to Kasho transfer',  'percent', null::numeric, null::numeric, 1.5::numeric)
) as v(operation, label, fee_type, min_amount, max_amount, fee_value)
where not exists (select 1 from public.fee_rules);

-- ---------------------------------------------------------------- Kasho to Kasho transfer with a fee
-- The sender pays amount + fee; the recipient receives the full amount. Replaces the version without a fee.
drop function if exists public.kasho_transfer(uuid, uuid, numeric, text);
create or replace function public.kasho_transfer(p_from uuid, p_to uuid, p_amount numeric, p_note text, p_fee numeric default 0)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_fee numeric := coalesce(p_fee, 0);
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

revoke all on function public.kasho_transfer(uuid, uuid, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.kasho_transfer(uuid, uuid, numeric, text, numeric) to service_role;
