# Semi-Live Staging Handoff

Status: ready for owner design validation. This is not production and contains fictional carrier and workflow data.

## Environment

- Application: https://tnbs-carrier-recruiter-staging.twistednail.workers.dev
- Supabase project: truck-recruitment-tool-staging
- Supabase ref: yhyoxhtguyturgdhwywc
- Region: us-east-2
- Production ref ejrfobddnojbijzrjbii is not used by this application.
- The persistent header says Staging, fictional data, not production and shows the staging ref.

The application is hosted as the isolated Cloudflare Worker tnbs-carrier-recruiter-staging. It has no production route, production custom domain, production Render cron, or production database connection.

## Owner access

Use the approved staging identity for hunter@twistednail.com. The user is a confirmed staging manager and exists only in the staging project. The password is not stored in this repository or this handoff document.

The staging password is currently the temporary credential delivered in the handoff chat. Self-service Forgot password is not yet usable: hosted Supabase rejects recovery delivery to this domain in the current project configuration. If the credential is lost or should be rotated, have the staging operator set a new temporary credential through the supported Auth administration path. Do not create or reuse a production login for this review.

## Five-minute review script

1. Sign in and confirm the staging banner remains visible.
2. On Dashboard, confirm the two fictional baseline batches and recruiting totals appear.
3. Open Central Texas Aggregate Recruitment and review its lane chips, status counts, warnings, filters, carrier table, and recent activity.
4. Open any carrier. Review contact information, insurance and safety tiles, batch memberships, research links, and contact timeline.
5. Return to the batch and use Log outreach with a fictional note. Change one carrier status.
6. From a carrier opened through a batch, test Mark as Promoted and Set global DNC. Restore contact when finished if the review should not suppress that fixture.
7. Open Print contact sheet. Confirm global DNC carriers are excluded automatically.
8. Open New Batch. Enter a fictional batch name and a pin lane such as Austin, TX at latitude 30.2672, longitude -97.7431. Review live PostGIS counts before creating it.
9. Open Users and confirm manager-only account provisioning controls are understandable.
10. Record feedback using the template below instead of treating this environment as production-ready.

## What currently works

- Email/password sign-in, registration gate, pending gate, roles, and manager user administration.
- Dashboard totals and fictional active-batch table.
- Radius-pin batch builder with live PostGIS matching, freight facets, insurance, fleet-size, contactability, authority, and operating-status filters.
- Named batch creation and stable fictional sample batches.
- Batch status filtering, carrier search, warning filters, pagination, status changes, refresh, comments, and batch-level outreach logging.
- Detailed carrier profiles with contact, authority, insurance, safety, warnings, memberships, research links, and contact timeline.
- Global do-not-contact, promoted state, and printable contact sheets with DNC hard-exclusion.

## Deliberately deferred

The following are labelled unavailable rather than simulated:

- Rendered Google maps and map markers.
- City, ZIP, county, and address geocoding.
- Interactive corridor routing.
- Global carrier search.
- QCMobile inspection refresh.
- Automated email, SMS/text, mail/postcards, and enrichment modules.
- Production pipeline scheduling and real FMCSA data refreshes.

These require separately provisioned restricted credentials, production-policy decisions, or later implementation. They are outside this design-validation handoff.

## Reset policy

The repository contains supabase/staging/reset-fictional-data.sql, supabase/staging/cleanup-fixtures.sql, supabase/staging/install-staging-identity-marker.sql, the runner pipeline/src/staging-sql-runner.ts, and the offline checks scripts/verify-staging-reset.mjs and scripts/verify-staging-contract.mjs.

All three SQL files run only through the staging SQL runner. Do not paste them into a SQL editor; they refuse to run without the value the runner sets. Before it opens any connection, the runner:

- parses the database connection string with the same guard the pipeline uses, refusing any query parameter or fragment (these can silently redirect the database driver to another project);
- refuses the production project outright;
- requires exactly the staging project named in the Environment section;
- requires port 5432 (a session connection), so its settings stay on one database session;
- requires the action's confirmation phrase typed on the command line;
- without --execute, only prints that the target was verified, and never prints the connection string, password, or host.

The pipeline itself refuses to write to the staging project unless PIPELINE_ALLOW_STAGING_WRITES=true is set in addition to listing staging in PIPELINE_ALLOWED_DEV_REFS (which is now empty by default), so real FMCSA data cannot land in staging silently.

The reset:

- requires the runner-verified staging project and the staging identity marker in the connected database, naming that same project;
- also requires the staging ref setting and the confirmation phrase RESET FICTIONAL TNBS RECRUITER DATA (both supplied by the runner);
- refuses before deleting anything if any carrier, cargo value, or batch is not fixture-owned, or if any profile is neither a fixture identity nor Hunter's staging login;
- deletes only rows registered as fixture-owned (plus batches built entirely from registered carriers, such as a batch created during a review session), and then registers every row it recreates;
- leaves pipeline and reference tables (pipeline runs, data-quality reports, centroids) untouched;
- preserves auth.users and public.profiles, including Hunter's staging login;
- restarts ID sequences only for tables it emptied, inside the same transaction, so a failed reset leaves both rows and sequences exactly as they were;
- writes historical fixture contacts before re-applying global do-not-contact, so the contact-log DNC guard stays enabled;
- restores the deterministic 800-carrier, two-batch fictional baseline in one transaction;
- rolls back unless identity, carrier, batch, cross-batch, DNC, and warning assertions pass.

