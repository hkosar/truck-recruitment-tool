-- ============================================================================
-- backout-window-on.sql -- the production runner action "window-on" (runbook step B10).
-- NOT EXECUTED ANYWHERE. Pinned by SHA-256 in pipeline/src/prod-sql.ts.
--
-- Source (the two statements below are copied VERBATIM; only the closing semicolon is added so the file can be split):
--   * docs/build-plan/16-staging-and-hosting-plan.md section 3.1, "Activate" (line 472, wrapped over lines 472-473) and "Verify" (line 475).
--   * docs/build-plan/17-signin-cutover-runbook-draft.md at commit f1189dc (the reviewed draft), step B10 paste boxes (lines 328 and 332).
-- The runner sends the update and the verify select in ONE transaction and reads the verify result BEFORE it commits: if email_edits_paused is not
-- true the transaction is rolled back. The same two statements, with the value false, are supabase/rollout/backout-window-off.sql (runbook C4).
-- ============================================================================
update internal.backout_window set email_edits_paused = true;

select email_edits_paused from internal.backout_window;
