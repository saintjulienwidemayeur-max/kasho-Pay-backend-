-- Web Push subscriptions (run after 20261021020000_remaining_fixes.sql). Safe to run twice.
-- Server-only table: the browser never reads or writes it; the backend (service role) does everything.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  lang text not null default 'fr' check (lang in ('fr','en')),
  tz text not null default 'America/Port-au-Prince',
  user_agent text,
  last_greeting_on date,
  failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

drop trigger if exists push_subscriptions_set_updated_at on public.push_subscriptions;
create trigger push_subscriptions_set_updated_at before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) can touch this table.
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;
