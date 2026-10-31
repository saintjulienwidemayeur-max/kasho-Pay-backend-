-- Back of the ID document. Freda requires it for some countries (identity.imageBackUrl on POST /v1/cards/holders)
-- and accepts it everywhere else.
--   NULL = not fetched yet from Didit
--   ''   = fetched, this document has no back (a passport)
--   else = path of the image in the private "kyc-docs" bucket
-- Run in Supabase > SQL Editor. Safe to run twice.
alter table public.profiles add column if not exists kyc_doc_back_path text;
