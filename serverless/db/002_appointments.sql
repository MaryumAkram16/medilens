-- MediLens voice appointments: specialties, doctors, slots, appointments.
--
-- Fixes carried over from the n8n workflow (Medilens_Voice_Appointment_Booking.json):
--  * A slot's availability is not a status string that has to be kept in sync
--    (the n8n flow mixed 'Booked'/'booked' and never freed slots on reschedule).
--    A slot is free when it is not blocked, is in the future, and has no
--    'Booked' appointment. A partial unique index makes a second booking of the
--    same slot impossible, even when two calls arrive at the same moment.
--  * Appointments have their own code (APT-XXXXXX) instead of reusing the slot
--    number, and every lookup or change also needs the caller's phone number.
--  * Book, cancel and reschedule are single functions, so each one succeeds or
--    fails as a whole.
-- Server-only, like 001: RLS on, no policies, functions not executable by anon.

create table if not exists public.specialties (
  code text primary key,
  name text not null
);

create table if not exists public.doctors (
  id             bigint generated always as identity primary key,
  name           text not null unique,
  specialty_code text not null references public.specialties (code),
  active         boolean not null default true
);

create table if not exists public.doctor_slots (
  id         bigint generated always as identity primary key,
  doctor_id  bigint not null references public.doctors (id),
  slot_date  date not null,
  start_time time not null,
  end_time   time not null,
  blocked    boolean not null default false,
  constraint doctor_slots_time_order check (end_time > start_time),
  constraint doctor_slots_unique unique (doctor_id, slot_date, start_time)
);

create index if not exists doctor_slots_date_idx on public.doctor_slots (slot_date, start_time);

create table if not exists public.appointments (
  id               bigint generated always as identity primary key,
  appointment_code text not null unique,
  slot_id          bigint not null references public.doctor_slots (id),
  patient_name     text not null,
  phone            text not null,
  -- Last 10 digits, so 0300 1234567 and +92 300 1234567 match.
  phone_key        text generated always as (right(regexp_replace(phone, '\D', '', 'g'), 10)) stored,
  email            text,
  status           text not null default 'Booked' check (status in ('Booked', 'Cancelled', 'Completed')),
  -- Retell call that created it, so a retried tool call returns the same booking.
  call_id          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  cancelled_at     timestamptz
);

-- The double-booking guard: at most one active booking per slot.
create unique index if not exists appointments_one_booking_per_slot
  on public.appointments (slot_id) where status = 'Booked';
create index if not exists appointments_phone_idx on public.appointments (phone_key);

alter table public.specialties enable row level security;
alter table public.doctors enable row level security;
alter table public.doctor_slots enable row level security;
alter table public.appointments enable row level security;

-- Slots a patient can book right now (Pakistan time).
create or replace function public.available_slots(p_specialty text, p_from date default null, p_limit int default 20)
returns table (slot_id bigint, doctor_name text, specialty_code text, slot_date date, start_time time, end_time time)
language sql stable
set search_path = public
as $$
  select s.id, d.name, d.specialty_code, s.slot_date, s.start_time, s.end_time
  from doctor_slots s
  join doctors d on d.id = s.doctor_id and d.active
  where d.specialty_code = p_specialty
    and not s.blocked
    and (s.slot_date + s.start_time) > (now() at time zone 'Asia/Karachi')
    and s.slot_date >= coalesce(p_from, (now() at time zone 'Asia/Karachi')::date)
    and not exists (select 1 from appointments a where a.slot_id = s.id and a.status = 'Booked')
  order by s.slot_date, s.start_time, d.name
  limit greatest(1, least(p_limit, 50));
$$;

-- Books a slot. Raises 'slot_unavailable' if it is taken, blocked or past.
-- A retry with the same call_id and slot returns the original booking.
create or replace function public.book_appointment(
  p_slot_id bigint, p_name text, p_phone text, p_email text, p_code text, p_call_id text default null
) returns setof public.appointments
language plpgsql
set search_path = public
as $$
declare
  v_slot doctor_slots%rowtype;
begin
  if p_call_id is not null then
    return query select * from appointments where call_id = p_call_id and slot_id = p_slot_id and status = 'Booked';
    if found then return; end if;
  end if;

  select * into v_slot from doctor_slots where id = p_slot_id for update;
  if not found or v_slot.blocked or (v_slot.slot_date + v_slot.start_time) <= (now() at time zone 'Asia/Karachi') then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;

  begin
    return query
      insert into appointments (appointment_code, slot_id, patient_name, phone, email, call_id)
      values (p_code, p_slot_id, p_name, p_phone, nullif(p_email, ''), p_call_id)
      returning *;
  exception when unique_violation then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end;
end;
$$;

-- Cancels a booked appointment. Raises 'not_found' (wrong code or phone) or 'not_booked'.
create or replace function public.cancel_appointment(p_code text, p_phone text)
returns setof public.appointments
language plpgsql
set search_path = public
as $$
declare
  v_appt appointments%rowtype;
