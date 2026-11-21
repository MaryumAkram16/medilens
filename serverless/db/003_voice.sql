-- MediLens voice complaints and call summaries.
--  * Complaints filed by voice may have no email (spelling an email over the
--    phone is unreliable). Duplicates are now keyed on the email, or the phone
--    when there is no email.
--  * Complaints remember the Retell call that filed them.
--  * call_actions records what each call did (booked, rescheduled, cancelled,
--    filed a complaint), for the after-call summary. One summary email per call.

alter table public.complaints alter column email drop not null;
alter table public.complaints add column if not exists call_id text;

alter table public.complaints
  add column if not exists contact_key text
  generated always as (coalesce(lower(btrim(email)), right(regexp_replace(phone, '\D', '', 'g'), 10))) stored;

alter table public.complaints drop constraint if exists complaints_no_duplicate;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'complaints_no_duplicate_contact') then
    alter table public.complaints add constraint complaints_no_duplicate_contact unique (contact_key, details_hash);
  end if;
end $$;

create index if not exists complaints_call_idx on public.complaints (call_id) where call_id is not null;

create table if not exists public.call_actions (
  id         bigint generated always as identity primary key,
  call_id    text not null,
  action     text not null check (action in ('booked', 'rescheduled', 'cancelled', 'complaint_filed', 'summary_sent')),
  reference  text not null,
  -- What to show in the summary: doctor, date and time, department. No free text from the caller.
  details    jsonb not null default '{}'::jsonb,
  email      text,
  created_at timestamptz not null default now()
);

create index if not exists call_actions_call_idx on public.call_actions (call_id, created_at);
-- At most one summary email per call, even if Retell sends the webhook twice.
create unique index if not exists call_actions_one_summary on public.call_actions (call_id) where action = 'summary_sent';

alter table public.call_actions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.call_actions from anon, authenticated;
  end if;
end $$;
