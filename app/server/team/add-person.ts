// Add a person (Task D; D8 approved 2026-10-22). A manager adds a staff member by name, email and
// role, with an optional mobile number that is stored UNVERIFIED and never used for sign-in or
// recovery (SMS is not built). Nothing is emailed: the person requests a sign-in link themselves.
//
// Authorization lives in the database (public.team_add_person, supabase/pending/M1b_add_person.sql):
// manager, link session only, roster lock first, duplicate addresses refused, audited. This module
// only shapes the request (normalization and fixed validation errors) and maps the outcome.
// Recovery sessions never reach it: /api/team/add is not in the recovery matrix (default deny).

import type { Tx } from '../db/database';
import { RefusedError, type AppResponse } from '../core/types';

export const ADD_PERSON_PATH = '/api/team/add';

export const ADDABLE_ROLES = ['manager', 'edit', 'view'] as const;
export type AddableRole = (typeof ADDABLE_ROLES)[number];

export interface AddPersonInput {
  fullName: string;
  /** Lower-cased and trimmed. */
  email: string;
  role: AddableRole;
  /** E.164 (+15551234567) or null. UNVERIFIED. */
  mobile: string | null;
}

export interface AddPersonStore {
  teamAddPerson(s: string, input: AddPersonInput): Promise<string>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * A mobile as typed by a manager -> E.164, or null when blank. US numbers may be typed with or
 * without +1 and with spaces, dashes, dots or brackets; anything else must already start with +.
 */
export function normalizeMobile(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new RefusedError('invalid');
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[+0-9 ().-]+$/.test(trimmed)) throw new RefusedError('invalid');
  const digits = trimmed.replace(/[^0-9]/g, '');
  let e164: string;
  if (trimmed.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else throw new RefusedError('invalid');
  if (!E164.test(e164)) throw new RefusedError('invalid');
  return e164;
}

/** Validates and normalizes the request body. Every problem is the same fixed refusal. */
export function parseAddPerson(body: unknown): AddPersonInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RefusedError('invalid');
  const b = body as Record<string, unknown>;
  const fullName = typeof b.full_name === 'string' ? b.full_name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const role = b.role;
  if (fullName === '' || fullName.length > 200) throw new RefusedError('invalid');
  if (email.length > 320 || !EMAIL.test(email)) throw new RefusedError('invalid');
  if (typeof role !== 'string' || !(ADDABLE_ROLES as readonly string[]).includes(role)) throw new RefusedError('invalid');
  return { fullName, email, role: role as AddableRole, mobile: normalizeMobile(b.mobile) };
}

/** The route: 201 with the new id; duplicates and invalid input are 409 (fixed codes). */
export async function handleAddPerson(body: unknown, s: string, store: AddPersonStore, json: (status: number, payload: unknown) => AppResponse): Promise<AppResponse> {
  const input = parseAddPerson(body);
  const id = await store.teamAddPerson(s, input);
  return json(201, { id });
}

/** The database call, inside the caller's session transaction. */
export async function teamAddPersonSql(tx: Tx, input: AddPersonInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>('select public.team_add_person($1, $2, $3::user_role, $4) as id', [input.fullName, input.email, input.role, input.mobile]);
  return rows[0].id;
}
