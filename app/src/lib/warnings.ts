import type { WarningCode } from '../types/domain';

/**
 * WarningCode -> {label, tone} — docs/build-plan/02-frontend-spec.md §1.1,
 * closed nine-code vocabulary per 01-architecture.md amendment #8. This is
 * the single place warning copy is authored; WarningChips (02 §5) and every
 * screen that renders them (batch table, profile header, contact-sheet
 * modal, print sheet — G5) should consume this map rather than hardcoding
 * label strings.
 *
 * Tone assignment (not spelled out verbatim in the spec, so documented
 * here): `crit` for signals that read as a hard stop (inactive/no
 * insurance/authority not active/poor rating/recent crashes); `warn` for
 * signals that are explicitly "visible, not excluded" by design — the
 * below-standard insurance threshold and expiring-soon date are the classic
 * locked-rule case (never a silent filter), high OOS is elevated-but-not-
 * disqualifying, and missing-from-source is a data-quality flag rather than
 * something the carrier did. Every code still renders the same flat
 * `bg-row-warning` row wash regardless of tone (rowTone is binary:
 * "default"|"warning"|"dnc") — tone only colors the individual chip.
 */
export type WarningTone = 'warn' | 'crit';

export interface WarningMeta {
  label: string;
  tone: WarningTone;
}

export const WARNING_META: Record<WarningCode, WarningMeta> = {
  carrier_inactive: { label: 'Carrier inactive', tone: 'crit' },
  no_insurance: { label: 'No insurance', tone: 'crit' },
  insurance_below_standard: { label: 'Insurance below required', tone: 'warn' },
  insurance_expiring_30d: { label: 'Insurance expiring soon', tone: 'warn' },
  authority_not_active: { label: 'Authority inactive', tone: 'crit' },
  safety_rating: { label: 'Poor safety rating', tone: 'crit' },
  high_oos: { label: 'High OOS', tone: 'warn' },
  recent_crashes: { label: 'Recent crashes', tone: 'crit' },
  missing_from_source: { label: 'Missing from FMCSA data', tone: 'warn' },
};

export const WARNING_CODES = Object.keys(WARNING_META) as WarningCode[];

export function getWarningMeta(code: WarningCode): WarningMeta {
  return WARNING_META[code];
}

/** True if `reasons` contains at least one recognized code — drives
 * `rowTone="warning"` / the pale-red wash (G5). Tolerates raw `string[]`
 * (what the RPC rows actually type warning_reasons as) so call sites don't
 * all need to narrow first. */
export function hasWarnings(reasons: readonly string[] | null | undefined): boolean {
  return Boolean(reasons && reasons.length > 0);
}
