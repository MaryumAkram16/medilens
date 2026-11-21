-- Rolls back 004_reviews.sql. Deletes review history.
drop table if exists public.complaint_reviews;
alter table public.complaints drop column if exists reviewed_at;
