import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type ParticipantPermission = {
  VIEW: boolean;
  ZOOM_PAN: boolean;
  SLICE_CONTROL: boolean;
  WINDOW_LEVEL: boolean;
  ANNOTATE: boolean;
  EDIT_ANNOTATION: boolean;
  DELETE_ANNOTATION: boolean;
  AI_ANALYSIS: boolean;
  DOWNLOAD: boolean;
};

export const DEFAULT_VIEWER_PERMISSIONS: ParticipantPermission = {
  VIEW: true,
  ZOOM_PAN: false,
  SLICE_CONTROL: false,
  WINDOW_LEVEL: false,
  ANNOTATE: false,
  EDIT_ANNOTATION: false,
  DELETE_ANNOTATION: false,
  AI_ANALYSIS: false,
  DOWNLOAD: false,
};

export const MASTER_PERMISSIONS: ParticipantPermission = {
  VIEW: true,
  ZOOM_PAN: true,
  SLICE_CONTROL: true,
  WINDOW_LEVEL: true,
  ANNOTATE: true,
  EDIT_ANNOTATION: true,
  DELETE_ANNOTATION: true,
  AI_ANALYSIS: true,
  DOWNLOAD: true,
};

export type ViewpointState = {
  sliceIndex: number;
  maxSlices: number;
  plane: "axial" | "coronal" | "sagittal";
  zoom: number;
  pan: { x: number; y: number };
  windowLevel: { lo: number; hi: number };
  overlayVisibility: {
    showBone: boolean;
    showBme: boolean;
    showGradcam: boolean;
    maskOpacity: number;
  };
  selectedCaseId?: string;
  selectedStem?: string;
  selectedRelPath?: string;
};

export type Participant = {
  id: string;
  name: string;
  initials: string;
  role: "MASTER" | "VIEWER";
  connected: boolean;
  joinedAt: string;
  permissions: ParticipantPermission;
  cursor?: { x: number; y: number; plane?: string };
};

export type CollabSession = {
  token: string;
  caseId: string;
  creatorId: string;
  createdAt: string;
  active: boolean;
  masterId: string;
  masterDisconnectedAt?: string | null;
  // Handed only to the team member who created the session. Presenting it is
  // the one thing that makes a socket the host; a user id can be typed by
  // anyone, so it proves nothing.
  hostKey: string;
  viewpoint: ViewpointState;
  participants: Map<string, Participant>;
  // The authoritative mask for each slice opened during this review, keyed
  // `${caseId}::${stem}`. Every edit is applied here and numbered before it
  // is sent out, so all participants apply the same edits in the same order.
  masks: Map<string, SliceMask>;
  pending: Map<
    string,
    {
      ws: WebSocket;
      name: string;
      since: string;
      onMessage?: (raw: any) => void;
      onClose?: () => void;
    }
  >;
  left: { name: string; at: string }[];
};

type SliceMask = { width: number; height: number; labels: Uint8Array; seq: number };

// In-memory store for active sessions
const sessions = new Map<string, CollabSession>();
// Client socket to session mapping
const socketMeta = new Map<WebSocket, { token: string; userId: string }>();
// Every live socket per `${token}::${userId}`. A participant can legitimately
// hold more than one (a second tab, or a reconnect that overlaps the old
// socket's close), so a closing socket must not evict the ones still open.
const activeSockets = new Map<string, Set<WebSocket>>();
// Secret per `${token}::${userId}`, issued when a viewer joins. Data routes use
// it to confirm a request comes from someone actually in the review. Held apart
// from Participant so it can never leak through a participants broadcast.
const participantKeys = new Map<string, string>();

// Built from bytes rather than Buffer#toString("hex"), which does not
// typecheck against this package's @types/node (see generateSessionToken).
function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

/*
 * Masks travel as runs: a flat array of [start, length, label, ...], where
 * start indexes the row-major pixel array. A label mask is mostly long stretches
 * of one value, so this is small, and it carries exact label values - no colour
 * encoding to drift.
 */
const MAX_RUN_NUMBERS = 3_000_000;
const SLICE_ID = /^[A-Za-z0-9_-]{1,120}$/;

