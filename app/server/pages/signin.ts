// Server-rendered sign-in pages, decisions 19 and 35 (Quote-Queue app/signin/page.tsx:38-98,
// app/auth/confirm/route.ts:127-182). No script on these pages; the stylesheet is a static
// same-origin file (/auth/signin.css), so CSP can be `script-src 'none'; style-src 'self'`.

export const APP_WORDMARK = 'Carrier Recruiter';
export const STALE_MESSAGE = 'This link was already used or has expired.';
export const RECOVERY_FAILURE_MESSAGE = "That didn't work. Check the address and code, or ask a manager.";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PageOptions {
  /** Shown only on staging, above the shell (not on Quote-Queue; flagged for visual review). */
  stagingBanner?: boolean;
}

function page(body: string, options: PageOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(APP_WORDMARK)} — Sign in</title>
<link rel="stylesheet" href="/auth/signin.css" />
</head>
<body>
${options.stagingBanner ? '<div class="signin-staging">STAGING — fictional data</div>\n' : ''}<main class="signin-page">
<div class="signin-shell">
<div class="signin-wordmark"><img src="/brand/badge-black.png" alt="" width="72" height="72" />${escapeHtml(APP_WORDMARK)}</div>
${body}
</div>
</main>
</body>
</html>`;
}

/** Decision 19: one email box over one full-width button. No heading, label or helper. */
export function renderSignInForm(options?: PageOptions): string {
  return page(
    `<section class="signin-block">
<form class="signin-form" method="post" action="/auth/request">
<input class="signin-input" id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" aria-label="Email" />
<button class="signin-btn" type="submit">Email me a sign-in link</button>
</form>
</section>`,
    options,
  );
}

/** Decision 19: the one generic paragraph, for every outcome. */
export function renderSignInSent(options?: PageOptions): string {
  return page(
    `<section class="signin-block" aria-live="polite">
<p class="signin-message"><b>Check your email.</b> If that address is on the roster, we emailed a sign-in link. It works once and expires in 15 minutes. <a class="signin-link" href="/signin">Use a different address</a></p>
</section>`,
    options,
  );
}

/** Decision 35: masked identity, one button, "Not you? Use a different address". */
export function renderConfirm(maskedEmail: string, nonce: string, csrfToken: string, options?: PageOptions): string {
  return page(
    `<section class="signin-block signin-form">
<p class="signin-message">Finish signing in as <strong>${escapeHtml(maskedEmail)}</strong>.</p>
<form class="signin-form" method="post" action="/auth/confirm">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}" />
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
<button type="submit" class="signin-btn">Confirm sign-in</button>
</form>
<a href="/signin" class="signin-link">Not you? Use a different address</a>
</section>`,
    options,
  );
}

/** Decision 35: used or expired link, and every fail-closed confirm path. */
export function renderStale(options?: PageOptions): string {
  return page(
    `<section class="signin-block signin-form">
<p class="signin-message">${escapeHtml(STALE_MESSAGE)}</p>
<a href="/signin" class="signin-btn">Get a new link</a>
</section>`,
    options,
  );
}

/** Recovery-code form (doc 14 §7.2), served only when recovery is enabled. Not linked from /signin. */
export function renderRecoveryForm(preToken: string, failed: boolean, options?: PageOptions): string {
  return page(
    `<section class="signin-block">
${failed ? `<p class="signin-message" role="alert">${escapeHtml(RECOVERY_FAILURE_MESSAGE)}</p>\n` : ''}<form class="signin-form" method="post" action="/auth/recovery">
<input type="hidden" name="pre_token" value="${escapeHtml(preToken)}" />
<input class="signin-input" name="email" type="email" required autocomplete="email" placeholder="you@example.com" aria-label="Email" />
<input class="signin-input" name="code" type="text" required autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX-XXXX" aria-label="Recovery code" />
<button class="signin-btn" type="submit">Sign in with a recovery code</button>
</form>
<a href="/signin" class="signin-link">Email me a sign-in link instead</a>
</section>`,
    options,
  );
}

/** Security headers for these pages (doc 14 §2.3; QQ middleware.ts:72-156, without script). */
export function signInPageHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}
