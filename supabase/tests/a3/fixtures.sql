-- A3 fixtures (throwaway test cluster ONLY; see README.md). Fictional data, fixed ids.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values ('a3000000-0000-4000-8000-000000000001', 'editor@a3.example.invalid');
update public.profiles set role = 'edit', status = 'approved', full_name = 'A3 Editor'
 where id = 'a3000000-0000-4000-8000-000000000001';

insert into public.carriers (dot_number, legal_name) values (3000001, 'A3 Test Hauling');
insert into public.batches (id, name, created_by, search_definition)
values ('a3000000-0000-4000-8000-0000000000b1', 'A3 batch', 'a3000000-0000-4000-8000-000000000001', '{}'::jsonb);
insert into public.batch_carriers (batch_id, dot_number) values ('a3000000-0000-4000-8000-0000000000b1', 3000001);

-- A link session that expires 4 seconds from now (well inside its 90-day cap).
insert into internal.app_sessions (id, user_id, token_hash, kind, email_at_issue, created_at, last_seen_at,
                                   idle_window, expires_at, absolute_expires_at)
values ('a3000000-0000-4000-8000-0000000000a1', 'a3000000-0000-4000-8000-000000000001', 'a3-session-hash', 'link',
        'editor@a3.example.invalid', now(), now(), interval '30 days', now() + interval '4 seconds', now() + interval '90 days');

-- A link that ended 31 days ago, with one delivery event from that time.
insert into internal.signin_links (id, user_id, token_hash, recipient_email, created_at, expires_at, used_at,
                                   send_status, send_attempted_at, provider_message_id)
values ('a3000000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-000000000001', 'a3-link-hash',
        'editor@a3.example.invalid', now() - interval '31 days', now() - interval '31 days' + interval '15 minutes',
        now() - interval '31 days' + interval '1 minute', 'accepted', now() - interval '31 days', 'a3-msg.1');
insert into internal.email_events (provider_event_id, link_id, recipient_email, provider_message_id, event_type, occurred_at, received_at)
values ('a3-event-1', 'a3000000-0000-4000-8000-0000000000c1', 'editor@a3.example.invalid', 'a3-msg.1', 'delivered',
        now() - interval '31 days', now() - interval '31 days');
commit;
