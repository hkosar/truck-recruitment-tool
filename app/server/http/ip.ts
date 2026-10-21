// Client IP for the per-IP flood bucket.
//
// UNVERIFIED for this service (doc 15 §3 C8, §4.2): Quote-Queue takes the LAST
// X-Forwarded-For hop (lib/request-ip.ts:44), which is only correct for its exact proxy chain.
// This app uses the same extraction only as a placeholder until hosted test T-IP passes for
// this service's chain. Until then the 20/IP limit is not counted as protection.
// When no usable IP is found, the caller uses the ONE shared unknown-IP bucket
// (auth/rate.ts ipBucketKey), so a missing header never bypasses the IP ceiling.

export interface ClientIpOptions {
  /** How many trusted proxy hops append to X-Forwarded-For (1 = take the last entry). */
  trustedHops: number;
}

export function getClientIp(headers: { get(name: string): string | null }, options: ClientIpOptions = { trustedHops: 1 }): string | undefined {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
    const index = hops.length - options.trustedHops;
    if (options.trustedHops >= 1 && index >= 0) return hops[index];
    return undefined;
  }
  const realIp = headers.get('x-real-ip')?.trim();
  return realIp ? realIp : undefined;
}
