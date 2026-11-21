-- New Freda card program (tokenized cards, Apple Pay / Google Pay). Run after 20261110000000_support_replies.sql. Safe to run twice.
-- Every customer whose KYC is verified gets a card holder registered at Freda with the complete identity (front and back of the ID).
-- The new issuer verifies that holder (it can take a few minutes): a card can only be created once it is "ready".
alter table public.card_holders add column if not exists verification_status text;      -- needs_profile | pending | ready | failed
alter table public.card_holders add column if not exists failure_reason text;           -- why the holder is not verified (shown to the customer)
alter table public.card_holders add column if not exists program_enrolled_at timestamptz; -- sent to Freda for the new program
alter table public.card_holders add column if not exists last_attempt_at timestamptz;   -- last registration attempt (Freda: 5 per 24 h)
alter table public.card_holders add column if not exists checked_at timestamptz;        -- last time Freda was asked about it
create index if not exists card_holders_verification_idx on public.card_holders (mode, verification_status, checked_at);
