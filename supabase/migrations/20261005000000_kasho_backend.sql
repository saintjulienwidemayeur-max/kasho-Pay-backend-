-- Kasho Pay backend schema.
-- Run once in Supabase Dashboard > SQL Editor (or `supabase db push`). Safe to re-run.
--
-- Security model:
--   * The browser can only READ its own rows (RLS select policies).
--   * Every money movement goes through server functions using the service role
--     and the SECURITY DEFINER functions below (not callable by anon/authenticated).

create sequence if not exists public.kasho_id_seq start 1000;

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  username text not null unique,
  avatar_url text,
  preferred_currency text not null default 'USD',
  notifications_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists phone_code text not null default '+509';
alter table public.profiles add column if not exists phone_number text;
alter table public.profiles add column if not exists date_of_birth date;
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists address_street text;
alter table public.profiles add column if not exists address_city text;
alter table public.profiles add column if not exists address_state text;
alter table public.profiles add column if not exists address_postal_code text;
alter table public.profiles add column if not exists id_type text;
alter table public.profiles add column if not exists id_number text;
alter table public.profiles add column if not exists kyc_status text not null default 'unverified';
alter table public.profiles add column if not exists kyc_reference text;
alter table public.profiles add column if not exists kasho_id text unique default ('KP-' || lpad(nextval('public.kasho_id_seq')::text, 6, '0'));
alter table public.profiles add column if not exists notification_prefs jsonb not null default '{"push":true,"email":true,"sms":false}'::jsonb;
alter table public.profiles add column if not exists freda_holder_id text;
alter table public.profiles add column if not exists freda_holder_mode text;
alter table public.profiles add column if not exists freda_holder_created boolean not null default false;
alter table public.profiles add column if not exists card_email text;

do $$ begin
  alter table public.profiles add constraint profiles_kyc_status_check
    check (kyc_status in ('unverified','pending','verified','rejected'));
exception when duplicate_object then null; end $$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- wallets
create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(14,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- cards
create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  freda_card_id text unique,
  reference text not null unique,
  label text not null default 'Kasho virtual debit',
  color text not null default 'mint',
  brand text not null default 'VISA',
  status text not null default 'pending'
    check (status in ('pending','active','disabled','failed','terminated')),
  last4 text,
  expiry text,
  balance numeric(14,2) not null default 0,
  creation_tx_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cards_user_idx on public.cards(user_id, created_at);
drop trigger if exists cards_set_updated_at on public.cards;
create trigger cards_set_updated_at before update on public.cards
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- transactions
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique default (
    'KP-' || to_char(now(), 'YYMMDD') || '-' ||
    upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))
  ),
  kind text not null,
  title text not null,
  category text not null,
  method text not null default '',
  amount numeric(14,2) not null,           -- signed USD (negative = money out)
  fee numeric(14,2) not null default 0 check (fee >= 0),
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  card_id uuid references public.cards(id) on delete set null,
  counterparty_id uuid,
  provider text,
  provider_ref text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists transactions_user_idx on public.transactions(user_id, created_at desc);
create index if not exists transactions_provider_ref_idx on public.transactions(provider_ref);
drop trigger if exists transactions_set_updated_at on public.transactions;
create trigger transactions_set_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- disputes
create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_ref text not null,
  title text not null default '',
  amount numeric(14,2) not null default 0,
  reason text not null,
  note text not null default '',
  reference text not null unique,
  created_at timestamptz not null default now(),
  unique (user_id, transaction_ref)
);

-- ---------------------------------------------------------------- notifications
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text not null default '',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);

-- ---------------------------------------------------------------- activity log
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event text not null,
  detail text not null default '',
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists activity_user_idx on public.activity_log(user_id, created_at desc);

-- ---------------------------------------------------------------- KYC
create table if not exists public.kyc_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  doc_type text not null,
  document_path text not null,
  selfie_path text not null,
  reviewer_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists kyc_user_idx on public.kyc_submissions(user_id, created_at desc);

-- ---------------------------------------------------------------- support + webhooks
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id text primary key,
  event text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- new user trigger
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  base text;
  uname text;
  dob date;
