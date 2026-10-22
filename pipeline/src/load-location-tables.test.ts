import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { cityCentroidFallback, zipCentroidFallback, type GeocodeCandidate } from './geocode.js';
import type { PipelineContext } from './db.js';
import {
  applyLoad, buildCityRows, buildZipRows, parseCliArgs, placeBaseName,
} from './load-location-tables.js';

/**
 * Always runs the pure parsing tests. The database part runs only when LOCATION_TEST_ADMIN_URL (an
 * admin connection to a throwaway LOCAL Postgres, loopback only) and the two real Gazetteer files
 * (LOCATION_TEST_ZCTA, LOCATION_TEST_PLACES) are provided; otherwise it is reported as skipped.
 * The test CREATES its own uniquely named database, stamps it with a marker, holds an advisory lock on
 * it, and drops only that database at the end. It refuses a database name that already exists and never
 * drops a supplied database or schema.
 */

const ZCTA = ['GEOID|GEOIDFQ|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG',
  '75001|x|1|1|1|1|32.96|-96.83', '88510|x|1|1|1|1|31.77|-106.40', '90210|x|1|1|1|1|34.1|-118.4',
  '77001|x|1|1|1|1|0|0', '7700|x|1|1|1|1|29.7|-95.3'].join('\n');
const PLACES = ['USPS|GEOID|GEOIDFQ|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG',
  'TX|1|x|x|Austin city|25|A|900|1|1|1|30.26|-97.74',
  'TX|2|x|x|Bayview town|43|A|100|1|1|1|26.1|-97.2',
  'TX|3|x|x|Bayview CDP|57|S|500|1|1|1|26.2|-97.3',
  'TX|4|x|x|Lopeño CDP|57|S|500|1|1|1|26.3|-99.1',
  'NM|5|x|x|Santa Fe city|25|A|500|1|1|1|35.6|-105.9  '].join('\n');

function pureTests(): void {
  const z = buildZipRows(ZCTA);
  assert.deepEqual(z.rows.map((r) => r.zcta), ['75001', '88510'], 'TX prefixes kept (incl. El Paso 885xx), 90210 dropped');
  assert.equal(z.rejected.length, 2, 'zero coordinates and a 4-digit GEOID are rejected');

  const c = buildCityRows(PLACES, 'TX');
  assert.deepEqual(c.rows.map((r) => r.city), ['Austin', 'Bayview', 'Lopeño']);
  assert.equal(c.rows.find((r) => r.city === 'Bayview')?.lat, 26.1, 'incorporated town beats the CDP of the same name');
  assert.equal(placeBaseName('Fort Worth city', '25'), 'Fort Worth');
  assert.equal(placeBaseName('Odd Name', '99'), 'Odd Name');

  assert.deepEqual(parseCliArgs(['--zcta=a', '--places=b']), { zcta: 'a', places: 'b', state: 'TX', apply: false }, 'dry-run is the default');
  assert.equal(parseCliArgs(['--zcta=a', '--places=b', '--apply']).apply, true);
  assert.throws(() => parseCliArgs(['--zcta=a']), /required/);
  const amb = buildCityRows([PLACES.split('\n')[0] as string,
    'TX|1|x|x|Reno city|25|A|900|1|1|1|32.9|-97.5', 'TX|2|x|x|Reno city|25|A|800|1|1|1|33.6|-95.5',
    'TX|3|x|x|Sunset CDP|57|S|1|1|1|1|33.4|-97.9', 'TX|4|x|x|Sunset CDP|57|S|1|1|1|1|30.0|-96.0',
    'TX|5|x|x|Lago Vista CDP|57|S|1|1|1|1|30.4|-97.9', 'TX|6|x|x|Lago Vista city|25|A|1|1|1|1|30.46|-97.99'].join('\n'), 'TX');
  assert.deepEqual(amb.ambiguous, ['Reno', 'Sunset'], 'same-standing duplicates are omitted and reported');
  assert.deepEqual(amb.rows.map((r) => r.city), ['Lago Vista'], 'town + CDP of one name resolves to the incorporated one');

  const panhandle = buildZipRows(['GEOID|INTPTLAT|INTPTLONG', '73960|36.0|-102.5', '73950|36.0|-102.6', '73301|30.2|-97.7'].join('\n'));
  assert.deepEqual(panhandle.rows.map((r) => r.zcta), ['73301', '73960'], '73960 is added; the rest of 739xx is not');
  console.log('ok  pure parsing tests');
}

