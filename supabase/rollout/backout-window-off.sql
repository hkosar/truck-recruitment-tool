-- ============================================================================
-- backout-window-off.sql -- the production runner action "window-off" (runbook step C4, only on Hunter's word).
-- NOT EXECUTED ANYWHERE. Pinned by SHA-256 in pipeline/src/prod-sql.ts.
--
-- Source (the two statements below are copied VERBATIM; only the closing semicolon is added so the file can be split):
--   * docs/build-plan/16-staging-and-hosting-plan.md section 3.1, "Close" (line 477: "window-off, then verify false"); the update is the inverse of the
--     "Activate" statement at lines 472-473, exactly as the reviewed runbook writes it.
--   * docs/build-plan/17-signin-cutover-runbook-draft.md at commit f1189dc (the reviewed draft), step C4 paste boxes (lines 434 and 438).
-- The runner sends the update and the verify select in ONE transaction and reads the verify result BEFORE it commits: if email_edits_paused is not
-- false the transaction is rolled back.
-- ============================================================================
update internal.backout_window set email_edits_paused = false;

select email_edits_paused from internal.backout_window;
