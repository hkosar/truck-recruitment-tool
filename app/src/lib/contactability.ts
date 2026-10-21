/** Global do-not-contact blocks every outreach control and every contact-log write. */
export function isGloballyDnc(carrier: { do_not_contact: boolean } | null | undefined): boolean {
  return carrier?.do_not_contact === true;
}

export const DNC_BLOCKED_MESSAGE = 'This carrier is on the global do-not-contact list. Outreach cannot be logged.';
