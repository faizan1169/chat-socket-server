import { createClient, type SupabaseClient } from '@supabase/supabase-js';
<<<<<<< HEAD
import ws from 'ws';
=======
>>>>>>> e10638d (chore: extract socket-server to standalone repo)
import { env } from './env.js';

export const supabaseAdmin: SupabaseClient = createClient(
  env.supabaseUrl,
  env.supabaseServiceKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    global: { headers: { 'x-client-info': 'nexchat-socket-server' } },
<<<<<<< HEAD
    realtime: { transport: ws as unknown as any },
=======
>>>>>>> e10638d (chore: extract socket-server to standalone repo)
  },
);
