import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVERYONE_SIGNED_OUT_MESSAGE, renderConfirm, renderRecoveryForm, renderSignInForm, renderSignInSent, renderStale, signInPageHeaders, STALE_MESSAGE } from './pages/signin';
import { CODE_ALPHABET, generateCode, generateCodeSet, normalizeCode } from './recovery/codes';
import { RECOVERY_COLUMNS, recoveryEnabled, recoveryRouteAllowed } from './recovery/matrix';

const appRoot = resolve(import.meta.dirname, '..');

describe('sign-in pages (decisions 19/35)', () => {
  it('form: badge, uppercase-styled wordmark, one accessible email box, one button, nothing else', () => {
    const html = renderSignInForm();
    expect(html).toContain('<img src="/brand/badge-black.png" alt="" width="72" height="72" />Carrier Recruiter');
    expect(html).toContain('aria-label="Email"');
    expect(html).toContain('>Email me a sign-in link</button>');
    expect(html).not.toMatch(/<h[1-6]|<label|password|Remember|Forgot|Create an account/i);
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script/i);
  });
  it('after an emergency sign-out: the form says everyone (including you) is out and unused links and recovery codes are cancelled', () => {
    expect(renderSignInForm()).not.toContain('signin-notice');
    const html = renderSignInForm({}, 'everyone_signed_out');
    expect(EVERYONE_SIGNED_OUT_MESSAGE).toMatch(/Everyone has been signed out, including you\./);
    expect(EVERYONE_SIGNED_OUT_MESSAGE).toMatch(/unused sign-in links and recovery codes were cancelled/);
    expect(html).toContain('role="status"');
    expect(html).toContain('>Email me a sign-in link</button>');
    expect(html.match(/<input/g)).toHaveLength(1);
  });
  it('result: the one generic paragraph with "Use a different address"', () => {
    const html = renderSignInSent();
    expect(html).toContain('<b>Check your email.</b> If that address is on the roster, we emailed a sign-in link. It works once and expires in 15 minutes.');
    expect(html).toContain('>Use a different address</a>');
    expect(html.match(/<p /g)).toHaveLength(1);
  });
  it('confirm: masked identity, escaped, one button, "Not you?" link', () => {
    const html = renderConfirm('j•••@<x>.com', 'n1', 't1');
    expect(html).toContain('Finish signing in as <strong>j•••@&lt;x&gt;.com</strong>.');
    expect(html).toContain('>Confirm sign-in</button>');
    expect(html).toContain('>Not you? Use a different address</a>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it('stale: exact message and "Get a new link"', () => {
    const html = renderStale();
    expect(STALE_MESSAGE).toBe('This link was already used or has expired.');
    expect(html).toContain(STALE_MESSAGE);
    expect(html).toContain('>Get a new link</a>');
  });
  it('staging banner only when asked', () => {
    expect(renderSignInForm()).not.toContain('STAGING');
    expect(renderSignInForm({ stagingBanner: true })).toContain('STAGING');
  });
  it('headers: no-store, same-origin referrer (so form POSTs carry a real Origin), CSP without script', () => {
    const h = signInPageHeaders();
    expect(h['cache-control']).toBe('no-store');
    // Not no-referrer: that makes browsers send Origin: null on the confirm POST (A6 finding).
    expect(h['referrer-policy']).toBe('same-origin');
    expect(renderSignInForm()).toContain('<meta name="referrer" content="same-origin" />');
    expect(renderSignInForm()).not.toContain('no-referrer');
    expect(h['content-security-policy']).toContain("script-src 'none'");
  });
  it('assets exist: black badge (same bytes as Quote-Queue) and stylesheet values', () => {
    expect(existsSync(resolve(appRoot, 'public/brand/badge-black.png'))).toBe(true);
    const css = readFileSync(resolve(appRoot, 'public/auth/signin.css'), 'utf8');
    expect(css).toContain('max-width: 440px');
    expect(css).toMatch(/\.signin-wordmark img \{ width: 72px; height: 72px;/);
    expect(css).toMatch(/\.signin-input \{[^}]*height: 40px/);
    expect(css).toMatch(/\.signin-btn \{[^}]*height: 40px/);
    expect(css).toContain('text-transform: uppercase');
    expect(css).not.toMatch(/box-shadow|\.card/);
  });
  it('recovery form escapes the pre-token and shows the generic failure only on failure', () => {
    expect(renderRecoveryForm('"x"', false)).toContain('value="&quot;x&quot;"');
    expect(renderRecoveryForm('t', false)).not.toContain("That didn't work");
    expect(renderRecoveryForm('t', true)).toContain("That didn&#39;t work. Check the address and code, or ask a manager.");
  });
});

describe('recovery codes', () => {
  it('codes are 16 Crockford symbols in four groups and unique within a set', () => {
    const code = generateCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(new Set(generateCodeSet()).size).toBe(10);
    expect(CODE_ALPHABET).toHaveLength(32);
  });
  it('normalization accepts typing variations and rejects anything else', () => {
    expect(normalizeCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(normalizeCode(' o0il 2345 6789 abcd ')).toBe('001123456789ABCD');
    expect(normalizeCode('ABCD-EFGH-JKMN-PQR')).toBeUndefined();
    expect(normalizeCode('ABCD-EFGH-JKMN-PQRU')).toBeUndefined();
  });
});

describe('recovery matrix (default deny, intersect with ordinary role)', () => {
  const batch = '/api/recovery/batches/11111111-2222-4333-8444-555555555555/members';
  it('allows only listed routes, and status change only for editors', () => {
    expect(recoveryRouteAllowed('GET', '/api/recovery/batches', 'view', 'approved')).toBe(true);
    expect(recoveryRouteAllowed('GET', batch, 'view', 'approved')).toBe(true);
    expect(recoveryRouteAllowed('POST', '/api/recovery/batch-carriers/status', 'view', 'approved')).toBe(false);
    expect(recoveryRouteAllowed('POST', '/api/recovery/batch-carriers/status', 'edit', 'approved')).toBe(true);
    expect(recoveryRouteAllowed('POST', '/api/recovery/batch-carriers/status', 'manager', 'approved')).toBe(true);
  });
  it('denies every normal route, exports, team and code management', () => {
    for (const [m, p] of [
      ['POST', '/api/rpc/search_carriers'],
      ['GET', '/api/carriers/123/profile'],
      ['POST', '/api/contact-logs'],
      ['GET', '/api/team'],
      ['POST', '/api/recovery-codes'],
      ['POST', '/api/rpc/generate_contact_sheet'],
    ] as const) {
      expect(recoveryRouteAllowed(m, p, 'manager', 'approved')).toBe(false);
    }
  });
  it('never for guest, pending or disabled', () => {
    expect(recoveryRouteAllowed('GET', '/api/recovery/batches', 'guest', 'approved')).toBe(false);
    expect(recoveryRouteAllowed('GET', '/api/recovery/batches', 'edit', 'pending')).toBe(false);
    expect(recoveryRouteAllowed('GET', '/api/recovery/batches', 'edit', 'disabled')).toBe(false);
  });
  it('returns no contact or notes columns', () => {
    const all = [...RECOVERY_COLUMNS.batches, ...RECOVERY_COLUMNS.members].join(' ');
    expect(all).not.toMatch(/phone|email|contact|note|reason|address|street/i);
  });
  it('is off unless RECOVERY_ENABLED is exactly "true"', () => {
    expect(recoveryEnabled({})).toBe(false);
    expect(recoveryEnabled({ RECOVERY_ENABLED: '1' })).toBe(false);
    expect(recoveryEnabled({ RECOVERY_ENABLED: 'true' })).toBe(true);
  });
});
