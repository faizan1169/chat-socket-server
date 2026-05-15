import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';
import { env } from './env.js';

export const supabaseAdmin: SupabaseClient = createClient(
  env.supabaseUrl,
  env.supabaseServiceKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    global: { headers: { 'x-client-info': 'nexchat-socket-server' } },
    realtime: { transport: ws as unknown as any },
  },
);
