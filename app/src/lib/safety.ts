export type Verdict = 'good' | 'warn' | 'bad';

/** Positive only when an explicit Satisfactory rating exists; a missing or unrecognised rating is "needs review". */
export function safetyVerdict(safety: { safety_rating: string | null } | null | undefined): Verdict {
  if (!safety) return 'warn';
  const rating = safety.safety_rating?.trim().toLowerCase();
  if (rating === 'unsatisfactory') return 'bad';
  if (rating === 'satisfactory') return 'good';
  return 'warn';
}
