/**
 * PLACEHOLDER Supabase generated types.
 *
 * Real types are produced by `supabase gen types typescript --linked` once
 * the schema in docs/build-plan/01-architecture.md Part A is migrated
 * (supabase/migrations/, not part of this scaffold). This file hand-mirrors
 * that DDL closely enough for the app to compile and for `lib/rpc.ts` to be
 * fully typed against real RPC signatures today.
 *
 * Scope, deliberately bounded (see the build manifest for the full list):
 *  - Enums: all 13, exact (01 §2.2).
 *  - Functions: all 17 CANONICAL RPCs the frontend calls (01 §5 + the
 *    Contract reconciliation section + amendments #3/#8/#9/#10/#11/#14).
 *    `internal.*` functions (e.g. matching_carriers) are NOT here — they are
 *    REVOKEd from anon/authenticated and never PostgREST-exposed.
 *  - Tables: `profiles` only — the one table this scaffold's code (app/
 *    guards.tsx) actually queries via `.from()`. Every other table
 *    (carriers, batches, batch_zones, batch_carriers, contact_logs,
 *    batch_activity, carrier_insurance, carrier_safety, carrier_inspections,
 *    contact_suppressions, cargo_other_values, sync_runs, ...) is NOT yet
 *    stubbed; feature work that reads/writes them should add Row/Insert/
 *    Update shapes here (or just regenerate from the real schema) before
 *    relying on `.from()` typing for them.
 *  - Views: `batch_dashboard` (01 §5.5 + amendment #11's `warnings_count`/
 *    `with_phone` additions) and `carrier_warnings` (01 §3) — both are
 *    read-only PostgREST embeds the dashboard/profile screens need.
 *
 * REGEN NOTE: when the real generated file lands, delete this one and
 * update the two imports in `lib/supabase.ts`. types/domain.ts derives its
 * enum/row aliases via indexed access on `Database[...]` (not by duplicating
 * shapes), so most of the app should keep compiling unchanged; the handful
 * of RPCs whose Args includes a `Json`-typed jsonb parameter (search
 * definitions) will keep needing the `as unknown as Json` cast documented
 * in lib/rpc.ts regardless of where the type comes from.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ---------------------------------------------------------------------------
// Enums (01 §2.2, verbatim; amendment #9 adds 'no_response', amendment #14
// fixes user_status to 'disabled' not 02's original "suspended" wording).
// ---------------------------------------------------------------------------
type UserRole = 'manager' | 'edit' | 'view' | 'guest';
type UserStatus = 'pending' | 'approved' | 'disabled';
type BatchCarrierStatus = 'new' | 'attempted' | 'contacted' | 'interested' | 'not_a_fit';
type ContactChannel = 'call' | 'text' | 'email' | 'mail';
type ContactDisposition =
  | 'no_answer'
  | 'voicemail'
  | 'connected'
  | 'callback'
  | 'interested'
  | 'not_interested'
  | 'wrong_number'
  | 'sent'
  | 'replied'
  | 'bounced'
  | 'no_response';
type ZoneType = 'radius' | 'corridor';
type AnchorKind = 'pin' | 'address' | 'city' | 'zip' | 'county';
type GeocodePrecision =
  | 'rooftop'
  | 'range_interpolated'
  | 'geometric_center'
  | 'approximate'
  | 'zip_centroid'
  | 'city_centroid'
  | 'none';
type AuthorityStatus = 'active' | 'pending' | 'inactive' | 'none' | 'unknown';
type ActivityType =
  | 'batch_created'
  | 'members_added'
  | 'refresh'
  | 'status_change'
  | 'bulk_status_change'
  | 'carrier_removed'
  | 'promoted'
  | 'dnc_set'
  | 'dnc_cleared'
  | 'comment'
  | 'export';
type SuppressionChannel = 'call' | 'text' | 'email' | 'mail' | 'all';
type SuppressionSource = 'manual' | 'carrier_request' | 'dnc_registry' | 'esp_unsubscribe' | 'esp_bounce' | 'sms_stop';
type SyncSource = 'census' | 'li' | 'sms_safety' | 'inspections' | 'geocode';

// ---------------------------------------------------------------------------
// Row shapes shared by more than one Function/Table (kept file-private;
// consume via Database[...] indexed access from types/domain.ts).
// ---------------------------------------------------------------------------
interface SearchCarrierRowRaw {
  dot_number: number;
  legal_name: string;
  dba_name: string | null;
  contact_name: string | null;
  phone: string | null;
  cell_phone: string | null;
  email: string | null;
  phy_city: string | null;
  phy_state: string | null;
  phy_zip: string | null;
  power_units: number | null;
  total_drivers: number | null;
  classdef: string | null;
  carrier_operation: string | null;
  cargo_other_desc: string | null;
  cargo_flags: string[];
  bipd_on_file: number | null;
  authority_active: boolean | null;
  lng: number | null;
  lat: number | null;
  geocode_precision: GeocodePrecision;
  do_not_contact: boolean;
  matched_zones: string[];
  warning_reasons: string[];
  has_warnings: boolean;
  in_batches: number;
  total_count: number;
}

interface BatchMemberRowRaw {
  dot_number: number;
  legal_name: string;
  dba_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  phy_city: string | null;
  power_units: number | null;
  status: BatchCarrierStatus;
  status_changed_at: string | null;
  status_changed_by_name: string | null;
  added_via_refresh: boolean;
  promoted_at: string | null;
  do_not_contact: boolean;
  warning_reasons: string[];
  has_warnings: boolean;
  last_contact_at: string | null;
  last_contact_channel: ContactChannel | null;
  contact_count: number;
  lng: number | null;
  lat: number | null;
  total_count: number;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          role: UserRole;
          status: UserStatus;
          avatar_color: string;
          approved_by: string | null;
          approved_at: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string;
          role?: UserRole;
          status?: UserStatus;
          avatar_color?: string;
          approved_by?: string | null;
          approved_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string;
          role?: UserRole;
          status?: UserStatus;
          avatar_color?: string;
          approved_by?: string | null;
          approved_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };

    Views: {
      // 01 §5.5 batch_dashboard view + amendment #11's warnings_count/with_phone.
      batch_dashboard: {
        Row: {
          id: string;
          name: string;
          customer: string | null;
          job: string | null;
          created_by: string;
          created_by_name: string;
          created_at: string;
          snapshot_taken_at: string | null;
          last_refreshed_at: string | null;
          archived_at: string | null;
          member_count: number;
          status_counts: Json;
          promoted_count: number;
          last_activity_at: string | null;
          zones: Json;
          warnings_count: number;
          with_phone: number;
        };
        Relationships: [];
      };
      // 01 §3 carrier_warnings view (security_invoker), header alert chips.
      carrier_warnings: {
        Row: {
          dot_number: number;
          warning_reasons: string[];
        };
        Relationships: [];
      };
    };

    Functions: {
      // --- 01 §5.1 ---------------------------------------------------------
      search_carriers: {
        Args: {
          p_definition: Json;
          p_page?: number;
          p_page_size?: number;
          p_sort?: string;
          p_dir?: string;
        };
        Returns: SearchCarrierRowRaw[];
      };

      // --- 01 §5.2 (amendment #11 adds tier1_count) ------------------------
      count_carriers: {
        Args: { p_definition: Json };
        Returns: {
          match_count: number;
          with_phone: number;
          with_email: number;
          with_warnings: number;
          dnc_excluded: number;
          geocoded_pct: number;
          tier1_count: number;
        }[];
      };

      // --- 01 §5.3 / F14 ----------------------------------------------------
      facet_other_values: {
        Args: {
          p_definition: Json;
          p_keyword?: string | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          value: string;
          sample_raw: string | null;
          carrier_count: number;
          match_group: string | null;
          is_sand_gravel: boolean;
          total_values: number;
        }[];
      };

      facet_suggested_keywords: {
        Args: { p_definition: Json };
        Returns: { match_group: string | null; value_count: number; carrier_count: number }[];
      };

      // --- reconciliation §item 3: approved ADDITION to Part A §5 -----------
      facet_cargo_flags: {
        Args: { p_definition: Json };
        Returns: { flag: string; carrier_count: number }[];
      };

      // --- 01 §5.4 (VOLATILE) ------------------------------------------------
      create_batch: {
        Args: {
          p_name: string;
          p_customer?: string | null;
          p_job?: string | null;
          p_description?: string | null;
          p_definition: Json;
        };
        Returns: { batch_id: string; member_count: number }[];
      };

      refresh_batch: {
        Args: { p_batch_id: string };
        Returns: { added_count: number; added_dots: number[] }[];
      };

      bulk_set_status: {
        Args: { p_batch_id: string; p_dots: number[]; p_status: BatchCarrierStatus };
        Returns: number; // rows updated (plain `returns int`, not a table)
      };

      set_do_not_contact: {
        Args: { p_dot: number; p_on: boolean; p_reason?: string | null };
        Returns: undefined; // `returns void`
      };

      log_export: {
        Args: { p_batch_id: string; p_kind: 'call_sheet' | 'csv'; p_row_count: number };
        Returns: undefined; // `returns void`
      };

      // --- 01 §5.5, extended by reconciliation item #3 ----------------------
      batch_members: {
        Args: {
          p_batch_id: string;
          p_status?: BatchCarrierStatus[] | null;
          p_q?: string | null;
          p_warnings_only?: boolean;
          p_min_insurance?: number | null;
          p_size_min?: number | null;
          p_size_max?: number | null;
          p_has_phone?: boolean | null;
          p_has_email?: boolean | null;
          p_page?: number;
          p_page_size?: number;
          p_sort?: string;
          p_dir?: string;
        };
        Returns: BatchMemberRowRaw[];
      };

      // --- 01 §5.5, extended by amendment #10 (parity args + row_num) -------
      batch_members_map: {
        Args: {
          p_batch_id: string;
          p_status?: BatchCarrierStatus[] | null;
          p_q?: string | null;
          p_warnings_only?: boolean;
          p_min_insurance?: number | null;
          p_size_min?: number | null;
          p_size_max?: number | null;
          p_has_phone?: boolean | null;
          p_has_email?: boolean | null;
          p_sort?: string;
          p_dir?: string;
        };
        Returns: {
          dot_number: number;
          lng: number;
          lat: number;
          status: BatchCarrierStatus;
          do_not_contact: boolean;
          has_warnings: boolean;
          row_num: number;
        }[];
      };

      search_carriers_map: {
        Args: { p_definition: Json; p_limit?: number };
        Returns: {
          dot_number: number;
          lng: number;
          lat: number;
          has_warnings: boolean;
          matched_zones: string[];
        }[];
      };

      generate_contact_sheet: {
        Args: { p_batch_id: string; p_dots?: number[] | null };
        Returns: {
          dot_number: number;
          legal_name: string;
          dba_name: string | null;
          contact_name: string | null;
          email: string | null;
          phone: string | null;
          cell_phone: string | null;
          phy_city: string | null;
          phy_state: string | null;
          status: BatchCarrierStatus;
          warning_reasons: string[];
          last_contact_at: string | null;
          next_steps: string | null;
        }[];
      };

      // --- amendment #11: new RPC (supersedes reconciliation item #2's
      // "read status_counts off batch_dashboard" — this is the richer,
      // purpose-built replacement: per-status counts + dnc/warnings/contact-
      // ability, one row, used by the status filter chips + stat strip).
      // Exact per-status column naming is a reconstruction (the amendment's
      // prose lists the fields, not full SQL) — see lib/rpc.ts for the note.
      batch_status_counts: {
        Args: { p_batch_id: string };
        Returns: {
          new_count: number;
          attempted_count: number;
          contacted_count: number;
          interested_count: number;
          not_a_fit_count: number;
          dnc_count: number;
          warnings_count: number;
          with_phone: number;
          with_email: number;
          total: number;
        }[];
      };

      // --- amendment #11: new RPC, dashboard StatStrip -----------------------
      dashboard_totals: {
        Args: Record<PropertyKey, never>;
        Returns: {
          active_batches: number;
          distinct_carriers: number;
          with_phone: number;
          interested: number;
          promoted: number;
        }[];
      };

      // --- 01 §5.6 public wrapper over internal.is_contactable ---------------
      is_contactable: {
        Args: { p_dot: number; p_channel: ContactChannel };
        Returns: boolean;
      };
    };

    Enums: {
      user_role: UserRole;
      user_status: UserStatus;
      batch_carrier_status: BatchCarrierStatus;
      contact_channel: ContactChannel;
      contact_disposition: ContactDisposition;
      zone_type: ZoneType;
      anchor_kind: AnchorKind;
      geocode_precision: GeocodePrecision;
      authority_status: AuthorityStatus;
      activity_type: ActivityType;
      suppression_channel: SuppressionChannel;
      suppression_source: SuppressionSource;
      sync_source: SyncSource;
    };

    CompositeTypes: Record<string, never>;
  };
}
