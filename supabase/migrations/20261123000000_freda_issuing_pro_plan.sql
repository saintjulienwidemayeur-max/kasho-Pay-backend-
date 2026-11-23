-- Freda Issuing plan PRO, new card program prices (https://issuing.fredapay.com/tarifs, 26 Oct 2026). Run after 20261121000000_card_program.sql.
-- Safe to run twice. These prices feed the ESTIMATES of the admin "Benefits" tab (what Freda charges us for what it does not report).
-- The monthly subscription (150 $) and the maintenance of 0.50 $ per active card (taken from the card) are not per operation: not counted.
insert into public.partner_costs (operation, label, percent, flat_usd, flat_htg, threshold_usd, active, note) values
  ('card_creation',         'Card creation',                      0,   2.00, 0, null, true, 'Pro plan: $2.00 per card (taken from the prefund in the new program)'),
  ('card_fund',             'Card top-up',                        0,   0.50, 0, null, true, 'Pro plan: $0.50 per top-up'),
  ('card_withdraw',         'Card withdrawal',                    2.0, 0,    0, null, true, 'Pro plan: 2.0 % of the amount withdrawn'),
  ('card_purchase',         'Card purchase',                      0,   0,    0, null, true, 'Pro plan: free (0 %)'),
  ('master_wallet_funding', 'Adding money to the Master Wallet',  2.7, 0,    0, null, true, 'Pro plan: 2.7 % of the money added (minimum 200 $ per top-up in the new program)')
on conflict (operation) do update set
  label = excluded.label, percent = excluded.percent, flat_usd = excluded.flat_usd, flat_htg = excluded.flat_htg,
  threshold_usd = excluded.threshold_usd, active = excluded.active, note = excluded.note, updated_at = now();

insert into public.app_settings (key, value) values ('partner_issuing_plan', '"pro"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
