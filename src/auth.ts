import type { Socket } from 'socket.io';
import { verifyAccessToken, type AccessPayload } from './tokens.js';
import { parseCookieHeader, COOKIE_ACCESS } from './cookies.js';
import { supabaseAdmin } from './supabase.js';
import { getRoleNameFromId } from './role-types.js';

export interface SocketAuth {
  userId: string;
  username: string;
  role: 'user' | 'admin';
}

function tokenFromHandshake(socket: Socket): string | null {
  const headerAuth = socket.handshake.headers.authorization;
  if (typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')) {
    return headerAuth.slice(7);
  }

  const tokenFromAuth = (socket.handshake.auth as { token?: string } | undefined)?.token;
  if (typeof tokenFromAuth === 'string' && tokenFromAuth.length > 0) {
    return tokenFromAuth;
  }

  const cookieHeader = socket.handshake.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookieHeader(cookieHeader);
    const t = cookies[COOKIE_ACCESS];
    if (t) return t;
  }
  return null;
}

export async function authenticateSocket(socket: Socket): Promise<SocketAuth | null> {
  const token = tokenFromHandshake(socket);
  if (!token) return null;

  let payload: AccessPayload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    return null;
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, username, role, is_disabled')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!user || user.is_disabled) return null;

  return {
    userId: user.id,
    username: user.username,
    role: await getRoleNameFromId(user.role),
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

const socketBuckets = new Map<string, Bucket>();

export function socketRateLimit(
  socketId: string,
  scope: string,
  limit: number,
  windowMs: number,
): boolean {
  const key = `${scope}:${socketId}`;
  const now = Date.now();
  const existing = socketBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    socketBuckets.set(key, { count: 1, resetAt: now + windowMs });
    if (socketBuckets.size > 10000) {
      socketBuckets.forEach((b, k) => {
        if (b.resetAt <= now) socketBuckets.delete(k);
      });
    }
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}
