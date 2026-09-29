"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "~/lib/auth-client";
import type { useCollaboration } from "~/lib/useCollaboration";

type Collab = ReturnType<typeof useCollaboration>;

export function shareUrlFor(token: string) {
  const baseOrigin =
    process.env.NEXT_PUBLIC_APP_URL &&
    !process.env.NEXT_PUBLIC_APP_URL.includes("localhost")
      ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
      : window.location.origin;
  return `${baseOrigin}/collaborate/${token}`;
}

/**
 * The host side of a review session, shared by the 2D painter and the 3D
 * viewer: who the host is, starting a session, and keeping it across reloads.
 * `storagePrefix` names the sessionStorage keys, so each viewer (and each 3D
 * case) keeps its own session.
 */
export function useHostSession({ storagePrefix, enabled }: { storagePrefix: string; enabled: boolean }) {
  const { data: session } = useSession();

  // Stable Master User ID for collaboration session and WebSocket
  const [masterUserId, setMasterUserId] = useState<string>("master_host");
  const [masterUserName, setMasterUserName] = useState<string>("Dr. Master");
  useEffect(() => {
    let uid = session?.user?.id;
    if (!uid) {
      try {
        uid = localStorage.getItem("bme_master_uid") || "";
        if (!uid) {
          uid = `master_${Math.random().toString(36).substring(2, 9)}`;
          localStorage.setItem("bme_master_uid", uid);
        }
      } catch {
        uid = `master_${Math.random().toString(36).substring(2, 9)}`;
      }
    }
    setMasterUserId(uid);
    setMasterUserName(session?.user?.name || "Dr. Master");
  }, [session?.user?.id, session?.user?.name]);

  const [token, setToken] = useState<string | null>(null);
  // Returned by the API to whoever created the session; it is what makes this
  // socket the host. Never shared, never put in a link.
  const [hostKey, setHostKey] = useState<string | null>(null);
  // The id this client created the session under. masterUserId starts as a
  // placeholder and is replaced once the auth session loads, so without pinning
  // it the host can connect under a different id than the one that owns the
  // session - and, now that nobody is promoted automatically, be locked out of
  // their own review. Kept with the token so a reload reconnects as the same id.
  const [hostId, setHostId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [showPanel, setShowPanel] = useState(false);

  const keys = {
    token: `${storagePrefix}_token`,
    hostKey: `${storagePrefix}_host_key`,
    hostId: `${storagePrefix}_host_id`,
  };

  // Restore an active session after a reload - once, on mount. Re-running
  // whenever the token went empty is what made End Session look broken:
  // clearing the token immediately restored it from storage.
  useEffect(() => {
    if (!enabled) return;
    try {
      const saved = sessionStorage.getItem(keys.token);
      if (saved) {
        setToken(saved);
        setHostKey(sessionStorage.getItem(keys.hostKey) || null);
        setHostId(sessionStorage.getItem(keys.hostId) || null);
        setShareUrl(shareUrlFor(saved));
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forget the session everywhere: state and the copy kept for reloads.
  const forget = () => {
    try {
      sessionStorage.removeItem(keys.token);
      sessionStorage.removeItem(keys.hostKey);
      sessionStorage.removeItem(keys.hostId);
    } catch { /* ignore */ }
    setToken(null);
    setHostKey(null);
    setShowPanel(false);
  };

  const start = async (caseId: string, mode: "2d" | "3d") => {
    if (token) {
      setShowPanel(true);
      return;
    }
    setStarting(true);
    const id = masterUserId;
    setHostId(id);
    try {
      const res = await fetch("/api/collaborate/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, mode, userId: id, userName: masterUserName }),
      });
      if (!res.ok) {
        let errorMsg = `Server error (${res.status})`;
        try {
          if ((res.headers.get("content-type") || "").includes("application/json")) {
            const data = await res.json();
            errorMsg = data.error || errorMsg;
          }
        } catch { /* fallback */ }
        if (res.status === 502 || res.status === 504) {
          errorMsg = "Backend API server (port 4000) is unreachable. Please make sure the backend server is running via 'pnpm dev'.";
        }
        console.error("Failed to start collaboration:", errorMsg);
        toast.error(errorMsg);
        return;
      }
      const data = await res.json();
      if (data.token) {
        setHostKey(data.hostKey ?? null);
        setToken(data.token);
        setShareUrl(shareUrlFor(data.token));
        setShowPanel(true);
        try {
          sessionStorage.setItem(keys.token, data.token);
          if (data.hostKey) sessionStorage.setItem(keys.hostKey, data.hostKey);
          sessionStorage.setItem(keys.hostId, id);
        } catch { /* ignore */ }
      }
    } catch (err) {
      console.error("Failed to start collaboration:", err);
    } finally {
      setStarting(false);
    }
  };

  return {
    userId: hostId ?? masterUserId,
    userName: masterUserName,
    token,
    hostKey,
    shareUrl,
    starting,
    showPanel,
    setShowPanel,
    start,
    forget,
  };
}

/**
 * Notices and cleanup once a session is live: people joining and leaving,
 * admission requests for the host, and dropping a session that has ended.
 */
export function useSessionNotices(collab: Collab, token: string | null, isHost: boolean, onGone: () => void) {
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // The host's session can also end without this page asking: from another
  // tab, or because the server restarted and a reload restored a token it no
  // longer knows. Drop back to "Start Collaboration" rather than leave a panel
  // attached to a dead session.
  useEffect(() => {
    if (!isHost || !token) return;
    if (collab.sessionInvalid) {
      toast.info("That review session no longer exists. Start a new one to collaborate.");
      onGoneRef.current();
    } else if (collab.sessionEnded) {
      onGoneRef.current();
    }
  }, [collab.sessionInvalid, collab.sessionEnded, token, isHost]);

  // Toast notifications when participants join or disconnect (keyed by boolean connected state)
  const prevConnectedMapRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!token || !collab.connected) return;
    const curr = collab.participants;
    const prevMap = prevConnectedMapRef.current;
    const newMap = new Map<string, boolean>();
    curr.forEach((p) => newMap.set(p.id, p.connected));

    curr.forEach((p) => {
      if (p.id !== collab.currentUserId && p.connected) {
        const wasConn = prevMap.get(p.id);
        if (wasConn === false || (wasConn === undefined && prevMap.size > 0)) {
          toast.info(`🩺 ${p.name} joined the review session`);
        }
      }
    });

    prevMap.forEach((wasConn, uid) => {
      if (uid !== collab.currentUserId && wasConn) {
        const target = curr.find((p) => p.id === uid);
        if (!target || !target.connected) {
          toast.warning(`🩺 ${target?.name || "Participant"} left the review session`);
        }
      }
    });

    prevConnectedMapRef.current = newMap;
  }, [collab.participants, token, collab.connected, collab.currentUserId]);

  // Toast notifications for the host when new viewers request admission
  const seenRequestsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!token || !isHost) return;
    const currentIds = new Set(collab.joinRequests.map((r) => r.userId));
    collab.joinRequests.forEach((req) => {
      if (!seenRequestsRef.current.has(req.userId)) {
        toast.info(`🩺 ${req.name} wants to join`);
      }
    });
    seenRequestsRef.current = currentIds;
  }, [collab.joinRequests, token, isHost]);
}

/**
 * The id a guest joins under. Generated once and persisted: the id is part of
 * the WebSocket URL, so a new one on every render would reconnect in a loop and
 * leave the master granting permissions to participants that no longer exist.
 */
export function useGuestUserId() {
  const [id] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      const saved = localStorage.getItem("bme_collab_radiologist_uid");
      if (saved) return saved;
      const fresh = `collab_${Math.random().toString(36).substring(2, 9)}`;
      localStorage.setItem("bme_collab_radiologist_uid", fresh);
      return fresh;
    } catch {
      return `collab_${Math.random().toString(36).substring(2, 9)}`;
    }
  });
  return id;
}
