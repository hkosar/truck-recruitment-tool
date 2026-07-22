export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      batch_activity: {
        Row: {
          activity_type: Database["public"]["Enums"]["activity_type"]
          actor_id: string | null
          batch_id: string
          comment: string | null
          created_at: string
          id: number
          payload: Json
        }
        Insert: {
          activity_type: Database["public"]["Enums"]["activity_type"]
          actor_id?: string | null
          batch_id: string
          comment?: string | null
          created_at?: string
          id?: never
          payload?: Json
        }
        Update: {
          activity_type?: Database["public"]["Enums"]["activity_type"]
          actor_id?: string | null
          batch_id?: string
          comment?: string | null
          created_at?: string
          id?: never
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "batch_activity_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_activity_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batch_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_activity_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
        ]
      }
      batch_carriers: {
        Row: {
          added_at: string
          added_via_refresh: boolean
          batch_id: string
          dot_number: number
          promoted_at: string | null
          promoted_by: string | null
          status: Database["public"]["Enums"]["batch_carrier_status"]
          status_changed_at: string | null
          status_changed_by: string | null
        }
        Insert: {
          added_at?: string
          added_via_refresh?: boolean
          batch_id: string
          dot_number: number
          promoted_at?: string | null
          promoted_by?: string | null
          status?: Database["public"]["Enums"]["batch_carrier_status"]
          status_changed_at?: string | null
          status_changed_by?: string | null
        }
        Update: {
          added_at?: string
          added_via_refresh?: boolean
          batch_id?: string
          dot_number?: number
          promoted_at?: string | null
          promoted_by?: string | null
          status?: Database["public"]["Enums"]["batch_carrier_status"]
          status_changed_at?: string | null
          status_changed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "batch_carriers_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batch_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_carriers_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_carriers_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "batch_carriers_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "batch_carriers_promoted_by_fkey"
            columns: ["promoted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_carriers_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      batch_zones: {
        Row: {
          batch_id: string
          created_at: string
          distance_miles: number
          geom: unknown
          id: string
          label: string
          params: Json
          sort_order: number
          zone_type: Database["public"]["Enums"]["zone_type"]
        }
        Insert: {
          batch_id: string
          created_at?: string
          distance_miles: number
          geom: unknown
          id?: string
          label: string
          params: Json
          sort_order?: number
          zone_type: Database["public"]["Enums"]["zone_type"]
        }
        Update: {
          batch_id?: string
          created_at?: string
          distance_miles?: number
          geom?: unknown
          id?: string
          label?: string
          params?: Json
          sort_order?: number
          zone_type?: Database["public"]["Enums"]["zone_type"]
        }
        Relationships: [
          {
            foreignKeyName: "batch_zones_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batch_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_zones_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
        ]
      }
      batches: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string
          customer: string | null
          description: string | null
          id: string
          job: string | null
          last_refreshed_at: string | null
          name: string
          refresh_count: number
          search_definition: Json
          snapshot_taken_at: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by: string
          customer?: string | null
          description?: string | null
          id?: string
          job?: string | null
          last_refreshed_at?: string | null
          name: string
          refresh_count?: number
          search_definition: Json
          snapshot_taken_at?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string
          customer?: string | null
          description?: string | null
          id?: string
          job?: string | null
          last_refreshed_at?: string | null
          name?: string
          refresh_count?: number
          search_definition?: Json
          snapshot_taken_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cargo_other_values: {
        Row: {
          carrier_count_tx: number
          first_seen_at: string
          is_sand_gravel: boolean
          last_seen_at: string
          match_group: string | null
          sample_raw: string | null
          value: string
        }
        Insert: {
          carrier_count_tx?: number
          first_seen_at?: string
          is_sand_gravel?: boolean
          last_seen_at?: string
          match_group?: string | null
          sample_raw?: string | null
          value: string
        }
        Update: {
          carrier_count_tx?: number
          first_seen_at?: string
          is_sand_gravel?: boolean
          last_seen_at?: string
          match_group?: string | null
          sample_raw?: string | null
          value?: string
        }
        Relationships: []
      }
      carrier_inspections: {
        Row: {
          dot_number: number
          id: number
          inspection_date: string
          level: number | null
          oos: boolean
          raw: Json | null
          report_number: string | null
          state: string | null
          synced_at: string
          violations: number
        }
        Insert: {
          dot_number: number
          id?: never
          inspection_date: string
          level?: number | null
          oos?: boolean
          raw?: Json | null
          report_number?: string | null
          state?: string | null
          synced_at?: string
          violations?: number
        }
        Update: {
          dot_number?: number
          id?: never
          inspection_date?: string
          level?: number | null
          oos?: boolean
          raw?: Json | null
          report_number?: string | null
          state?: string | null
          synced_at?: string
          violations?: number
        }
        Relationships: [
          {
            foreignKeyName: "carrier_inspections_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "carrier_inspections_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
        ]
      }
      carrier_insurance: {
        Row: {
          authority_active: boolean | null
          authority_raw: Json | null
          bipd_cancel_date: string | null
          bipd_on_file: number | null
          bipd_required: number | null
          bond_on_file: number | null
          broker_status: Database["public"]["Enums"]["authority_status"]
          cargo_on_file: number | null
          common_status: Database["public"]["Enums"]["authority_status"]
          contract_status: Database["public"]["Enums"]["authority_status"]
          dot_number: number
          insurance_effective_date: string | null
          insurer_name: string | null
          last_synced_at: string
        }
        Insert: {
          authority_active?: boolean | null
          authority_raw?: Json | null
          bipd_cancel_date?: string | null
          bipd_on_file?: number | null
          bipd_required?: number | null
          bond_on_file?: number | null
          broker_status?: Database["public"]["Enums"]["authority_status"]
          cargo_on_file?: number | null
          common_status?: Database["public"]["Enums"]["authority_status"]
          contract_status?: Database["public"]["Enums"]["authority_status"]
          dot_number: number
          insurance_effective_date?: string | null
          insurer_name?: string | null
          last_synced_at?: string
        }
        Update: {
          authority_active?: boolean | null
          authority_raw?: Json | null
          bipd_cancel_date?: string | null
          bipd_on_file?: number | null
          bipd_required?: number | null
          bond_on_file?: number | null
          broker_status?: Database["public"]["Enums"]["authority_status"]
          cargo_on_file?: number | null
          common_status?: Database["public"]["Enums"]["authority_status"]
          contract_status?: Database["public"]["Enums"]["authority_status"]
          dot_number?: number
          insurance_effective_date?: string | null
          insurer_name?: string | null
          last_synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "carrier_insurance_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: true
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "carrier_insurance_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: true
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
        ]
      }
      carrier_insurance_filings: {
        Row: {
          cancl_effective_date: string | null
          docket_number: string
          dot_number: number
          effective_date: string
          ins_class_code: string | null
          ins_form_code: string | null
          ins_type_desc: string | null
          insurer_name: string | null
          max_cov_amount: number | null
          min_cov_amount: number | null
          policy_no: string
          synced_at: string
          trans_date: string | null
          underl_lim_amount: number | null
        }
        Insert: {
          cancl_effective_date?: string | null
          docket_number: string
          dot_number: number
          effective_date: string
          ins_class_code?: string | null
          ins_form_code?: string | null
          ins_type_desc?: string | null
          insurer_name?: string | null
          max_cov_amount?: number | null
          min_cov_amount?: number | null
          policy_no: string
          synced_at?: string
          trans_date?: string | null
          underl_lim_amount?: number | null
        }
        Update: {
          cancl_effective_date?: string | null
          docket_number?: string
          dot_number?: number
          effective_date?: string
          ins_class_code?: string | null
          ins_form_code?: string | null
          ins_type_desc?: string | null
          insurer_name?: string | null
          max_cov_amount?: number | null
          min_cov_amount?: number | null
          policy_no?: string
          synced_at?: string
          trans_date?: string | null
          underl_lim_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "carrier_insurance_filings_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "carrier_insurance_filings_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
        ]
      }
      carrier_qc_snapshots: {
        Row: {
          dot_number: number
          fetched_at: string
          payload: Json
        }
        Insert: {
          dot_number: number
          fetched_at?: string
          payload: Json
        }
        Update: {
          dot_number?: number
          fetched_at?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "carrier_qc_snapshots_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: true
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "carrier_qc_snapshots_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: true
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
        ]
      }
      carrier_safety: {
        Row: {
          crash_fatal_24mo: number | null
          crash_injury_24mo: number | null
          crash_total_24mo: number | null
          crash_tow_24mo: number | null
          dot_number: number
          driver_insp_24mo: number | null
          driver_oos_24mo: number | null
          driver_oos_rate: number | null
          inspections_24mo: number | null
          last_synced_at: string
          safety_rating: string | null
          safety_rating_date: string | null
          snapshot_month: string | null
          vehicle_insp_24mo: number | null
          vehicle_oos_24mo: number | null
          vehicle_oos_rate: number | null
        }
        Insert: {
          crash_fatal_24mo?: number | null
          crash_injury_24mo?: number | null
          crash_total_24mo?: number | null
          crash_tow_24mo?: number | null
          dot_number: number
          driver_insp_24mo?: number | null
          driver_oos_24mo?: number | null
          driver_oos_rate?: number | null
          inspections_24mo?: number | null
          last_synced_at?: string
          safety_rating?: string | null
          safety_rating_date?: string | null
          snapshot_month?: string | null
          vehicle_insp_24mo?: number | null
          vehicle_oos_24mo?: number | null
          vehicle_oos_rate?: number | null
        }
        Update: {
          crash_fatal_24mo?: number | null
          crash_injury_24mo?: number | null
          crash_total_24mo?: number | null
          crash_tow_24mo?: number | null
          dot_number?: number
          driver_insp_24mo?: number | null
          driver_oos_24mo?: number | null
          driver_oos_rate?: number | null
          inspections_24mo?: number | null
          last_synced_at?: string
          safety_rating?: string | null
          safety_rating_date?: string | null
          snapshot_month?: string | null
          vehicle_insp_24mo?: number | null
          vehicle_oos_24mo?: number | null
          vehicle_oos_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "carrier_safety_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: true
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "carrier_safety_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: true
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
        ]
      }
      carriers: {
        Row: {
          address_hash: string | null
          bus_units: number | null
          cargo_other_norm: string | null
          carrier_operation: string | null
          cell_phone: string | null
          census_raw: Json | null
          census_updated_at: string | null
          classdef: string | null
          company_officer_1: string | null
          company_officer_2: string | null
          contact_email_override: string | null
          contact_name: string | null
          contact_name_override: string | null
          contact_phone_override: string | null
          crgo_beverages: boolean
          crgo_bldgmat: boolean
          crgo_cargoothr: boolean
          crgo_cargoothr_desc: string | null
          crgo_chem: boolean
          crgo_coalcoke: boolean
          crgo_coldfood: boolean
          crgo_construct: boolean
          crgo_drivetow: boolean
          crgo_drybulk: boolean
          crgo_farmsupp: boolean
          crgo_garbage: boolean
          crgo_genfreight: boolean
          crgo_grainfeed: boolean
          crgo_household: boolean
          crgo_intermodal: boolean
          crgo_liqgas: boolean
          crgo_livestock: boolean
          crgo_logpole: boolean
          crgo_machlrg: boolean
          crgo_meat: boolean
          crgo_metalsheet: boolean
          crgo_mobilehome: boolean
          crgo_motoveh: boolean
          crgo_oilfield: boolean
          crgo_paperprod: boolean
          crgo_passengers: boolean
          crgo_produce: boolean
          crgo_usmail: boolean
          crgo_utility: boolean
          crgo_waterwell: boolean
          dba_name: string | null
          dnc_reason: string | null
          dnc_set_at: string | null
          dnc_set_by: string | null
          do_not_contact: boolean
          docket_display: string | null
          dot_number: number
          duns_number: string | null
          email_address: string | null
          entity_type: string | null
          fax: string | null
          first_seen_at: string
          fleetsize: string | null
          fmcsa_add_date: string | null
          geocode_addr_hash: string | null
          geocode_precision: Database["public"]["Enums"]["geocode_precision"]
          geocode_source: string | null
          geocoded_at: string | null
          geom: unknown
          hm_ind: boolean | null
          last_changed_at: string | null
          last_synced_at: string | null
          lat: number | null
          leased_tractors: number | null
          leased_trailers: number | null
          leased_trucks: number | null
          legal_name: string
          lng: number | null
          mail_city: string | null
          mail_state: string | null
          mail_street: string | null
          mail_zip: string | null
          mcs150_date: string | null
          mcs150_mileage: number | null
          mcs150_mileage_year: number | null
          owned_tractors: number | null
          owned_trailers: number | null
          owned_trucks: number | null
          phone: string | null
          phy_city: string | null
          phy_county: string | null
          phy_state: string | null
          phy_street: string | null
          phy_zip: string | null
          phy_zip5: string | null
          power_units: number | null
          prior_revoke_dot_number: number | null
          prior_revoke_flag: boolean | null
          recordable_crash_rate: number | null
          row_hash: string | null
          source_missing_since: string | null
          status_code: string | null
          total_cdl: number | null
          total_drivers: number | null
          truck_units: number | null
        }
        Insert: {
          address_hash?: string | null
          bus_units?: number | null
          cargo_other_norm?: string | null
          carrier_operation?: string | null
          cell_phone?: string | null
          census_raw?: Json | null
          census_updated_at?: string | null
          classdef?: string | null
          company_officer_1?: string | null
          company_officer_2?: string | null
          contact_email_override?: string | null
          contact_name?: string | null
          contact_name_override?: string | null
          contact_phone_override?: string | null
          crgo_beverages?: boolean
          crgo_bldgmat?: boolean
          crgo_cargoothr?: boolean
          crgo_cargoothr_desc?: string | null
          crgo_chem?: boolean
          crgo_coalcoke?: boolean
          crgo_coldfood?: boolean
          crgo_construct?: boolean
          crgo_drivetow?: boolean
          crgo_drybulk?: boolean
          crgo_farmsupp?: boolean
          crgo_garbage?: boolean
          crgo_genfreight?: boolean
          crgo_grainfeed?: boolean
          crgo_household?: boolean
          crgo_intermodal?: boolean
          crgo_liqgas?: boolean
          crgo_livestock?: boolean
          crgo_logpole?: boolean
          crgo_machlrg?: boolean
          crgo_meat?: boolean
          crgo_metalsheet?: boolean
          crgo_mobilehome?: boolean
          crgo_motoveh?: boolean
          crgo_oilfield?: boolean
          crgo_paperprod?: boolean
          crgo_passengers?: boolean
          crgo_produce?: boolean
          crgo_usmail?: boolean
          crgo_utility?: boolean
          crgo_waterwell?: boolean
          dba_name?: string | null
          dnc_reason?: string | null
          dnc_set_at?: string | null
          dnc_set_by?: string | null
          do_not_contact?: boolean
          docket_display?: string | null
          dot_number: number
          duns_number?: string | null
          email_address?: string | null
          entity_type?: string | null
          fax?: string | null
          first_seen_at?: string
          fleetsize?: string | null
          fmcsa_add_date?: string | null
          geocode_addr_hash?: string | null
          geocode_precision?: Database["public"]["Enums"]["geocode_precision"]
          geocode_source?: string | null
          geocoded_at?: string | null
          geom?: unknown
          hm_ind?: boolean | null
          last_changed_at?: string | null
          last_synced_at?: string | null
          lat?: number | null
          leased_tractors?: number | null
          leased_trailers?: number | null
          leased_trucks?: number | null
          legal_name: string
          lng?: number | null
          mail_city?: string | null
          mail_state?: string | null
          mail_street?: string | null
          mail_zip?: string | null
          mcs150_date?: string | null
          mcs150_mileage?: number | null
          mcs150_mileage_year?: number | null
          owned_tractors?: number | null
          owned_trailers?: number | null
          owned_trucks?: number | null
          phone?: string | null
          phy_city?: string | null
          phy_county?: string | null
          phy_state?: string | null
          phy_street?: string | null
          phy_zip?: string | null
          phy_zip5?: string | null
          power_units?: number | null
          prior_revoke_dot_number?: number | null
          prior_revoke_flag?: boolean | null
          recordable_crash_rate?: number | null
          row_hash?: string | null
          source_missing_since?: string | null
          status_code?: string | null
          total_cdl?: number | null
          total_drivers?: number | null
          truck_units?: number | null
        }
        Update: {
          address_hash?: string | null
          bus_units?: number | null
          cargo_other_norm?: string | null
          carrier_operation?: string | null
          cell_phone?: string | null
          census_raw?: Json | null
          census_updated_at?: string | null
          classdef?: string | null
          company_officer_1?: string | null
          company_officer_2?: string | null
          contact_email_override?: string | null
          contact_name?: string | null
          contact_name_override?: string | null
          contact_phone_override?: string | null
          crgo_beverages?: boolean
          crgo_bldgmat?: boolean
          crgo_cargoothr?: boolean
          crgo_cargoothr_desc?: string | null
          crgo_chem?: boolean
          crgo_coalcoke?: boolean
          crgo_coldfood?: boolean
          crgo_construct?: boolean
          crgo_drivetow?: boolean
          crgo_drybulk?: boolean
          crgo_farmsupp?: boolean
          crgo_garbage?: boolean
          crgo_genfreight?: boolean
          crgo_grainfeed?: boolean
          crgo_household?: boolean
          crgo_intermodal?: boolean
          crgo_liqgas?: boolean
          crgo_livestock?: boolean
          crgo_logpole?: boolean
          crgo_machlrg?: boolean
          crgo_meat?: boolean
          crgo_metalsheet?: boolean
          crgo_mobilehome?: boolean
          crgo_motoveh?: boolean
          crgo_oilfield?: boolean
          crgo_paperprod?: boolean
          crgo_passengers?: boolean
          crgo_produce?: boolean
          crgo_usmail?: boolean
          crgo_utility?: boolean
          crgo_waterwell?: boolean
          dba_name?: string | null
          dnc_reason?: string | null
          dnc_set_at?: string | null
          dnc_set_by?: string | null
          do_not_contact?: boolean
          docket_display?: string | null
          dot_number?: number
          duns_number?: string | null
          email_address?: string | null
          entity_type?: string | null
          fax?: string | null
          first_seen_at?: string
          fleetsize?: string | null
          fmcsa_add_date?: string | null
          geocode_addr_hash?: string | null
          geocode_precision?: Database["public"]["Enums"]["geocode_precision"]
          geocode_source?: string | null
          geocoded_at?: string | null
          geom?: unknown
          hm_ind?: boolean | null
          last_changed_at?: string | null
          last_synced_at?: string | null
          lat?: number | null
          leased_tractors?: number | null
          leased_trailers?: number | null
          leased_trucks?: number | null
          legal_name?: string
          lng?: number | null
          mail_city?: string | null
          mail_state?: string | null
          mail_street?: string | null
          mail_zip?: string | null
          mcs150_date?: string | null
          mcs150_mileage?: number | null
          mcs150_mileage_year?: number | null
          owned_tractors?: number | null
          owned_trailers?: number | null
          owned_trucks?: number | null
          phone?: string | null
          phy_city?: string | null
          phy_county?: string | null
          phy_state?: string | null
          phy_street?: string | null
          phy_zip?: string | null
          phy_zip5?: string | null
          power_units?: number | null
          prior_revoke_dot_number?: number | null
          prior_revoke_flag?: boolean | null
          recordable_crash_rate?: number | null
          row_hash?: string | null
          source_missing_since?: string | null
          status_code?: string | null
          total_cdl?: number | null
          total_drivers?: number | null
          truck_units?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "carriers_dnc_set_by_fkey"
            columns: ["dnc_set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      city_centroids: {
        Row: {
          city: string
          lat: number
          lng: number
          state: string
        }
        Insert: {
          city: string
          lat: number
          lng: number
          state: string
        }
        Update: {
          city?: string
          lat?: number
          lng?: number
          state?: string
        }
        Relationships: []
      }
      contact_logs: {
        Row: {
          batch_id: string | null
          callback_at: string | null
          channel: Database["public"]["Enums"]["contact_channel"]
          contacted_at: string
          created_at: string
          disposition: Database["public"]["Enums"]["contact_disposition"]
          dot_number: number
          id: string
          next_steps: string | null
          notes: string | null
          user_id: string
        }
        Insert: {
          batch_id?: string | null
          callback_at?: string | null
          channel: Database["public"]["Enums"]["contact_channel"]
          contacted_at?: string
          created_at?: string
          disposition: Database["public"]["Enums"]["contact_disposition"]
          dot_number: number
          id?: string
          next_steps?: string | null
          notes?: string | null
          user_id: string
        }
        Update: {
          batch_id?: string | null
          callback_at?: string | null
          channel?: Database["public"]["Enums"]["contact_channel"]
          contacted_at?: string
          created_at?: string
          disposition?: Database["public"]["Enums"]["contact_disposition"]
          dot_number?: number
          id?: string
          next_steps?: string | null
          notes?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_logs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batch_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_logs_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_logs_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "contact_logs_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "contact_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_suppressions: {
        Row: {
          channel: Database["public"]["Enums"]["suppression_channel"]
          created_at: string
          created_by: string | null
          dot_number: number | null
          expires_at: string | null
          id: number
          reason: string | null
          source: Database["public"]["Enums"]["suppression_source"]
          value: string | null
        }
        Insert: {
          channel: Database["public"]["Enums"]["suppression_channel"]
          created_at?: string
          created_by?: string | null
          dot_number?: number | null
          expires_at?: string | null
          id?: never
          reason?: string | null
          source?: Database["public"]["Enums"]["suppression_source"]
          value?: string | null
        }
        Update: {
          channel?: Database["public"]["Enums"]["suppression_channel"]
          created_at?: string
          created_by?: string | null
          dot_number?: number | null
          expires_at?: string | null
          id?: never
          reason?: string | null
          source?: Database["public"]["Enums"]["suppression_source"]
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contact_suppressions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_suppressions_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carrier_warnings"
            referencedColumns: ["dot_number"]
          },
          {
            foreignKeyName: "contact_suppressions_dot_number_fkey"
            columns: ["dot_number"]
            isOneToOne: false
            referencedRelation: "carriers"
            referencedColumns: ["dot_number"]
          },
        ]
      }
      data_quality_reports: {
        Row: {
          created_at: string
          metrics: Json
          run_date: string
        }
        Insert: {
          created_at?: string
          metrics: Json
          run_date: string
        }
        Update: {
          created_at?: string
          metrics?: Json
          run_date?: string
        }
        Relationships: []
      }
      pipeline_config: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      pipeline_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: number
          job: Database["public"]["Enums"]["pipeline_job"]
          meta: Json
          rows_changed: number | null
          rows_read: number | null
          rows_upserted: number | null
          started_at: string
          status: Database["public"]["Enums"]["run_status"]
          step: Database["public"]["Enums"]["pipeline_step"]
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: never
          job: Database["public"]["Enums"]["pipeline_job"]
          meta?: Json
          rows_changed?: number | null
          rows_read?: number | null
          rows_upserted?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          step: Database["public"]["Enums"]["pipeline_step"]
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: never
          job?: Database["public"]["Enums"]["pipeline_job"]
          meta?: Json
          rows_changed?: number | null
          rows_read?: number | null
          rows_upserted?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          step?: Database["public"]["Enums"]["pipeline_step"]
        }
        Relationships: []
      }
      profiles: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          avatar_color: string
          created_at: string
          email: string
          full_name: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
          status: Database["public"]["Enums"]["user_status"]
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          avatar_color?: string
          created_at?: string
          email: string
          full_name?: string
          id: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["user_status"]
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          avatar_color?: string
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["user_status"]
        }
        Relationships: [
          {
            foreignKeyName: "profiles_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      zip_centroids: {
        Row: {
          lat: number
          lng: number
          zcta: string
        }
        Insert: {
          lat: number
          lng: number
          zcta: string
        }
        Update: {
          lat?: number
          lng?: number
          zcta?: string
        }
        Relationships: []
      }
    }
    Views: {
      batch_dashboard: {
        Row: {
          archived_at: string | null
          created_at: string | null
          created_by: string | null
          created_by_name: string | null
          customer: string | null
          id: string | null
          job: string | null
          last_activity_at: string | null
          last_refreshed_at: string | null
          member_count: number | null
          name: string | null
          promoted_count: number | null
          snapshot_taken_at: string | null
          status_counts: Json | null
          warnings_count: number | null
          with_phone: number | null
          zones: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      carrier_warnings: {
        Row: {
          dot_number: number | null
          warning_reasons: string[] | null
        }
        Relationships: []
      }
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      sync_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: number | null
          ok: boolean | null
          rows_upserted: number | null
          source: Database["public"]["Enums"]["sync_source"] | null
          started_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      batch_members: {
        Args: {
          p_batch_id: string
          p_dir?: string
          p_has_email?: boolean
          p_has_phone?: boolean
          p_min_insurance?: number
          p_page?: number
          p_page_size?: number
          p_q?: string
          p_size_max?: number
          p_size_min?: number
          p_sort?: string
          p_status?: Database["public"]["Enums"]["batch_carrier_status"][]
          p_warnings_only?: boolean
        }
        Returns: {
          added_via_refresh: boolean
          contact_count: number
          contact_name: string
          dba_name: string
          do_not_contact: boolean
          dot_number: number
          email: string
          has_warnings: boolean
          last_contact_at: string
          last_contact_channel: Database["public"]["Enums"]["contact_channel"]
          lat: number
          legal_name: string
          lng: number
          phone: string
          phy_city: string
          power_units: number
          promoted_at: string
          status: Database["public"]["Enums"]["batch_carrier_status"]
          status_changed_at: string
          status_changed_by_name: string
          total_count: number
          warning_reasons: string[]
        }[]
      }
      batch_members_map: {
        Args: {
          p_batch_id: string
          p_dir?: string
          p_has_email?: boolean
          p_has_phone?: boolean
          p_min_insurance?: number
          p_q?: string
          p_size_max?: number
          p_size_min?: number
          p_sort?: string
          p_status?: Database["public"]["Enums"]["batch_carrier_status"][]
          p_warnings_only?: boolean
        }
        Returns: {
          do_not_contact: boolean
          dot_number: number
          has_warnings: boolean
          lat: number
          lng: number
          row_num: number
          status: Database["public"]["Enums"]["batch_carrier_status"]
        }[]
      }
      batch_status_counts: {
        Args: { p_batch_id: string }
        Returns: {
          attempted_count: number
          contacted_count: number
          dnc_count: number
          interested_count: number
          new_count: number
          not_a_fit_count: number
          warnings_count: number
          with_email: number
          with_phone: number
        }[]
      }
      bulk_set_status: {
        Args: {
          p_batch_id: string
          p_dots: number[]
          p_status: Database["public"]["Enums"]["batch_carrier_status"]
        }
        Returns: number
      }
      count_carriers: {
        Args: { p_definition: Json }
        Returns: {
          dnc_excluded: number
          geocoded_pct: number
          match_count: number
          tier1_count: number
          with_email: number
          with_phone: number
          with_warnings: number
        }[]
      }
      create_batch: {
        Args: {
          p_customer: string
          p_definition: Json
          p_description: string
          p_job: string
          p_name: string
        }
        Returns: {
          batch_id: string
          member_count: number
        }[]
      }
      dashboard_totals: {
        Args: never
        Returns: {
          active_batches: number
          distinct_carriers: number
          interested: number
          promoted: number
          with_phone: number
        }[]
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      facet_cargo_flags: {
        Args: { p_definition: Json }
        Returns: {
          carrier_count: number
          flag: string
        }[]
      }
      facet_other_values: {
        Args: {
          p_definition: Json
          p_keyword?: string
          p_limit?: number
          p_offset?: number
        }
        Returns: {
          carrier_count: number
          is_sand_gravel: boolean
          match_group: string
          sample_raw: string
          total_values: number
          value: string
        }[]
      }
      facet_suggested_keywords: {
        Args: { p_definition: Json }
        Returns: {
          carrier_count: number
          match_group: string
          value_count: number
        }[]
      }
      generate_contact_sheet: {
        Args: { p_batch_id: string; p_dots?: number[] }
        Returns: {
          cell_phone: string
          contact_name: string
          dba_name: string
          dot_number: number
          email: string
          last_contact_at: string
          legal_name: string
          next_steps: string
          phone: string
          phy_city: string
          phy_state: string
          status: Database["public"]["Enums"]["batch_carrier_status"]
          warning_reasons: string[]
        }[]
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      gettransactionid: { Args: never; Returns: unknown }
      is_contactable: {
        Args: {
          p_channel: Database["public"]["Enums"]["contact_channel"]
          p_dot: number
        }
        Returns: boolean
      }
      log_export: {
        Args: { p_batch_id: string; p_kind: string; p_row_count: number }
        Returns: undefined
      }
      longtransactionsenabled: { Args: never; Returns: boolean }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      refresh_batch: {
        Args: { p_batch_id: string }
        Returns: {
          added_count: number
          added_dots: number[]
        }[]
      }
      search_carriers: {
        Args: {
          p_definition: Json
          p_dir?: string
          p_page?: number
          p_page_size?: number
          p_sort?: string
        }
        Returns: {
          authority_active: boolean
          bipd_on_file: number
          cargo_flags: string[]
          cargo_other_desc: string
          carrier_operation: string
          cell_phone: string
          classdef: string
          contact_name: string
          dba_name: string
          do_not_contact: boolean
          dot_number: number
          email: string
          geocode_precision: Database["public"]["Enums"]["geocode_precision"]
          has_warnings: boolean
          in_batches: number
          lat: number
          legal_name: string
          lng: number
          matched_zones: string[]
          phone: string
          phy_city: string
          phy_state: string
          phy_zip: string
          power_units: number
          total_count: number
          total_drivers: number
          warning_reasons: string[]
        }[]
      }
      search_carriers_map: {
        Args: { p_definition: Json; p_limit?: number }
        Returns: {
          dot_number: number
          has_warnings: boolean
          lat: number
          lng: number
          matched_zones: string[]
        }[]
      }
      set_do_not_contact: {
        Args: { p_dot: number; p_on: boolean; p_reason?: string }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
    }
    Enums: {
      activity_type:
        | "batch_created"
        | "members_added"
        | "refresh"
        | "status_change"
        | "bulk_status_change"
        | "carrier_removed"
        | "promoted"
        | "dnc_set"
        | "dnc_cleared"
        | "comment"
        | "export"
      anchor_kind: "pin" | "address" | "city" | "zip" | "county"
      authority_status: "active" | "pending" | "inactive" | "none" | "unknown"
      batch_carrier_status:
        | "new"
        | "attempted"
        | "contacted"
        | "interested"
        | "not_a_fit"
      contact_channel: "call" | "text" | "email" | "mail"
      contact_disposition:
        | "no_answer"
        | "voicemail"
        | "connected"
        | "callback"
        | "interested"
        | "not_interested"
        | "wrong_number"
        | "sent"
        | "replied"
        | "bounced"
        | "no_response"
      geocode_precision:
        | "rooftop"
        | "range_interpolated"
        | "geometric_center"
        | "approximate"
        | "zip_centroid"
        | "city_centroid"
        | "none"
      pipeline_job: "nightly" | "monthly" | "backfill"
      pipeline_step:
        | "sync-census"
        | "sync-authority"
        | "sync-insurance"
        | "sync-safety"
        | "cargo-facets"
        | "geocode"
        | "dq-report"
      run_status: "running" | "success" | "failed"
      suppression_channel: "call" | "text" | "email" | "mail" | "all"
      suppression_source:
        | "manual"
        | "carrier_request"
        | "dnc_registry"
        | "esp_unsubscribe"
        | "esp_bounce"
        | "sms_stop"
      sync_source: "census" | "li" | "sms_safety" | "inspections" | "geocode"
      user_role: "manager" | "edit" | "view" | "guest"
      user_status: "pending" | "approved" | "disabled"
      zone_type: "radius" | "corridor"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      activity_type: [
        "batch_created",
        "members_added",
        "refresh",
        "status_change",
        "bulk_status_change",
        "carrier_removed",
        "promoted",
        "dnc_set",
        "dnc_cleared",
        "comment",
        "export",
      ],
      anchor_kind: ["pin", "address", "city", "zip", "county"],
      authority_status: ["active", "pending", "inactive", "none", "unknown"],
      batch_carrier_status: [
        "new",
        "attempted",
        "contacted",
        "interested",
        "not_a_fit",
      ],
      contact_channel: ["call", "text", "email", "mail"],
      contact_disposition: [
        "no_answer",
        "voicemail",
        "connected",
        "callback",
        "interested",
        "not_interested",
        "wrong_number",
        "sent",
        "replied",
        "bounced",
        "no_response",
      ],
      geocode_precision: [
        "rooftop",
        "range_interpolated",
        "geometric_center",
        "approximate",
        "zip_centroid",
        "city_centroid",
        "none",
      ],
      pipeline_job: ["nightly", "monthly", "backfill"],
      pipeline_step: [
        "sync-census",
        "sync-authority",
        "sync-insurance",
        "sync-safety",
        "cargo-facets",
        "geocode",
        "dq-report",
      ],
      run_status: ["running", "success", "failed"],
      suppression_channel: ["call", "text", "email", "mail", "all"],
      suppression_source: [
        "manual",
        "carrier_request",
        "dnc_registry",
        "esp_unsubscribe",
        "esp_bounce",
        "sms_stop",
      ],
      sync_source: ["census", "li", "sms_safety", "inspections", "geocode"],
      user_role: ["manager", "edit", "view", "guest"],
      user_status: ["pending", "approved", "disabled"],
      zone_type: ["radius", "corridor"],
    },
  },
} as const
