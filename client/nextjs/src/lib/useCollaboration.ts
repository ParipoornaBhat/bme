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

export type UseCollaborationOptions = {
  token: string;
  userId?: string;
  userName?: string;
  onViewpointUpdated?: (viewpoint: ViewpointState) => void;
  onMaskUpdated?: (data: { stem?: string; caseId?: string; maskDataUrl?: string; maskPixels?: number[]; width?: number; height?: number }) => void;
  onSessionEnded?: () => void;
  onUserRemoved?: () => void;
};

export function useCollaboration({
  token,
  userId,
  userName,
  onViewpointUpdated,
  onMaskUpdated,
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

  const socketRef = useRef<WebSocket | null>(null);
  const lastCursorEmitRef = useRef<number>(0);
  const lastViewpointEmitRef = useRef<number>(0);
  const lastMaskEmitRef = useRef<number>(0);

  // Stabilize callbacks in refs so they never trigger WebSocket reconnects
  const callbacksRef = useRef({
    onViewpointUpdated,
    onMaskUpdated,
    onSessionEnded,
    onUserRemoved,
  });
  useEffect(() => {
    callbacksRef.current = {
      onViewpointUpdated,
      onMaskUpdated,
      onSessionEnded,
      onUserRemoved,
    };
  }, [onViewpointUpdated, onMaskUpdated, onSessionEnded, onUserRemoved]);

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

    return `${protocol}//${host}/ws/collaborate?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(uid)}&userName=${encodeURIComponent(uname)}`;
  }, [token, userId, userName]);

  useEffect(() => {
    if (!token) return;

    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        if (data.type === "SESSION_JOIN_SUCCESS") {
          setRole(data.role);
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
              callbacksRef.current.onViewpointUpdated(data.viewpoint);
            }
          }
        } else if (data.type === "CURSOR_UPDATED") {
          setParticipants((prev) =>
            prev.map((p) =>
              p.id === data.userId ? { ...p, cursor: data.cursor } : p
            )
          );
        } else if (data.type === "PERMISSION_UPDATED") {
          if (data.targetUserId === currentUserId) {
            setPermissions(data.permissions);
          }
          if (data.participants) {
            setParticipants(data.participants);
          }
        } else if (data.type === "PARTICIPANTS_UPDATED") {
          if (data.participants) {
            setParticipants(data.participants);
          }
        } else if (data.type === "MASK_UPDATED") {
          if (callbacksRef.current.onMaskUpdated) {
            callbacksRef.current.onMaskUpdated(data);
          }
        } else if (data.type === "USER_REMOVED") {
          setRemoved(true);
          if (callbacksRef.current.onUserRemoved) {
            callbacksRef.current.onUserRemoved();
          }
        } else if (data.type === "SESSION_ENDED") {
          setSessionEnded(true);
          if (callbacksRef.current.onSessionEnded) {
            callbacksRef.current.onSessionEnded();
          }
        }
      } catch (err) {
        console.error("Error parsing WS message:", err);
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = (err) => {
      console.warn("WS error:", err);
      setConnected(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [token, getWsUrl]);

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
  const updateMask = useCallback((maskPayload: { stem: string; caseId: string; maskDataUrl?: string; maskPixels?: number[]; width?: number; height?: number }) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastMaskEmitRef.current < 80) return;
    lastMaskEmitRef.current = now;

    socketRef.current.send(
      JSON.stringify({
        type: "MASK_UPDATE",
        ...maskPayload,
      })
    );
  }, []);

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

  // Master Action: Grant/Revoke Permission
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
    updateViewpoint,
    updateCursor,
    updateMask,
    updatePermission,
    removeUser,
    endSession,
  };
}
