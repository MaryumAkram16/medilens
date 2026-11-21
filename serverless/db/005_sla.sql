-- MediLens deadline monitor: escalate complaints that are past their
-- department's target response time (departments.sla_hours) and not resolved,
-- without anyone having to notice. Run by POST /api/sla-sweep every hour.

alter table public.complaints add column if not exists escalated_at timestamptz;

create index if not exists complaints_open_idx on public.complaints (created_at)
  where status <> 'Resolved' and escalated_at is null;

-- Marks overdue complaints as escalated and returns them, in one statement.
-- Rows another sweep is already handling are skipped (skip locked), so two
-- sweeps at once never escalate the same complaint twice.
create or replace function public.claim_overdue_complaints(p_limit int default 50)
returns setof public.complaints
language sql
set search_path = public
as $$
  update complaints c
  set escalated_at = now(), updated_at = now()
  where c.id in (
    select c2.id
    from complaints c2
    join departments d on d.code = c2.department_code
    where c2.status <> 'Resolved'
      and c2.escalated_at is null
      and c2.created_at + make_interval(hours => d.sla_hours) < now()
    order by c2.created_at
    limit greatest(1, least(p_limit, 200))
    for update of c2 skip locked
  )
  returning c.*;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.claim_overdue_complaints(int) from public, anon, authenticated;
  end if;
end $$;