begin
  base := left(regexp_replace(lower(split_part(coalesce(new.email, 'user'), '@', 1)), '[^a-z0-9]', '', 'g'), 12);
  if base = '' then base := 'user'; end if;
  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    uname := base || floor(random() * 9000 + 1000)::int;
  end loop;

  if (meta->>'date_of_birth') ~ '^\d{4}-\d{2}-\d{2}$' then
    dob := (meta->>'date_of_birth')::date;
  end if;

  insert into public.profiles (id, username, display_name, first_name, last_name, phone_code, phone_number, date_of_birth)
  values (
    new.id, uname,
    trim(coalesce(meta->>'first_name', '') || ' ' || coalesce(meta->>'last_name', '')),
    nullif(meta->>'first_name', ''), nullif(meta->>'last_name', ''),
    coalesce(nullif(meta->>'phone_code', ''), '+509'), nullif(meta->>'phone_number', ''),
    dob
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill for users created before this migration
insert into public.profiles (id, username)
select u.id, 'user' || substr(replace(u.id::text, '-', ''), 1, 8)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

insert into public.wallets (user_id)
select u.id from auth.users u
where not exists (select 1 from public.wallets w where w.user_id = u.id);

-- ---------------------------------------------------------------- ledger functions
-- Debit the wallet (balance check + row lock) and record the transaction atomically.
create or replace function public.kasho_debit(
  p_user uuid, p_kind text, p_title text, p_category text, p_method text,
  p_amount numeric, p_fee numeric, p_status text, p_card uuid,
  p_provider text, p_meta jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_fee numeric := coalesce(p_fee, 0);
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 or v_fee < 0 then raise exception 'INVALID_AMOUNT'; end if;
  select balance into v_balance from public.wallets where user_id = p_user for update;
  if v_balance is null then raise exception 'NO_WALLET'; end if;
  if v_balance < p_amount + v_fee then raise exception 'INSUFFICIENT_FUNDS'; end if;

  update public.wallets set balance = balance - p_amount - v_fee, updated_at = now()
  where user_id = p_user;

  insert into public.transactions (user_id, kind, title, category, method, amount, fee, status, card_id, provider, meta)
  values (p_user, p_kind, p_title, p_category, coalesce(p_method, ''), -p_amount, v_fee,
          coalesce(p_status, 'pending'), p_card, p_provider, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

-- Mark a pending transaction completed. Credits the wallet exactly once for money-in rows.
create or replace function public.kasho_complete_tx(p_tx uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.transactions%rowtype;
begin
  update public.transactions set status = 'completed', updated_at = now()
  where id = p_tx and status = 'pending'
  returning * into r;
  if not found then return false; end if;
  if r.amount > 0 then
    update public.wallets set balance = balance + r.amount - r.fee, updated_at = now()
    where user_id = r.user_id;
  end if;
  return true;
end $$;

-- Mark a pending transaction failed. Gives the money back exactly once for money-out rows.
create or replace function public.kasho_fail_tx(p_tx uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.transactions%rowtype;
begin
  update public.transactions
  set status = 'failed',
      meta = meta || jsonb_build_object('failure_reason', coalesce(p_reason, '')),
      updated_at = now()
  where id = p_tx and status = 'pending'
  returning * into r;
  if not found then return false; end if;
  if r.amount < 0 then
    update public.wallets set balance = balance + (-r.amount) + r.fee, updated_at = now()
    where user_id = r.user_id;
  end if;
  return true;
end $$;

-- Kasho to Kasho transfer: both ledger rows and both balances in one transaction.
create or replace function public.kasho_transfer(p_from uuid, p_to uuid, p_amount numeric, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_ref text;
  v_from_name text; v_from_user text;
  v_to_name text; v_to_user text;
begin
  if p_from = p_to then raise exception 'SELF_TRANSFER'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  perform 1 from public.wallets where user_id in (p_from, p_to) order by user_id for update;
  if not exists (select 1 from public.wallets where user_id = p_to) then
    raise exception 'RECIPIENT_NOT_FOUND';
  end if;
  select balance into v_balance from public.wallets where user_id = p_from;
  if v_balance is null or v_balance < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;

  select nullif(trim(display_name), ''), username into v_from_name, v_from_user from public.profiles where id = p_from;
  select nullif(trim(display_name), ''), username into v_to_name, v_to_user from public.profiles where id = p_to;

  update public.wallets set balance = balance - p_amount, updated_at = now() where user_id = p_from;
  update public.wallets set balance = balance + p_amount, updated_at = now() where user_id = p_to;

  insert into public.transactions (user_id, kind, title, category, method, amount, status, counterparty_id, meta)
  values (p_from, 'transfer_out', coalesce(v_to_name, '@' || v_to_user), 'Transfer', 'Kasho transfer',
          -p_amount, 'completed', p_to, jsonb_build_object('username', v_to_user, 'note', coalesce(p_note, '')))
  returning reference into v_ref;

  insert into public.transactions (user_id, kind, title, category, method, amount, status, counterparty_id, meta)
  values (p_to, 'transfer_in', coalesce(v_from_name, '@' || v_from_user), 'Transfer', 'Kasho transfer',
          p_amount, 'completed', p_from, jsonb_build_object('username', v_from_user, 'note', coalesce(p_note, '')));

  return v_ref;
end $$;

revoke all on function public.kasho_debit(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.kasho_complete_tx(uuid) from public, anon, authenticated;
revoke all on function public.kasho_fail_tx(uuid, text) from public, anon, authenticated;
revoke all on function public.kasho_transfer(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.kasho_debit(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb) to service_role;
grant execute on function public.kasho_complete_tx(uuid) to service_role;
grant execute on function public.kasho_fail_tx(uuid, text) to service_role;
grant execute on function public.kasho_transfer(uuid, uuid, numeric, text) to service_role;

-- ---------------------------------------------------------------- RLS + grants
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.cards enable row level security;
alter table public.transactions enable row level security;
alter table public.disputes enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_log enable row level security;
alter table public.kyc_submissions enable row level security;
alter table public.support_messages enable row level security;
alter table public.webhook_events enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
drop policy if exists "Users can create their own profile" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
drop policy if exists "Users can delete their own profile" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- The browser may only edit harmless profile fields. kyc_status, ids, holder ids are server-only.
revoke all on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, first_name, last_name, phone_code, phone_number, avatar_url,
              notifications_enabled, notification_prefs) on public.profiles to authenticated;
grant all on public.profiles to service_role;

do $$
declare t text;
begin
  foreach t in array array['wallets','cards','transactions','disputes','activity_log','kyc_submissions'] loop
    execute format('drop policy if exists "%1$s_select_own" on public.%1$s', t);
    execute format('create policy "%1$s_select_own" on public.%1$s for select to authenticated using (auth.uid() = user_id)', t);
    execute format('revoke all on public.%1$s from authenticated', t);
    execute format('grant select on public.%1$s to authenticated', t);
    execute format('grant all on public.%1$s to service_role', t);
  end loop;
end $$;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications for select to authenticated using (auth.uid() = user_id);
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.notifications from authenticated;
grant select on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;
grant all on public.notifications to service_role;

grant all on public.support_messages to service_role;
grant all on public.webhook_events to service_role;
grant usage, select on sequence public.kasho_id_seq to service_role;

-- ---------------------------------------------------------------- card holders (Freda Issuing)
create table if not exists public.card_holders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  freda_holder_id text,
  mode text not null default 'sandbox',
  email text not null,
  first_name text not null,
  last_name text not null,
  dob date,
  country text,
  id_number text,
  phone_code text,
  phone_number text,
  address_street text,
  address_city text,
  address_state text,
  address_postal_code text,
  status text not null default 'enrolled',
  created_at timestamptz not null default now()
);
create index if not exists card_holders_user_idx on public.card_holders(user_id, created_at desc);
alter table public.card_holders enable row level security;
drop policy if exists "card_holders_select_own" on public.card_holders;
create policy "card_holders_select_own" on public.card_holders for select to authenticated using (auth.uid() = user_id);
revoke all on public.card_holders from authenticated;
grant select on public.card_holders to authenticated;
grant all on public.card_holders to service_role;
do $$ begin
  alter publication supabase_realtime add table public.card_holders;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- storage (private KYC documents)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-documents', 'kyc-documents', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "kyc_upload_own_folder" on storage.objects;
create policy "kyc_upload_own_folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "kyc_read_own_folder" on storage.objects;
create policy "kyc_read_own_folder" on storage.objects for select to authenticated
  using (bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------- realtime (live balance / notifications)
do $$
declare t text;
begin
  foreach t in array array['notifications', 'wallets', 'transactions', 'cards'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ================================================================ SECURITY HARDENING (safe to re-run)
-- 1) Usernames must not reveal the e-mail address: new accounts get a random "kp" + 8 hex username.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  base text;
  uname text;
  dob date;
begin
  base := 'kp' || substr(md5(random()::text || clock_timestamp()::text || new.id::text), 1, 8);
  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    uname := 'kp' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  end loop;

  if (meta->>'date_of_birth') ~ '^\d{4}-\d{2}-\d{2}$' then
    dob := (meta->>'date_of_birth')::date;
  end if;

  insert into public.profiles (id, username, display_name, first_name, last_name, phone_code, phone_number, date_of_birth)
  values (
    new.id, uname,
    left(trim(coalesce(meta->>'first_name', '') || ' ' || coalesce(meta->>'last_name', '')), 80),
    left(nullif(meta->>'first_name', ''), 60), left(nullif(meta->>'last_name', ''), 60),
    coalesce(nullif(left(meta->>'phone_code', 6), ''), '+509'), left(nullif(meta->>'phone_number', ''), 20),
    dob
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- OPTIONAL (not run automatically): give EXISTING users a random username too. Old QR links stop working.
--   update public.profiles set username = 'kp' || substr(md5(random()::text || id::text), 1, 8)
--   where username !~ '^kp[0-9a-f]{8}$';

-- 2) Limits on the few columns the browser may edit itself (NOT VALID = old rows are not re-checked).
do $$ begin
  alter table public.profiles add constraint profiles_display_name_len check (char_length(display_name) <= 80) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_avatar_https check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500)) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_prefs_size check (pg_column_size(notification_prefs) <= 256) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint profiles_phone_len check (char_length(coalesce(phone_number, '')) <= 20 and char_length(coalesce(phone_code, '')) <= 6) not valid;
exception when duplicate_object then null; end $$;

-- 3) Wallet can never go negative, even through a bug (already enforced for wallets; make it explicit for cards).
do $$ begin
  alter table public.cards add constraint cards_balance_nonneg check (balance >= 0) not valid;
exception when duplicate_object then null; end $$;
