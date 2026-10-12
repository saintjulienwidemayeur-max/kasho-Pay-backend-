-- Once identity is verified, the customer can no longer change their name from the app.
-- Only the server (service role, e.g. the KYC decision) may write these fields.
create or replace function public.lock_verified_name()
returns trigger
language plpgsql
as $$
begin
  if old.kyc_status = 'verified'
     and coalesce(auth.role(), '') <> 'service_role'
     and (new.first_name is distinct from old.first_name
          or new.last_name is distinct from old.last_name
          or new.display_name is distinct from old.display_name) then
    raise exception 'Your name cannot be changed after identity verification.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_lock_verified_name on public.profiles;
create trigger profiles_lock_verified_name
  before update on public.profiles
  for each row execute function public.lock_verified_name();
