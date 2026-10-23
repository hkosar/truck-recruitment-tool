// Routes for the batch working list. Registered from app.ts with one line.

import { NotFoundError, RefusedError, type AppRequest, type AppResponse } from '../core/types';
import type { DataStore } from '../core/stores';

/** Byte-order mark so Excel opens the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BatchListContext {
  req: AppRequest;
  /** Session hash. */
  s: string;
  data: DataStore;
  readJson: (req: AppRequest) => Promise<unknown>;
  json: (status: number, payload: unknown) => AppResponse;
  /** Headers every response carries. */
  commonHeaders: Record<string, string>;
  /** Signed-in person, for the audit log line. */
  actorId: string;
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

function dotList(v: unknown, max: number): number[] {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0)) throw new RefusedError('invalid');
  return v as number[];
}

/** Returns a response when the path is one of ours, otherwise undefined. */
export async function batchListRoute(ctx: BatchListContext): Promise<AppResponse | undefined> {
  const { req, s, data } = ctx;
  let m: RegExpExecArray | null;
  if (req.method === 'GET' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/list-extras$/i.exec(req.path))) {
    if (!UUID.test(m[1])) throw new NotFoundError();
    const raw = req.query.get('dots') ?? '';
    const dots = raw === '' ? [] : raw.split(',').map(Number);
    return ctx.json(200, await data.batchListExtras(s, m[1], dotList(dots, 200)));
  }
  if (req.method === 'POST' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/export-csv$/i.exec(req.path))) {
    if (!UUID.test(m[1])) throw new NotFoundError();
    const body = await ctx.readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RefusedError('invalid');
    const rawDots = (body as Record<string, unknown>).dots;
    const dots = rawDots === null || rawDots === undefined ? null : dotList(rawDots, 10_000);
    const result = await data.batchCsvExport(s, m[1], dots);
    if (result.rowCount < 0) throw new NotFoundError();
    return {
      status: 200,
      headers: {
        ...ctx.commonHeaders,
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="contact-options.csv"',
        'cache-control': 'no-store',
        'x-export-rows': String(result.rowCount),
        'x-export-excluded': String(result.excluded),
      },
      setCookies: [],
      body: `${BOM}${result.csv}`,
    };
  }
  if (req.method === 'POST' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/rename$/i.exec(req.path))) {
    const body = await ctx.readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RefusedError('invalid');
    const name = (body as Record<string, unknown>).name;
    if (typeof name !== 'string') throw new RefusedError('invalid');
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 200) throw new RefusedError('invalid');
    const result = await data.batchRename(s, m[1], trimmed);
    if (!result.found) throw new NotFoundError();
    ctx.log('batch_renamed', { batch: m[1], actor: ctx.actorId });
    return ctx.json(200, { ok: true });
  }
  if (req.method === 'POST' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/delete$/i.exec(req.path))) {
    // Managers only: enforced in the database (lock_and_validate, delete policy). The batch's own
    // feed is deleted with it, so the durable trace is this log line.
    await ctx.readJson(req);
    if (!(await data.batchDelete(s, m[1]))) throw new NotFoundError();
    ctx.log('batch_deleted', { batch: m[1], actor: ctx.actorId });
    return ctx.json(200, { ok: true });
  }
  return undefined;
}
