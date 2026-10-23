// Batch working list: the pieces the stock RPCs do not cover (insurance and distance columns, and
// the CSV export). Pure SQL over a Tx; the caller (PgDataStore) supplies the session transaction.

import type { Tx } from '../db/database';

export interface MemberExtra {
  dot_number: number;
  bipd_on_file: number | null;
  bipd_required: number | null;
  /** Straight-line miles from the carrier to the nearest lane of this batch; null if it has no location. */
  distance_mi: number | null;
}

const MAX_DOTS = 200;

/** Insurance on file and distance to the nearest lane, for the carriers on the visible page. */
export async function memberExtras(tx: Tx, batchId: string, dots: number[]): Promise<MemberExtra[]> {
  const wanted = [...new Set(dots)].slice(0, MAX_DOTS);
  if (wanted.length === 0) return [];
  const { rows } = await tx.query<MemberExtra>(
    `select bc.dot_number,
            ci.bipd_on_file,
            ci.bipd_required,
            case when c.geom is null then null else
              (select min(st_distance(c.geom, z.geom)) / 1609.344 from public.batch_zones z where z.batch_id = bc.batch_id)
            end as distance_mi
       from public.batch_carriers bc
       join public.carriers c on c.dot_number = bc.dot_number
       left join public.carrier_insurance ci on ci.dot_number = bc.dot_number
      where bc.batch_id = $1 and bc.dot_number = any($2::bigint[])`,
    [batchId, wanted],
  );
  return rows.map((r) => ({
    dot_number: Number(r.dot_number),
    bipd_on_file: r.bipd_on_file === null ? null : Number(r.bipd_on_file),
    bipd_required: r.bipd_required === null ? null : Number(r.bipd_required),
    distance_mi: r.distance_mi === null ? null : Math.round(Number(r.distance_mi) * 10) / 10,
  }));
}

interface SheetRow {
  dot_number: number;
  legal_name: string;
  dba_name: string | null;
  contact_name: string | null;
  phone: string | null;
  cell_phone: string | null;
  email: string | null;
  phy_city: string | null;
  phy_state: string | null;
  status: string;
  warning_reasons: string[];
  last_contact_at: string | Date | null;
}

const HEADER = ['USDOT', 'Legal name', 'DBA', 'Contact name', 'Phone', 'Cell phone', 'Email', 'City', 'State', 'Status', 'Warnings', 'Last contact (UTC)'];

/** One CSV cell. Quotes everything that needs it and defuses spreadsheet formulas. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  // OWASP CSV injection: = + - @ and a leading tab/CR/LF, also written full-width (NFKC maps ＝＋－＠ to ASCII) or after spaces.
  const folded = s.normalize('NFKC');
  if (/^[=+\-@\t\r\n]/.test(folded) || /^[=+\-@]/.test(folded.trimStart())) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function buildCsv(rows: SheetRow[]): string {
  const lines = [HEADER.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [r.dot_number, r.legal_name, r.dba_name, r.contact_name, r.phone, r.cell_phone, r.email, r.phy_city, r.phy_state, r.status.replaceAll('_', ' '), (r.warning_reasons ?? []).join('; '), r.last_contact_at]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface CsvExport {
  csv: string;
  rowCount: number;
  /** Requested carriers that were left out because they are do-not-contact (or not in the batch). */
  excluded: number;
}

/**
 * The CSV of the chosen carriers (or the whole batch when `dots` is null). The exclusion of
 * do-not-contact carriers is done by generate_contact_sheet itself, in the database: the same
 * rule as the printed call sheet. The export is written to the batch activity log in the same
 * transaction (public.log_export), so there is never an export without a log line.
 */
export async function exportCsv(tx: Tx, batchId: string, dots: number[] | null): Promise<CsvExport> {
  await tx.query("select internal.lock_and_validate(array['manager','edit']::user_role[], array['link'])");
  const parent = await tx.query('select 1 from public.batches where id = $1 for key share', [batchId]);
  if (parent.rowCount === 0) return { csv: '', rowCount: -1, excluded: 0 };
  const requested = dots === null ? null : [...new Set(dots)];
  const { rows } = await tx.query<SheetRow>('select * from public.generate_contact_sheet($1, $2::bigint[])', [batchId, requested]);
  let excluded = 0;
  if (requested === null) {
    const total = await tx.query<{ n: number }>('select count(*)::int as n from public.batch_carriers where batch_id = $1', [batchId]);
    excluded = Math.max(0, total.rows[0].n - rows.length);
  } else {
    excluded = Math.max(0, requested.length - rows.length);
  }
  await tx.query("select public.log_export($1, 'csv', $2)", [batchId, rows.length]);
  return { csv: buildCsv(rows), rowCount: rows.length, excluded };
}

export interface RenameResult { found: boolean; from: string }

/**
 * Renames a batch (editors and managers; the update policy and column grant decide) and records it
 * in the batch feed as a comment, since the activity enum has no rename type.
 */
export async function renameBatch(tx: Tx, batchId: string, name: string): Promise<RenameResult> {
  await tx.query("select internal.lock_and_validate(array['manager','edit']::user_role[], array['link'])");
  const current = await tx.query<{ name: string }>('select name from public.batches where id = $1 for no key update', [batchId]);
  if (current.rowCount === 0) return { found: false, from: '' };
  const from = current.rows[0].name;
  if (from === name) return { found: true, from };
  await tx.query('update public.batches set name = $2 where id = $1', [batchId, name]);
  await tx.query(
    `insert into public.batch_activity (batch_id, actor_id, activity_type, comment)
     values ($1, internal.current_staff_id(), 'comment', $2)`,
    [batchId, `Renamed batch from "${from}" to "${name}"`],
  );
  return { found: true, from };
}

/**
 * Deletes a batch. Managers only (public.batch_delete: lock_and_validate, then the delete policy's
 * own check). The permanent record (internal.batch_delete_audit, M1c) is written by the same
 * function, so it commits with the delete or not at all. False when the batch does not exist.
 */
export async function deleteBatch(tx: Tx, batchId: string): Promise<boolean> {
  const r = await tx.query<{ deleted: boolean }>('select public.batch_delete($1) as deleted', [batchId]);
  return r.rows[0].deleted === true;
}
