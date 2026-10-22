// The 17 RPCs the app may call (= the grants in 20260722223300_security_hardening.sql:39-57),
// with their exact parameter names and types (20260720001100_rpc.sql). The server calls them
// with PostgreSQL named notation, so argument order can never be confused; anything not listed
// here is refused before the database is touched.

export type PgType =
  | 'jsonb'
  | 'int'
  | 'bigint'
  | 'text'
  | 'boolean'
  | 'uuid'
  | 'bigint[]'
  | 'batch_carrier_status'
  | 'batch_carrier_status[]'
  | 'contact_channel';

export interface RpcSpec {
  params: Readonly<Record<string, PgType>>;
  /** rows: setof/table result; scalar: single value; void. */
  returns: 'rows' | 'scalar' | 'void';
}

export const RPC_SPECS: Readonly<Record<string, RpcSpec>> = {
  search_carriers: { params: { p_definition: 'jsonb', p_page: 'int', p_page_size: 'int', p_sort: 'text', p_dir: 'text' }, returns: 'rows' },
  count_carriers: { params: { p_definition: 'jsonb' }, returns: 'rows' },
  facet_other_values: { params: { p_definition: 'jsonb', p_keyword: 'text', p_limit: 'int', p_offset: 'int' }, returns: 'rows' },
  facet_suggested_keywords: { params: { p_definition: 'jsonb' }, returns: 'rows' },
  facet_cargo_flags: { params: { p_definition: 'jsonb' }, returns: 'rows' },
  create_batch: { params: { p_name: 'text', p_customer: 'text', p_job: 'text', p_description: 'text', p_definition: 'jsonb' }, returns: 'rows' },
  refresh_batch: { params: { p_batch_id: 'uuid' }, returns: 'rows' },
  bulk_set_status: { params: { p_batch_id: 'uuid', p_dots: 'bigint[]', p_status: 'batch_carrier_status' }, returns: 'scalar' },
  set_do_not_contact: { params: { p_dot: 'bigint', p_on: 'boolean', p_reason: 'text' }, returns: 'void' },
  log_export: { params: { p_batch_id: 'uuid', p_kind: 'text', p_row_count: 'int' }, returns: 'void' },
  batch_members: {
    params: {
      p_batch_id: 'uuid', p_status: 'batch_carrier_status[]', p_q: 'text', p_warnings_only: 'boolean', p_page: 'int', p_page_size: 'int',
      p_sort: 'text', p_dir: 'text', p_min_insurance: 'bigint', p_size_min: 'int', p_size_max: 'int', p_has_phone: 'boolean', p_has_email: 'boolean',
    },
    returns: 'rows',
  },
  batch_members_map: {
    params: {
      p_batch_id: 'uuid', p_status: 'batch_carrier_status[]', p_q: 'text', p_warnings_only: 'boolean', p_min_insurance: 'bigint', p_size_min: 'int',
      p_size_max: 'int', p_has_phone: 'boolean', p_has_email: 'boolean', p_sort: 'text', p_dir: 'text',
    },
    returns: 'rows',
  },
  search_carriers_map: { params: { p_definition: 'jsonb', p_limit: 'int' }, returns: 'rows' },
  generate_contact_sheet: { params: { p_batch_id: 'uuid', p_dots: 'bigint[]' }, returns: 'rows' },
  batch_status_counts: { params: { p_batch_id: 'uuid' }, returns: 'rows' },
  dashboard_totals: { params: {}, returns: 'rows' },
  is_contactable: { params: { p_dot: 'bigint', p_channel: 'contact_channel' }, returns: 'scalar' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['new', 'attempted', 'contacted', 'interested', 'not_a_fit']);
const CHANNELS = new Set(['call', 'text', 'email', 'mail']);

function valid(type: PgType, v: unknown): boolean {
  if (v === null) return true;
  switch (type) {
    case 'jsonb':
      return typeof v === 'object';
    case 'int':
    case 'bigint':
      return typeof v === 'number' && Number.isSafeInteger(v);
    case 'text':
      return typeof v === 'string' && v.length <= 10_000;
    case 'boolean':
      return typeof v === 'boolean';
    case 'uuid':
      return typeof v === 'string' && UUID.test(v);
    case 'bigint[]':
      return Array.isArray(v) && v.length <= 10_000 && v.every((x) => typeof x === 'number' && Number.isSafeInteger(x));
    case 'batch_carrier_status':
      return typeof v === 'string' && STATUSES.has(v);
    case 'batch_carrier_status[]':
      return Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string' && STATUSES.has(x));
    case 'contact_channel':
      return typeof v === 'string' && CHANNELS.has(v);
  }
}

/** Returns the validated arguments (only known names), or undefined if anything is wrong. */
export function validateRpcArgs(name: string, args: unknown): Record<string, unknown> | undefined {
  const spec = Object.prototype.hasOwnProperty.call(RPC_SPECS, name) ? RPC_SPECS[name] : undefined;
  if (!spec || typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const type = spec.params[key];
    if (type === undefined || value === undefined) return undefined;
    if (!valid(type, value)) return undefined;
    out[key] = value;
  }
  return out;
}

/** `public.name(p_a => $1::type, ...)` for the given validated arguments. */
export function rpcCallSql(name: string, args: Record<string, unknown>): { sql: string; params: unknown[] } {
  const spec = RPC_SPECS[name];
  const keys = Object.keys(args);
  const parts = keys.map((k, i) => `${k} => $${i + 1}::${spec.params[k]}`);
  const params = keys.map((k) => (spec.params[k] === 'jsonb' && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
  const call = `public.${name}(${parts.join(', ')})`;
  const sql = spec.returns === 'rows' ? `select * from ${call}` : `select ${call} as value`;
  return { sql, params };
}
