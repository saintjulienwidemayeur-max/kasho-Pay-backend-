-- Lets a customer remove a terminated card from their card list (the row is kept for history).
alter table public.cards add column if not exists hidden boolean not null default false;
