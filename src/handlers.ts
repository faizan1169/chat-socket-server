/**
 * Socket.IO event handlers for NexChat. Ported from the original
 * Next.js pages/api/socket.ts so behaviour stays identical — only the
 * runtime/transport changed (Vercel serverless → standalone Node).
 */
import type { Server as ServerIO, Socket } from 'socket.io';
import { authenticateSocket, socketRateLimit, type SocketAuth } from './auth.js';
import { supabaseAdmin } from './supabase.js';
import { pushToUser } from './push.js';

function previewForMessage(data: any): string {
  if (data?.isVoiceMessage) return '🎤 Voice message';
  if (data?.file?.type?.startsWith?.('image/') || data?.file?.isImage) return '📷 Photo';
  if (data?.file?.filename) return `📎 ${data.file.filename}`;
  const text = typeof data?.message === 'string' ? data.message : '';
  if (!text) return 'New message';
  return text.length > 120 ? text.slice(0, 117) + '…' : text;
}

function previewForStoredMessage(row: {
  content?: string | null;
  is_voice_message?: boolean | null;
  file?: any;
}): string {
  if (row?.is_voice_message) return '🎤 Voice message';
  const f = row?.file;
  if (f?.type?.startsWith?.('image/') || f?.isImage) return '📷 Photo';
  if (f?.filename) return `📎 ${f.filename}`;
  const text = typeof row?.content === 'string' ? row.content : '';
  if (!text) return '';
  return text.length > 80 ? text.slice(0, 77) + '…' : text;
}

const MAX_MESSAGE_LENGTH = 5000;
export const USER_ROOM = (username: string) => `user:${username}`;

interface SocketData {
  auth: SocketAuth;
}
type AppSocket = Socket<
  Record<string, (...args: any[]) => void>,
  Record<string, (...args: any[]) => void>,
  Record<string, (...args: any[]) => void>,
  SocketData
>;

// Module-level presence + active-call maps. Survive across connections within
// the single Node process. (For multi-instance deploys, swap to a Redis
// adapter — see README.)
export const onlineUsers = new Map<string, number>();
export const activeCalls = new Map<string, string>();

export const isUserConnected = (username: string) => onlineUsers.has(username);

const onlineMapForClient = (): Record<string, true> => {
  const out: Record<string, true> = {};
  onlineUsers.forEach((_, name) => {
    out[name] = true;
  });
  return out;
};

const userOnline = (username: string) => {
  onlineUsers.set(username, (onlineUsers.get(username) ?? 0) + 1);
};

const userOffline = (username: string) => {
  const next = (onlineUsers.get(username) ?? 1) - 1;
  if (next <= 0) onlineUsers.delete(username);
  else onlineUsers.set(username, next);
};

const clearCallPair = (a?: string, b?: string) => {
  if (a) activeCalls.delete(a);
  if (b) activeCalls.delete(b);
};

function buildCallPreview(callType: string, callStatus: string, durationSec: number) {
  const kind = callType === 'video' ? 'video' : 'voice';
  if (callStatus === 'completed') {
    const mm = Math.floor(durationSec / 60).toString().padStart(2, '0');
    const ss = Math.floor(durationSec % 60).toString().padStart(2, '0');
    return `${kind === 'video' ? 'Video' : 'Voice'} call · ${mm}:${ss}`;
  }
  if (callStatus === 'missed') return `Missed ${kind} call`;
  if (callStatus === 'rejected') return `Declined ${kind} call`;
  if (callStatus === 'canceled') return `Canceled ${kind} call`;
  return `${kind === 'video' ? 'Video' : 'Voice'} call`;
}

