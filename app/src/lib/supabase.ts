import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill in ' +
      'your Supabase project credentials.',
  );
}

/**
 * "Remember me" storage switch — docs/build-plan/02-frontend-spec.md §1.4:
 * checked -> localStorage (session survives closing the browser), unchecked
 * -> sessionStorage (session ends with the tab). The Supabase client is a
 * module-level singleton created once at import time, before any login
 * attempt, so the *preference* has to live somewhere synchronous and
 * readable before that — a tiny always-in-localStorage flag this adapter
 * consults on every read/write. features/auth/Login.tsx calls
 * setRememberMe() immediately before signInWithPassword().
 */
const REMEMBER_ME_KEY = 'tnbs-recruiter:remember-me';

function activeAuthStorage(): Storage {
  try {
    return window.localStorage.getItem(REMEMBER_ME_KEY) === 'false' ? window.sessionStorage : window.localStorage;
  } catch {
    return window.localStorage;
  }
}

export function setRememberMe(remember: boolean): void {
  window.localStorage.setItem(REMEMBER_ME_KEY, remember ? 'true' : 'false');
}

const authStorageAdapter = {
  getItem: (key: string) => activeAuthStorage().getItem(key),
  setItem: (key: string, value: string) => activeAuthStorage().setItem(key, value),
  removeItem: (key: string) => {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

/**
 * Typed Supabase client (Database placeholder: types/database.ts — see that
 * file's header for what's real vs. hand-mirrored, and regen instructions).
 * Every heavy read goes through Postgres RPCs (lib/rpc.ts); this raw client
 * is also used directly for plain PostgREST reads/writes under RLS (single-
 * row status PATCH, comment/contact-log INSERT, profile SELECT in
 * app/guards.tsx — 01 §5.4's "plain PostgREST, no RPC" list) and for
 * supabase.auth.*.
 */
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: authStorageAdapter,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
