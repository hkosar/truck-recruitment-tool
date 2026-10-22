// DataStore over Postgres. Every operation is one transaction with app.session_hash set, run
// as recruiter_app, so the M1 policies and functions decide authorization. Writes take the
// lock sequence first (doc 15 §14.2), then the batch parent before member rows (§17.2).

import type { UserRole } from '../auth/identity';
import { deleteBatch, exportCsv, memberExtras, renameBatch } from '../batch/batch-list';
import type { ContactLogInput, DataStore, TeamMember } from '../core/stores';
import { RPC_SPECS, rpcCallSql } from '../core/rpc-spec';
import { NotFoundError, RefusedError } from '../core/types';
import type { Database, Tx } from './database';

const DATA_TX = { lockTimeoutMs: 2_000, statementTimeoutMs: 8_000, deadlineMs: 10_000 };
const EDITOR_LOCK = "select internal.lock_and_validate(array['manager','edit']::user_role[], array['link'])";

/** Team and contact rules raise check_violation; pick a fixed code from the known messages. */
function refineRefusal(err: unknown, context: 'team' | 'contact'): never {
  if (err instanceof RefusedError && err.code === 'dnc_blocked' && context === 'team') {
    throw new RefusedError('invalid');
  }
  throw err;
}

export class PgDataStore implements DataStore {
  constructor(private readonly db: Database) {}

  private tx<T>(s: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction({ ...DATA_TX, sessionHash: s }, work);
  }

