import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useProfile } from '../../app/guards';

/**
 * docs/build-plan/02-frontend-spec.md §3f: guest gate landing, v1 copy
 * kept ("A manager needs to review and provision your account"), sign-out
 * button.
 */
export default function Pending() {
  const navigate = useNavigate();
  const profile = useProfile();

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-elev-2">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-st-new-tint text-st-new">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="font-ui text-xl font-extrabold text-text">Waiting on approval</h1>
        <p className="mt-2 text-sm text-text-muted">
          A manager needs to review and provision your account{profile?.email ? ` (${profile.email})` : ''}.
        </p>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="mt-6 rounded-md border border-border-strong px-4 py-2 text-sm font-medium text-text-muted hover:bg-surface-2"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
