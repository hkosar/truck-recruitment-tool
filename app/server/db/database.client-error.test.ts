// OFFLINE TESTS: a connection error on a CHECKED-OUT pooled client must not escape as an
// uncaught exception. pg-pool removes its idle 'error' listener at checkout, and the pg Client
// emits 'error' when the connection ends unexpectedly. This uses the real pg-pool with a fake
// client (no database, no network). The fake raises its errors from a timer, like a socket event,
// and the test records anything that would have been thrown there (that is an uncaught exception).

import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { OutcomeUnknownError, UnavailableError } from '../core/types';
import { Database } from './database';

type Behaviour = (sql: string, client: FakeClient) => Promise<unknown> | undefined;

class FakeClient extends EventEmitter {
  static made: FakeClient[] = [];
  static behaviour: Behaviour = () => undefined;
  static connectDelayMs = 0;
  static uncaught: unknown[] = [];
  _queryable = true;
  _ending = false;
  ended = false;
  constructor() {
    super();
    FakeClient.made.push(this);
  }
  connect(cb: (err?: Error) => void): void {
    setTimeout(() => cb(), FakeClient.connectDelayMs);
  }
  query(config: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = typeof config === 'string' ? config : config.text;
    return Promise.resolve(FakeClient.behaviour(sql, this)).then(() => ({ rows: [], rowCount: 0 }));
  }
  end(cb?: () => void): void {
    this.ended = true;
    this._ending = true;
    cb?.();
  }
  ref(): void {}
  unref(): void {}
  /** Raised at once, as the acknowledgement is delivered (the error event arrives in the same turn). */
  errorNow(err: Error = new Error('Connection terminated unexpectedly')): void {
    try {
      this._queryable = false;
      this.emit('error', err);
    } catch (thrown) {
      FakeClient.uncaught.push(thrown);
    }
  }
  /** A socket-style error: raised from a timer; whatever the emitter throws would be uncaught. */
  socketError(err: Error = new Error('Connection terminated unexpectedly')): void {
    setImmediate(() => {
      try {
        this._queryable = false;
        this.emit('error', err);
      } catch (thrown) {
        FakeClient.uncaught.push(thrown);
      }
    });
  }
}
const never = () => new Promise<never>(() => undefined);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const open: Database[] = [];
function makeDb(options: Partial<ConstructorParameters<typeof Database>[0]> = {}): Database {
  const db = new Database({ connectionString: 'postgres://fake', max: 2, ...options });
  // Swap in a real pg-pool that builds FakeClients; the Database code under test is unchanged.
  (db as unknown as { pool: pg.Pool }).pool = new pg.Pool({ Client: FakeClient as never, max: 2, idleTimeoutMillis: 0 });
  (db as unknown as { pool: pg.Pool }).pool.on('error', () => undefined);
  open.push(db);
  return db;
}
const pool = (db: Database) => (db as unknown as { pool: pg.Pool }).pool;

afterEach(async () => {
  FakeClient.made = [];
  FakeClient.behaviour = () => undefined;
  FakeClient.connectDelayMs = 0;
  FakeClient.uncaught = [];
  await Promise.all(open.splice(0).map((d) => d.close()));
});

