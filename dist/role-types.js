"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRoleNameFromId = getRoleNameFromId;
const supabase_js_1 = require("./supabase.js");
let cache = null;
let pending = null;
async function loadCache() {
    if (cache)
        return cache;
    if (pending)
        return pending;
    pending = (async () => {
        const { data, error } = await supabase_js_1.supabaseAdmin
            .from('roles')
            .select('id, name')
            .eq('is_system', true)
            .in('name', ['user', 'admin']);
        if (error)
            throw error;
        const byId = new Map();
        const byName = new Map();
        for (const row of (data ?? [])) {
            if (row.name === 'user' || row.name === 'admin') {
                byId.set(row.id, row.name);
                byName.set(row.name, row.id);
            }
        }
        if (!byName.has('user') || !byName.has('admin')) {
            throw new Error('roles is missing the system rows for "user" and/or "admin"');
        }
        const result = { byId, byName };
        cache = result;
        pending = null;
        return result;
    })();
    return pending;
}
async function getRoleNameFromId(id) {
    if (!id)
        return 'user';
    const c = await loadCache();
    return c.byId.get(id) ?? 'user';
}
//# sourceMappingURL=role-types.js.map