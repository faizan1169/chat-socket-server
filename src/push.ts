import { supabaseAdmin } from './supabase.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushMessage {
  to: string;
  title?: string;
  body?: string;
  sound?: 'default' | null;
  data?: Record<string, unknown>;
  channelId?: 'default' | 'calls';
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
}

async function getTokensForUserIds(userIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!userIds.length) return map;
  const { data, error } = await supabaseAdmin
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

async function sendExpoPush(messages: PushMessage[]): Promise<void> {
  if (!messages.length) return;
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
    const json: any = await res.json().catch(() => null);
    const tickets = Array.isArray(json?.data) ? json.data : [];
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
        const token = messages[i]?.to;
        if (token) {
          await supabaseAdmin.from('push_tokens').delete().eq('token', token);
        }
      }
    }
  } catch (err) {
    console.error('[push] send failed:', err);
  }
}

export async function pushToUser(
  userId: string,
  payload: Omit<PushMessage, 'to'>,
): Promise<void> {
  const map = await getTokensForUserIds([userId]);
  const tokens = map.get(userId) ?? [];
  if (!tokens.length) return;
  const messages: PushMessage[] = tokens.map((t) => ({ ...payload, to: t }));
  await sendExpoPush(messages);
}