begin
  select * into v_appt from appointments
  where appointment_code = p_code and phone_key = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
  for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_appt.status <> 'Booked' then raise exception 'not_booked' using errcode = 'P0001'; end if;

  return query
    update appointments set status = 'Cancelled', cancelled_at = now(), updated_at = now()
    where id = v_appt.id returning *;
end;
$$;

-- Moves a booked appointment to another slot of the same specialty, in one step.
-- The old slot is freed by the same update. Raises 'not_found', 'not_booked',
-- 'slot_unavailable' or 'different_specialty'.
create or replace function public.reschedule_appointment(p_code text, p_phone text, p_new_slot_id bigint)
returns setof public.appointments
language plpgsql
set search_path = public
as $$
declare
  v_appt appointments%rowtype;
  v_old_specialty text;
  v_new doctor_slots%rowtype;
  v_new_specialty text;
begin
  select * into v_appt from appointments
  where appointment_code = p_code and phone_key = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
  for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_appt.status <> 'Booked' then raise exception 'not_booked' using errcode = 'P0001'; end if;

  select d.specialty_code into v_old_specialty from doctor_slots s join doctors d on d.id = s.doctor_id where s.id = v_appt.slot_id;
  select * into v_new from doctor_slots where id = p_new_slot_id for update;
  if not found or v_new.blocked or (v_new.slot_date + v_new.start_time) <= (now() at time zone 'Asia/Karachi') then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;
  select specialty_code into v_new_specialty from doctors where id = v_new.doctor_id;
  if v_new_specialty <> v_old_specialty then raise exception 'different_specialty' using errcode = 'P0001'; end if;
  if v_new.id = v_appt.slot_id then return query select * from appointments where id = v_appt.id; return; end if;

  begin
    return query
      update appointments set slot_id = p_new_slot_id, updated_at = now()
      where id = v_appt.id returning *;
  exception when unique_violation then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end;
end;
$$;

-- An appointment with its slot and doctor, for read-backs. Needs code + phone.
create or replace function public.find_appointment(p_code text, p_phone text)
returns table (
  appointment_code text, status text, patient_name text, email text,
  slot_id bigint, doctor_name text, specialty_code text, slot_date date, start_time time, end_time time
)
language sql stable
set search_path = public
as $$
  select a.appointment_code, a.status, a.patient_name, a.email,
         s.id, d.name, d.specialty_code, s.slot_date, s.start_time, s.end_time
  from appointments a
  join doctor_slots s on s.id = a.slot_id
  join doctors d on d.id = s.doctor_id
  where a.appointment_code = p_code and a.phone_key = right(regexp_replace(p_phone, '\D', '', 'g'), 10);
$$;

-- Keeps the demo bookable: adds 30-minute slots, 09:00-13:00, Monday to
-- Saturday, for the next p_days days. Safe to call repeatedly.
create or replace function public.ensure_demo_slots(p_days int default 14)
returns integer
language sql
set search_path = public
as $$
  with inserted as (
    insert into doctor_slots (doctor_id, slot_date, start_time, end_time)
    select d.id, day::date, t::time, (t + interval '30 minutes')::time
    from doctors d
    cross join generate_series((now() at time zone 'Asia/Karachi')::date,
                               (now() at time zone 'Asia/Karachi')::date + least(p_days, 60), interval '1 day') as day
    cross join generate_series(timestamp '2000-01-01 09:00', timestamp '2000-01-01 12:30', interval '30 minutes') as t
    where d.active and extract(isodow from day) < 7
    on conflict (doctor_id, slot_date, start_time) do nothing
    returning 1
  )
  select count(*)::int from inserted;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.specialties, public.doctors, public.doctor_slots, public.appointments from anon, authenticated;
    revoke execute on function
      public.available_slots(text, date, int),
      public.book_appointment(bigint, text, text, text, text, text),
      public.cancel_appointment(text, text),
      public.reschedule_appointment(text, text, bigint),
      public.find_appointment(text, text),
      public.ensure_demo_slots(int)
    from public, anon, authenticated;
  end if;
end $$;

-- Synthetic specialties and doctors (no real people).
insert into public.specialties (code, name) values
  ('general_medicine', 'General Medicine'),
  ('cardiology', 'Cardiology'),
  ('pediatrics', 'Pediatrics'),
  ('dermatology', 'Dermatology'),
  ('orthopedics', 'Orthopedics'),
  ('gynecology', 'Gynecology')
on conflict (code) do update set name = excluded.name;

insert into public.doctors (name, specialty_code) values
  ('Dr. Ayesha Khan', 'general_medicine'),
  ('Dr. Bilal Ahmed', 'general_medicine'),
  ('Dr. Sara Malik', 'cardiology'),
  ('Dr. Usman Raza', 'pediatrics'),
  ('Dr. Hina Qureshi', 'dermatology'),
  ('Dr. Omar Siddiqui', 'orthopedics'),
  ('Dr. Fatima Javed', 'gynecology')
on conflict (name) do nothing;

select public.ensure_demo_slots(14);
