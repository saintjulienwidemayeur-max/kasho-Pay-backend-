-- Find a Kasho user by full name, e-mail (exact), Kasho ID, @username or phone, for transfers.
-- Called only by the backend (service role). The e-mail is matched exactly so addresses cannot be enumerated.
create or replace function public.kasho_search_users(p_me uuid, p_q text)
returns table (id uuid, username text, display_name text, kasho_id text, email text, phone text)
language sql stable security definer set search_path = public, auth as $$
  with q as (
    select trim(p_q) as raw,
           lower(regexp_replace(trim(p_q), '^@', '')) as handle,
           regexp_replace(trim(p_q), '\D', '', 'g') as digits
  )
  select p.id, p.username, p.display_name, p.kasho_id, u.email::text,
         coalesce(p.phone_code, '') || coalesce(p.phone_number, '')
  from public.profiles p
  join auth.users u on u.id = p.id
  cross join q
  where p.id <> p_me
    and length(q.raw) >= 2
    and (
      lower(u.email) = lower(q.raw)
      or (length(q.handle) >= 2 and left(lower(p.username), length(q.handle)) = q.handle)
      or (length(q.raw) >= 3 and strpos(lower(p.display_name), lower(q.raw)) > 0)
      or upper(p.kasho_id) = upper(q.raw)
      or (length(q.digits) >= 7 and (regexp_replace(coalesce(p.phone_number, ''), '\D', '', 'g') = q.digits
          or regexp_replace(coalesce(p.phone_code, '') || coalesce(p.phone_number, ''), '\D', '', 'g') = q.digits))
    )
  order by (lower(u.email) = lower(q.raw)) desc, p.display_name
  limit 8;
$$;
revoke all on function public.kasho_search_users(uuid, text) from public, anon, authenticated;
grant execute on function public.kasho_search_users(uuid, text) to service_role;
