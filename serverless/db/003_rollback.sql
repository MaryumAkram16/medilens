-- Rolls back 003_voice.sql. Fails if a complaint without an email exists
-- (restore an email or delete those rows first).
drop table if exists public.call_actions;
drop index if exists public.complaints_call_idx;
alter table public.complaints drop constraint if exists complaints_no_duplicate_contact;
alter table public.complaints drop column if exists contact_key;
alter table public.complaints drop column if exists call_id;
alter table public.complaints alter column email set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'complaints_no_duplicate') then
    alter table public.complaints add constraint complaints_no_duplicate unique (email_norm, details_hash);
  end if;
end $$;
