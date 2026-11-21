-- Rolls back 005_sla.sql.
drop function if exists public.claim_overdue_complaints(int);
drop index if exists public.complaints_open_idx;
alter table public.complaints drop column if exists escalated_at;
