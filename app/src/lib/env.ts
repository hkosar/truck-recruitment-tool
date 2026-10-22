// Build-time environment flags. No Supabase URL or key is part of the app bundle any more.
export const appEnvironment = (import.meta.env.VITE_APP_ENV || 'development').toLowerCase();
export const isStaging = appEnvironment === 'staging';
