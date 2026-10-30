// OFFLINE TESTS for two review findings on the checked-out client error guard.
//
// 1. The acquisition window. pg-pool resolves pool.connect() and the caller's await continues
//    LATER; if pg parses ReadyForQuery and a fatal ErrorResponse from the same input buffer, the
//    'error' event fires before that continuation. This drives the REAL pg.Client, pg-pool and the
//    pg-protocol parser over an in-memory Duplex (no socket, no network, no database): the peer
//    answers the startup packet with AuthenticationOk + ReadyForQuery + FATAL 57P01 in one buffer.
//    Anything the emitter throws there is what would have been an uncaught exception.
// 2. COMMIT classification whatever the event order. After COMMIT was sent, a definite refusal is
//    an allowlisted SQLSTATE on a still-healthy connection; everything else (unlisted code, FATAL,
//    translated severity text, transport error, a connection failure during ROLLBACK) is an
//    unknown outcome. An acknowledged COMMIT still stands.

import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { OutcomeUnknownError, RefusedError, UnavailableError } from '../core/types';
import { Database } from './database';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function packet(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}
const authOk = packet('R', Buffer.alloc(4));
const ready = packet('Z', Buffer.from('I'));
const fatal = packet('E', Buffer.from('SFATAL\0C57P01\0MConnection terminated unexpectedly\0\0'));

const uncaught: unknown[] = [];
class Wire extends Duplex {
  static deliveryDelayMs = 0;
  first = true;
  _read(): void {}
  _write(_chunk: Buffer, _enc: string, callback: (err?: Error | null) => void): void {
    if (this.first) {
      this.first = false;
      setTimeout(() => {
        try {
          this.push(Buffer.concat([authOk, ready, fatal])); // one buffer: parsed in one pass
        } catch (thrown) {
          uncaught.push(thrown);
        }
      }, Wire.deliveryDelayMs);
    }
    callback();
  }
  connect(): void {
    setImmediate(() => this.emit('connect'));
  }
  setNoDelay(): void {}
  setKeepAlive(): void {}
  ref(): void {}
  unref(): void {}
}
class WireClient extends pg.Client {
  constructor(config: pg.ClientConfig) {
    super({ ...config, stream: (() => new Wire()) as never });
  }
}

/** What COMMIT does in a scenario; ROLLBACK and the connection follow `then`. */
interface CommitScript {
  /** Absent: COMMIT is acknowledged. Present: it is rejected with this SQLSTATE and severity text. */
  reject?: { code?: string; severity: string };
  /**
   * healthy: the connection stays usable.
   * drop-in-rollback: the client 'error' arrives while ROLLBACK is pending (a late event).
   * drop-with-reject: the link closes right after the rejection (a FATAL); the 'error' event comes later.
   */
  then: 'healthy' | 'drop-in-rollback' | 'drop-with-reject';
  /** COMMIT is answered (no error, connection stays healthy) with this command tag. */
  tag?: string;
}
class FakeClient extends EventEmitter {
  static commit: CommitScript = { then: 'healthy' };
  _queryable = true;
  _ending = false;
  connect(cb: () => void): void {
    setImmediate(cb);
  }
  private lose(): Error {
    this._queryable = false;
    const err = new Error('Connection terminated unexpectedly');
    this.emit('error', err);
    return err;
  }
  query(config: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = typeof config === 'string' ? config : config.text;
    const ok = { rows: [], rowCount: 0 };
    const script = FakeClient.commit;
    if (sql === 'COMMIT') {
      if (!script.reject && script.tag) return Promise.resolve({ ...ok, command: script.tag });
      if (!script.reject) {
        // Acknowledged, and the connection error follows in the same turn: the result stands.
        return new Promise((resolve) =>
          setImmediate(() => {
            resolve(ok);
            this._queryable = false;
            this.emit('error', new Error('connection dropped after acknowledgement'));
          }),
        );
      }
      const err = Object.assign(new Error('translated server text'), {
        severity: script.reject.severity,
        ...(script.reject.code === undefined ? {} : { code: script.reject.code }),
      });
      if (script.then === 'drop-with-reject') {
        return new Promise((_resolve, reject) =>
          setImmediate(() => {
            reject(err); // the rejection first ...
            this._queryable = false; // ... the link closes with it; the 'error' event comes later
            setImmediate(() => this.emit('error', new Error('Connection terminated unexpectedly')));
          }),
        );
      }
      return Promise.reject(err);
    }
    if (sql === 'ROLLBACK' && script.then === 'drop-in-rollback') {
      return new Promise((_resolve, reject) => setImmediate(() => reject(this.lose())));
    }
    if (sql === 'ROLLBACK' && script.then === 'drop-with-reject') {
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    }
    return Promise.resolve(ok);
  }
  end(cb?: () => void): void {
    this._ending = true;
    cb?.();
  }
  ref(): void {}
  unref(): void {}
}

