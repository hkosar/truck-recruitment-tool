-- Retention vs the event -> link foreign key (run as recruiter_maintenance after fixtures.sql).
-- The same statements as app/server/scripts/retention.ts RETENTION_RULES.
delete from internal.email_events where ctid in (
  select ctid from internal.email_events where received_at < clock_timestamp() - interval '180 days' limit 5000);
delete from internal.signin_links where ctid in (
  select ctid from internal.signin_links
  where coalesce(used_at, revoked_at, expires_at) < clock_timestamp() - interval '30 days' limit 5000);

do $assert$
begin
  if exists (select 1 from internal.signin_links where id = 'a3000000-0000-4000-8000-0000000000c1') then
    raise exception 'FAIL: the 31-day-old link was not deleted';
  end if;
  if not exists (
    select 1 from internal.email_events
    where provider_event_id = 'a3-event-1' and link_id is null
      and recipient_email = 'editor@a3.example.invalid' and provider_message_id = 'a3-msg.1'
  ) then
    raise exception 'FAIL: the delivery event was lost or kept a dangling link reference';
  end if;
  raise notice 'PASS: link deleted; delivery evidence kept with its snapshot and a null link reference';
end
$assert$;
