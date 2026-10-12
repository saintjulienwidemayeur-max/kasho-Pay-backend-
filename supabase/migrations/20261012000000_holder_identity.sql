-- Freda Pay Issuing now requires an official ID document (type, number, https image) for each card holder.
alter table public.profiles add column if not exists kyc_doc_type text;
alter table public.profiles add column if not exists kyc_doc_path text;
alter table public.card_holders add column if not exists identity_sent boolean not null default false;

-- Private bucket for the ID document image copied from Didit (served to Freda through short-lived signed URLs).
insert into storage.buckets (id, name, public) values ('kyc-docs', 'kyc-docs', false) on conflict (id) do nothing;
