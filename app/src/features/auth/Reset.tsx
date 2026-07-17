import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

/**
 * docs/build-plan/02-frontend-spec.md §3f: new password from the email
 * link. Not gated by RequireAnon (see app/router.tsx's deviation note) — a
 * Supabase recovery link signs the user in, so this screen checks for that
 * session itself instead.
 */
export default function Reset() {
  const navigate = useNavigate();
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setHasRecoverySession(Boolean(data.session));
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError(null);

    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
    window.setTimeout(() => navigate('/dashboard', { replace: true }), 1500);
  }

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-elev-2">
        <div className="mb-8 text-center">
          <h1 className="font-ui text-xl font-extrabold text-text">Set a new password</h1>
        </div>

        {checkingSession ? (
          <p className="text-center text-sm text-text-muted">Checking your reset link…</p>
        ) : !hasRecoverySession ? (
          <div className="space-y-4 text-center">
            <p className="rounded-md bg-crit-tint px-3 py-2 text-sm text-crit">
              This reset link is invalid or has expired.
            </p>
            <Link to="/forgot" className="font-medium text-accent hover:text-accent-hover">
              Request a new link
            </Link>
          </div>
        ) : done ? (
          <p className="rounded-md bg-good-tint px-3 py-2 text-sm text-good">
            Password updated — taking you to the dashboard…
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-text">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring"
              />
            </div>

            <div>
              <label htmlFor="confirm_password" className="mb-1 block text-sm font-medium text-text">
                Confirm password
              </label>
              <input
                id="confirm_password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring"
              />
            </div>

            {error ? <p className="rounded-md bg-crit-tint px-3 py-2 text-sm text-crit">{error}</p> : null}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
