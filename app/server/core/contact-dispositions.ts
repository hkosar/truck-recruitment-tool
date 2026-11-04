/** Server-side copy of src/types/domain.ts DISPOSITIONS_BY_CHANNEL (a test keeps them equal).
 * The database enum stays the final guard; this only turns an empty or
 * wrong-channel outcome into a plain 400 before it reaches the enum cast. */
export const CONTACT_DISPOSITIONS_BY_CHANNEL: Readonly<Record<string, readonly string[]>> = {
  call: ['connected', 'no_answer', 'voicemail', 'callback', 'interested', 'not_interested', 'wrong_number'],
  text: ['sent', 'replied', 'no_response', 'wrong_number'],
  email: ['sent', 'replied', 'bounced', 'no_response'],
};

/** The channels the contact_channel enum holds (migration 20260720000200_enums.sql). Exact, case-sensitive match only. */
const CONTACT_CHANNELS: readonly string[] = ['call', 'text', 'email', 'mail'];

export function contactChannelKnown(channel: string): boolean {
  return CONTACT_CHANNELS.includes(channel);
}

/** True when the outcome is non-empty and, for a channel with a list, allowed there. Channels with no list (mail) are left to the database, but still need a non-empty outcome (the enum cast refuses '' anyway). */
export function contactDispositionAllowed(channel: string, disposition: string): boolean {
  if (!disposition) return false;
  const allowed = Object.hasOwn(CONTACT_DISPOSITIONS_BY_CHANNEL, channel) ? CONTACT_DISPOSITIONS_BY_CHANNEL[channel] : undefined;
  return allowed ? allowed.includes(disposition) : true;
}
