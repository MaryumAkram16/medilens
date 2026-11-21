-- Rolls back 001_complaints.sql. Deletes all complaint data.
drop table if exists public.complaint_audit;
drop table if exists public.complaints;
drop table if exists public.departments;
