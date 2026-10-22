// Graceful-shutdown contract (doc 15 §4.1): tracks every accepted request AND every
// post-response continuation, registered before the response is written. On shutdown:
// stop admission, drain both sets within the budget, then close the database.

export class Lifecycle {
  private accepting = true;
  private readonly accepted = new Set<Promise<unknown>>();
  private readonly continuations = new Set<Promise<unknown>>();
  private abandoned = 0;

  get isAccepting(): boolean {
    return this.accepting;
  }

  get counts(): { accepted: number; continuations: number; abandoned: number } {
    return { accepted: this.accepted.size, continuations: this.continuations.size, abandoned: this.abandoned };
  }

  /** Track a request from acceptance to completion. Returns undefined when shutting down. */
  trackRequest<T>(work: () => Promise<T>): Promise<T> | undefined {
    if (!this.accepting) return undefined;
    const p = work();
    this.accepted.add(p);
    const done = () => this.accepted.delete(p);
    p.then(done, done);
    return p;
  }

  /** Register post-response work; it runs to completion or to its own deadline. */
  trackContinuation(work: () => Promise<void>): void {
    const p = work().catch(() => undefined);
    this.continuations.add(p);
    p.finally(() => this.continuations.delete(p));
  }

  /**
   * Stop admission, wait for accepted requests (which may register continuations), then for
   * continuations, all within `budgetMs`; then run `closeDb`. Returns the abandoned count.
   */
  async shutdown(budgetMs: number, closeDb: () => Promise<void>): Promise<number> {
    this.accepting = false;
    const deadline = Date.now() + budgetMs;
    const waitFor = async (set: Set<Promise<unknown>>) => {
      while (set.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await Promise.race([Promise.allSettled([...set]), new Promise((r) => setTimeout(r, remaining))]);
      }
      return true;
    };
    await waitFor(this.accepted);
    await waitFor(this.continuations);
    this.abandoned = this.accepted.size + this.continuations.size;
    await closeDb();
    return this.abandoned;
  }
}
