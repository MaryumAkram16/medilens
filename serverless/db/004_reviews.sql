-- MediLens staff review: staff confirm or correct the triage's priority and
-- department. The first review of each complaint is the ground truth for the
-- live triage accuracy (GET /api/triage-accuracy); later reviews are history.

alter table public.complaints add column if not exists reviewed_at timestamptz;

create table if not exists public.complaint_reviews (
  id              bigint generated always as identity primary key,
  complaint_id    bigint not null references public.complaints (id) on delete cascade,
  action          text not null check (action in ('confirmed', 'corrected')),
  -- What the complaint had before this review, and what staff set.
  from_priority   text not null check (from_priority in ('High', 'Medium', 'Low')),
  from_department text not null references public.departments (code),
  to_priority     text not null check (to_priority in ('High', 'Medium', 'Low')),
  to_department   text not null references public.departments (code),
  -- What made the original decision, so AI and keyword accuracy are reported separately.
  triage_source   text not null check (triage_source in ('ai', 'keywords')),
  first_review    boolean not null,
  note            text check (char_length(note) <= 500),
  created_at      timestamptz not null default now()
);

-- Exactly one first review per complaint, even if two staff save at once.
create unique index if not exists complaint_reviews_one_first on public.complaint_reviews (complaint_id) where first_review;
create index if not exists complaint_reviews_first_idx on public.complaint_reviews (created_at desc) where first_review;

alter table public.complaint_reviews enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.complaint_reviews from anon, authenticated;
  end if;
end $$;
