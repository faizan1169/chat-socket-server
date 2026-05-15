import { jwtVerify, type JWTPayload } from 'jose';
import { env } from './env.js';

const accessSecret = new TextEncoder().encode(env.jwtSecret);

export type UserRole = 'user' | 'admin';

export interface AccessPayload extends JWTPayload {
  sub: string;
  username: string;
  role?: UserRole;
  type: 'access';
}

export async function verifyAccessToken(token: string): Promise<AccessPayload> {
  const { payload } = await jwtVerify(token, accessSecret);
  if (payload.type !== 'access') throw new Error('Invalid token type');
  return payload as AccessPayload;
}
