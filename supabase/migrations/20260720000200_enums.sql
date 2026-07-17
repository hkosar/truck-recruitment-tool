-- ============================================================================
-- 20260720000200_enums.sql
-- Spec: docs/build-plan/01-architecture.md Part A §2.2, amended per §9 (adds
-- 'no_response' to contact_disposition) and §14 (user_status 'disabled' is
-- already the canonical value below — no change needed, 02's "suspended"
-- copy reads as this value).
-- ============================================================================

create type user_role  as enum ('manager','edit','view','guest');            -- brief §7
create type user_status as enum ('pending','approved','disabled');           -- approval workflow (01 reconciliation #14)

create type batch_carrier_status as enum
  ('new','attempted','contacted','interested','not_a_fit');                  -- locked pipeline (§16 addendum)

create type contact_channel as enum ('call','text','email','mail');          -- F8 (mail reserved for Phase 3)

create type contact_disposition as enum
  ('no_answer','voicemail','connected','callback','interested',
   'not_interested','wrong_number',              -- call-ish (mockup carry-forward names)
   'sent','replied','bounced','no_response');     -- text/email manual logging (F8); no_response added per amendment #9
-- channel↔disposition compatibility is a UI concern; DB stays permissive.

create type zone_type as enum ('radius','corridor');                         -- F21 (extensible: ALTER TYPE ADD VALUE 'polygon' later)

create type anchor_kind as enum ('pin','address','city','zip','county');     -- F12, exactly this order in UI

create type geocode_precision as enum
  ('rooftop','range_interpolated','geometric_center','approximate',          -- Google location_type values
   'zip_centroid','city_centroid','none');                                   -- our fallback tiers (brief §5)
-- Part B's tiers map onto these 7 unchanged (amendment #7): street match ->
-- (rooftop|range_interpolated|geometric_center), zip -> zip_centroid, city -> city_centroid.

create type authority_status as enum ('active','pending','inactive','none','unknown');

create type activity_type as enum
  ('batch_created','members_added','refresh','status_change','bulk_status_change',
   'carrier_removed','promoted','dnc_set','dnc_cleared','comment','export'); -- F11

create type suppression_channel as enum ('call','text','email','mail','all');
create type suppression_source  as enum
  ('manual','carrier_request','dnc_registry','esp_unsubscribe','esp_bounce','sms_stop');
create type sync_source as enum ('census','li','sms_safety','inspections','geocode');
