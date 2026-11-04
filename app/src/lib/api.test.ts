import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPost, ApiError } from './api';

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function failure(status: number, body: unknown): Promise<ApiError> {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => (path === '/api/session' ? reply(200, { csrfToken: 't' }) : reply(status, body))));
  return apiPost('/api/x', {}).then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as ApiError);
}

describe('apiPost error messages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the server message for bad_disposition and bad_channel', async () => {
    const a = await failure(400, { error: 'bad_disposition', message: 'Choose an outcome that fits the contact channel.' });
    expect(a).toBeInstanceOf(ApiError);
    expect(a.message).toBe('Choose an outcome that fits the contact channel.');
    expect((await failure(400, { error: 'bad_channel', message: 'Choose a contact channel: call, text, email or mail.' })).message).toBe('Choose a contact channel: call, text, email or mail.');
  });

  it('keeps the generic text for other codes, even when the body carries a message', async () => {
    expect((await failure(400, { error: 'weird', message: 'server text' })).message).toBe('Request failed (400).');
    expect((await failure(409, { error: 'invalid', message: 'server text' })).message).toBe('That request was not accepted.');
    expect((await failure(400, { error: 'bad_disposition' })).message).toBe('Request failed (400).');
    expect((await failure(500, null)).message).toBe('Request failed (500).');
  });
});
