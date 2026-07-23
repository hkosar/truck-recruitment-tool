import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { connectedSupabaseRef, isStaging, setRememberMe, supabase } from '../../lib/supabase';

/** docs/build-plan/02-frontend-spec.md §3f: "Login (email, password,
 * Remember me, Forgot link)" — v1 shape kept, minus the demo-role buttons. */

interface LocationState {
  from?: { pathname: string };
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // Must be set before signInWithPassword() persists the new session
    // (lib/supabase.ts's storage adapter reads this flag synchronously).
    setRememberMe(remember);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }

    const state = location.state as LocationState | null;
    navigate(state?.from?.pathname ?? '/', { replace: true });
  }

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-elev-2">
        {isStaging ? (
          <div className="mb-5 border border-warn bg-warn-tint px-3 py-2 text-center text-[10px] font-extrabold uppercase tracking-[0.09em] text-warn">
            Staging · fictional data · not production
            <span className="mt-1 block font-mono normal-case tracking-normal text-text-subtle">{connectedSupabaseRef}</span>
          </div>
        ) : null}
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <div className="flex items-center gap-3 bg-bar px-4 py-3">
            <img src="/brand/badge-white.png" alt="" className="h-9 w-9 object-contain" />
            <img src="/brand/primary-white.png" alt="Twisted Nail" className="h-7 w-auto object-contain" />
          </div>
          <div className="text-xs font-medium uppercase tracking-wider text-text-subtle">Carrier Recruiter</div>
        </div>

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

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-text">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring"
            />
          </div>

          <div className="flex items-center justify-between text-sm">
            <label className="flex items-center gap-2 text-text-muted">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 rounded border-border-strong text-accent focus:ring-accent-ring"
              />
              Remember me
            </label>
            <Link to="/forgot" className="font-medium text-accent hover:text-accent-hover">
              Forgot password?
            </Link>
          </div>

          {error ? <p className="rounded-md bg-crit-tint px-3 py-2 text-sm text-crit">{error}</p> : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-text-muted">
          Don't have an account?{' '}
          <Link to="/register" className="font-medium text-accent hover:text-accent-hover">
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}
