# Production Recovery Rehearsal Runbook

Status: approval-ready plan. This document does not create a project, restore a backup, change production, or authorize cost.

## Objective

Prove that a current physical backup of the production Carrier Recruiter can be restored into an independent project and that the restored database is usable. The rehearsal is a launch gate before any production migration-ledger or pipeline canary write.

## Verified source identity and baseline

- Source project: `truck-recruitment-tool`
- Source ref: `ejrfobddnojbijzrjbii`
- Organization: `Twisted Nail Broker Services` (`svmhdffcnfuoyvaegpbl`), Pro plan
- Region: `us-east-2`
- PostgreSQL: 17.6
- Current database size: 538,987,667 bytes (about 514 MiB)
- Current database totals: 192,300 carriers, 0 safety rows, 0 Auth users, 0 profiles, 0 batches, 0 contact logs
- Current migration ledger: only `20260722042539_geocode_attempt_queue`
- Installed application extensions: PostGIS 3.3.7, pg_trgm 1.6, citext 1.6, uuid-ossp 1.1, pgcrypto 1.3, pg_stat_statements 1.11, supabase_vault 0.3.1
- Edge Functions: none
- Realtime publication: batches, batch_zones, batch_carriers, batch_activity, contact_logs, profiles

These values are acceptance anchors, not immutable expected values. Immediately before the restore, record fresh values and explain any ordinary pipeline drift.

## Official platform facts

Supabase automatically creates daily backups for Pro projects and retains seven days. Restore to a New Project is available on paid plans when physical backups are enabled. The restore creates a new, independent project in the same region and mirrors source compute, disk attributes, SSL enforcement, and network restrictions. The dashboard presents the exact added monthly cost before confirmation.

The clone copies the database schema, data, indexes, roles/permissions, Auth records, and encryption root key. It does not copy Storage objects/settings, Edge Functions, Auth settings/API keys, Realtime settings, or read replicas. Database extensions are copied, but extension configuration and externally acting extensions still require review. A restored project cannot itself be used as a source for another clone.

Sources:
- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/platform/clone-project
- https://supabase.com/pricing

## Owner gate and cost boundary

The restore is not authorized until all three are true:

1. Hunter is signed in to the exact production project's Supabase dashboard and confirms a current daily backup is visible under Database > Backups.
2. The Restore to a New Project dialog displays the exact new-project name, source backup timestamp, region, mirrored compute/disk, and added monthly cost.
3. Hunter explicitly approves that quoted cost and exact destination in chat.

Do not infer the clone cost from the existing $10/month staging quote. The clone mirrors source resource attributes and its displayed cost is authoritative.

## Proposed clone identity

- Name: `truck-recruitment-tool-recovery-20260723`
- Organization: `Twisted Nail Broker Services`
- Source: the newest completed daily backup that predates the rehearsal start
- Region: inherited `us-east-2`
- Lifecycle: retain only through evidence collection, then obtain separate owner approval to delete or retire it

If the name already exists, stop and choose a new dated name. Never repurpose staging or another application project.

## Pre-restore capture

Record immediately before confirmation:

- backup timestamp and status;
- source project ref/status/Postgres version;
- database byte size;
- exact counts for carriers, active Texas carriers, safety, Auth users, profiles, batches, contact logs, and pipeline runs;
- migration ledger rows;
- installed extension versions and schemas;
- public tables, RLS flags, functions, policies, grants, indexes, and Realtime publication members;
- Edge Function inventory;
- quoted clone cost and copied resource attributes.

No secret, API key, database password, JWT secret, or connection string belongs in screenshots, logs, repository files, or chat.

## Restore execution and stop conditions

Use the dashboard's Restore to a New Project flow only after approval. Stop if:

- the source ref, organization, backup timestamp, region, compute/disk, or name differs from the approved values;
- the cost differs from the approved quote;
- the selected backup is failed, incomplete, or older than intended;
- the flow proposes an in-place production restore;
- any unrelated project is selected;
- initialization remains unhealthy or produces an ambiguous timeout.

A timeout is an unknown state. Reread the project inventory before retrying; never submit twice blindly.

## Post-restore acceptance

The restored project passes only when:

1. Project status is ACTIVE_HEALTHY and identity matches the approved clone.
2. PostgreSQL version and region match the source.
3. Schema, tables, functions, policies, grants, indexes, migration ledger, extension inventory, and Realtime publication match the captured source baseline, except for documented platform-generated differences.
4. Representative row counts match the backup point. Current source counts may be newer and are not the comparison target.
5. Auth user count matches the backup point.
6. Representative carrier rows, geometry, insurance, cargo facets, pipeline configuration, and pipeline run history are readable.
7. No production Render cron, webhook, external integration, or application deployment points at the clone.
8. New API keys differ from production and are not copied into any production configuration.
9. Auth, Realtime, Storage, Edge Functions, extensions/settings, and network restrictions are reviewed for manual reconfiguration gaps.
10. Restore start/end times and total recovery time are recorded.

Do not run the production pipeline against the clone. Any functional write probe must use a separately approved fictional record or a transaction that rolls back.

## Evidence package

Retain:

- backup timestamp and pre-restore source inventory;
- approved cost and clone identity;
- restore start/end timestamps;
- clone project ref/status;
- post-restore inventory comparison;
- row-count comparison at the backup point;
- manual-reconfiguration checklist;
- unresolved defects and whether they block Tier 3 production work.

## Cleanup gate

Deletion is irreversible and removes clone data and backups. Do not delete the clone automatically. After evidence is retained, present the exact clone identity and current cost to Hunter and obtain a separate lifecycle decision. Verify deletion/retirement independently afterward.

## Current blocker

The connected Supabase integration does not expose backup inventory or Restore to a New Project actions, and the available browser session is not signed in. Hunter must complete the dashboard sign-in and backup/cost confirmation. No terminal work is required.