const open: Database[] = [];
function make(Client: unknown, options: Record<string, unknown> = {}) {
  const db = new Database({ connectionString: 'postgres://fake', max: 1, ...options });
  // Swap in a real pg-pool that builds the given client class; the Database code is unchanged.
  const pool = new pg.Pool({ Client: Client as never, max: 1, idleTimeoutMillis: 0 });
  pool.on('error', () => undefined);
  (db as unknown as { pool: pg.Pool }).pool = pool;
  open.push(db);
  return { db, pool };
}

afterEach(async () => {
  uncaught.length = 0;
  Wire.deliveryDelayMs = 0;
  FakeClient.commit = { then: 'healthy' };
  await Promise.all(open.splice(0).map((d) => d.close()));
});

describe('the acquisition window (ReadyForQuery and a fatal error in one buffer)', () => {
  it('transaction: fails closed with UnavailableError, nothing uncaught, no client left in the pool', async () => {
    const { db, pool } = make(WireClient);
    await expect(db.transaction({ deadlineMs: 100 }, async () => 'x')).rejects.toBeInstanceOf(UnavailableError);
    await delay(20);
    expect(uncaught).toEqual([]);
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
  });

  it('transaction with an acquire limit: same', async () => {
    const { db, pool } = make(WireClient);
    await expect(db.transaction({ acquireTimeoutMs: 500, deadlineMs: 100 }, async () => 'x')).rejects.toBeInstanceOf(UnavailableError);
    await delay(20);
    expect(uncaught).toEqual([]);
    expect(pool.totalCount).toBe(0);
  });

  it('a client that arrives after the acquire limit is released at once and its error is not thrown', async () => {
    Wire.deliveryDelayMs = 60;
    const { db, pool } = make(WireClient);
    await expect(db.transaction({ acquireTimeoutMs: 10 }, async () => 'x')).rejects.toBeInstanceOf(UnavailableError);
    await delay(150);
    expect(uncaught).toEqual([]);
    expect(pool.totalCount).toBe(0);
  });

  it('warm-up: warm() rejects, nothing uncaught', async () => {
    const { db, pool } = make(WireClient, { minWarm: 1 });
    await expect(db.warm()).rejects.toBeDefined();
    await delay(20);
    expect(uncaught).toEqual([]);
    expect(pool.totalCount).toBe(0);
  });

  it('listeners are removed again: at most the pool\'s own idle listener is left on the destroyed client', async () => {
    const seen: pg.Client[] = [];
    class Spy extends WireClient {
      constructor(config: pg.ClientConfig) {
        super(config);
        seen.push(this);
      }
    }
    const { db } = make(Spy);
    await expect(db.transaction({ deadlineMs: 100 }, async () => 'x')).rejects.toBeInstanceOf(UnavailableError);
    await delay(20);
    expect(seen[0]!.listenerCount('error')).toBeLessThanOrEqual(1);
  });
});