The fixture cleanup (removes the seven fixture identities) has the same runner and marker gates and its own confirmation phrase CLEAN UP TNBS RECRUITER FIXTURES. It deletes only registered fixture rows and the fixture identities (recognised by their explicit test metadata). It clears approval references to those identities under a service-role claim limited to that one statement, and it refuses if any other row still references a fixture identity.

The reset is an operator-run maintenance action, not a browser button. That avoids exposing a destructive database-wide action to ordinary application sessions.

### What "fixture-owned" means

The staging-only table staging_identity.fixture_rows lists, by key, every carrier, batch, and cargo value the fixture set owns. The reset adds its own rows to it. When the marker is first installed, existing rows are registered only if every one of them is provably part of the deterministic fictional baseline the reset generates: carriers must match the generator's exact fingerprint (derived DOT numbers and row hashes, reserved 555-01xx phone numbers, example.invalid email addresses); batches must be the two baseline batches created by their fixture identities; cargo values, contact logs, batch members, and batch activity must match what the reset writes; and there must be no contact suppressions. If anything else exists (for example real carriers loaded by a pipeline run, or batches, notes, status changes, or do-not-contact changes made during a review session), the installer refuses and lists how many rows of each kind it did not recognise. Nothing is adopted on trust.

### One-time step before the new reset or cleanup will run

The staging identity marker is a one-row table, staging_identity.marker, that exists only in the staging database. It is not a migration and must never be created in production. Until it exists, the reset and cleanup refuse to run. An approved operator does this once:

1. Get Hunter's approval for this staging change in chat.
2. On the operator's own machine, in the repository, run `npm ci` in the pipeline folder.
3. Put the staging database connection string (session pooler, port 5432, no `?` options) in the environment variable STAGING_DB_URL in that terminal only. Do not save it in a file in the repository.
4. Dry run first. Nothing connects:
   `npm --prefix pipeline run staging:sql -- --action=install-marker --confirm="INSTALL TNBS STAGING IDENTITY MARKER"`
   Expect a line containing staging-sql.verified and then staging-sql.plan_only. If it prints staging-sql.refused instead, stop and report the message.
5. Run it for real by adding --execute to the same command.
6. Expect staging-sql.done. The installer refuses if the marker already exists, if any profile is neither a fixture identity nor Hunter's staging login, or if any business row is not part of the fictional baseline; that last refusal lists counts per kind (carriers, batches, cargo values, contact logs, contact suppressions, batch members, batch activity, carrier do-not-contact changes). If it refuses, stop and report the whole message to Hunter; do not edit the file to force it. There is currently no approved way to adopt rows outside the baseline.

### Running the reset afterwards

Same terminal setup, then:
`npm --prefix pipeline run staging:sql -- --action=reset --confirm="RESET FICTIONAL TNBS RECRUITER DATA" --execute`
A refusal message names the gate that failed; nothing has been changed when it refuses.

## Acceptance evidence

A real hosted browser smoke pass succeeded for:

- staging manager sign-in;
- Dashboard and Users rendering after the query-cache collision fix;
- a 73-match Austin-area fictional batch creation;
- status change to interested;
- batch-level call logging with notes and next step;
- carrier profile and timeline;
- mark promoted;
- global DNC;
- a 72-row contact sheet from 73 members after one DNC exclusion.

Repository verification passed:

- application typecheck;
- ESLint with no errors and 16 existing Fast Refresh warnings;
- five focused unit tests;
- production and staging builds;
- migration baseline verification;
- hosted-fixture safety scan;
- staging fixture/role-test contract;
- staging reset safety contract.

## Known operational notes

- The application is currently a static Worker deployment. Update it only from a verified staging build.
- The inactive Pages shell named tnbs-carrier-recruiter-staging has no deployment and is not the review URL.
- Refreshing a deployment may require a cache-busting query while a browser tab still holds the prior immutable asset graph. New sessions receive the current build.
- Test actions intentionally change fictional staging rows until the operator runs the reset.
- Self-service password recovery currently returns an Auth email-address validation error for hunter@twistednail.com; use the known temporary credential or request an operator rotation.
- The reset preserves Hunter's staging login but invalidates batch IDs because the deterministic baseline batches are recreated with new UUIDs.

## Feedback template

For each issue or idea, capture:

- Screen or workflow step:
- What you expected:
- What happened:
- Why it matters operationally:
- Must fix before real use, should improve, or later enhancement:
- Screenshot or carrier/batch identifier, if useful:

## Repository references

- Active review branch: hyperagent/safety-contract-live-types-20260722
- Query-cache isolation fix: remote commit b9ed2891cdef8b387c200cb2ab8dde7b6f7d8b83
- Gated reset initial commit: remote commit c756282c7967536da3ac6644553a289ea3c6070e
- Reset delete-audit fix: remote commit 40f2e5863bded277224a617af7b7691dc729218c

No merge to the production branch, production deployment, production data write, or production migration-ledger change is authorized by this handoff.
