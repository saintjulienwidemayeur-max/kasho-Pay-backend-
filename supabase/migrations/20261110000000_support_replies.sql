-- Support replies (run after 20261101000000_admin_panel.sql). Safe to run twice.
-- An administrator answers a customer's help message or dispute from the admin site (Support tab): the reply is kept on the row
-- and the customer gets an in-app notification (and a push if enabled). Only the backend (service role) writes these columns.
alter table public.support_messages add column if not exists reply text;
alter table public.support_messages add column if not exists replied_at timestamptz;
alter table public.support_messages add column if not exists replied_by uuid references auth.users(id) on delete set null;

alter table public.disputes add column if not exists reply text;
alter table public.disputes add column if not exists replied_at timestamptz;
alter table public.disputes add column if not exists replied_by uuid references auth.users(id) on delete set null;
