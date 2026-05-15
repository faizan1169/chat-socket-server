"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushToUser = pushToUser;
const supabase_js_1 = require("./supabase.js");
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
async function getTokensForUserIds(userIds) {
    const map = new Map();
    if (!userIds.length)
        return map;
    const { data, error } = await supabase_js_1.supabaseAdmin
        .from('push_tokens')
        .select('user_id, token')
        .in('user_id', userIds);
    if (error) {
        console.error('[push] fetch tokens failed:', error);
        return map;
    }
    for (const row of data ?? []) {
        const list = map.get(row.user_id) ?? [];
        list.push(row.token);
        map.set(row.user_id, list);
    }
    return map;
}
async function sendExpoPush(messages) {
    if (!messages.length)
        return;
    try {
        const res = await fetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Accept-Encoding': 'gzip, deflate',
            },
            body: JSON.stringify(messages),
        });
        if (!res.ok) {
            console.error('[push] expo push http error', res.status, await res.text().catch(() => ''));
            return;
        }
        const json = await res.json().catch(() => null);
        const tickets = Array.isArray(json?.data) ? json.data : [];
        for (let i = 0; i < tickets.length; i++) {
            const t = tickets[i];
            if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
                const token = messages[i]?.to;
                if (token) {
                    await supabase_js_1.supabaseAdmin.from('push_tokens').delete().eq('token', token);
                }
            }
        }
    }
    catch (err) {
        console.error('[push] send failed:', err);
    }
}
async function pushToUser(userId, payload) {
    const map = await getTokensForUserIds([userId]);
    const tokens = map.get(userId) ?? [];
    if (!tokens.length)
        return;
    const messages = tokens.map((t) => ({ ...payload, to: t }));
    await sendExpoPush(messages);
}
//# sourceMappingURL=push.js.map