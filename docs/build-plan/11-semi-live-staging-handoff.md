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

If the password is unknown or should be rotated, use Forgot password on the staging login screen. Do not create or reuse a production login for this review.

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

- Email/password sign-in, registration gate, pending gate, password-reset request, roles, and manager user administration.
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

The repository contains supabase/staging/reset-fictional-data.sql and scripts/verify-staging-reset.mjs.

The reset:

- requires the exact staging ref yhyoxhtguyturgdhwywc;
- requires the confirmation phrase RESET FICTIONAL TNBS RECRUITER DATA;
- refuses any other ref before deleting rows;
- contains no production ref;
- preserves auth.users and public.profiles, including Hunter's staging login;
- deletes only staging application and pipeline data;
- restores the deterministic 800-carrier, two-batch fictional baseline in one transaction;
- rolls back unless identity, carrier, batch, cross-batch, DNC, and warning assertions pass.

The reset is an operator-run maintenance action, not a browser button. That avoids exposing a destructive database-wide action to ordinary application sessions. Run it only through an authenticated staging maintenance channel after independently confirming the selected project is truck-recruitment-tool-staging.

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
