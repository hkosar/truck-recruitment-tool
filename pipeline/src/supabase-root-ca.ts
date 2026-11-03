/**
 * The pinned Supabase database root certificate(s): the ONLY trust source db-tls.ts accepts for a hosted
 * (non-loopback) database connection. There is no fallback to Node's built-in store and none to
 * `rejectUnauthorized: false`.
 *
 * Where the certificate comes from (official docs only, read 2026-11-03 UTC):
 *  - https://supabase.com/docs/guides/platform/ssl-enforcement : "To use verify-full you will need to download the Supabase CA
 *    certificate for your database. The certificate is available through the dashboard under the SSL Configuration section in
 *    the Database Settings page." Example file name: prod-ca-2021.crt.
 *  - https://supabase.com/docs/guides/database/psql : "Download your SSL certificate from Database Settings", then
 *    `sslmode=verify-full sslrootcert=... host=[CLOUD_PROVIDER]-0-[REGION].pooler.supabase.com`.
 *  - https://supabase.com/docs/guides/database/connecting-to-postgres : "download your server root certificate from Database
 *    settings in the Supabase Dashboard".
 * These pages link NO public certificate file; it is a per-project download from the signed-in dashboard. So nothing is
 * pinned yet and every hosted connection fails closed (`no_trusted_ca`) until the owner downloads it and a reviewed commit
 * adds it here. Whether every project (staging-2 and production) gets the same certificate is not stated by the docs:
 * compare the downloads' SHA-256 before pinning one entry for both.
 *
 * Each entry: `sha256` is the SHA-256 of the certificate's DER bytes as uppercase hex pairs joined by ':' (Node's
 * X509Certificate.fingerprint256; PowerShell: `(Get-PfxCertificate <file>).GetCertHashString('SHA256')` without colons).
 * db-tls.ts refuses an entry whose PEM does not match its hash, or that is not a CA certificate.
 */
export interface PinnedRootCa {
  /** Human label, e.g. "Supabase Root 2021 CA (staging-2 download)". */
  name: string;
  /** SHA-256 of the DER certificate, uppercase hex pairs joined by ':'. */
  sha256: string;
  /** Where it came from (dashboard page and date downloaded). */
  source: string;
  /** The PEM text, exactly as downloaded. */
  pem: string;
}

export const SUPABASE_ROOT_CAS: readonly PinnedRootCa[] = [];
