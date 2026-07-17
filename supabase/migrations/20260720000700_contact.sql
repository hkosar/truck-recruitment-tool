-- ============================================================================
-- 20260720000700_contact.sql -- contact_logs, contact_suppressions
-- Spec: docs/build-plan/01-architecture.md Part A §2.7, §2.9 (contact indexes).
-- ============================================================================

create table public.contact_logs (                 -- F8/G6: unified multi-channel timeline
  id           uuid primary key default gen_random_uuid(),
  dot_number   bigint not null references public.carriers(dot_number) on delete restrict,
  batch_id     uuid references public.batches(id) on delete set null,  -- timeline SURVIVES batch deletion
  user_id      uuid not null references public.profiles(id),
  channel      contact_channel not null,           -- call | text | email (mail reserved)
  disposition  contact_disposition not null,
  notes        text,
  next_steps   text,
  callback_at  timestamptz,                        -- drives 'callbacks due' surfacing
  contacted_at timestamptz not null default now(), -- backdatable ('logged a call from this morning')
  created_at   timestamptz not null default now()
);
comment on table public.contact_logs is
  'Immutable ledger: no UPDATE policy for anyone; DELETE manager-only (§6).';

create table public.contact_suppressions (         -- brief §9 + F10 legitimate-email groundwork
  id          bigint generated always as identity primary key,
  dot_number  bigint references public.carriers(dot_number) on delete cascade,  -- null = value-only suppression
  channel     suppression_channel not null,
  value       text,                                -- specific phone/email suppressed; null = whole carrier+channel
  reason      text,
  source      suppression_source not null default 'manual',
  created_by  uuid references public.profiles(id), -- null when machine-written (ESP webhook, DNC scrub)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,                         -- DNC-registry scrubs age out
  constraint target_present check (dot_number is not null or value is not null)
);
create unique index uq_suppress_value   on public.contact_suppressions(channel, lower(value)) where value is not null;
create unique index uq_suppress_carrier on public.contact_suppressions(dot_number, channel)   where value is null;

comment on table public.contact_suppressions is
  'Division of labor: carriers.do_not_contact is the GLOBAL, UI-critical flag (red badge '
  'everywhere, locked rule); contact_suppressions is the channel/value compliance ledger '
  '(email unsubscribe, SMS STOP, DNC-registry hits) that future senders must consult. '
  'internal.is_contactable(dot, channel) (§5.6) evaluates both.';

-- ----------------------------------------------------------------------------
-- Indexes (§2.9) -- contact
-- ----------------------------------------------------------------------------
create index idx_logs_dot_time   on public.contact_logs (dot_number, contacted_at desc);  -- unified timeline (G6)
create index idx_logs_batch_time on public.contact_logs (batch_id, contacted_at desc);
create index idx_logs_callbacks  on public.contact_logs (callback_at) where callback_at is not null;
create index idx_logs_user       on public.contact_logs (user_id);