function isValidRuns(runs: unknown, pixels: number): runs is number[] {
  if (!Array.isArray(runs) || runs.length % 3 !== 0 || runs.length > MAX_RUN_NUMBERS) return false;
  for (let i = 0; i < runs.length; i += 3) {
    const start = runs[i], len = runs[i + 1], label = runs[i + 2];
    if (!Number.isInteger(start) || !Number.isInteger(len) || !Number.isInteger(label)) return false;
    if (start < 0 || len < 1 || start + len > pixels || label < 0 || label > 3) return false;
  }
  return true;
}

function applyRuns(labels: Uint8Array, runs: number[]) {
  for (let i = 0; i < runs.length; i += 3) labels.fill(runs[i + 2], runs[i], runs[i] + runs[i + 1]);
}

function nonZeroRuns(labels: Uint8Array): number[] {
  const runs: number[] = [];
  let i = 0;
  while (i < labels.length) {
    const v = labels[i];
    let j = i + 1;
    while (j < labels.length && labels[j] === v) j++;
    if (v !== 0) runs.push(i, j - i, v);
    i = j;
  }
  return runs;
}

export function generateSessionToken(): string {
  return "collab_sec_" + randomBytes(16).toString("hex");
}

export function createSession(caseId: string, creatorId: string, creatorName: string): CollabSession {
  const token = generateSessionToken();
  const session: CollabSession = {
    token,
    caseId,
    creatorId,
    createdAt: new Date().toISOString(),
    active: true,
    masterId: creatorId,
    hostKey: randomSecret(),
    viewpoint: {
      sliceIndex: 0,
      maxSlices: 100,
      plane: "axial",
      zoom: 1.0,
      pan: { x: 0, y: 0 },
      windowLevel: { lo: 0, hi: 255 },
      overlayVisibility: {
        showBone: true,
        showBme: true,
        showGradcam: false,
        maskOpacity: 0.5,
      },
    },
    participants: new Map(),
    masks: new Map(),
    pending: new Map(),
    left: [],
  };

  // Add Master participant
  const masterInitials = getInitials(creatorName);
  session.participants.set(creatorId, {
    id: creatorId,
    name: creatorName,
    initials: masterInitials,
    role: "MASTER",
    connected: false,
    joinedAt: new Date().toISOString(),
    permissions: { ...MASTER_PERMISSIONS },
  });

  sessions.set(token, session);
  return session;
}

export type CollabAccess =
  | { ok: true; role: "MASTER" | "VIEWER"; permissions: ParticipantPermission }
  | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Decide whether a request carrying a session token and participant key may
 * read study data right now. Everything has to hold at once: the session is
 * live, the host is in the room, and the key belongs to someone who is still
 * connected - so a copied link or a key kept after leaving opens nothing.
 */
export function checkCollabAccess(token: string, key: string): CollabAccess {
  const session = sessions.get(token);
  if (!session || !session.active) {
    return { ok: false, status: 404, error: "Session not found or ended" };
  }
  if (!session.participants.get(session.masterId)?.connected) {
    return { ok: false, status: 403, error: "The host is not connected" };
  }
  for (const [mapKey, secret] of participantKeys) {
    if (secret !== key || !mapKey.startsWith(`${token}::`)) continue;
    const userId = mapKey.slice(token.length + 2);
    const participant = session.participants.get(userId);
    const live = activeSockets.get(mapKey);
    if (!participant || !participant.connected || !live || live.size === 0) {
      return { ok: false, status: 401, error: "Participant is not connected" };
    }
    return { ok: true, role: participant.role, permissions: participant.permissions };
  }
  return { ok: false, status: 401, error: "Invalid participant key" };
}

export function getSession(token: string): CollabSession | undefined {
  return sessions.get(token);
}

export function validatePermission(
  token: string,
  userId: string,
  permission: keyof ParticipantPermission
): boolean {
  const session = sessions.get(token);
  if (!session || !session.active) return false;
  
  const participant = session.participants.get(userId);
  if (!participant) return false;
  
  if (participant.role === "MASTER") return true;
  return Boolean(participant.permissions[permission]);
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name.slice(0, 2) || "U").toUpperCase();
}

