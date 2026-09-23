"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

export type ViewpointState = {
  sliceIndex: number;
  maxSlices?: number;
  plane?: "axial" | "coronal" | "sagittal";
  zoom: number;
  pan: { x: number; y: number };
  windowLevel?: { lo: number; hi: number };
  overlayVisibility?: {
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

// [start, length, label, start, length, label, ...] over the row-major pixels.
export type MaskRuns = number[];
export type MaskSnapshot = { caseId: string; stem: string; width: number; height: number; seq: number; runs: MaskRuns };
export type MaskOpApplied = { caseId: string; stem: string; opId: string; runs: MaskRuns; seq: number; userId: string };

export type UseCollaborationOptions = {
  token: string;
  userId?: string;
  userName?: string;
  // Secret returned to whoever created the session. Presenting it is what makes
  // this socket the host; a viewer never has one.
  hostKey?: string;
  onViewpointUpdated?: (viewpoint: ViewpointState, updatedBy?: string) => void;
  // The live mask for a slice, from the server: the whole thing, when a slice
  // is opened or reopened.
  onMaskSnapshot?: (data: MaskSnapshot) => void;
  // One numbered edit. Arrives for every edit by anyone, including this
  // client's own, in the single order the server applied them.
  onMaskOp?: (data: MaskOpApplied) => void;
  onSessionEnded?: () => void;
  onUserRemoved?: () => void;
};

export function useCollaboration({
  token,
  userId,
  userName,
  hostKey,
  onViewpointUpdated,
  onMaskSnapshot,
  onMaskOp,
  onSessionEnded,
  onUserRemoved,
}: UseCollaborationOptions) {
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<"MASTER" | "VIEWER">("VIEWER");
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [permissions, setPermissions] = useState<ParticipantPermission>({
    VIEW: true,
    ZOOM_PAN: false,
    SLICE_CONTROL: false,
    WINDOW_LEVEL: false,
    ANNOTATE: false,
    EDIT_ANNOTATION: false,
    DELETE_ANNOTATION: false,
    AI_ANALYSIS: false,
    DOWNLOAD: false,
  });
  const [viewpoint, setViewpoint] = useState<ViewpointState | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [caseId, setCaseId] = useState<string>("");
  const [sessionEnded, setSessionEnded] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [hostOffline, setHostOffline] = useState(false);
  // Issued by the server on join. Study data requests carry it so the server
  // can confirm they come from someone who is actually in this review.
  const [participantKey, setParticipantKey] = useState<string | null>(null);
  // Bumped to re-run the connect effect. The server closes viewer sockets when
  // the host leaves, so without retrying the link stays dead until a refresh.
  const [reconnectTick, setReconnectTick] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  // The socket's onmessage closure is created once per connection, so it cannot
  // read currentUserId from state without going stale. Keep it in a ref.
  const currentUserIdRef = useRef<string>("");
  const lastCursorEmitRef = useRef<number>(0);
  const lastViewpointEmitRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fatalRef = useRef(false);

  // Stabilize callbacks in refs so they never trigger WebSocket reconnects
  const callbacksRef = useRef({
    onViewpointUpdated,
    onMaskSnapshot,
    onMaskOp,
    onSessionEnded,
    onUserRemoved,
  });
  useEffect(() => {
    callbacksRef.current = {
      onViewpointUpdated,
      onMaskSnapshot,
      onMaskOp,
      onSessionEnded,
      onUserRemoved,
    };
  }, [onViewpointUpdated, onMaskSnapshot, onMaskOp, onSessionEnded, onUserRemoved]);

  const getWsUrl = useCallback(() => {
    let host = "localhost:4000";
    if (typeof window !== "undefined") {
      if (!window.location.hostname.includes("localhost") && !window.location.hostname.includes("127.0.0.1")) {
        host = window.location.host;
      } else if (process.env.NEXT_PUBLIC_SERVER_URL) {
        try {
          const u = new URL(process.env.NEXT_PUBLIC_SERVER_URL);
          host = u.host;
        } catch { /* fallback */ }
      } else {
        host = window.location.hostname + ":4000";
      }
    }

    const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    let defaultUid = "";
    if (typeof window !== "undefined") {
      try {
        defaultUid = sessionStorage.getItem("bme_collab_uid") || "";
        if (!defaultUid) {
          defaultUid = `user_${Math.random().toString(36).substring(2, 9)}`;
          sessionStorage.setItem("bme_collab_uid", defaultUid);
        }
      } catch { /* fallback */ }
    }
    const uid = userId || defaultUid || `user_${Math.random().toString(36).substring(2, 9)}`;
    const uname = userName || `Dr. ${uid.slice(-4)}`;

    const hostParam = hostKey ? `&hostKey=${encodeURIComponent(hostKey)}` : "";
    return `${protocol}//${host}/ws/collaborate?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(uid)}&userName=${encodeURIComponent(uname)}${hostParam}`;
  }, [token, userId, userName, hostKey]);

  useEffect(() => {
    if (!token) return;

    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;
    // Captured by this socket's own handlers. A shared ref cannot work here:
    // close() resolves asynchronously, so a flag cleared right after the call
    // is already false by the time onclose runs, and every teardown then looks
    // like a dropped connection and schedules another reconnect.
    let disposed = false;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        if (data.type === "ERROR") {
          // Only a session that can never become valid again stops the retry
          // loop. Routine refusals - a permission the host has not granted -
          // arrive as errors too, and must not kill the connection.
          if (data.fatal) fatalRef.current = true;
          console.warn("Collaboration error:", data.error);
        } else if (data.type === "HOST_OFFLINE") {
          setHostOffline(true);
        } else if (data.type === "SESSION_JOIN_SUCCESS") {
          setHostOffline(false);
          setParticipantKey(data.participantKey ?? null);
          setRole(data.role);
          currentUserIdRef.current = data.userId;
          setCurrentUserId(data.userId);
          setPermissions(data.permissions);
          if (data.session) {
            setCaseId(data.session.caseId);
            setViewpoint(data.session.viewpoint);
            setParticipants(data.session.participants);
          }
        } else if (data.type === "VIEWPOINT_UPDATED") {
          if (data.viewpoint) {
            setViewpoint(data.viewpoint);
            if (callbacksRef.current.onViewpointUpdated) {
              callbacksRef.current.onViewpointUpdated(data.viewpoint, data.updatedBy);
            }
          }
        } else if (data.type === "CURSOR_UPDATED") {
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === data.userId ? { ...p, cursor: data.cursor } : p
            )
          );
        } else if (data.type === "PERMISSION_UPDATED") {
          if (data.targetUserId === currentUserIdRef.current) {
            setPermissions(data.permissions);
          }
          if (data.participants) {
            setParticipants(data.participants);
          }
        } else if (data.type === "PARTICIPANTS_UPDATED") {
          if (data.participants) {
            setParticipants(data.participants);
          }
        } else if (data.type === "MASK_SNAPSHOT") {
          if (callbacksRef.current.onMaskSnapshot) {
            callbacksRef.current.onMaskSnapshot(data);
          }
        } else if (data.type === "MASK_OP_APPLIED") {
          if (callbacksRef.current.onMaskOp) {
            callbacksRef.current.onMaskOp(data);
          }
        } else if (data.type === "USER_REMOVED") {
          setRemoved(true);
          fatalRef.current = true;
          if (callbacksRef.current.onUserRemoved) {
            callbacksRef.current.onUserRemoved();
          }
        } else if (data.type === "SESSION_ENDED") {
          setSessionEnded(true);
          fatalRef.current = true;
          if (callbacksRef.current.onSessionEnded) {
            callbacksRef.current.onSessionEnded();
          }
        }
      } catch (err) {
        console.error("Error parsing WS message:", err);
      }
    };

    ws.onclose = () => {
      if (disposed) return;
      setConnected(false);
      // A close we did not ask for means a dropped connection or a host who
      // stepped out; both recover on their own. A finished or invalid session
      // never will, so it stops here.
      if (!fatalRef.current) {
        reconnectTimerRef.current = setTimeout(() => setReconnectTick((t) => t + 1), 4000);
      }
    };

    ws.onerror = (err) => {
      if (disposed) return;
      console.warn("WS error:", err);
      setConnected(false);
    };

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      disposed = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [token, getWsUrl, reconnectTick]);

  // Viewpoint Update emitter (throttling only continuous pan updates)
  const updateViewpoint = useCallback((newVp: Partial<ViewpointState>, force = false) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const isDiscrete = Boolean(
      force ||
      newVp.selectedRelPath ||
      newVp.selectedStem ||
      newVp.selectedCaseId ||
      newVp.sliceIndex !== undefined
    );
    if (!isDiscrete && now - lastViewpointEmitRef.current < 50) return;
    lastViewpointEmitRef.current = now;

    socketRef.current.send(
      JSON.stringify({
        type: "VIEWPOINT_UPDATE",
        viewpoint: newVp,
      })
    );
  }, []);

  // Live Mask Update emitter
  // Throttled Cursor Update emitter (max 1 update per 50ms)
  const updateCursor = useCallback((cursor: { x: number; y: number; plane?: string }) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastCursorEmitRef.current < 50) return;
    lastCursorEmitRef.current = now;

    socketRef.current.send(
      JSON.stringify({
        type: "CURSOR_UPDATE",
        cursor,
      })
    );
  }, []);

  // Open a slice in the live session. `base` is what this client has on
  // screen; the server keeps it only if nobody has opened the slice yet.
  const sendMaskJoin = useCallback((join: { caseId: string; stem: string; width: number; height: number; base: MaskRuns }) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify({ type: "MASK_JOIN", ...join }));
    return true;
  }, []);

  // Send one edit: only the pixels that changed. Not throttled here - the
  // caller batches - and never dropped, because a lost edit is a lost stroke.
  const sendMaskOp = useCallback((op: { caseId: string; stem: string; opId: string; runs: MaskRuns }) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify({ type: "MASK_OP", ...op }));
    return true;
  }, []);

  const updatePermission = useCallback((targetUserId: string, newPermissions: Partial<ParticipantPermission>) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({
        type: "PERMISSION_UPDATE",
        targetUserId,
        permissions: newPermissions,
      })
    );
  }, []);

  // Master Action: Remove User
  const removeUser = useCallback((targetUserId: string) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({
        type: "REMOVE_USER",
        targetUserId,
      })
    );
  }, []);

  // Master Action: End Session
  const endSession = useCallback(() => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({
        type: "END_SESSION",
      })
    );
  }, []);

  return {
    connected,
    role,
    currentUserId,
    permissions,
    viewpoint,
    participants,
    caseId,
    sessionEnded,
    removed,
    hostOffline,
    participantKey,
    updateViewpoint,
    updateCursor,
    sendMaskJoin,
    sendMaskOp,
    updatePermission,
    removeUser,
    endSession,
  };
}
