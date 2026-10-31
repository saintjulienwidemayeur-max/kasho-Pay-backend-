-- Admin panel (run after 20261031000000_kyc_doc_back.sql). Safe to run twice.
--
--   1) admins.role            'super' (everything, incl. moving customer money) or 'admin' (read + fee schedule)
--   2) admin_audit            append-only log of what admins did (nobody, not even the backend, can edit or delete rows)
--   3) app_settings           small key / value store (which Freda plans you are on)
--   4) partner_costs          what Freda Pay Issuing charges YOU per operation, to compute your profit
--   5) card_events            card purchases reported by the card.transaction webhook (Freda charges per purchase)
--   6) kasho_admin_adjust     add / remove money on a customer wallet: one atomic step with the ledger row and the audit row
--   7) kasho_admin_stats      counts and totals for the admin overview
--   8) kasho_admin_users      customer search / list (reads auth.users, so it is a service-role-only function)
--
-- Everything here is server-only: the browser (anon / authenticated) has no access to these tables or functions.

-- ---------------------------------------------------------------- 1) admin roles
alter table public.admins add column if not exists role text not null default 'admin';
do $$ begin
  alter table public.admins add constraint admins_role_check check (role in ('super', 'admin'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- 2) audit log (append only)
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references auth.users(id) on delete set null,
  admin_email text,
  action text not null,
  target_user uuid references auth.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
create index if not exists admin_audit_target_idx on public.admin_audit (target_user, created_at desc);
alter table public.admin_audit enable row level security;
revoke all on public.admin_audit from anon, authenticated;
grant select, insert on public.admin_audit to service_role;
revoke update, delete, truncate on public.admin_audit from service_role;

-- ---------------------------------------------------------------- 3) settings
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant all on public.app_settings to service_role;
insert into public.app_settings (key, value) values
  ('partner_gateway_plan', '"standard"'::jsonb),
  ('partner_issuing_plan', '"startup"'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 4) partner costs (what Freda charges you)