describe('a connection error on a checked-out client', () => {
  it('mid-query: raises UnavailableError, destroys the client, throws nothing uncaught', async () => {
    const db = makeDb();
    FakeClient.behaviour = (sql, client) => {
      if (sql === 'BEGIN') return undefined;
      if (sql.startsWith('select 1 from t')) {
        client.socketError();
        return never(); // the answer never comes; the error event is what ends the work
      }
      return undefined;
    };
    await expect(db.transaction({}, (tx) => tx.query('select 1 from t'))).rejects.toBeInstanceOf(UnavailableError);
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    const [client] = FakeClient.made;
    expect(client!.ended).toBe(true); // destroyed, not returned to the pool
    expect(pool(db).totalCount).toBe(0);
    expect(pool(db).idleCount).toBe(0);
  });

  it('while the work awaits something other than the database: fails closed at once, not at the deadline', async () => {
    const db = makeDb();
    const started = Date.now();
    await expect(
      db.transaction({ deadlineMs: 4_000 }, async () => {
        FakeClient.made[0]!.socketError();
        await never();
      }),
    ).rejects.toBeInstanceOf(UnavailableError);
    expect(Date.now() - started).toBeLessThan(1_000);
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    expect(FakeClient.made[0]!.ended).toBe(true);
    expect(pool(db).idleCount).toBe(0);
  });

  it('after COMMIT was sent: raises OutcomeUnknownError and destroys the client', async () => {
    const db = makeDb();
    FakeClient.behaviour = (sql, client) => {
      if (sql === 'COMMIT') {
        client.socketError();
        return never();
      }
      return undefined;
    };
    await expect(db.transaction({}, async () => 'ok')).rejects.toBeInstanceOf(OutcomeUnknownError);
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    expect(FakeClient.made[0]!.ended).toBe(true);
    expect(pool(db).idleCount).toBe(0);
  });

  it('when the server answers with a code and the link drops with it, after COMMIT was sent: OutcomeUnknownError', async () => {
    const db = makeDb();
    FakeClient.behaviour = (sql, client) => {
      if (sql === 'COMMIT') {
        client.errorNow();
        return Promise.reject(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
      }
      return undefined;
    };
    await expect(db.transaction({}, async () => 'ok')).rejects.toBeInstanceOf(OutcomeUnknownError);
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    expect(FakeClient.made[0]!.ended).toBe(true);
  });

  it('an error observed on a client makes release destroy it even when release is called without an error', async () => {
    const db = makeDb();
    const checkedOut = await (db as unknown as { checkout(): Promise<{ client: FakeClient; release(e?: Error): void }> }).checkout();
    checkedOut.client.errorNow();
    expect(FakeClient.uncaught).toEqual([]);
    expect(checkedOut.client.listenerCount('error')).toBe(1);
    checkedOut.release();
    checkedOut.release(); // idempotent: no double-release error from pg-pool
    expect(checkedOut.client.ended).toBe(true);
    expect(pool(db).idleCount).toBe(0);
    expect(pool(db).totalCount).toBe(0);
  });

  it('is destroyed and never reused: the next transaction gets a new client', async () => {
    const db = makeDb();
    FakeClient.behaviour = (sql, client) => {
      if (sql === 'select boom') {
        client.socketError();
        return never();
      }
      return undefined;
    };
    await expect(db.transaction({}, (tx) => tx.query('select boom'))).rejects.toBeInstanceOf(UnavailableError);
    FakeClient.behaviour = () => undefined;
    await expect(db.transaction({}, async () => 'again')).resolves.toBe('again');
    expect(FakeClient.made).toHaveLength(2);
    expect(FakeClient.uncaught).toEqual([]);
  });

  it('also when the acquire limit is in use (the tighter admission path)', async () => {
    const db = makeDb();
    FakeClient.behaviour = (sql, client) => {
      if (sql === 'select boom') {
        client.socketError();
        return never();
      }
      return undefined;
    };
    await expect(db.transaction({ acquireTimeoutMs: 500 }, (tx) => tx.query('select boom'))).rejects.toBeInstanceOf(UnavailableError);
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    expect(FakeClient.made[0]!.ended).toBe(true);
  });
});

describe('listeners', () => {
  it('a client has no extra error listener after release, however often it is reused', async () => {
    const db = makeDb();
    await db.transaction({}, async () => 1);
    const client = FakeClient.made[0]!;
    const baseline = client.listenerCount('error'); // pg-pool's own idle listener
    expect(baseline).toBe(1);
    for (let i = 0; i < 25; i++) {
      await db.transaction({}, async () => i);
      expect(client.listenerCount('error')).toBe(baseline);
    }
    expect(FakeClient.made).toHaveLength(1); // it really was the same client every time
  });

  it('a failed (rolled back) transaction also removes its listener', async () => {
    const db = makeDb();
    await db.transaction({}, async () => 1);
    const client = FakeClient.made[0]!;
    await expect(
      db.transaction({}, async () => {
        throw Object.assign(new Error('x'), { code: '23505' });
      }),
    ).rejects.toBeDefined();
    expect(client.listenerCount('error')).toBe(1);
    expect(pool(db).idleCount).toBe(1);
  });

  it('is attached before any query (during BEGIN)', async () => {
    const db = makeDb();
    const seen: number[] = [];
    FakeClient.behaviour = (sql, client) => {
      if (sql === 'BEGIN') seen.push(client.listenerCount('error'));
      return undefined;
    };
    await db.transaction({}, async () => 1);
    expect(seen).toEqual([1]); // pg-pool removed its own at checkout; ours is the one present
  });
});

describe('an error when nobody has the client', () => {
  it('while idle: handled by the pool, not thrown; the client is dropped from the pool', async () => {
    const db = makeDb();
    await db.transaction({}, async () => 1);
    const client = FakeClient.made[0]!;
    expect(pool(db).idleCount).toBe(1);
    client.socketError();
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    expect(pool(db).idleCount).toBe(0);
    expect(pool(db).totalCount).toBe(0);
  });

  it('after release: handled by the pool, not thrown (the per-checkout listener is already gone)', async () => {
    const db = makeDb();
    await db.transaction({}, async () => 1);
    const client = FakeClient.made[0]!;
    expect(client.listenerCount('error')).toBe(1);
    client.socketError();
    client.socketError(new Error('a second one')); // pg-pool swaps in a quiet listener after the first
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
  });

  it('a client destroyed at the deadline does not throw if its socket errors later', async () => {
    const db = makeDb();
    FakeClient.behaviour = () => never();
    await expect(db.transaction({ deadlineMs: 30 }, (tx) => tx.query('select 1'))).rejects.toBeInstanceOf(UnavailableError);
    FakeClient.made[0]!.socketError();
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
  });
});

describe('the acquire limit', () => {
  it('a client that arrives after the limit is released at once: no listener left, a later error is not thrown', async () => {
    const db = makeDb();
    FakeClient.connectDelayMs = 60;
    await expect(db.transaction({ acquireTimeoutMs: 10 }, async () => 1)).rejects.toBeInstanceOf(UnavailableError);
    await tick(120); // the late client arrives and is released
    const late = FakeClient.made[0]!;
    expect(pool(db).idleCount).toBe(1);
    expect(late.listenerCount('error')).toBe(1); // only pg-pool's idle listener
    late.socketError();
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
  });
});

describe('warm-up', () => {
  it('an error during a warm-up query: warm() rejects, the client is destroyed, nothing is thrown', async () => {
    const db = makeDb({ minWarm: 1 });
    FakeClient.behaviour = (_sql, client) => {
      client.socketError();
      return never();
    };
    await expect(db.warm()).rejects.toBeDefined();
    await tick();
    expect(FakeClient.uncaught).toEqual([]);
    expect(FakeClient.made[0]!.ended).toBe(true);
    expect(pool(db).totalCount).toBe(0);
  });

  it('a successful warm-up leaves only the pool listener on the idle client', async () => {
    const db = makeDb({ minWarm: 2 });
    await expect(db.warm()).resolves.toBe(2);
    for (const c of FakeClient.made) expect(c.listenerCount('error')).toBe(1);
    expect(pool(db).idleCount).toBe(2);
  });
});
