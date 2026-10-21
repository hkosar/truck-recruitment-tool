-- Enforce global do-not-contact on the contact ledger.
--
-- Effect: any INSERT into public.contact_logs for a carrier that is globally
-- do-not-contact is rejected. "Globally DNC" matches the first two clauses of
-- internal.is_contactable(): carriers.do_not_contact is true, or an unexpired
-- carrier-wide contact_suppressions row with channel 'all' exists. Channel- and
-- value-specific suppressions are not enforced here, so logging stays possible
-- for those. Existing rows are untouched; UPDATE is unaffected (ledger is
-- immutable). Applies to every role, including service_role.
--
-- Idempotent: create or replace function + drop trigger if exists.
-- Rollback:
--   drop trigger if exists contact_logs_dnc_guard on public.contact_logs;
--   drop function if exists internal.contact_logs_dnc_guard();

create or replace function internal.contact_logs_dnc_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.carriers c
    where c.dot_number = new.dot_number and c.do_not_contact
  ) or exists (
    select 1 from public.contact_suppressions cs
    where cs.dot_number = new.dot_number
      and cs.channel::text = 'all'
      and cs.value is null
      and (cs.expires_at is null or cs.expires_at > now())
  ) then
    raise exception 'carrier % is on the global do-not-contact list; contact cannot be logged', new.dot_number
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function internal.contact_logs_dnc_guard() from public, anon, authenticated;

drop trigger if exists contact_logs_dnc_guard on public.contact_logs;
create trigger contact_logs_dnc_guard
  before insert on public.contact_logs
  for each row execute function internal.contact_logs_dnc_guard();