function realFileTests(zctaFile: string, placesFile: string): void {
  const cities = buildCityRows(readFileSync(placesFile, 'utf8'));
  const names = new Set(cities.rows.map((r) => r.city.toLowerCase()));
  for (const dup of ['reno', 'lakeside', 'oak ridge', 'sunset', 'chula vista']) {
    assert.ok(cities.ambiguous.map((n) => n.toLowerCase()).includes(dup), `${dup} is reported ambiguous`);
    assert.ok(!names.has(dup), `${dup} is not loaded`);
  }
  assert.ok(names.has('lago vista') && names.has('austin'), 'resolvable and unique names are still loaded');
  const zips = buildZipRows(readFileSync(zctaFile, 'utf8'));
  assert.ok(zips.rows.some((r) => r.zcta === '73960'), '73960 is loaded from the real file');
  assert.ok(!zips.rows.some((r) => r.zcta === '73950'), 'other 739xx ZIPs are not');
  console.log(JSON.stringify({ ambiguousCityNames: cities.ambiguous.length, names: cities.ambiguous }));
  console.log('ok  real-file tests');
}

async function dbTests(adminUrl: string, zctaFile: string, placesFile: string): Promise<void> {
  const adminParsed = new URL(adminUrl);
  if (adminParsed.hostname !== '127.0.0.1' && adminParsed.hostname !== 'localhost') throw new Error('LOCATION_TEST_ADMIN_URL must be loopback');
  // A brand-new database that only this run creates; a name that already exists is refused, never reused.
  const dbName = `tr_loctest_${randomBytes(6).toString('hex')}`;
  const token = randomBytes(16).toString('hex');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const existing = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
  if (existing.rowCount) throw new Error(`refusing: database ${dbName} already exists`);
  await admin.query(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  const lock = new pg.Client({ connectionString: url.toString() });
  try {
    await lock.connect();
    await lock.query('create table _owner_marker (token text not null)');
    await lock.query('insert into _owner_marker values ($1)', [token]);
    const got = await lock.query('select pg_try_advisory_lock(727002) as ok');
    if (!got.rows[0]?.ok) throw new Error('test database is claimed by another process');
    // Local Postgres has no PostGIS: shim just enough for geocode.ts st_setsrid(st_makepoint(..))::geography.
    await q(`create domain geography as point;
      create function st_makepoint(double precision, double precision) returns point language sql immutable as 'select point($1,$2)';
      create function st_setsrid(point, int) returns point language sql immutable as 'select $1';
      create table zip_centroids (zcta text primary key, lat double precision not null, lng double precision not null);
      create table city_centroids (state text not null, city text not null, lat double precision not null, lng double precision not null, primary key (state, city));
      create table carriers (dot_number bigint primary key, phy_street text, phy_city text, phy_state text, phy_zip5 text,
        address_hash text, geocode_addr_hash text, geom geography, geocode_precision text, geocode_source text, geocoded_at timestamptz);`);

    const zips = buildZipRows(readFileSync(zctaFile, 'utf8'));
    const cities = buildCityRows(readFileSync(placesFile, 'utf8'));
    const first = await applyLoad(pool, zips.rows, cities.rows);
    console.log('first load ', JSON.stringify(first));
    assert.deepEqual(first.zip, { inserted: zips.rows.length, updated: 0, unchanged: 0 });
    assert.deepEqual(first.city, { inserted: cities.rows.length, updated: 0, unchanged: 0 });
    const second = await applyLoad(pool, zips.rows, cities.rows);
    console.log('second load', JSON.stringify(second));
    assert.deepEqual(second.zip, { inserted: 0, updated: 0, unchanged: zips.rows.length }, 'idempotent');
    assert.deepEqual(second.city, { inserted: 0, updated: 0, unchanged: cities.rows.length }, 'idempotent');
    await q(`update zip_centroids set lat = lat + 1 where zcta = '75001'; delete from city_centroids where city = 'Austin'`);
    const third = await applyLoad(pool, zips.rows, cities.rows);
    console.log('repair load', JSON.stringify(third));
    assert.equal(third.zip.updated, 1);
    assert.equal(third.city.inserted, 1);
    const counts = await q(`select (select count(*) from zip_centroids)::int z, (select count(*) from city_centroids)::int c`);
    assert.deepEqual(counts.rows[0], { z: zips.rows.length, c: cities.rows.length });

    // Synthetic carriers, deterministic. Expected outcome is part of the fixture.
    const carriers: Array<GeocodeCandidate & { expect: 'zip' | 'city' | 'none'; kind: string }> = [];
    let dot = 1000;
    const add = (kind: string, expect: 'zip' | 'city' | 'none', city: string, state: string, zip: string) =>
      carriers.push({ dotNumber: dot++, street: 'PO BOX 1', city, state, zip, expect, kind });
    const dallas = zips.rows.filter((_, i) => i % 20 === 0).slice(0, 60);
    for (const zr of dallas) add('real TX ZIP (city text arbitrary)', 'zip', 'WHEREVER', 'TX', zr.zcta);
    const known = ['HOUSTON', ' dallas ', 'Fort Worth', 'AUSTIN', 'san antonio', 'El Paso', 'LUBBOCK', 'Amarillo'];
    for (let i = 0; i < 40; i++) add('ZIP not in table, real city, mixed case', 'city', known[i % known.length] as string, 'TX', '75999');
    for (let i = 0; i < 20; i++) add('ZIP missing (null), real city', 'city', known[i % known.length] as string, 'TX', '');
    for (let i = 0; i < 20; i++) add('bad ZIP and made-up city', 'none', 'NOWHEREVILLE', 'TX', '00000');
    for (let i = 0; i < 20; i++) add('non-TX city, bad ZIP', 'none', 'SANTA FE', 'NM', '87501');
    for (let i = 0; i < 10; i++) add('ambiguous city name (two Reno city), bad ZIP', 'none', 'RENO', 'TX', '00000');
    for (let i = 0; i < 10; i++) add('Panhandle ZIP 73960', 'zip', 'WHEREVER', 'TX', '73960');
    await q(`insert into carriers (dot_number, phy_street, phy_city, phy_state, phy_zip5, address_hash)
             select * from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])`,
      [carriers.map((c) => c.dotNumber), carriers.map((c) => c.street), carriers.map((c) => c.city), carriers.map((c) => c.state),
        carriers.map((c) => c.zip || null), carriers.map((c) => `h${c.dotNumber}`)]);

    const ctx = { pg: pool, log: { info() {}, warn() {}, error() {} } } as unknown as PipelineContext;
    const zipMatched = await zipCentroidFallback(ctx, carriers);
    const cityMatched = await cityCentroidFallback(ctx, carriers);
    const rows = (await q(`select dot_number, geocode_precision p from carriers order by dot_number`)).rows;
    const byDot = new Map(rows.map((r) => [Number(r.dot_number), r.p as string | null]));
    let correct = 0;
    for (const c of carriers) {
      const got = byDot.get(c.dotNumber);
      const want = c.expect === 'zip' ? 'zip_centroid' : c.expect === 'city' ? 'city_centroid' : null;
      if (got === want) correct++;
    }
    const matched = zipMatched + cityMatched;
    const shouldMatch = carriers.filter((c) => c.expect !== 'none').length;
    console.log(JSON.stringify({ carriers: carriers.length, zipFallbackMatched: zipMatched, cityFallbackMatched: cityMatched,
      matched, matchRatePct: Math.round((matched / carriers.length) * 1000) / 10, expectedMatchable: shouldMatch, outcomesAsExpected: correct }));
    assert.equal(correct, carriers.length, 'every synthetic carrier ended in its expected tier');
    console.log('ok  database tests');
  } finally {
    await pool.end();
    await lock.end().catch(() => undefined);
    // Drop only the database this run created, and only after proving it carries this run's marker.
    const verify = new pg.Client({ connectionString: url.toString() });
    let mine = false;
    try {
      await verify.connect();
      mine = (await verify.query('select 1 from _owner_marker where token = $1', [token])).rowCount === 1;
    } catch { /* fall through: not dropped */ } finally { await verify.end().catch(() => undefined); }
    if (mine) await admin.query(`drop database ${dbName} with (force)`);
    else console.error(`NOT dropping ${dbName}: marker not verified`);
    await admin.end();
  }
}

async function main(): Promise<void> {
  pureTests();
  const { LOCATION_TEST_ADMIN_URL: url, LOCATION_TEST_ZCTA: z, LOCATION_TEST_PLACES: p } = process.env;
  if (z && p) realFileTests(z, p);
  if (url && z && p) await dbTests(url, z, p);
  else console.log('skip database tests (set LOCATION_TEST_ADMIN_URL, LOCATION_TEST_ZCTA, LOCATION_TEST_PLACES)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