function sanitizeSessionForPublic(session: CollabSession) {
  const participantsList = Array.from(session.participants.values()).map((p) => ({
    id: p.id,
    name: p.name,
    initials: p.initials,
    role: p.role,
    connected: p.connected,
    joinedAt: p.joinedAt,
    permissions: p.permissions,
    cursor: p.cursor,
  }));

  return {
    token: session.token,
    caseId: session.caseId,
    active: session.active,
    createdAt: session.createdAt,
    masterId: session.masterId,
    masterConnected: session.participants.get(session.masterId)?.connected ?? false,
    viewpoint: session.viewpoint,
    participants: participantsList,
    left: session.left,
  };
}

function broadcastToSession(token: string, message: any, excludeWs?: WebSocket) {
  for (const [ws, meta] of socketMeta.entries()) {
    if (meta.token === token && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

function sendJoinRequests(session: CollabSession) {
  const hostSockets = activeSockets.get(`${session.token}::${session.masterId}`);
  if (!hostSockets || hostSockets.size === 0) return;
  const pendingList = Array.from(session.pending.entries()).map(([userId, p]) => ({
    userId,
    name: p.name,
    since: p.since,
  }));
  const payload = JSON.stringify({
    type: "JOIN_REQUESTS",
    pending: pendingList,
  });
  for (const ws of hostSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function completeJoin(
  ws: WebSocket,
  session: CollabSession,
  userId: string,
  userName: string,
  isMaster: boolean
) {
  const token = session.token;
  socketMeta.set(ws, { token, userId });
  const socketKey = `${token}::${userId}`;
  const liveSockets = activeSockets.get(socketKey) ?? new Set<WebSocket>();
  liveSockets.add(ws);
  activeSockets.set(socketKey, liveSockets);

  if (isMaster && session.masterId !== userId) {
    const stale = session.participants.get(session.masterId);
    if (stale && !stale.connected) session.participants.delete(session.masterId);
    session.masterId = userId;
  }
  const role = isMaster ? "MASTER" : "VIEWER";

  let participant = session.participants.get(userId);
  if (!participant) {
    participant = {
      id: userId,
      name: userName,
      initials: getInitials(userName),
      role,
      connected: true,
      joinedAt: new Date().toISOString(),
      permissions: role === "MASTER" ? { ...MASTER_PERMISSIONS } : { ...DEFAULT_VIEWER_PERMISSIONS },
    };
    session.participants.set(userId, participant);
  } else {
    participant.connected = true;
    participant.name = userName;
    participant.initials = getInitials(userName);
    if (isMaster) {
      participant.role = "MASTER";
      participant.permissions = { ...MASTER_PERMISSIONS };
    }
  }

  let participantKey = participantKeys.get(socketKey);
  if (!isMaster && !participantKey) {
    participantKey = randomSecret();
    participantKeys.set(socketKey, participantKey);
  }

  // Notify client of successful connection & initial state
  ws.send(
    JSON.stringify({
      type: "SESSION_JOIN_SUCCESS",
      role: participant.role,
      userId: participant.id,
      permissions: participant.permissions,
      participantKey: isMaster ? undefined : participantKey,
      session: sanitizeSessionForPublic(session),
    })
  );

  const isHostConnected = session.participants.get(session.masterId)?.connected ?? false;
  if (!isMaster && !isHostConnected) {
    ws.send(
      JSON.stringify({
        type: "HOST_OFFLINE",
        error: "The host is not connected. This review link is inactive until they rejoin.",
      })
    );
  }

  // Broadcast updated participant list to everyone in session
  broadcastToSession(token, {
    type: "PARTICIPANTS_UPDATED",
    participants: Array.from(session.participants.values()),
    left: session.left,
    masterConnected: isHostConnected,
  });

  // Handle incoming messages
  ws.on("message", (raw: string) => {
    try {
      const data = JSON.parse(raw.toString());
      const { type } = data;

      if (type === "ADMIT") {
        if (!isMaster) {
          ws.send(JSON.stringify({ type: "ERROR", error: "Only host can admit participants" }));
          return;
        }
        const targetUserId = data.userId;
        const pendingEntry = session.pending.get(targetUserId);
        if (pendingEntry) {
          session.pending.delete(targetUserId);
          if (pendingEntry.onMessage) pendingEntry.ws.off("message", pendingEntry.onMessage);
          if (pendingEntry.onClose) pendingEntry.ws.off("close", pendingEntry.onClose);
          completeJoin(pendingEntry.ws, session, targetUserId, pendingEntry.name, false);
          sendJoinRequests(session);
        }
        return;
      }

      if (type === "DENY") {
        if (!isMaster) {
          ws.send(JSON.stringify({ type: "ERROR", error: "Only host can deny participants" }));
          return;
        }
        const targetUserId = data.userId;
        const pendingEntry = session.pending.get(targetUserId);
        if (pendingEntry) {
          session.pending.delete(targetUserId);
          if (pendingEntry.onMessage) pendingEntry.ws.off("message", pendingEntry.onMessage);
          if (pendingEntry.onClose) pendingEntry.ws.off("close", pendingEntry.onClose);
          pendingEntry.ws.send(
            JSON.stringify({
              type: "ERROR",
              fatal: true,
              reason: "denied",
              error: "The host declined your request",
            })
          );
          pendingEntry.ws.close(4003, "Declined by host");
          sendJoinRequests(session);
        }
        return;
      }

      if (type === "LEAVE") {
        participantKeys.delete(socketKey);
        const p = session.participants.get(userId);
        const leftName = p?.name || userName;
        session.participants.delete(userId);
        session.left.push({ name: leftName, at: new Date().toISOString() });
        if (session.left.length > 20) session.left.shift();
        broadcastToSession(token, {
          type: "PARTICIPANTS_UPDATED",
          participants: Array.from(session.participants.values()),
          left: session.left,
          masterConnected: session.participants.get(session.masterId)?.connected ?? false,
        });
        ws.close(1000, "Left");
        return;
      }

      if (type === "VIEWPOINT_UPDATE") {
        if (!data.viewpoint) return;

        const ownsSessionView = isMaster || participant?.permissions.SLICE_CONTROL || participant?.permissions.ZOOM_PAN;
        const viewpoint = ownsSessionView
          ? (session.viewpoint = { ...session.viewpoint, ...data.viewpoint })
          : { ...session.viewpoint, ...data.viewpoint };

        broadcastToSession(token, {
          type: "VIEWPOINT_UPDATED",
          updatedBy: userId,
          viewpoint,
        }, ws);
      } else if (type === "MASK_JOIN") {
        const { caseId, stem, width, height, base } = data;
        if (!SLICE_ID.test(String(caseId)) || !SLICE_ID.test(String(stem))) return;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_000_000) return;

        const key = `${caseId}::${stem}`;
        let slice = session.masks.get(key);
        if (!slice) {
          const canAnnotate = isMaster || participant?.permissions.ANNOTATE;
          if (!canAnnotate || !isValidRuns(base, width * height)) return;
          slice = { width, height, labels: new Uint8Array(width * height), seq: 0 };
          applyRuns(slice.labels, base);
          session.masks.set(key, slice);
        }

        broadcastToSession(token, {
          type: "MASK_SNAPSHOT",
          caseId, stem,
          width: slice.width,
          height: slice.height,
          seq: slice.seq,
          runs: nonZeroRuns(slice.labels),
        });
      } else if (type === "CURSOR_UPDATE") {
        if (data.cursor && participant) {
          participant.cursor = data.cursor;
          broadcastToSession(token, {
            type: "CURSOR_UPDATED",
            userId,
            name: participant.name,
            initials: participant.initials,
            cursor: data.cursor,
          }, ws);
        }
      } else if (type === "MASK_OP") {
        const canAnnotate = isMaster || participant?.permissions.ANNOTATE;
        if (!canAnnotate) {
          ws.send(JSON.stringify({ type: "ERROR", error: "Permission denied: drawing locked by Master" }));
          return;
        }
        const { caseId, stem, opId, runs } = data;
        const slice = session.masks.get(`${caseId}::${stem}`);
        if (!slice || !isValidRuns(runs, slice.width * slice.height) || typeof opId !== "string") return;

        applyRuns(slice.labels, runs);
        slice.seq += 1;
        broadcastToSession(token, {
          type: "MASK_OP_APPLIED",
          caseId, stem, opId, runs,
          seq: slice.seq,
          userId,
        });
      } else if (type === "PERMISSION_UPDATE") {
        if (!isMaster) {
          ws.send(JSON.stringify({ type: "ERROR", error: "Only Master can update permissions" }));
          return;
        }

        const { targetUserId, permissions } = data;
        const target = session.participants.get(targetUserId);
        if (target && target.role !== "MASTER") {
          target.permissions = {
            ...target.permissions,
            ...permissions,
          };

          broadcastToSession(token, {
            type: "PERMISSION_UPDATED",
            targetUserId,
            permissions: target.permissions,
            participants: Array.from(session.participants.values()),
            left: session.left,
          });
        }
      } else if (type === "REMOVE_USER") {
        if (!isMaster) {
          ws.send(JSON.stringify({ type: "ERROR", error: "Only Master can remove users" }));
          return;
        }

        const { targetUserId } = data;
        if (targetUserId !== session.masterId) {
          session.participants.delete(targetUserId);
          participantKeys.delete(`${token}::${targetUserId}`);

          for (const [sWs, sMeta] of socketMeta.entries()) {
            if (sMeta.token === token && sMeta.userId === targetUserId) {
              sWs.send(JSON.stringify({ type: "USER_REMOVED", reason: "Removed by Master" }));
              sWs.close(4001, "Removed by Master");
              socketMeta.delete(sWs);
            }
          }

          broadcastToSession(token, {
            type: "PARTICIPANTS_UPDATED",
            participants: Array.from(session.participants.values()),
            left: session.left,
          });
        }
      } else if (type === "END_SESSION") {
        if (!isMaster) {
          ws.send(JSON.stringify({ type: "ERROR", error: "Only Master can end session" }));
          return;
        }

        session.active = false;
        broadcastToSession(token, {
          type: "SESSION_ENDED",
          reason: "Session closed by Master",
        });

        // Close all admitted sockets
        for (const [sWs, sMeta] of socketMeta.entries()) {
          if (sMeta.token === token) {
            sWs.close(1000, "Session ended");
            socketMeta.delete(sWs);
          }
        }
        // Close all pending sockets
        for (const [_, p] of session.pending) {
          p.ws.send(JSON.stringify({ type: "SESSION_ENDED", reason: "Session closed by Master" }));
          p.ws.close(1000, "Session ended");
        }
        session.pending.clear();
        sessions.delete(token);
        for (const mapKey of [...participantKeys.keys()]) {
          if (mapKey.startsWith(`${token}::`)) participantKeys.delete(mapKey);
        }
      }
    } catch (err: any) {
      console.error("Collab WS Error parsing message:", err);
    }
  });

  ws.on("close", () => {
    socketMeta.delete(ws);

    const remaining = activeSockets.get(socketKey);
    remaining?.delete(ws);
    if (remaining && remaining.size > 0) return;
    activeSockets.delete(socketKey);

    if (participant) {
      participant.connected = false;
      if (isMaster) {
        session.masterDisconnectedAt = new Date().toISOString();
        for (const [sWs, sMeta] of socketMeta.entries()) {
          if (sMeta.token === token && sMeta.userId !== userId && sWs.readyState === WebSocket.OPEN) {
            sWs.send(
              JSON.stringify({
                type: "HOST_OFFLINE",
                error: "The host left the review session.",
              })
            );
          }
        }
        for (const [_, p] of session.pending) {
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: "JOIN_PENDING", hostConnected: false }));
          }
        }
      } else {
        session.participants.delete(userId);
      }
    }

    broadcastToSession(token, {
      type: "PARTICIPANTS_UPDATED",
      participants: Array.from(session.participants.values()),
      left: session.left,
      masterConnected: session.participants.get(session.masterId)?.connected ?? false,
    });
  });
}

