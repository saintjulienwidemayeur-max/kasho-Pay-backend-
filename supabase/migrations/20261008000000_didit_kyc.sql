-- Didit identity verification
alter table public.kyc_submissions add column if not exists didit_session_id text;
create unique index if not exists kyc_didit_session_idx on public.kyc_submissions(didit_session_id) where didit_session_id is not null;
