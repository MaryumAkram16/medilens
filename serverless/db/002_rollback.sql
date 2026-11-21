-- Rolls back 002_appointments.sql. Deletes all appointment data.
drop function if exists public.ensure_demo_slots(int);
drop function if exists public.find_appointment(text, text);
drop function if exists public.reschedule_appointment(text, text, bigint);
drop function if exists public.cancel_appointment(text, text);
drop function if exists public.book_appointment(bigint, text, text, text, text, text);
drop function if exists public.available_slots(text, date, int);
drop table if exists public.appointments;
drop table if exists public.doctor_slots;
drop table if exists public.doctors;
drop table if exists public.specialties;
