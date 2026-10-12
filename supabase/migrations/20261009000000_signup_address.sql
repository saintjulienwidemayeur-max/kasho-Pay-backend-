-- Sign up now collects the country and full address; the profile trigger stores them.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  base text;
  uname text;
  dob date;
  ctry text;
begin
  base := 'kp' || substr(md5(random()::text || clock_timestamp()::text || new.id::text), 1, 8);
  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    uname := 'kp' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  end loop;

  if (meta->>'date_of_birth') ~ '^\d{4}-\d{2}-\d{2}$' then
    dob := (meta->>'date_of_birth')::date;
  end if;
  if (meta->>'country') ~ '^[A-Za-z]{2}$' then
    ctry := upper(meta->>'country');
  end if;

  insert into public.profiles (id, username, display_name, first_name, last_name, phone_code, phone_number, date_of_birth,
                               country, address_street, address_city, address_state, address_postal_code)
  values (
    new.id, uname,
    left(trim(coalesce(meta->>'first_name', '') || ' ' || coalesce(meta->>'last_name', '')), 80),
    left(nullif(meta->>'first_name', ''), 60), left(nullif(meta->>'last_name', ''), 60),
    coalesce(nullif(left(meta->>'phone_code', 6), ''), '+509'), left(nullif(meta->>'phone_number', ''), 20),
    dob, ctry,
    left(nullif(meta->>'address_street', ''), 120), left(nullif(meta->>'address_city', ''), 80),
    left(nullif(meta->>'address_state', ''), 80), left(nullif(meta->>'address_postal_code', ''), 20)
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
