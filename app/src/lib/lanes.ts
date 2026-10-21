export interface LaneDraft { id: string; label: string; anchorLabel: string; lat: string; lng: string; radius: string }
export interface LaneErrors { anchorLabel?: string; lat?: string; lng?: string; radius?: string }
export interface ValidLane { label: string; anchorLabel: string; lat: number; lng: number; radius: number }

const parseCoordinate = (raw: string, min: number, max: number, name: string): { value?: number; error?: string } => {
  if (!raw.trim()) return { error: `${name} is required` };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `${name} must be a number` };
  if (value < min || value > max) return { error: `${name} must be between ${min} and ${max}` };
  return { value };
};

/** Every lane must be complete: anchor, lat in [-90, 90], lng in [-180, 180], radius > 0. */
export function validateLane(lane: LaneDraft): { errors: LaneErrors; valid?: ValidLane } {
  const errors: LaneErrors = {};
  const anchorLabel = lane.anchorLabel.trim();
  if (!anchorLabel) errors.anchorLabel = 'Anchor is required';
  const lat = parseCoordinate(lane.lat, -90, 90, 'Latitude');
  const lng = parseCoordinate(lane.lng, -180, 180, 'Longitude');
  if (lat.error) errors.lat = lat.error;
  if (lng.error) errors.lng = lng.error;
  const radius = Number(lane.radius);
  if (!lane.radius.trim() || !Number.isFinite(radius) || radius <= 0) errors.radius = 'Radius must be greater than 0';
  if (Object.keys(errors).length > 0) return { errors };
  return { errors, valid: { label: lane.label.trim(), anchorLabel, lat: lat.value as number, lng: lng.value as number, radius } };
}