async function isParticipant(userId: string, conversationId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

async function getOrCreateConversation(
  fromUserId: string,
  toUserId: string,
): Promise<{ id: string; wasCreated: boolean } | null> {
  if (fromUserId === toUserId) {
    const { data: myConvIds } = await supabaseAdmin
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', fromUserId);
    const candidateIds = (myConvIds ?? []).map((r) => r.conversation_id);
    if (candidateIds.length) {
      const { data: allRows } = await supabaseAdmin
        .from('conversation_participants')
        .select('conversation_id, user_id')
        .in('conversation_id', candidateIds);
      const counts = new Map<string, number>();
      (allRows ?? []).forEach((r) => {
        counts.set(r.conversation_id, (counts.get(r.conversation_id) ?? 0) + 1);
      });
      const soloIds = Array.from(counts.entries())
        .filter(([, c]) => c === 1)
        .map(([id]) => id);
      if (soloIds.length) {
        const { data: solo } = await supabaseAdmin
          .from('conversations')
          .select('id')
          .in('id', soloIds)
          .eq('is_admin_thread', false)
          .limit(1)
          .maybeSingle();
        if (solo?.id) return { id: solo.id as string, wasCreated: false };
      }
    }
    const { data: newSolo } = await supabaseAdmin
      .from('conversations')
      .insert({ is_group: false, is_admin_thread: false })
      .select('id')
      .single();
    if (!newSolo) return null;
    await supabaseAdmin
      .from('conversation_participants')
      .insert([{ user_id: fromUserId, conversation_id: newSolo.id }]);
    return { id: newSolo.id, wasCreated: true };
  }

  const { data: participants } = await supabaseAdmin
    .from('conversation_participants')
    .select('conversation_id')
    .in('user_id', [fromUserId, toUserId]);

  if (participants?.length) {
    const convCounts: Record<string, number> = {};
    participants.forEach((p) => {
      convCounts[p.conversation_id] = (convCounts[p.conversation_id] || 0) + 1;
    });
    const sharedIds = Object.entries(convCounts)
      .filter(([, c]) => c === 2)
      .map(([id]) => id);

    if (sharedIds.length) {
      // Only reuse a regular (user-mode) thread here. Admin-mode threads are
      // owned by the admin send-as-admin flow and stay separate.
      const { data: userThread } = await supabaseAdmin
        .from('conversations')
        .select('id')
        .in('id', sharedIds)
        .eq('is_admin_thread', false)
        .limit(1)
        .maybeSingle();
      if (userThread?.id) return { id: userThread.id as string, wasCreated: false };
    }
  }

  const { data: newConv } = await supabaseAdmin
    .from('conversations')
    .insert({ is_group: false, is_admin_thread: false })
    .select('id')
    .single();

  if (!newConv) return null;
  await supabaseAdmin.from('conversation_participants').insert([
    { user_id: fromUserId, conversation_id: newConv.id },
    { user_id: toUserId, conversation_id: newConv.id },
  ]);
  return { id: newConv.id, wasCreated: true };
}

async function buildConversationPayload(conversationId: string) {
  const { data: conv } = await supabaseAdmin
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv) return null;

  const { data: partRows } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id, is_admin, joined_at, left_at')
    .eq('conversation_id', conversationId);
  const rows = partRows || [];
  const userIds = rows.map((p: any) => p.user_id);
  const { data: usersData } = userIds.length
    ? await supabaseAdmin.from('users').select('id, username, avatar').in('id', userIds)
    : { data: [] as Array<{ id: string; username: string; avatar: string | null }> };
  const usersById = new Map<string, { id: string; username: string; avatar: string | null }>();
  (usersData || []).forEach((u: any) => usersById.set(u.id, u));
  const participants = rows
    .map((r: any) => {
      const u = usersById.get(r.user_id);
      if (!u) return null;
      return {
        user: u,
        isAdmin: !!r.is_admin,
        joinedAt: r.joined_at,
        leftAt: r.left_at ?? null,
      };
    })
    .filter((x): x is { user: any; isAdmin: boolean; joinedAt: any; leftAt: any } => !!x);

  const { data: lastMsg } = await supabaseAdmin
    .from('messages')
    .select('*, sender:users(id, username, avatar)')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    id: conv.id,
    name: conv.name,
    isGroup: conv.is_group,
    isAdminThread: !!conv.is_admin_thread,
    adminId: conv.admin_id || null,
    avatar: conv.avatar || null,
    about: conv.about || null,
    onlyAdminCanSend: !!conv.only_admin_can_send,
    createdBy: conv.created_by || null,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    participants,
    messages: lastMsg ? [lastMsg] : [],
    state: {
      archived: false,
      locked: false,
      muted: false,
      favorite: false,
      useAccountPassword: false,
    },
    hasBlockedParticipant: false,
    iAmBlockedByParticipant: false,
  };
}

