/** Server-side copy of src/types/domain.ts DISPOSITIONS_BY_CHANNEL (a test keeps them equal).
 * The database enum stays the final guard; this only turns an empty or
 * wrong-channel outcome into a plain 400 before it reaches the enum cast. */
export const CONTACT_DISPOSITIONS_BY_CHANNEL: Readonly<Record<string, readonly string[]>> = {
  call: ['connected', 'no_answer', 'voicemail', 'callback', 'interested', 'not_interested', 'wrong_number'],
  text: ['sent', 'replied', 'no_response', 'wrong_number'],
  email: ['sent', 'replied', 'bounced', 'no_response'],
};

/** True when the outcome is non-empty and, for a channel with a list, allowed there. Channels with no list (e.g. mail) are left to the database. */
export function contactDispositionAllowed(channel: string, disposition: string): boolean {
  if (!disposition) return false;
  const allowed = Object.hasOwn(CONTACT_DISPOSITIONS_BY_CHANNEL, channel) ? CONTACT_DISPOSITIONS_BY_CHANNEL[channel] : undefined;
  return allowed ? allowed.includes(disposition) : true;
}