-- One row per operation. The cost of one operation of `amount` USD is:
--   threshold_usd is null  ->  percent % of amount  +  flat_usd  +  flat_htg / rate
--   threshold_usd is set   ->  flat_usd when amount <= threshold_usd, otherwise percent % of amount
-- Defaults: Freda's public price list, Gateway plan "Standard" and Issuing plan "Startup" (editable in the admin page).
create table if not exists public.partner_costs (
  operation text primary key check (operation in (
    'deposit', 'withdrawal', 'card_creation', 'card_fund', 'card_withdraw', 'card_closure', 'card_purchase', 'master_wallet_funding'
  )),
  label text not null default '',
  percent numeric(8,4) not null default 0 check (percent >= 0 and percent <= 100),
  flat_usd numeric(12,4) not null default 0 check (flat_usd >= 0),
  flat_htg numeric(12,2) not null default 0 check (flat_htg >= 0),
  threshold_usd numeric(12,2) check (threshold_usd is null or threshold_usd >= 0),
  active boolean not null default true,
  note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
drop trigger if exists partner_costs_set_updated_at on public.partner_costs;
create trigger partner_costs_set_updated_at before update on public.partner_costs
  for each row execute function public.set_updated_at();
alter table public.partner_costs enable row level security;
revoke all on public.partner_costs from anon, authenticated;
grant all on public.partner_costs to service_role;

insert into public.partner_costs (operation, label, percent, flat_usd, flat_htg, threshold_usd, note)
select * from (values
  ('deposit',               'MonCash / NatCash payment (Gateway)',  6::numeric,   0::numeric,    10::numeric, null::numeric, '6 % + 10 HTG per payment (Standard plan)'),
  ('withdrawal',            'MonCash / NatCash payout',             5::numeric,   0::numeric,    0::numeric,  null::numeric, '5 % of the amount sent'),
  ('card_creation',         'Card creation',                        0::numeric,   5::numeric,    0::numeric,  null::numeric, '$5.00 per card (Startup plan)'),
  ('card_fund',             'Card top-up',                          3::numeric,   1.6::numeric,  0::numeric,  100::numeric,  '$1.60 up to $100, then 3 % (Startup plan)'),
  ('card_withdraw',         'Card withdrawal',                      0::numeric,   1.3::numeric,  0::numeric,  null::numeric, '$1.30 per withdrawal (Startup plan)'),
  ('card_closure',          'Card closing',                         0::numeric,   0.5::numeric,  0::numeric,  null::numeric, '$0.50, never more than what is left on the card'),
  ('card_purchase',         'Card purchase',                        0::numeric,   0.1::numeric,  0::numeric,  null::numeric, '$0.10 per purchase (Startup plan)'),
  ('master_wallet_funding', 'Adding money to the Master Wallet',    4.5::numeric, 0::numeric,    0::numeric,  null::numeric, '4.5 % of the money added (Startup plan)')
) as v(operation, label, percent, flat_usd, flat_htg, threshold_usd, note)
where not exists (select 1 from public.partner_costs);

-- ---------------------------------------------------------------- 5) card purchases (card.transaction webhook)
create table if not exists public.card_events (
  id text primary key,                     -- Freda's id of the movement: a replayed webhook is ignored
  card_id uuid references public.cards(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  type text not null default '',
  amount numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists card_events_created_idx on public.card_events (created_at desc);
alter table public.card_events enable row level security;
revoke all on public.card_events from anon, authenticated;
grant all on public.card_events to service_role;

-- ---------------------------------------------------------------- 6) add / remove money on a customer wallet
-- Atomic: wallet row lock, balance change, ledger row (kind admin_credit / admin_debit) and audit row in one transaction.
-- Only a 'super' admin may call it (checked here too, not only in the API), never on their own account, never below 0.
create or replace function public.kasho_admin_adjust(
  p_admin uuid, p_user uuid, p_credit boolean, p_amount numeric, p_note text, p_ip text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amount numeric := round(p_amount, 2);
  v_note text := left(trim(coalesce(p_note, '')), 200);
  v_before numeric;
  v_after numeric;
  v_ref text;
  v_email text;
begin
  if v_amount is null or v_amount <= 0 or v_amount > 1000000 then raise exception 'INVALID_AMOUNT'; end if;
  if length(v_note) < 3 then raise exception 'NOTE_REQUIRED'; end if;
  if not exists (select 1 from public.admins where user_id = p_admin and role = 'super') then raise exception 'NOT_ALLOWED'; end if;
  if p_admin = p_user then raise exception 'SELF_ADJUST'; end if;

  select balance into v_before from public.wallets where user_id = p_user for update;
  if v_before is null then raise exception 'NO_WALLET'; end if;
  if not p_credit and v_before < v_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  v_after := v_before + case when p_credit then v_amount else -v_amount end;

  update public.wallets set balance = v_after, updated_at = now() where user_id = p_user;

  insert into public.transactions (user_id, kind, title, category, method, amount, fee, status, provider, meta)
  values (p_user, case when p_credit then 'admin_credit' else 'admin_debit' end,
          case when p_credit then 'Added by Kasho Pay' else 'Removed by Kasho Pay' end,
          'Adjustment', 'Kasho Pay', case when p_credit then v_amount else -v_amount end, 0, 'completed', 'admin',
          jsonb_build_object('admin_id', p_admin, 'note', v_note))
  returning reference into v_ref;

  select email into v_email from auth.users where id = p_admin;
  insert into public.admin_audit (admin_id, admin_email, action, target_user, details, ip)
  values (p_admin, v_email, case when p_credit then 'balance_credit' else 'balance_debit' end, p_user,
          jsonb_build_object('amount', v_amount, 'note', v_note, 'balance_before', v_before, 'balance_after', v_after, 'reference', v_ref), p_ip);

  return jsonb_build_object('reference', v_ref, 'balance_before', v_before, 'balance_after', v_after);
end $$;

-- ---------------------------------------------------------------- 7) overview numbers
create or replace function public.kasho_admin_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'users_total',      (select count(*) from public.profiles),
    'users_new',        (select count(*) from public.profiles where created_at >= p_from and created_at < p_to),
    'users_verified',   (select count(*) from public.profiles where kyc_status = 'verified'),
    'users_kyc_pending',(select count(*) from public.profiles where kyc_status = 'pending'),
    'wallets_total',    (select coalesce(sum(balance), 0) from public.wallets),
    'wallets_funded',   (select count(*) from public.wallets where balance > 0),
    'cards_total',      (select count(*) from public.cards where status in ('pending', 'active', 'disabled')),
    'cards_active',     (select count(*) from public.cards where status = 'active'),
    'cards_balance',    (select coalesce(sum(balance), 0) from public.cards where status in ('active', 'disabled')),
    'tx_pending',       (select count(*) from public.transactions where status = 'pending'),
    'tx_pending_old',   (select count(*) from public.transactions where status = 'pending' and created_at < now() - interval '1 hour'),
    'tx_failed',        (select count(*) from public.transactions where status = 'failed' and created_at >= p_from and created_at < p_to),
    'adjust_credits',   (select coalesce(sum(amount), 0) from public.transactions where kind = 'admin_credit' and status = 'completed' and created_at >= p_from and created_at < p_to),
    'adjust_debits',    (select coalesce(sum(-amount), 0) from public.transactions where kind = 'admin_debit' and status = 'completed' and created_at >= p_from and created_at < p_to),
    'card_purchases',   (select count(*) from public.card_events where created_at >= p_from and created_at < p_to and upper(type) not in ('CREDIT', 'REFUND', 'REVERSAL', 'DECLINE', 'DECLINED')),
    'card_events_since',(select min(created_at) from public.card_events)
  );
