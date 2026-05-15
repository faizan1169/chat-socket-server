import { supabaseAdmin } from './supabase.js';

export type RoleName = 'user' | 'admin';

interface RoleRow {
  id: string;
  name: string;
}

interface RoleCache {
  byId: Map<string, RoleName>;
  byName: Map<RoleName, string>;
}

let cache: RoleCache | null = null;
let pending: Promise<RoleCache> | null = null;

async function loadCache(): Promise<RoleCache> {
  if (cache) return cache;
  if (pending) return pending;
  pending = (async () => {
    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id, name')
      .eq('is_system', true)
      .in('name', ['user', 'admin']);
    if (error) throw error;
    const byId = new Map<string, RoleName>();
    const byName = new Map<RoleName, string>();
    for (const row of (data ?? []) as RoleRow[]) {
      if (row.name === 'user' || row.name === 'admin') {
        byId.set(row.id, row.name);
        byName.set(row.name, row.id);
      }
    }
    if (!byName.has('user') || !byName.has('admin')) {
      throw new Error('roles is missing the system rows for "user" and/or "admin"');
    }
    const result: RoleCache = { byId, byName };
    cache = result;
    pending = null;
    return result;
  })();
  return pending;
}

export async function getRoleNameFromId(id: string | null | undefined): Promise<RoleName> {
  if (!id) return 'user';
  const c = await loadCache();
  return c.byId.get(id) ?? 'user';
}
