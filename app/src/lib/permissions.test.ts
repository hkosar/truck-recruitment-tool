import { describe, expect, it } from 'vitest';
import { can, getPermissions } from './permissions';

describe('role permissions', () => {
  it('keeps managers and editors writable while viewers are read-only', () => {
    expect(getPermissions('manager')).toEqual({ canEdit: true, isManager: true, isViewer: false, isGuest: false });
    expect(getPermissions('edit').canEdit).toBe(true);
    expect(getPermissions('view')).toEqual({ canEdit: false, isManager: false, isViewer: true, isGuest: false });
  });

  it('fails closed for guests and missing profiles', () => {
    expect(getPermissions('guest').canEdit).toBe(false);
    expect(getPermissions(null).isGuest).toBe(true);
    expect(can(undefined, 'manage')).toBe(false);
  });
});