$$;

-- ---------------------------------------------------------------- 8) customer list / search
-- Matches e-mail, name, @username, Kasho ID or phone digits (plain substring, no wildcards). Newest customers first.
create or replace function public.kasho_admin_users(p_q text, p_limit integer default 25, p_offset integer default 0)
returns table (
  id uuid, email text, display_name text, username text, kasho_id text, phone text, kyc_status text, balance numeric,
  cards integer, created_at timestamptz, last_sign_in_at timestamptz, banned boolean, admin_role text, total bigint
) language sql stable security definer set search_path = public, auth, pg_temp as $$
  with q as (
    select nullif(lower(trim(coalesce(p_q, ''))), '') as raw,
           regexp_replace(coalesce(p_q, ''), '\D', '', 'g') as digits
  )
  select p.id, u.email::text, p.display_name, p.username, p.kasho_id,
         coalesce(p.phone_code, '') || coalesce(p.phone_number, ''), p.kyc_status, coalesce(w.balance, 0),
         (select count(*)::integer from public.cards c where c.user_id = p.id and c.status in ('pending', 'active', 'disabled')),
         p.created_at, u.last_sign_in_at, (u.banned_until is not null and u.banned_until > now()),
         (select a.role from public.admins a where a.user_id = p.id),
         count(*) over ()
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.wallets w on w.user_id = p.id
  cross join q
  where q.raw is null
     or strpos(lower(coalesce(u.email, '')), q.raw) > 0
     or strpos(lower(coalesce(p.display_name, '')), q.raw) > 0
     or strpos(lower(coalesce(p.username, '')), regexp_replace(q.raw, '^@', '')) > 0
     or strpos(lower(coalesce(p.kasho_id, '')), q.raw) > 0
     or (length(q.digits) >= 4 and strpos(regexp_replace(coalesce(p.phone_code, '') || coalesce(p.phone_number, ''), '\D', '', 'g'), q.digits) > 0)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.kasho_admin_adjust(uuid, uuid, boolean, numeric, text, text) from public, anon, authenticated;
revoke all on function public.kasho_admin_stats(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.kasho_admin_users(text, integer, integer) from public, anon, authenticated;
grant execute on function public.kasho_admin_adjust(uuid, uuid, boolean, numeric, text, text) to service_role;
grant execute on function public.kasho_admin_stats(timestamptz, timestamptz) to service_role;
grant execute on function public.kasho_admin_users(text, integer, integer) to service_role;
