-- A3 business fixtures (fictional), after profile-fixtures.sql. Enough rows for the after-M1
-- role matrix (carriers 1400001-1400005, one batch with members, one cargo value, one log).
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.carriers (dot_number, legal_name, phy_city, phy_state, geom)
select d, 'A3 Fictional Carrier ' || d, 'Austin', 'TX', ('POINT(-97.74 30.27)')::geography
from generate_series(1400001, 1400005) d;

insert into public.batches (id, name, customer, job, created_by, search_definition)
values ('a3b00000-0000-4000-8000-000000000001', 'A3 Batch', 'Fictional Customer', 'Fictional Job',
        '71000000-0000-4000-8000-000000000001', '{}'::jsonb);
insert into public.batch_carriers (batch_id, dot_number) select 'a3b00000-0000-4000-8000-000000000001', d from generate_series(1400001, 1400003) d;

insert into public.cargo_other_values (value) values ('A3 FICTIONAL CARGO') on conflict do nothing;

insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes)
values (1400001, 'a3b00000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'call', 'connected', 'A3 fixture');
insert into public.batch_activity (batch_id, actor_id, activity_type, comment)
values ('a3b00000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'comment', 'A3 fixture comment');
commit;
