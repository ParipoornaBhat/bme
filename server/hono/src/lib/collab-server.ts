import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";

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
  viewpoint: ViewpointState;
  participants: Map<string, Participant>;
};

// In-memory store for active sessions
const sessions = new Map<string, CollabSession>();
// Client socket to session mapping
const socketMeta = new Map<WebSocket, { token: string; userId: string }>();

export function generateSessionToken(): string {
  return "collab_sec_" + crypto.randomBytes(16).toString("hex");
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
  };
}

function broadcastToSession(token: string, message: any, excludeWs?: WebSocket) {
  for (const [ws, meta] of socketMeta.entries()) {
    if (meta.token === token && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

export function initCollaborationWSServer(wss: WebSocketServer) {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    const userId = url.searchParams.get("userId") || `user_${crypto.randomBytes(4).toString("hex")}`;
    const userName = url.searchParams.get("userName") || `Dr. ${userId.slice(-4)}`;

    if (!token || !sessions.has(token)) {
      ws.send(JSON.stringify({ type: "ERROR", error: "Invalid or expired collaboration session token" }));
      ws.close(1008, "Invalid session token");
      return;
    }

    const session = sessions.get(token)!;
    if (!session.active) {
      ws.send(JSON.stringify({ type: "ERROR", error: "Session has ended" }));
      ws.close(1008, "Session ended");
      return;
    }

    socketMeta.set(ws, { token, userId });

    // Determine role: if userId matches session.masterId, role is MASTER.
    // Rule: NEVER automatically grant MASTER to a second user or auto-promote.
    const isMaster = userId === session.masterId;
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
    }

    // Notify client of successful connection & initial state
    ws.send(
      JSON.stringify({
        type: "SESSION_JOIN_SUCCESS",
        role: participant.role,
        userId: participant.id,
        permissions: participant.permissions,
        session: sanitizeSessionForPublic(session),
      })
    );

    // Broadcast updated participant list to everyone in session
    broadcastToSession(token, {
      type: "PARTICIPANTS_UPDATED",
      participants: Array.from(session.participants.values()),
    });

    // Handle incoming messages
    ws.on("message", (raw: string) => {
      try {
        const data = JSON.parse(raw.toString());
        const { type } = data;

        if (type === "VIEWPOINT_UPDATE") {
          // Check permission or Master role
          const canControlSlice = isMaster || participant?.permissions.SLICE_CONTROL || participant?.permissions.ZOOM_PAN;
          if (!canControlSlice) {
            ws.send(JSON.stringify({ type: "ERROR", error: "Permission denied: viewpoint control locked by Master" }));
            return;
          }

          if (data.viewpoint) {
            session.viewpoint = {
              ...session.viewpoint,
              ...data.viewpoint,
            };
            broadcastToSession(token, {
              type: "VIEWPOINT_UPDATED",
              updatedBy: userId,
              viewpoint: session.viewpoint,
            }, ws);
          }
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

            // Notify target user directly & broadcast
            broadcastToSession(token, {
              type: "PERMISSION_UPDATED",
              targetUserId,
              permissions: target.permissions,
              participants: Array.from(session.participants.values()),
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

            // Disconnect target socket if connected
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

          // Close all sockets
          for (const [sWs, sMeta] of socketMeta.entries()) {
            if (sMeta.token === token) {
              sWs.close(1000, "Session ended");
              socketMeta.delete(sWs);
            }
          }
          sessions.delete(token);
        }
      } catch (err: any) {
        console.error("Collab WS Error parsing message:", err);
      }
    });

    ws.on("close", () => {
      socketMeta.delete(ws);
      if (participant) {
        participant.connected = false;
        if (isMaster) {
          session.masterDisconnectedAt = new Date().toISOString();
        }
      }

      broadcastToSession(token, {
        type: "PARTICIPANTS_UPDATED",
        participants: Array.from(session.participants.values()),
        masterConnected: session.participants.get(session.masterId)?.connected ?? false,
      });
    });
  });
}
