// America/Chicago calendar-day bounds for the 10-per-day ceiling. Sign-in rows store UTC
// timestamptz, so a ::date cast would count UTC days; this returns the [start, end) UTC
// instants of the Chicago day containing `instant`, DST-correct (Quote-Queue request route
// :176-234 technique: two-pass Intl round trip).

const CHICAGO_TZ = 'America/Chicago';

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function wallClockParts(instantMs: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = wallClock.formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0; // ICU midnight quirk
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

function wallClockAsUtcMs(instantMs: number): number {
  const p = wallClockParts(instantMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** UTC instant of Chicago local midnight on the given calendar date. */
function chicagoMidnightUtcMs(year: number, month: number, day: number): number {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) guess += target - wallClockAsUtcMs(guess);
  return guess;
}

export function chicagoDateString(instant: Date): string {
  const p = wallClockParts(instant.getTime());
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function chicagoDayUtcBounds(instant: Date): { start: Date; end: Date } {
  const p = wallClockParts(instant.getTime());
  const start = new Date(chicagoMidnightUtcMs(p.year, p.month, p.day));
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = new Date(chicagoMidnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()));
  return { start, end };
}