export function initCollaborationWSServer(wss: WebSocketServer) {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    const userId = url.searchParams.get("userId") || `user_${randomBytes(4).toString("hex")}`;
    const userName = url.searchParams.get("userName") || `Dr. ${userId.slice(-4)}`;

    if (!token || !sessions.has(token)) {
      ws.send(JSON.stringify({ type: "ERROR", fatal: true, error: "Invalid or expired collaboration session token" }));
      ws.close(1008, "Invalid session token");
      return;
    }

    const session = sessions.get(token)!;
    if (!session.active) {
      ws.send(JSON.stringify({ type: "ERROR", fatal: true, error: "Session has ended" }));
      ws.close(1008, "Session ended");
      return;
    }

    const presentedHostKey = url.searchParams.get("hostKey") || "";
    const isMaster =
      presentedHostKey.length > 0 &&
      presentedHostKey.length === session.hostKey.length &&
      timingSafeEqual(Buffer.from(presentedHostKey), Buffer.from(session.hostKey));

    if (isMaster) {
      completeJoin(ws, session, userId, userName, true);
      sendJoinRequests(session);
      for (const [sWs, sMeta] of socketMeta.entries()) {
        if (sMeta.token === token && sMeta.userId !== userId && sWs.readyState === WebSocket.OPEN) {
          sWs.send(JSON.stringify({ type: "HOST_BACK" }));
        }
      }
      for (const [_, p] of session.pending) {
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({ type: "JOIN_PENDING", hostConnected: true }));
        }
      }
      return;
    }

    const socketKey = `${token}::${userId}`;
    const presentedRejoinKey = url.searchParams.get("rejoinKey") || "";
    const existingKey = participantKeys.get(socketKey);
    const isValidRejoin = Boolean(
      presentedRejoinKey &&
      existingKey &&
      presentedRejoinKey.length === existingKey.length &&
      timingSafeEqual(Buffer.from(presentedRejoinKey), Buffer.from(existingKey))
    );

    if (isValidRejoin) {
      completeJoin(ws, session, userId, userName, false);
      return;
    }

    if (session.pending.size >= 20 && !session.pending.has(userId)) {
      ws.send(JSON.stringify({ type: "ERROR", fatal: true, error: "Lobby full" }));
      ws.close(1008, "Lobby full");
      return;
    }

    const existingPending = session.pending.get(userId);
    if (existingPending) {
      if (existingPending.onMessage) existingPending.ws.off("message", existingPending.onMessage);
      if (existingPending.onClose) existingPending.ws.off("close", existingPending.onClose);
      try {
        existingPending.ws.send(
          JSON.stringify({
            type: "ERROR",
            fatal: true,
            reason: "replaced",
            error: "This review was opened in another tab",
          })
        );
        existingPending.ws.close(1000, "Replaced by newer connection");
      } catch { /* ignore */ }
      session.pending.delete(userId);
    }

    const pendingMessageHandler = (raw: string) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "LEAVE") {
          session.pending.delete(userId);
          sendJoinRequests(session);
          ws.close(1000, "Left lobby");
        }
      } catch { /* ignore */ }
    };

    const pendingCloseHandler = () => {
      const currPending = session.pending.get(userId);
      if (currPending && currPending.ws === ws) {
        session.pending.delete(userId);
        sendJoinRequests(session);
      }
    };

    ws.on("message", pendingMessageHandler);
    ws.on("close", pendingCloseHandler);

    session.pending.set(userId, {
      ws,
      name: userName,
      since: new Date().toISOString(),
      onMessage: pendingMessageHandler,
      onClose: pendingCloseHandler,
    });

    const hostConnected = session.participants.get(session.masterId)?.connected ?? false;
    ws.send(JSON.stringify({
      type: "JOIN_PENDING",
      hostConnected,
    }));

    if (hostConnected) {
      sendJoinRequests(session);
    }
  });
}
