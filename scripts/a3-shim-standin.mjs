// LOCAL TEST TOOLING ONLY. The A3 Supabase shim (supabase/tests/a3/harness/supabase-shim.sql) attaches its PostGIS stand-ins to
// test_ext5, an empty SQL-only extension from PostgreSQL's own test modules. The PostgreSQL 16 install ships it; the PostgreSQL 17
// binaries zip does not. Where it is missing, the same empty, relocatable extension is made from tsm_system_rows (a contrib module both
// ship): created, its one member function taken out of it and dropped, so the PostGIS stand-ins are again its only members (pg_depend 'e').
// Nothing is written into the PostgreSQL install, and the shim file itself is unchanged and used as written when test_ext5 exists.
// Used by scripts/a3-build-test-db.mjs and pipeline/src/prod-sql-a2-backouts-a3.test.ts (the two places that run the shim).

/** Is test_ext5 installed on the server `query` talks to? `query(sql)` returns { rows }. */
export async function hasTestExt5(query) {
  return (await query("select count(*)::int as n from pg_catalog.pg_available_extensions where name = 'test_ext5'")).rows[0].n > 0;
}

/** The shim text with test_ext5 replaced by an emptied tsm_system_rows. Throws if the shim does not have exactly one
 *  "create extension test_ext5 schema <name>;" line or names test_ext5 anywhere else outside a comment. Pure. */
export function shimWithoutTestExt5(shim) {
  const create = /^create extension test_ext5 schema ([a-z_]+);$/gm;
  if ((shim.match(create) ?? []).length !== 1) throw new Error('supabase-shim.sql: expected exactly one "create extension test_ext5" line');
  const out = shim
    .replace(create, (_m, schema) => `create extension tsm_system_rows schema ${schema};
alter extension tsm_system_rows drop function ${schema}.system_rows(internal);
drop function ${schema}.system_rows(internal);`)
    .replace(/^alter extension test_ext5 add /gm, 'alter extension tsm_system_rows add ');
  if (/test_ext5/.test(out.replace(/^--.*$/gm, ''))) throw new Error('supabase-shim.sql: test_ext5 is named outside the lines that are replaced');
  return out;
}

/** The shim text to run on this server: unchanged when test_ext5 is installed, otherwise shimWithoutTestExt5. */
export async function shimForServer(shim, query) {
  return (await hasTestExt5(query)) ? shim : shimWithoutTestExt5(shim);
}
