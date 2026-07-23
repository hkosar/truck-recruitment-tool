-- Staging-only cleanup for the deterministic database fixture set.
-- Apply only after independently verifying project ref yhyoxhtguyturgdhwywc.

begin;

-- Business rows must be deleted in dependency order before database-only users.
delete from public.contact_logs;
delete from public.contact_suppressions;
delete from public.batch_activity;
delete from public.batch_carriers;
delete from public.batch_zones;
delete from public.batches;
delete from public.cargo_other_values;
delete from public.carrier_qc_snapshots;
delete from public.carrier_inspections;
delete from public.carrier_safety;
delete from public.carrier_insurance_filings;
delete from public.carrier_insurance;
delete from public.data_quality_reports;
delete from public.pipeline_runs;
delete from public.zip_centroids;
delete from public.city_centroids;
delete from public.carriers;

delete from auth.users
where raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'
  and raw_user_meta_data->>'test_only' = 'true'
  and email like '%@tnbs-recruiter.example.invalid'
  and encrypted_password is null;

commit;
