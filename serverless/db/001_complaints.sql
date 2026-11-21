-- MediLens complaint management: departments, complaints with AI triage, audit log.
-- Server-only: RLS is on with no policies, so only the service role (the
-- serverless backend) can read or write. The browser never talks to the database.

create table if not exists public.departments (
  code          text primary key,
  name          text not null,
  contact_email text not null,
  sla_hours     integer not null check (sla_hours > 0)
);

create table if not exists public.complaints (
  id               bigint generated always as identity primary key,
  complaint_code   text not null unique,
  patient_name     text not null,
  email            text not null,
  email_norm       text generated always as (lower(btrim(email))) stored,
  phone            text not null,
  details          text not null,
  -- sha256 of the normalised details: the same patient filing the same text twice is a duplicate.
  details_hash     text not null,
  channel          text not null default 'web' check (channel in ('web', 'voice')),
  -- What the patient picked, kept as a hint; the triage decides the priority.
  category_hint    text,
  priority_hint    text check (priority_hint in ('High', 'Medium', 'Low')),
  priority         text not null check (priority in ('High', 'Medium', 'Low')),
  department_code  text not null references public.departments (code),
  category         text not null,
  sentiment        text not null check (sentiment in ('Negative', 'Neutral', 'Positive')),
  suggested_action text not null,
  confidence       numeric(3, 2) not null check (confidence between 0 and 1),
  triage_source    text not null check (triage_source in ('ai', 'keywords')),
  emergency        boolean not null default false,
  needs_review     boolean not null default false,
  status           text not null default 'Pending' check (status in ('Pending', 'In Review', 'Resolved')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint complaints_no_duplicate unique (email_norm, details_hash)
);

create index if not exists complaints_department_status_idx on public.complaints (department_code, status);
create index if not exists complaints_created_at_idx on public.complaints (created_at desc);

create table if not exists public.complaint_audit (
  id           bigint generated always as identity primary key,
  complaint_id bigint references public.complaints (id) on delete set null,
  action       text not null,
  actor        text not null default 'system',
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists complaint_audit_complaint_idx on public.complaint_audit (complaint_id);

alter table public.departments enable row level security;
alter table public.complaints enable row level security;
alter table public.complaint_audit enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.departments, public.complaints, public.complaint_audit from anon, authenticated;
  end if;
end $$;

-- Synthetic departments. Contact addresses use the reserved .test domain;
-- set ALERT_EMAIL_OVERRIDE to receive department alerts in a real inbox.
insert into public.departments (code, name, contact_email, sla_hours) values
  ('emergency',         'Emergency Department',        'emergency@medilens.test',   1),
  ('clinical_care',     'Doctor & Clinical Care',      'clinical@medilens.test',    24),
  ('nursing',           'Nursing & Ward Care',         'nursing@medilens.test',     24),
  ('pharmacy',          'Pharmacy',                    'pharmacy@medilens.test',    24),
  ('laboratory',        'Laboratory & Diagnostics',    'lab@medilens.test',         48),
  ('appointments',      'Appointments & Scheduling',   'appointments@medilens.test', 48),
  ('billing',           'Billing & Insurance',         'billing@medilens.test',     72),
  ('facilities',        'Facilities & Cleanliness',    'facilities@medilens.test',  72),
  ('patient_relations', 'Patient Relations (triage desk)', 'relations@medilens.test', 48)
on conflict (code) do update
  set name = excluded.name, contact_email = excluded.contact_email, sla_hours = excluded.sla_hours;
