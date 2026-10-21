-- Session B (start FIRST, as the migration role): hold the batch row past the A session's expiry.
begin;
select 1 from public.batches where id = 'a3000000-0000-4000-8000-0000000000b1' for update;
select pg_sleep(6);                       -- the fixture session expires 4 s after fixtures.sql
commit;
