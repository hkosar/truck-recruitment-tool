import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { cityCentroidFallback, zipCentroidFallback, type GeocodeCandidate } from './geocode.js';
import type { PipelineContext } from './db.js';
import {
  applyLoad, buildCityRows, buildZipRows, parseCliArgs, placeBaseName,
} from './load-location-tables.js';

/**
 * Always runs the pure parsing tests. The database part runs only when LOCATION_TEST_DB_URL
 * (a throwaway LOCAL Postgres, loopback only) and the two real Gazetteer files
 * (LOCATION_TEST_ZCTA, LOCATION_TEST_PLACES) are provided; otherwise it is reported as skipped.
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
  console.log('ok  pure parsing tests');
}

async function dbTests(url: string, zctaFile: string, placesFile: string): Promise<void> {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('LOCATION_TEST_DB_URL must be loopback');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  try {
    // Local Postgres has no PostGIS: shim just enough for geocode.ts's st_setsrid(st_makepoint(..))::geography.
    await q(`drop schema if exists public cascade; create schema public;
      create domain geography as point;
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
  }
}

async function main(): Promise<void> {
  pureTests();
  const { LOCATION_TEST_DB_URL: url, LOCATION_TEST_ZCTA: z, LOCATION_TEST_PLACES: p } = process.env;
  if (url && z && p) await dbTests(url, z, p);
  else console.log('skip database tests (set LOCATION_TEST_DB_URL, LOCATION_TEST_ZCTA, LOCATION_TEST_PLACES)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
