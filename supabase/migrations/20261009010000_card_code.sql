-- 4-digit code required to reveal card details. Only the hash is stored, in a table the browser cannot read.
create table if not exists public.card_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.card_codes enable row level security;
revoke all on public.card_codes from anon, authenticated;
grant all on public.card_codes to service_role;

-- Flag the browser can read ("has a code"); written by the server only.
alter table public.profiles add column if not exists card_code_set boolean not null default false;
