// Unit test of response-completion tracking (Gate 2 review finding 7) with a simulated socket.
// On this Windows machine the kernel absorbs even a 512 MiB loopback response at once, so real
// process-side backpressure cannot be produced locally; Linux send buffers are bounded.

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { responseDone } from './node-adapter';

function fakes(pending: number) {
  const socket = Object.assign(new EventEmitter(), { writableLength: pending, destroyed: false });
  const res = Object.assign(new EventEmitter(), { socket });
  return { socket, res: res as unknown as ServerResponse };
}
const state = async (p: Promise<void>) => Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);

describe('responseDone: finished means handed off AND the socket buffer drained', () => {
  it('stays pending after finish while the socket still holds bytes; settles on drain', async () => {
    const { socket, res } = fakes(1_000_000);
    const done = responseDone(res);
    expect(await state(done)).toBe('pending');
    res.emit('finish');
    expect(await state(done)).toBe('pending');
    socket.writableLength = 0;
    socket.emit('drain');
    expect(await state(done)).toBe('settled');
  });

  it('settles on finish when nothing is buffered, and on close in every case', async () => {
    const a = fakes(0);
    const doneA = responseDone(a.res);
    a.res.emit('finish');
    expect(await state(doneA)).toBe('settled');
    const b = fakes(5);
    const doneB = responseDone(b.res);
    b.res.emit('finish');
    b.socket.emit('close');
    expect(await state(doneB)).toBe('settled');
    const c = fakes(5);
    const doneC = responseDone(c.res);
    c.res.emit('close');
    expect(await state(doneC)).toBe('settled');
  });
});