export function registerHandlers(io: ServerIO) {
  // Authenticate every socket connection from the access-token cookie /
  // Authorization header. Reject the handshake if the token is missing,
  // expired, or the user is disabled.
  io.use(async (socket, next) => {
    try {
      const auth = await authenticateSocket(socket);
      if (!auth) {
        const hasAuthToken = !!(socket.handshake.auth as { token?: string } | undefined)?.token;
        const hasAuthHeader = typeof socket.handshake.headers.authorization === 'string';
        const hasCookie = !!socket.handshake.headers.cookie;
        console.warn(
          `[socket] auth rejected from ${socket.handshake.address} ` +
            `(authToken=${hasAuthToken} header=${hasAuthHeader} cookie=${hasCookie})`,
        );
        return next(new Error('UNAUTHORIZED'));
      }
      (socket as AppSocket).data.auth = auth;
      next();
    } catch (err) {
      console.error('[socket] auth middleware error', err);
      next(new Error('UNAUTHORIZED'));
    }
  });

  // Reject events that try to spoof the sender. The socket's identity comes
  // from the verified JWT, not from the client payload.
  const isSenderValid = (socket: AppSocket, claimedFrom?: unknown): boolean => {
    if (!socket.data.auth) return false;
    if (typeof claimedFrom !== 'string') return true;
    return claimedFrom.trim() === socket.data.auth.username;
  };

  const limit = (socket: AppSocket, scope: string, max: number, windowMs: number) =>
    socketRateLimit(socket.id, scope, max, windowMs);

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AppSocket;
    const auth = socket.data.auth;

    // Auto-join the per-user room. Multi-tab/multi-device users get one
    // logical destination, no manual socket-id bookkeeping required.
    socket.join(USER_ROOM(auth.username));
    userOnline(auth.username);
    io.emit('joined', onlineMapForClient());
    console.log(`[socket] connect ${auth.username} (${socket.id}) online=${onlineUsers.size}`);

    socket.on('join-user', () => {
      socket.join(USER_ROOM(auth.username));
      io.emit('joined', onlineMapForClient());
    });

    socket.on('disconnect', (reason) => {
      const peer = activeCalls.get(auth.username);
      if (peer) {
        io.to(USER_ROOM(peer)).emit('call-ended', {
          from: auth.username,
          to: peer,
          reason: 'peer_disconnected',
        });
        clearCallPair(auth.username, peer);
      }
      userOffline(auth.username);
      io.emit('joined', onlineMapForClient());
      console.log(`[socket] disconnect ${auth.username} (${socket.id}) reason=${reason} online=${onlineUsers.size}`);
    });

    socket.on('send-message', async (data, callback) => {
      if (!limit(socket, 'send-message', 30, 10_000)) {
        if (callback) callback({ status: 'error', message: 'Rate limit exceeded' });
        return;
      }

      const {
        to,
        from,
        message,
        id,
        timestamp,
        status,
        isVoiceMessage,
        audioUrl,
        audioDuration,
      } = data || {};

      if (!from) {
        if (callback) callback({ status: 'error', message: 'Missing sender' });
        return;
      }
      if (!isSenderValid(socket, from)) {
        if (callback) callback({ status: 'error', message: 'Sender mismatch' });
        return;
      }
      if (typeof message === 'string' && message.length > MAX_MESSAGE_LENGTH) {
        if (callback) callback({ status: 'error', message: 'Message too long' });
        return;
      }

      const cleanFrom = String(from).trim();
      const rawTo = typeof to === 'string' ? to.trim() : '';
      const isGroupPlaceholder = rawTo.startsWith('__group:');
      const cleanTo = isGroupPlaceholder ? '' : rawTo;
      const clientConvIdRaw: string | undefined =
        (data as any).conversation_id || (data as any).conversationId;
      if (!cleanTo && !clientConvIdRaw) {
        if (callback) callback({ status: 'error', message: 'Missing recipient or conversation' });
        return;
      }

      try {
        const fromUserRes = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('username', cleanFrom)
          .single();
        const fromUser = fromUserRes.data;
        let toUser: { id: string } | null = null;
        if (cleanTo) {
          const toUserRes = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('username', cleanTo)
            .single();
          toUser = toUserRes.data;
        }

        if (!fromUser) {
          if (callback) callback({ status: 'error', message: 'User not found' });
          return;
        }
        if (cleanTo && !toUser) {
          if (callback) callback({ status: 'error', message: 'User not found' });
          return;
        }
        if (fromUser.id !== auth.userId) {
          if (callback) callback({ status: 'error', message: 'Sender mismatch' });
          return;
        }

        const clientConvId: string | undefined = clientConvIdRaw;
        let convId: string;
        let createdNew = false;
        let convRow: { id: string; is_group: boolean; only_admin_can_send: boolean | null } | null = null;
        if (clientConvId) {
          const { data: existing } = await supabaseAdmin
            .from('conversations')
            .select('id, is_group, only_admin_can_send')
            .eq('id', clientConvId)
            .maybeSingle();
          if (!existing) {
            if (callback) callback({ status: 'error', message: 'Conversation not found' });
            return;
          }
          if (!(await isParticipant(fromUser.id, existing.id))) {
            if (callback) callback({ status: 'error', message: 'Not a participant' });
            return;
          }
          convId = existing.id as string;
          convRow = existing as any;
        } else {
          if (!toUser) {
            if (callback) callback({ status: 'error', message: 'Conversation required' });
            return;
          }
          const convResult = await getOrCreateConversation(fromUser.id, toUser.id);
          if (!convResult) {
            if (callback) callback({ status: 'error', message: 'Failed to create conversation' });
            return;
          }
          convId = convResult.id;
          createdNew = convResult.wasCreated;
        }

        if (convRow?.is_group && convRow.only_admin_can_send) {
          const { data: senderMember } = await supabaseAdmin
            .from('conversation_participants')
            .select('is_admin, left_at')
            .eq('conversation_id', convId)
            .eq('user_id', fromUser.id)
            .maybeSingle();
          if (!senderMember || senderMember.left_at || !senderMember.is_admin) {
            if (callback) callback({ status: 'error', message: 'Only admins can send messages in this group' });
            return;
          }
        }

        await supabaseAdmin.from('messages').upsert(
          {
            id,
            conversation_id: convId,
            sender_id: fromUser.id,
            content: message || '',
            timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
            status: status || 'sent',
            is_voice_message: !!isVoiceMessage,
            audio_url: audioUrl || null,
            audio_duration: audioDuration ?? null,
            is_edited: !!data.isEdited,
            is_deleted: !!data.isDeleted,
            is_pinned: !!data.isPinned,
            reply_to: data.replyTo || null,
            file: data.file || null,
            group_id: data.groupId || null,
            chunk_index: data.chunkIndex ?? null,
            total_chunks: data.totalChunks ?? null,
          },
          { onConflict: 'id' },
        );

        const enriched = { ...data, conversation_id: convId, conversationId: convId };

        const { data: convParticipants } = await supabaseAdmin
          .from('conversation_participants')
          .select('user_id, left_at, users:users(id, username)')
          .eq('conversation_id', convId);
        const activeUsernames = (convParticipants || [])
          .filter((p: any) => !p.left_at && p.users?.username)
          .map((p: any) => p.users.username as string);

        if (createdNew) {
          const convPayload = await buildConversationPayload(convId);
          if (convPayload) {
            const recipients = activeUsernames.length
              ? activeUsernames
              : Array.from(new Set([cleanTo, cleanFrom]));
            recipients.forEach((uname) => {
              io.to(USER_ROOM(uname)).emit('new-conversation', convPayload);
            });
          }
        }

        const recipientOnline = cleanTo ? isUserConnected(cleanTo) : false;

        if (convRow?.is_group) {
          activeUsernames.forEach((uname) => {
            io.to(USER_ROOM(uname)).emit('receive-message', enriched);
          });
        } else {
          if (recipientOnline) {
            io.to(USER_ROOM(cleanTo)).emit('receive-message', enriched);
          }
          if (cleanFrom !== cleanTo) {
            io.to(USER_ROOM(cleanFrom)).emit('receive-message', enriched);
          }
        }

        if (!convRow?.is_group && toUser && !recipientOnline && cleanFrom !== cleanTo) {
          void pushToUser(toUser.id, {
            title: cleanFrom,
            body: previewForMessage(data),
            sound: 'default',
            channelId: 'default',
            priority: 'high',
            data: {
              type: 'message',
              conversationId: convId,
              messageId: id,
              from: cleanFrom,
            },
          });
        }

        if (
          recipientOnline &&
          cleanFrom !== cleanTo &&
          (status || 'sent') !== 'read'
        ) {
          io.to(USER_ROOM(cleanFrom)).emit('message-status-update', {
            messageId: id,
            status: 'delivered',
          });
          supabaseAdmin
            .from('messages')
            .update({ status: 'delivered' })
            .eq('id', id)
            .then(({ error }) => {
              if (error) console.error('[socket] mark-delivered persist failed:', error);
            });
        }

        if (callback) callback({ status: 'ok', id: data.id, conversation_id: convId });
      } catch (error) {
        console.error('[socket] send-message error:', error);
        if (callback) callback({ status: 'error', message: 'Failed to process message' });
      }
    });

    socket.on('delete-message', async ({ id, to }) => {
      if (!limit(socket, 'delete-message', 20, 10_000)) return;
      try {
        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('timestamp, sender_id')
          .eq('id', id)
          .single();
        if (!msg) return;
        if (auth.role !== 'admin') {
          if (msg.sender_id !== auth.userId) return;
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
          if (new Date(msg.timestamp) < oneHourAgo) return;
        }

        await supabaseAdmin
          .from('messages')
          .update({ is_deleted: true, content: '', audio_url: null })
          .eq('id', id);

        if (typeof to === 'string') io.to(USER_ROOM(to)).emit('delete-message', { id });
      } catch (error) {
        console.error('[socket] delete-message error:', error);
      }
    });

    /* ─── WebRTC signalling ─────────────────────────────────────────── */
    socket.on('offer', (payload) => {
      if (!limit(socket, 'offer', 30, 10_000)) return;
      if (!isSenderValid(socket, payload?.from) || !payload?.to) return;
      activeCalls.set(payload.from, payload.to);
      activeCalls.set(payload.to, payload.from);
      io.to(USER_ROOM(payload.to)).emit('offer', payload);

      const callType: 'audio' | 'video' =
        payload?.callType === 'video' || payload?.isVideo ? 'video' : 'audio';
      void (async () => {
        try {
          const { data: callee } = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('username', String(payload.to).trim())
            .maybeSingle();
          if (!callee?.id) return;
          await pushToUser(callee.id, {
            title: `Incoming ${callType === 'video' ? 'video' : 'voice'} call`,
            body: payload.from,
            sound: 'default',
            channelId: 'calls',
            priority: 'high',
            ttl: 30,
            data: {
              type: 'call',
              callType,
              from: payload.from,
              to: payload.to,
            },
          });
        } catch (e) {
          console.error('[socket] call push failed:', e);
        }
      })();
    });

    socket.on('answer', (payload) => {
      if (!limit(socket, 'answer', 30, 10_000)) return;
      if (!isSenderValid(socket, payload?.from) || !payload?.to) return;
      activeCalls.set(payload.from, payload.to);
      activeCalls.set(payload.to, payload.from);
      io.to(USER_ROOM(payload.to)).emit('answer', payload);
    });

    socket.on('icecandidate', (payload) => {
      if (!limit(socket, 'icecandidate', 200, 10_000)) return;
      if (!payload?.to) return;
      io.to(USER_ROOM(payload.to)).emit('icecandidate', payload.candidate);
    });

    socket.on('call-ended', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      clearCallPair(payload.from, payload.to);
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('call-ended', payload);
    });

    socket.on('call-rejected', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      clearCallPair(payload.from, payload.to);
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('call-rejected', payload);
    });

    socket.on('call-missed', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      clearCallPair(payload.from, payload.to);
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('call-missed', payload);
    });

    socket.on('call-upgrade-request', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('call-upgrade-request', payload);
    });

    socket.on('call-upgrade-accept', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('call-upgrade-accept', payload);
    });

    socket.on('call-upgrade-reject', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('call-upgrade-reject', payload);
    });

    socket.on('renegotiate-offer', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('renegotiate-offer', payload);
    });

    socket.on('renegotiate-answer', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('renegotiate-answer', payload);
    });

    socket.on('block-status', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('block-status', payload);
    });

    socket.on('mute-status', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('mute-status', payload);
    });

    socket.on('typing', (payload) => {
      if (!limit(socket, 'typing', 60, 10_000)) return;
      if (!payload?.to || !payload?.from) return;
      if (!isSenderValid(socket, payload.from)) return;
      io.to(USER_ROOM(payload.to)).emit('typing', {
        from: payload.from,
        conversationId: payload.conversationId,
        isTyping: !!payload.isTyping,
      });
    });

    socket.on('camera-facing', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (payload?.to) io.to(USER_ROOM(payload.to)).emit('camera-facing', payload);
    });

    socket.on('log-call', async (payload, callback) => {
      if (!limit(socket, 'log-call', 30, 60_000)) {
        if (callback) callback({ status: 'error', message: 'Rate limit exceeded' });
        return;
      }
      try {
        const { from, to, callType, callStatus, callDuration } = payload || {};
        if (!from || !to || !callType || !callStatus) {
          if (callback) callback({ status: 'error', message: 'Missing fields' });
          return;
        }
        if (!isSenderValid(socket, from)) {
          if (callback) callback({ status: 'error', message: 'Sender mismatch' });
          return;
        }

        const tFrom = String(from).trim();
        const tTo = String(to).trim();

        const [{ data: fromUser }, { data: toUser }] = await Promise.all([
          supabaseAdmin.from('users').select('id').eq('username', tFrom).single(),
          supabaseAdmin.from('users').select('id').eq('username', tTo).single(),
        ]);

        if (!fromUser || !toUser || fromUser.id !== auth.userId) {
          if (callback) callback({ status: 'error', message: 'User not found' });
          return;
        }

        const convResult = await getOrCreateConversation(fromUser.id, toUser.id);
        if (!convResult) {
          if (callback) callback({ status: 'error', message: 'Failed to resolve conversation' });
          return;
        }

        const duration = Math.max(0, Math.floor(Number(callDuration) || 0));
        const preview = buildCallPreview(callType, callStatus, duration);
        const endedAt = new Date();
        const startedAt = new Date(endedAt.getTime() - duration * 1000);

        const { data: callRow, error: callsError } = await supabaseAdmin
          .from('calls')
          .insert({
            conversation_id: convResult.id,
            caller_id: fromUser.id,
            callee_id: toUser.id,
            call_type: callType,
            call_status: callStatus,
            duration_seconds: duration,
            started_at: startedAt.toISOString(),
            ended_at: endedAt.toISOString(),
          })
          .select('*')
          .single();

        if (callsError || !callRow) {
          console.error('[socket] log-call insert failed:', callsError);
          if (callback) callback({ status: 'error', message: 'Failed to save call record' });
          return;
        }

        const broadcast = {
          id: callRow.id,
          conversationId: convResult.id,
          conversation_id: convResult.id,
          from,
          to,
          message: preview,
          content: preview,
          timestamp: callRow.ended_at,
          status: 'sent',
          callType,
          callStatus,
          callDuration: duration,
          isCallLog: true,
        };

        io.to(USER_ROOM(tTo)).emit('receive-message', broadcast);
        io.to(USER_ROOM(tFrom)).emit('receive-message', broadcast);

        if (callback) callback({ status: 'ok', id: callRow.id });
      } catch (err) {
        console.error('[socket] log-call error:', err);
        if (callback) callback({ status: 'error', message: 'Internal error' });
      }
    });

    socket.on('mark-delivered', async ({ messageId, to }) => {
      if (!limit(socket, 'mark-status', 200, 10_000)) return;
      try {
        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('conversation_id, sender_id')
          .eq('id', messageId)
          .maybeSingle();
        if (!msg) return;
        if (msg.sender_id === auth.userId) return;
        if (!(await isParticipant(auth.userId, msg.conversation_id))) return;

        await supabaseAdmin.from('messages').update({ status: 'delivered' }).eq('id', messageId);
        if (typeof to === 'string') {
          io.to(USER_ROOM(to)).emit('message-status-update', { messageId, status: 'delivered' });
        }
      } catch (e) {
        console.error('[socket] mark-delivered failed:', e);
      }
    });

    socket.on('mark-read', async ({ messageId, to }) => {
      if (!limit(socket, 'mark-status', 200, 10_000)) return;
      try {
        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('conversation_id, sender_id')
          .eq('id', messageId)
          .maybeSingle();
        if (!msg) return;
        if (msg.sender_id === auth.userId) return;
        if (!(await isParticipant(auth.userId, msg.conversation_id))) return;

        await supabaseAdmin.from('messages').update({ status: 'read' }).eq('id', messageId);
        if (typeof to === 'string') {
          io.to(USER_ROOM(to)).emit('message-status-update', { messageId, status: 'read' });
        }
      } catch (e) {
        console.error('[socket] mark-read failed:', e);
      }
    });

    socket.on('edit-message', async ({ id, to, message }) => {
      if (!limit(socket, 'edit-message', 30, 10_000)) return;
      try {
        if (!id || !to) return;
        if (typeof message === 'string' && message.length > MAX_MESSAGE_LENGTH) return;

        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('sender_id')
          .eq('id', id)
          .maybeSingle();
        if (!msg) return;
        if (msg.sender_id !== auth.userId && auth.role !== 'admin') return;

        io.to(USER_ROOM(String(to))).emit('message-edited', { id, message });
      } catch (e) {
        console.error('[socket] edit-message failed:', e);
      }
    });

    socket.on('pin-message', async ({ id, isPinned, to }) => {
      if (!limit(socket, 'pin-message', 30, 10_000)) return;
      try {
        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('conversation_id')
          .eq('id', id)
          .maybeSingle();
        if (!msg) return;
        if (auth.role !== 'admin' && !(await isParticipant(auth.userId, msg.conversation_id))) return;

        await supabaseAdmin.from('messages').update({ is_pinned: !!isPinned }).eq('id', id);
        if (typeof to === 'string') {
          io.to(USER_ROOM(to)).emit('pin-message', { id, isPinned });
        }
      } catch (e) {
        console.error('[socket] pin-message failed:', e);
      }
    });

    socket.on('react-message', async ({ id, emoji, to }) => {
      if (!limit(socket, 'react-message', 60, 10_000)) return;
      if (typeof id !== 'string' || !id) return;
      if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 16) return;
      try {
        const { data: msg } = await supabaseAdmin
          .from('messages')
          .select('conversation_id, reactions, sender_id, content, file, is_voice_message')
          .eq('id', id)
          .maybeSingle();
        if (!msg) return;
        if (auth.role !== 'admin' && !(await isParticipant(auth.userId, msg.conversation_id))) return;

        const current: Record<string, string[]> =
          msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions)
            ? { ...(msg.reactions as Record<string, string[]>) }
            : {};

        for (const key of Object.keys(current)) {
          const list = Array.isArray(current[key]) ? current[key] : [];
          const filtered = list.filter((u) => u !== auth.userId);
          if (filtered.length === 0) delete current[key];
          else current[key] = filtered;
        }

        const existing = Array.isArray(current[emoji]) ? current[emoji] : [];
        const wasReactedWithSame = existing.includes(auth.userId);
        const removed = wasReactedWithSame;
        if (!wasReactedWithSame) {
          current[emoji] = [...existing, auth.userId];
        }

        await supabaseAdmin.from('messages').update({ reactions: current }).eq('id', id);

        socket.emit('message-reacted', { id, reactions: current });

        const cleanTo = typeof to === 'string' ? to.trim() : '';
        if (cleanTo) {
          const messagePreview = previewForStoredMessage(msg);
          const recipientIsMessageOwner =
            !!msg.sender_id && msg.sender_id !== auth.userId;
          io.to(USER_ROOM(cleanTo)).emit('message-reacted', {
            id,
            reactions: current,
            from: auth.username,
            emoji,
            removed,
            conversationId: msg.conversation_id,
            messagePreview,
            ownerIsRecipient: recipientIsMessageOwner,
          });

          if (!removed && recipientIsMessageOwner && !isUserConnected(cleanTo)) {
            const { data: toUser } = await supabaseAdmin
              .from('users')
              .select('id')
              .eq('username', cleanTo)
              .maybeSingle();
            if (toUser?.id) {
              const body = messagePreview
                ? `Reacted ${emoji} to: ${messagePreview}`
                : `Reacted ${emoji} to your message`;
              void pushToUser(toUser.id, {
                title: auth.username,
                body,
                sound: 'default',
                channelId: 'default',
                priority: 'high',
                data: {
                  type: 'reaction',
                  conversationId: msg.conversation_id,
                  messageId: id,
                  emoji,
                  from: auth.username,
                },
              });
            }
          }
        }
      } catch (e) {
        console.error('[socket] react-message failed:', e);
      }
    });

    socket.on('admin-call', (payload) => {
      if (auth.role !== 'admin') return;
      if (!payload?.to) return;
      const target = typeof payload.to === 'string' ? payload.to.trim() : '';
      if (target) io.to(USER_ROOM(target)).emit('admin-call-incoming', payload);
    });

    socket.on('admin-call-response', (payload) => {
      if (!isSenderValid(socket, payload?.from)) return;
      if (!payload?.to) return;
      const target = typeof payload.to === 'string' ? payload.to.trim() : '';
      if (target) io.to(USER_ROOM(target)).emit('admin-call-response', payload);
    });

    socket.on('admin-force-logout', (payload) => {
      if (auth.role !== 'admin') return;
      if (!payload?.to) return;
      const target = typeof payload.to === 'string' ? payload.to.trim() : '';
      if (target) io.to(USER_ROOM(target)).emit('admin-force-logout', payload);
    });

    socket.on('clear-all-messages', async ({ from, to, conversationId }) => {
      if (!isSenderValid(socket, from)) return;
      if (!conversationId) return;
      if (!limit(socket, 'clear-all-messages', 5, 60_000)) return;
      try {
        if (auth.role !== 'admin' && !(await isParticipant(auth.userId, conversationId))) return;

        await supabaseAdmin.from('messages').delete().eq('conversation_id', conversationId);

        if (typeof to === 'string') {
          io.to(USER_ROOM(to)).emit('clear-all-messages', { from, to });
        }
      } catch (e) {
        console.error('[socket] clear-all-messages error:', e);
      }
    });
  });
}