describe('COMMIT classification: an allowlist of proven rollbacks, whatever the event order', () => {
  const run = (script: CommitScript) => {
    FakeClient.commit = script;
    const { db, pool } = make(FakeClient);
    return { outcome: db.transaction({}, async () => 'saved'), pool };
  };

  it('COMMIT rejected with 57P01, the connection error only arrives while ROLLBACK is pending: OutcomeUnknownError', async () => {
    const { outcome, pool } = run({ reject: { code: '57P01', severity: 'FATAL' }, then: 'drop-in-rollback' });
    await expect(outcome).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(pool.totalCount).toBe(0); // destroyed, not returned
  });

  it('a FATAL with an unlisted SQLSTATE (translated server, healthy-looking client, no error event yet): OutcomeUnknownError', async () => {
    const { outcome, pool } = run({ reject: { code: 'XX000', severity: 'SCHWERWIEGEND' }, then: 'healthy' });
    await expect(outcome).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(pool.totalCount).toBe(0);
  });

  it('a rejection with no SQLSTATE at all: OutcomeUnknownError', async () => {
    const { outcome, pool } = run({ reject: { severity: 'FATAL' }, then: 'healthy' });
    await expect(outcome).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(pool.totalCount).toBe(0);
  });

  it('an allowlisted code from a FATAL (the link closes with it), severity text in any language: OutcomeUnknownError', async () => {
    for (const severity of ['FATAL', 'SCHWERWIEGEND', 'FATALE']) {
      const { outcome, pool } = run({ reject: { code: '23505', severity }, then: 'drop-with-reject' });
      await expect(outcome).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(pool.totalCount).toBe(0);
    }
  });

  it('an allowlisted code but the connection is lost during ROLLBACK: OutcomeUnknownError', async () => {
    const { outcome, pool } = run({ reject: { code: '40001', severity: 'ERROR' }, then: 'drop-in-rollback' });
    await expect(outcome).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(pool.totalCount).toBe(0);
  });

  it.each([
    ['23505', RefusedError],
    ['23503', UnavailableError],
    ['40001', UnavailableError],
  ])('allowlisted %s on a healthy connection is its definite refusal (rolled back, client returned)', async (code, expected) => {
    // The severity text is never consulted: a translated server gives the same answer.
    for (const severity of ['ERROR', 'FEHLER']) {
      const { outcome, pool } = run({ reject: { code, severity }, then: 'healthy' });
      await expect(outcome).rejects.toBeInstanceOf(expected);
      expect(pool.idleCount).toBe(1);
      await open.pop()!.close();
    }
  });

  it.each(['23514', 'P0001', '40P01', '57014', '55P03', '42501', '08006', '57P01'])(
    'unlisted %s after COMMIT was sent is never a definite refusal: OutcomeUnknownError',
    async (code) => {
      const { outcome, pool } = run({ reject: { code, severity: 'ERROR' }, then: 'healthy' });
      await expect(outcome).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(pool.totalCount).toBe(0);
    },
  );

  it('an acknowledged COMMIT stands even when a connection error follows in the same turn', async () => {
    const { outcome, pool } = run({ then: 'healthy' });
    await expect(outcome).resolves.toBe('saved');
    expect(pool.totalCount).toBe(0);
  });

  it('COMMIT answered with the tag ROLLBACK (no error) is a definite failure: UnavailableError, not success, not unknown; the healthy client is returned', async () => {
    const { outcome, pool } = run({ then: 'healthy', tag: 'ROLLBACK' });
    const seen = await outcome.then(() => undefined, (e: unknown) => e);
    expect(seen).toBeInstanceOf(UnavailableError);
    expect(seen).not.toBeInstanceOf(OutcomeUnknownError);
    expect(pool.idleCount).toBe(1);
  });

  it('COMMIT answered with the ordinary tag COMMIT is success', async () => {
    const { outcome } = run({ then: 'healthy', tag: 'COMMIT' });
    await expect(outcome).resolves.toBe('saved');
  });

  it('the same code BEFORE COMMIT keeps its ordinary mapping (not unknown)', async () => {
    const { db } = make(FakeClient);
    await expect(
      db.transaction({}, async () => {
        throw Object.assign(new Error('x'), { code: '23505' });
      }),
    ).rejects.toBeInstanceOf(RefusedError);
  });
});
