-- Once identity is verified, the whole "Personal information" section is read-only for the customer:
-- name (already locked) plus phone and address. Only the server (service role) may change them.
-- Run in Supabase > SQL Editor. Safe to run twice.
create or replace function public.lock_verified_name()
returns trigger
language plpgsql
as $$
begin
  if old.kyc_status = 'verified'
     and coalesce(auth.role(), '') <> 'service_role'
     and (new.first_name is distinct from old.first_name
          or new.last_name is distinct from old.last_name
          or new.display_name is distinct from old.display_name
          or new.phone_code is distinct from old.phone_code
          or new.phone_number is distinct from old.phone_number
          or new.address_street is distinct from old.address_street
          or new.address_city is distinct from old.address_city
          or new.address_state is distinct from old.address_state
          or new.address_postal_code is distinct from old.address_postal_code) then
    raise exception 'Your personal information cannot be changed after identity verification.' using errcode = '42501';
  end if;
  return new;
end;
$$;
