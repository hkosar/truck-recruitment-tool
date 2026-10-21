// In-memory mail adapter for tests (EMAIL_MODE=test). Holds sent links only in memory and
// exposes them to the test that asked; never logs or prints them.

import type { MailAdapter, SendOutcome, SignInMail } from './adapter';

export class FakeMailAdapter implements MailAdapter {
  private readonly sent: SignInMail[] = [];
  private next: () => Promise<SendOutcome> = async () => ({ outcomeClass: 'accepted', providerMessageId: `fake-${this.sent.length}` });

  /** Make the next sends resolve to a given outcome, hang, or throw. */
  respondWith(next: () => Promise<SendOutcome>): void {
    this.next = next;
  }

  async sendSignInLink(mail: SignInMail): Promise<SendOutcome> {
    this.sent.push(mail);
    return this.next();
  }

  /** Last link sent to an address, for the test's own browser step. */
  lastLinkFor(address: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].to === address) return this.sent[i].linkUrl;
    return undefined;
  }

  get count(): number {
    return this.sent.length;
  }
}
