import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

/** docs/build-plan/02-frontend-spec.md §3f: Forgot -> reset email. */
export default function Forgot() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset`,
    });
    setSubmitting(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setSent(true);
  }

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-elev-2">
        <div className="mb-8 text-center">
          <h1 className="font-ui text-xl font-extrabold text-text">Reset your password</h1>
          <p className="mt-1 text-sm text-text-muted">We'll email you a link to set a new one.</p>
        </div>

        {sent ? (
          <p className="rounded-md bg-good-tint px-3 py-2 text-sm text-good">Check {email} for a reset link.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-text">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring"
              />
            </div>

            {error ? <p className="rounded-md bg-crit-tint px-3 py-2 text-sm text-crit">{error}</p> : null}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-text-muted">
          <Link to="/login" className="font-medium text-accent hover:text-accent-hover">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