  async rpc(s: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const spec = RPC_SPECS[name];
    const { sql, params } = rpcCallSql(name, args);
    return this.tx(s, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(sql, params);
      if (spec.returns === 'rows') return rows;
      if (spec.returns === 'scalar') return rows[0]?.value ?? null;
      return null;
    });
  }

  async batchDetail(s: string, batchId: string) {
    return this.tx(s, async (tx) => {
      const { rows } = await tx.query(
        `select b.*, coalesce((select json_agg(z) from public.batch_zones z where z.batch_id = b.id), '[]'::json) as batch_zones
         from public.batches b where b.id = $1`,
        [batchId],
      );
      if (!rows[0]) throw new NotFoundError();
      return rows[0];
    });
  }

  async batchActivity(s: string, batchId: string, limit: number) {
    return this.tx(s, async (tx) => {
      const { rows } = await tx.query(
        `select a.id, a.activity_type, a.comment, a.payload, a.created_at, a.actor_id,
                case when p.id is null then null else json_build_object('full_name', p.full_name) end as profiles
         from public.batch_activity a left join public.profiles p on p.id = a.actor_id
         where a.batch_id = $1 order by a.id desc limit $2`,
        [batchId, limit],
      );
      return rows;
    });
  }

  async addComment(s: string, batchId: string, comment: string) {
    await this.tx(s, async (tx) => {
      await tx.query(EDITOR_LOCK);
      await tx.query('select 1 from public.batches where id = $1 for key share', [batchId]);
      await tx.query(
        `insert into public.batch_activity (batch_id, actor_id, activity_type, comment)
         values ($1, internal.current_staff_id(), 'comment', $2)`,
        [batchId, comment],
      );
    });
  }

  private async memberUpdate(s: string, batchId: string, dot: number, set: string, extra: unknown[]): Promise<boolean> {
    return this.tx(s, async (tx) => {
      await tx.query(EDITOR_LOCK);
      const parent = await tx.query('select 1 from public.batches where id = $1 for key share', [batchId]);
      if (parent.rowCount === 0) return false;
      const r = await tx.query(`update public.batch_carriers set ${set} where batch_id = $1 and dot_number = $2`, [batchId, dot, ...extra]);
      return r.rowCount > 0;
    });
  }

  setMemberStatus(s: string, batchId: string, dot: number, status: string) {
    return this.memberUpdate(s, batchId, dot, 'status = $3::batch_carrier_status', [status]);
  }

  promote(s: string, batchId: string, dot: number) {
    return this.memberUpdate(s, batchId, dot, 'promoted_at = now()', []);
  }

  async logContact(s: string, input: ContactLogInput) {
    await this.tx(s, async (tx) => {
      await tx.query(EDITOR_LOCK);
      await tx.query(
        `insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes, next_steps)
         values ($1, $2, internal.current_staff_id(), $3::contact_channel, $4::contact_disposition, $5, $6)`,
        [input.dot_number, input.batch_id, input.channel, input.disposition, input.notes, input.next_steps],
      );
    }).catch((err) => refineRefusal(err, 'contact'));
  }

  async sheetHeader(s: string, batchId: string) {
    return this.tx(s, async (tx) => {
      const { rows } = await tx.query('select name, customer, job from public.batches where id = $1', [batchId]);
      if (!rows[0]) throw new NotFoundError();
      return rows[0];
    });
  }

  async carrierProfile(s: string, dot: number) {
    return this.tx(s, async (tx) => {
      const one = async (sql: string) => (await tx.query(sql, [dot])).rows[0] ?? null;
      const many = async (sql: string) => (await tx.query(sql, [dot])).rows;
      const carrier = await one('select * from public.carriers where dot_number = $1');
      if (!carrier) throw new NotFoundError();
      return {
        carrier,
        insurance: await one('select * from public.carrier_insurance where dot_number = $1'),
        safety: await one('select * from public.carrier_safety where dot_number = $1'),
        inspections: await many('select * from public.carrier_inspections where dot_number = $1 order by inspection_date desc limit 10'),
        warning: await one('select * from public.carrier_warnings where dot_number = $1'),
        logs: await many(
          `select cl.*,
                  case when p.id is null then null else json_build_object('full_name', p.full_name) end as profiles,
                  case when b.id is null then null else json_build_object('name', b.name) end as batches
           from public.contact_logs cl
           left join public.profiles p on p.id = cl.user_id
           left join public.batches b on b.id = cl.batch_id
           where cl.dot_number = $1 order by cl.contacted_at desc limit 100`,
        ),
        memberships: await many(
          `select bc.*, json_build_object('name', b.name, 'customer', b.customer, 'job', b.job) as batches
           from public.batch_carriers bc join public.batches b on b.id = bc.batch_id
           where bc.dot_number = $1 order by bc.added_at desc`,
        ),
        suppressions: await many(
          `select channel, value, expires_at from public.contact_suppressions
           where dot_number = $1 and channel = 'all' and value is null`,
        ),
      };
    });
  }

  async dashboardBatches(s: string) {
    return this.tx(s, async (tx) => (await tx.query('select * from public.batch_dashboard where archived_at is null order by last_activity_at desc nulls last')).rows);
  }

  async dncLookup(s: string, dots: number[]) {
    return this.tx(s, async (tx) => ({
      carriers: (await tx.query('select dot_number, do_not_contact from public.carriers where dot_number = any($1::bigint[])', [dots])).rows,
      suppressions: (await tx.query(
        `select dot_number, channel, value, expires_at from public.contact_suppressions
         where dot_number = any($1::bigint[]) and channel = 'all' and value is null`,
        [dots],
      )).rows,
    }));
  }

  async teamList(s: string): Promise<TeamMember[]> {
    return this.tx(s, async (tx) => (await tx.query<TeamMember>('select * from public.team_list()')).rows);
  }

  async teamUpdate(s: string, target: string, fullName: string | null, role: UserRole | null, email: string | null) {
    await this.tx(s, (tx) => tx.query('select public.team_update($1, $2, $3::user_role, $4)', [target, fullName, role, email])).catch((err) => refineRefusal(err, 'team'));
  }

  async teamSetActive(s: string, target: string, active: boolean) {
    await this.tx(s, (tx) => tx.query('select public.team_set_active($1, $2)', [target, active])).catch((err) => refineRefusal(err, 'team'));
  }

  batchListExtras(s: string, batchId: string, dots: number[]) {
    return this.tx(s, (tx) => memberExtras(tx, batchId, dots));
  }

  batchCsvExport(s: string, batchId: string, dots: number[] | null) {
    return this.tx(s, (tx) => exportCsv(tx, batchId, dots));
  }

  batchRename(s: string, batchId: string, name: string) {
    return this.tx(s, (tx) => renameBatch(tx, batchId, name));
  }

  batchDelete(s: string, batchId: string) {
    return this.tx(s, (tx) => deleteBatch(tx, batchId));
  }

  async teamSignEveryoneOut(s: string) {
    return this.db.transaction({ sessionHash: s, lockTimeoutMs: 10_000, statementTimeoutMs: 15_000, deadlineMs: 20_000 }, async (tx) => {
      const { rows } = await tx.query<{ n: number }>('select public.team_sign_everyone_out() as n');
      return rows[0].n;
    });
  }
}
