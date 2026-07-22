-- Prevent permanent Census no-match addresses from being reprocessed forever.
-- A carrier is due when its current address has never been attempted, or changed since the
-- last attempt. `geom is null` alone is not a queue predicate because a valid no-match remains
-- NULL by design until ZIP/city fallback data is available.

drop index if exists public.idx_carriers_geocode_todo;

create index idx_carriers_geocode_todo on public.carriers (dot_number)
  where geocode_addr_hash is distinct from address_hash;

comment on index public.idx_carriers_geocode_todo is
  'Location enrichment queue: current address never attempted or changed since last attempt.';
