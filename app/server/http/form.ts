// Form handling for the server-rendered sign-in pages. Any preflight or parse failure
// collapses to "no field" (Quote-Queue request route :544-566): a probe sees exactly what an
// invalid submission sees, and no parse detail is ever echoed.

export function isUrlEncodedForm(contentType: string | null | undefined): boolean {
  return (contentType ?? '').trim().toLowerCase().startsWith('application/x-www-form-urlencoded');
}

/**
 * Returns the single string value of each requested field, or undefined when the field is
 * missing, repeated, or the body is not a valid urlencoded form.
 */
export function readFormFields<K extends string>(
  contentType: string | null | undefined,
  body: Buffer | undefined,
  fields: readonly K[],
): Record<K, string | undefined> {
  const out = Object.fromEntries(fields.map((f) => [f, undefined])) as Record<K, string | undefined>;
  if (!body || !isUrlEncodedForm(contentType)) return out;
  let params: URLSearchParams;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    params = new URLSearchParams(text);
  } catch {
    return out;
  }
  for (const field of fields) {
    const values = params.getAll(field);
    out[field] = values.length === 1 ? values[0] : undefined;
  }
  return out;
}
