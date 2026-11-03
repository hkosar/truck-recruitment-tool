/**
 * The pinned Supabase database root certificate(s): the ONLY trust source db-tls.ts accepts for a hosted
 * (non-loopback) database connection. There is no fallback to Node's built-in store and none to
 * `rejectUnauthorized: false`. (There is no DB_CA_CERT override in the code: the pin is the only way to supply a root.)
 *
 * Pinned entry: "Supabase Root 2021 CA" (prod-ca-2021.crt).
 *  - Subject = issuer = CN Supabase Root 2021 CA (self-signed); valid 2021-04-28 to 2031-04-26 (UTC).
 *  - SHA-256 of the DER bytes: 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
 *  - Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt, downloaded by the manager
 *    thread on 2026-11-03 (HTTP 200, 1367 bytes).
 *  - Independent corroboration: the same fingerprint is pinned by Remote Tickets (src/lib/db-tls.mjs,
 *    SUPABASE_ROOT_2021_CA_SHA256) and by the Sales app (certs/supabase-prod-ca-2021.crt).
 *  - Verified on 2026-11-03: a password-free TLS handshake (SSLRequest, no startup message) from this PC to the staging-2 pooler
 *    host validated the chain *.pooler.supabase.com <- Supabase Intermediate 2021 CA <- Supabase Root 2021 CA with the hostname
 *    check (TLSv1.3); a control with a wrong CA was refused (SELF_SIGNED_CERT_IN_CHAIN).
 *  - NOT checked: production. Nothing here says this root covers the production project; check it with the same password-free
 *    handshake before relying on it there. Staging-2 is the only target verified.
 *
 * The list and its entries are frozen. db-tls.ts re-checks every entry each time a hosted connection is configured (one certificate, a CA, DER SHA-256 equal to
 * `sha256` below), allows no other PEM block (a TRUSTED CERTIFICATE or X509 CERTIFICATE block would be loaded by OpenSSL too), hands TLS only
 * the re-encoded checked certificate, and refuses before dialling on any mismatch (`invalid_trusted_ca`). An empty list refuses too (`no_trusted_ca`).
 * `sha256` is Node's X509Certificate.fingerprint256: uppercase hex pairs joined by ':'.
 */export interface PinnedRootCa {
  /** Human label, e.g. "Supabase Root 2021 CA (staging-2 download)". */
  name: string;
  /** SHA-256 of the DER certificate, uppercase hex pairs joined by ':'. */
  sha256: string;
  /** Where it came from (dashboard page and date downloaded). */
  source: string;
  /** The PEM text, exactly as downloaded. */
  pem: string;
}

export const SUPABASE_ROOT_CAS: readonly PinnedRootCa[] = Object.freeze([
  Object.freeze({
    name: 'Supabase Root 2021 CA (prod-ca-2021.crt; verified against staging-2 only)',
    sha256: '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
    source: 'supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt, downloaded 2026-11-03 (1367 bytes)',
    pem: [
      '-----BEGIN CERTIFICATE-----\n',
      'MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\n',
      'BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\n',
      'dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\n',
      'c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\n',
      'azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\n',
      'YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\n',
      'Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\n',
      'QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\n',
      'DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\n',
      'GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\n',
      'cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\n',
      'O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\n',
      'NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\n',
      'uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\n',
      'aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\n',
      'tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\n',
      'VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\n',
      'jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\n',
      'Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\n',
      'CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\n',
      'o/bKiIz+Fq8=\n',
      '-----END CERTIFICATE-----\n',
    ].join(''),
  }),
]);
