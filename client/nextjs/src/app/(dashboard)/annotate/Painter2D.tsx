"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eraser,
  Flashlight,
  Flag,
  Hand,
  Info,
  Lasso,
  Layers,
  Loader2,
  Lock,
  Maximize2,
  MessageSquare,
  Move,
  Paintbrush,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "~/lib/auth-client";
import CollaborationViewerHeader from "~/components/collaborate/CollaborationViewerHeader";
import CollaborationMasterPanel from "~/components/collaborate/CollaborationMasterPanel";
import LiveCursorsOverlay from "~/components/collaborate/LiveCursorsOverlay";
import {
  useCollaboration,
  type MaskOpApplied,
  type MaskRuns,
  type MaskSnapshot,
  type Participant,
  type ParticipantPermission,
  type ViewpointState,
} from "~/lib/useCollaboration";
import { MaskSync, type MaskSyncIO } from "~/lib/mask-sync";

export type Case2DSlice = {
  caseId: string;
  label: "bme" | "non_bme";
  relPath: string;
  stem: string;
  hasMask: boolean;
  maskSavedAt: string | null;
  flagged?: boolean;
  flagReason?: string;
  flagNote?: string;
  flaggedAt?: string;
};

export type Painter2DProps = {
  collabToken?: string;
  isCollaborator?: boolean;
  collaboratorUserName?: string;
  collaboratorUserId?: string;
};

const LABELS = [
  { id: 1, name: "Bone Marrow", color: "rgba(16, 185, 129, 0.45)", stroke: "#10b981", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" },
  { id: 2, name: "BME Lesion", color: "rgba(239, 68, 68, 0.55)", stroke: "#ef4444", badge: "bg-red-500/20 text-red-400 border-red-500/40" },
  { id: 3, name: "Uncertain", color: "rgba(245, 158, 11, 0.50)", stroke: "#f59e0b", badge: "bg-amber-500/20 text-amber-400 border-amber-500/40" },
] as const;

export default function Painter2D({
  collabToken: externalCollabToken,
  isCollaborator = false,
  collaboratorUserName,
  collaboratorUserId,
}: Painter2DProps = {}) {
  const [slices, setSlices] = useState<Case2DSlice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Case2DSlice | null>(null);
  const [filter, setFilter] = useState<"all" | "bme" | "non_bme" | "annotated" | "unannotated" | "flagged">("all");
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<"brush" | "pencil" | "pan" | "torch">(isCollaborator ? "pan" : "brush");
  // Torch: hides the annotation inside a circle around the cursor so the scan
  // underneath can be seen. Purely visual - it never touches the mask data, so
  // nothing is erased and collaborators are unaffected. Selected as a tool, or
  // held with T to peek while using another tool.
  const [torchSize, setTorchSize] = useState(48);
  const [torchHeld, setTorchHeld] = useState(false);
  const torchActive = tool === "torch" || torchHeld;
  const torchActiveRef = useRef(torchActive);
  torchActiveRef.current = torchActive;
  const torchSizeRef = useRef(torchSize);
  torchSizeRef.current = torchSize;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const torchRingRef = useRef<HTMLDivElement>(null);
  const [maskInside, setMaskInside] = useState(false);
  const [activeLabel, setActiveLabel] = useState<number>(1);
  const [brushSize, setBrushSize] = useState(12);
  const [isErasing, setIsErasing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Auto Save & History states
  const [autoSave, setAutoSave] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<string>("");
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isDirtyRef = useRef(false);

  // Flagging states
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [flagReason, setFlagReason] = useState("Not Sure");
  const [flagNote, setFlagNote] = useState("");
  const [flagSaving, setFlagSaving] = useState(false);
  const [deletingMask, setDeletingMask] = useState(false);

  const [imgDim, setImgDim] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [maskRevision, setMaskRevision] = useState(0);
  // Whose view this client mirrors. Null means moving independently. Either
  // side can follow the other: the host can watch a radiologist work, and a
  // radiologist can watch the host.
  const [followUserId, setFollowUserId] = useState<string | null>(null);
  const followUserIdRef = useRef<string | null>(null);
  followUserIdRef.current = followUserId;
  const followInitialisedRef = useRef(false);
  const appliedRemoteViewRef = useRef<string | null>(null);
  const lastViewpointByUserRef = useRef<Map<string, ViewpointState>>(new Map());
  const applyViewpointRef = useRef<(vp: ViewpointState) => void>(() => {});
  const [counts, setCounts] = useState<{ bone: number; bme: number; uncertain: number }>({ bone: 0, bme: 0, uncertain: 0 });
  const countsRef = useRef<{ bone: number; bme: number; uncertain: number }>({ bone: 0, bme: 0, uncertain: 0 });

  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  // Collaboration States
  const { data: session } = useSession();
  const [collabToken, setCollabToken] = useState<string | null>(externalCollabToken || null);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [showMasterPanel, setShowMasterPanel] = useState(false);
  const [startingCollab, setStartingCollab] = useState(false);
  // The id this client created the session under. masterUserId starts as a
  // placeholder and is replaced once the auth session loads, so without pinning
  // it the host can connect under a different id than the one that owns the
  // session - and, now that nobody is promoted automatically, be locked out of
  // their own review.
  const [collabHostId, setCollabHostId] = useState<string | null>(null);
  // Returned by the API to whoever created the session; it is what makes this
  // socket the host. Never shared, never put in a link.
  const [collabHostKey, setCollabHostKey] = useState<string | null>(null);

  useEffect(() => {
    if (externalCollabToken) {
      setCollabToken(externalCollabToken);
    }
  }, [externalCollabToken]);

  // Stable Master User ID for collaboration session and WebSocket
  const [masterUserId, setMasterUserId] = useState<string>("master_host");
  const [masterUserName, setMasterUserName] = useState<string>("Dr. Master");

  useEffect(() => {
    if (typeof window !== "undefined") {
      let uid = session?.user?.id;
      if (!uid) {
        uid = localStorage.getItem("bme_master_uid") || "";
        if (!uid) {
          uid = `master_${Math.random().toString(36).substring(2, 9)}`;
          localStorage.setItem("bme_master_uid", uid);
        }
      }
      setMasterUserId(uid);
      setMasterUserName(session?.user?.name || "Dr. Master");
    }
  }, [session?.user?.id, session?.user?.name]);

  // Generated once and persisted: the id is part of the WebSocket URL, so a new
  // one on every render would reconnect in a loop and leave the master granting
  // permissions to participants that no longer exist.
  const [persistedCollabUserId] = useState<string>(() => {
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

  const activeUserId = isCollaborator
    ? (collaboratorUserId || persistedCollabUserId)
    : (collabHostId ?? masterUserId);
  const activeUserName = isCollaborator
    ? (collaboratorUserName || (typeof window !== "undefined" && localStorage.getItem("bme_collab_radiologist_name")) || "Dr. Radiologist")
    : masterUserName;

  const collab = useCollaboration({
    token: collabToken || "",
    userId: activeUserId,
    userName: activeUserName,
    hostKey: isCollaborator ? undefined : (collabHostKey ?? undefined),
    onViewpointUpdated: (vp, updatedBy) => {
      // Remember where everyone is, so choosing to follow someone can jump
      // straight to their view instead of waiting for them to move again.
      if (updatedBy) lastViewpointByUserRef.current.set(updatedBy, vp);
      if (updatedBy && followUserIdRef.current && updatedBy === followUserIdRef.current) {
        applyViewpointRef.current(vp);
      }
    },
    onMaskSnapshot: (data) => {
      const screen = maskDataRef.current;
      if (!screen || sliceLoadingRef.current) return;
      maskSync.onSnapshot(data, screen, canEditRef.current, [undoStackRef.current, redoStackRef.current]);
    },
    onMaskOp: (data) => {
      const screen = maskDataRef.current;
      if (!screen || sliceLoadingRef.current) return;
      maskSync.onOp(data, screen, canEditRef.current, currentUserIdRef.current, [undoStackRef.current, redoStackRef.current]);
    },
  });

  const sessionViewpointRef = useRef(collab.viewpoint);
  sessionViewpointRef.current = collab.viewpoint;

  // Study data routes refuse anyone who is not a signed-in team member unless
  // the request proves the caller is in a live review. A guest does that by
  // sending the session token and the key the server issued them on joining.
  const guestAccessQuery =
    isCollaborator && collabToken && collab.participantKey
      ? `collab=${encodeURIComponent(collabToken)}&key=${encodeURIComponent(collab.participantKey)}`
      : "";
  const withAccess = (url: string) =>
    guestAccessQuery ? `${url}${url.includes("?") ? "&" : "?"}${guestAccessQuery}` : url;
  const withAccessRef = useRef(withAccess);
  withAccessRef.current = withAccess;
  // A guest has nothing to fetch with until the server has issued their key.
  const dataReady = !isCollaborator || Boolean(guestAccessQuery);

  const permissions: ParticipantPermission = isCollaborator
    ? collab.permissions
    : {
        VIEW: true,
        ZOOM_PAN: true,
        SLICE_CONTROL: true,
        WINDOW_LEVEL: true,
        ANNOTATE: true,
        EDIT_ANNOTATION: true,
        DELETE_ANNOTATION: true,
        AI_ANALYSIS: true,
        DOWNLOAD: false,
      };

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

  // Restore an active collaboration session after a reload - once, on mount.
  // Re-running whenever collabToken went empty is what made End Session look
  // broken: clearing the token immediately restored it from storage.
  useEffect(() => {
    try {
      const savedToken = sessionStorage.getItem("bme_active_collab_token");
      const savedHostKey = sessionStorage.getItem("bme_active_collab_host_key");
      if (savedToken && !collabToken && !isCollaborator) {
        setCollabToken(savedToken);
        setCollabHostKey(savedHostKey || null);
        const baseOrigin =
          process.env.NEXT_PUBLIC_APP_URL &&
          !process.env.NEXT_PUBLIC_APP_URL.includes("localhost")
            ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
            : window.location.origin;
        setShareUrl(`${baseOrigin}/collaborate/${savedToken}`);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forget the host's session everywhere: state and the copy kept for reloads.
  const forgetHostSession = () => {
    try {
      sessionStorage.removeItem("bme_active_collab_token");
      sessionStorage.removeItem("bme_active_collab_host_key");
    } catch { /* ignore */ }
    setCollabToken(null);
    setCollabHostKey(null);
    setShowMasterPanel(false);
  };

  // The host's session can also end without this page asking: from another
  // tab, or because the server restarted and a reload restored a token it no
  // longer knows. Drop back to "Start Collaboration" rather than leave a panel
  // attached to a dead session.
  useEffect(() => {
    if (isCollaborator || !collabToken) return;
    if (collab.sessionInvalid) {
      toast.info("That review session no longer exists. Start a new one to collaborate.");
      forgetHostSession();
    } else if (collab.sessionEnded) {
      forgetHostSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.sessionInvalid, collab.sessionEnded, collabToken, isCollaborator]);

  const startCollaboration = async () => {
    if (collabToken) {
      setShowMasterPanel(true);
      return;
    }
    setStartingCollab(true);
    const hostId = masterUserId;
    setCollabHostId(hostId);
    try {
      const res = await fetch("/api/collaborate/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: selected?.stem || "2d_slice",
          userId: hostId,
          userName: masterUserName,
        }),
      });
      if (!res.ok) {
        let errorMsg = `Server error (${res.status})`;
        try {
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await res.json();
            errorMsg = data.error || errorMsg;
          }
        } catch { /* fallback */ }
        if (res.status === 502 || res.status === 504) {
          errorMsg = "Backend API server (port 4000) is unreachable. Please make sure the backend server is running via 'pnpm dev'.";
        }
        console.error("Failed to start 2D collaboration:", errorMsg);
        toast.error(errorMsg);
        return;
      }
      const data = await res.json();
      if (data.token) {
        const baseOrigin =
          process.env.NEXT_PUBLIC_APP_URL &&
          !process.env.NEXT_PUBLIC_APP_URL.includes("localhost")
            ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
            : window.location.origin;
        const shareUrl = `${baseOrigin}/collaborate/${data.token}`;
        setCollabHostKey(data.hostKey ?? null);
        setCollabToken(data.token);
        setShareUrl(shareUrl);
        setShowMasterPanel(true);
        try {
          sessionStorage.setItem("bme_active_collab_token", data.token);
          if (data.hostKey) sessionStorage.setItem("bme_active_collab_host_key", data.hostKey);
        } catch { /* ignore */ }
      }
    } catch (err) {
      console.error("Failed to start 2D collaboration:", err);
    } finally {
      setStartingCollab(false);
    }
  };

  useEffect(() => {
    if (collabToken && collab.connected && selected) {
      // Do not echo a view we only adopted because we are following someone.
      // Two participants following each other would otherwise bounce the same
      // viewpoint back and forth.
      const signature = `${selected.stem}|${zoom}|${pan.x}|${pan.y}`;
      if (appliedRemoteViewRef.current === signature) {
        appliedRemoteViewRef.current = null;
        return;
      }
      collab.updateViewpoint(
        {
          sliceIndex: Math.max(0, slices.findIndex((s) => s.stem === selected.stem)),
          maxSlices: slices.length,
          zoom,
          pan,
          selectedCaseId: selected.caseId,
          selectedStem: selected.stem,
          selectedRelPath: selected.relPath,
        },
        true,
      );
    }
  }, [selected, zoom, pan, collabToken, collab.connected, slices, collab.updateViewpoint]);

  // Toast notifications when participants join or disconnect from Master session (keyed by boolean connected state)
  const prevConnectedMapRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!collabToken || !collab.connected) return;
    const curr = collab.participants;
    const prevMap = prevConnectedMapRef.current;
    const newMap = new Map<string, boolean>();

    curr.forEach((p) => newMap.set(p.id, p.connected));

    // Notify for new connected participants
    curr.forEach((p) => {
      if (p.id !== collab.currentUserId && p.connected) {
        const wasConn = prevMap.get(p.id);
        if (wasConn === false || (wasConn === undefined && prevMap.size > 0)) {
          toast.info(`🩺 ${p.name} joined the review session`);
        }
      }
    });

    // Notify for disconnected participants
    prevMap.forEach((wasConn, uid) => {
      if (uid !== collab.currentUserId && wasConn) {
        const target = curr.find((p) => p.id === uid);
        if (!target || !target.connected) {
          const name = target?.name || `Participant`;
          toast.warning(`🩺 ${name} left the review session`);
        }
      }
    });

    prevConnectedMapRef.current = newMap;
  }, [collab.participants, collabToken, collab.connected, collab.currentUserId]);

  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hoveredSlice, setHoveredSlice] = useState<Case2DSlice | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isLockedDraw, setIsLockedDraw] = useState(false);
  const isLockedDrawRef = useRef(false);
  const lastTapTimeRef = useRef<number>(0);

  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const maskDataRef = useRef<Uint8Array | null>(null);
  const sliceLoadingRef = useRef(false);
  // Keeps this client's mask in step with a live review; see src/lib/mask-sync.ts.
  // Its callbacks go through syncIORef so they always see the current render.
  const syncIORef = useRef<MaskSyncIO>({ sendOp: () => {}, render: () => {}, newOpId: () => "" });
  const maskSyncRef = useRef<MaskSync | null>(null);
  if (!maskSyncRef.current) {
    maskSyncRef.current = new MaskSync({
      sendOp: (opId, runs) => syncIORef.current.sendOp(opId, runs),
      render: () => syncIORef.current.render(),
      newOpId: () => syncIORef.current.newOpId(),
    });
  }
  const maskSync = maskSyncRef.current;
  const canEditRef = useRef(false);
  const currentUserIdRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imgDimRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const undoStackRef = useRef<Uint8Array[]>([]);
  const redoStackRef = useRef<Uint8Array[]>([]);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const outlineRef = useRef<Array<[number, number]>>([]);
  const lastLoadedStemRef = useRef<string>("");
  const loadedSliceRef = useRef<Case2DSlice | null>(null);
  const loadRequestIdRef = useRef<number>(0);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Hydrate preferences from localStorage
  useEffect(() => {
    try {
      const savedFilter = localStorage.getItem("bme_painter2d_filter") as any;
      if (savedFilter && ["all", "bme", "non_bme", "annotated", "unannotated", "flagged"].includes(savedFilter)) {
        setFilter(savedFilter);
      }
      const savedQuery = localStorage.getItem("bme_painter2d_query");
      if (savedQuery) setQuery(savedQuery);
      const savedTool = localStorage.getItem("bme_painter2d_tool") as any;
      if (savedTool === "brush" || savedTool === "pencil" || savedTool === "pan") setTool(savedTool);
      const savedBrushSize = localStorage.getItem("bme_painter2d_brush_size");
      if (savedBrushSize) setBrushSize(Number(savedBrushSize));
      const savedLabel = localStorage.getItem("bme_painter2d_active_label");
      if (savedLabel) setActiveLabel(Number(savedLabel));
      const savedMaskInside = localStorage.getItem("bme_painter2d_mask_inside");
      if (savedMaskInside !== null) setMaskInside(savedMaskInside === "true");
      const savedAutoSave = localStorage.getItem("bme_painter2d_autosave");
      if (savedAutoSave !== null) setAutoSave(savedAutoSave === "true");
    } catch { /* ignore */ }
  }, []);

  // Load slices once access is settled (supporting ?case=...&stem=... deep
  // linking with localStorage fallback)
  useEffect(() => {
    if (!dataReady) return;
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(withAccessRef.current("/api/cases2d"), { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        const list: Case2DSlice[] = data.slices || [];
        setSlices(list);

        if (isCollaborator) {
          const vp = sessionViewpointRef.current;
          let matched: Case2DSlice | undefined;
          if (vp?.selectedStem) {
            matched = list.find((s) => s.stem === vp.selectedStem);
          }
          if (!matched && vp?.selectedRelPath) {
            matched = list.find((s) => s.relPath === vp.selectedRelPath);
          }
          if (!matched && vp?.selectedCaseId) {
            matched = list.find((s) => s.caseId === vp.selectedCaseId);
          }
          if (matched) {
            setSelected(matched);
            return;
          }
        }

        const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
        const targetCase = urlParams?.get("case");
        const targetStem = urlParams?.get("stem");
        let urlMatched: Case2DSlice | undefined;
        if (targetStem) {
          urlMatched = list.find((s) => s.stem === targetStem);
        }
        if (!urlMatched && targetCase) {
          urlMatched = list.find((s) => s.caseId === targetCase);
        }
        if (urlMatched) {
          setSelected(urlMatched);
          return;
        }

        const savedSliceKey = localStorage.getItem("bme_painter2d_selected");
        if (savedSliceKey) {
          const found = list.find((s) => `${s.caseId}/${s.stem}` === savedSliceKey);
          if (found) {
            setSelected(found);
            return;
          }
        }
        setSelected((prev) => prev ?? (list.length > 0 ? list[0] : null));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [dataReady]);


  const renderMaskToCanvas = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const mask = maskDataRef.current;
    const { w, h } = imgDimRef.current;
    if (!canvas || !mask || w === 0 || h === 0) return;

    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    let bCount = 0, lCount = 0, uCount = 0;

    for (let i = 0; i < mask.length; i++) {
      const v = mask[i];
      const p = i * 4;
      if (v === 1) {
        // Bone: Green
        data[p] = 16;
        data[p + 1] = 185;
        data[p + 2] = 129;
        data[p + 3] = 165;
        bCount++;
      } else if (v === 2) {
        // BME: Red
        data[p] = 239;
        data[p + 1] = 68;
        data[p + 2] = 68;
        data[p + 3] = 185;
        lCount++;
      } else if (v === 3) {
        // Uncertain: Amber
        data[p] = 245;
        data[p + 1] = 158;
        data[p + 2] = 11;
        data[p + 3] = 175;
        uCount++;
      } else {
        data[p + 3] = 0;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const newCounts = { bone: bCount, bme: lCount, uncertain: uCount };
    setCounts(newCounts);
    countsRef.current = newCounts;

    // In a live session, send what changed since the last flush. Batched, so a
    // brush stroke goes out as a few edits rather than one per mouse event.
    if (maskSyncRef.current?.ready && flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const screen = maskDataRef.current;
        if (screen && !sliceLoadingRef.current) maskSyncRef.current?.flush(screen, canEditRef.current);
      }, 60);
    }
  }, []);

  // Re-broadcast the viewpoint whenever participants join or reconnect. Masks
  // need no help here: a joiner gets the live mask from the server.
  useEffect(() => {
    if (collabToken && collab.connected && collab.role === "MASTER" && selected) {
      collab.updateViewpoint(
        {
          sliceIndex: Math.max(0, slices.findIndex((s) => s.stem === selected.stem)),
          maxSlices: slices.length,
          zoom,
          pan,
          selectedCaseId: selected.caseId,
          selectedStem: selected.stem,
          selectedRelPath: selected.relPath,
        },
        true,
      );
    }
  }, [collab.participants.length]);

  const pushUndo = () => {
    if (!maskDataRef.current) return;
    undoStackRef.current.push(new Uint8Array(maskDataRef.current));
    if (undoStackRef.current.length > 30) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = []; // New drawing stroke clears redo stack
    isDirtyRef.current = true;
  };

  const undo = () => {
    if (!maskDataRef.current || undoStackRef.current.length === 0) return;
    const prev = undoStackRef.current.pop();
    if (prev) {
      redoStackRef.current.push(new Uint8Array(maskDataRef.current));
      maskDataRef.current.set(prev);
      renderMaskToCanvas();
      isDirtyRef.current = true;
      triggerAutoSaveIfNeeded();
    }
  };

  const redo = () => {
    if (!maskDataRef.current || redoStackRef.current.length === 0) return;
    const next = redoStackRef.current.pop();
    if (next) {
      undoStackRef.current.push(new Uint8Array(maskDataRef.current));
      maskDataRef.current.set(next);
      renderMaskToCanvas();
      isDirtyRef.current = true;
      triggerAutoSaveIfNeeded();
    }
  };

  const clearMask = () => {
    if (!maskDataRef.current) return;
    pushUndo();
    maskDataRef.current.fill(0);
    renderMaskToCanvas();
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
  };

  // Ensure mask is drawn immediately whenever canvas dimensions are set or update
  useEffect(() => {
    if (imgDim.w > 0 && imgDim.h > 0 && maskDataRef.current) {
      renderMaskToCanvas();
    }
  }, [imgDim.w, imgDim.h, renderMaskToCanvas]);

  const selectedRelPath = selected?.relPath;
  const selectedCaseId = selected?.caseId;
  const selectedStem = selected?.stem;

  // Read by the slice loader below without being part of its dependencies:
  // renderMaskToCanvas is rebuilt on every collaboration update, and depending
  // on it would restart the in-flight load each time a participant moves.
  const renderMaskRef = useRef(renderMaskToCanvas);
  renderMaskRef.current = renderMaskToCanvas;


  applyViewpointRef.current = (vp) => {
    const nextZoom = vp.zoom ?? zoomRef.current;
    const nextPan = vp.pan ?? panRef.current;
    if (vp.selectedStem) {
      appliedRemoteViewRef.current = `${vp.selectedStem}|${nextZoom}|${nextPan.x}|${nextPan.y}`;
    }
    if (vp.zoom !== undefined) setZoom(vp.zoom);
    if (vp.pan !== undefined) setPan(vp.pan);
    if (vp.selectedStem || vp.selectedRelPath || vp.selectedCaseId) {
      setSelected((prev) => {
        if (
          prev &&
          ((vp.selectedStem && prev.stem === vp.selectedStem) ||
           (vp.selectedRelPath && prev.relPath === vp.selectedRelPath))
        ) {
          return prev;
        }
        // Resolve the precise slice first. A single find() with these three
        // checks OR'd together matches on caseId for every slice of the case,
        // so it always returns the first one (_s000) whatever stem the
        // follow target actually selected.
        let match: Case2DSlice | undefined;
        if (vp.selectedStem) {
          match = slices.find((s) => s.stem === vp.selectedStem);
        }
        if (!match && vp.selectedRelPath) {
          match = slices.find((s) => s.relPath === vp.selectedRelPath);
        }
        if (!match && vp.selectedCaseId) {
          match = slices.find((s) => s.caseId === vp.selectedCaseId);
        }
        return match || prev;
      });
    }
  };

  // Snap to the followed participant's last known view the moment we start
  // following them.
  useEffect(() => {
    if (!followUserId) return;
    const vp = lastViewpointByUserRef.current.get(followUserId);
    if (vp) applyViewpointRef.current(vp);
  }, [followUserId]);

  // ── Live mask sync ── (the algorithm is in src/lib/mask-sync.ts)
  // Viewers without annotate permission never send: the server would refuse,
  // and their edits would sit unconfirmed forever.
  canEditRef.current = !isCollaborator || permissions.ANNOTATE;
  currentUserIdRef.current = collab.currentUserId;
  syncIORef.current = {
    sendOp: (opId, runs) => {
      const loaded = loadedSliceRef.current;
      if (loaded) collab.sendMaskOp({ caseId: loaded.caseId, stem: loaded.stem, opId, runs });
    },
    render: () => renderMaskRef.current(),
    newOpId: () =>
      `${collab.currentUserId || "me"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  };

  // Open the loaded slice in the live session - on load, on connecting, and
  // again after a reconnect.
  useEffect(() => {
    if (!collabToken) {
      maskSync.leave();
      return;
    }
    const loaded = loadedSliceRef.current;
    const screen = maskDataRef.current;
    const { w, h } = imgDimRef.current;
    if (!collab.connected || !loaded || !screen || w === 0 || h === 0 || sliceLoadingRef.current) return;
    const base = maskSync.join(`${loaded.caseId}::${loaded.stem}`, screen, canEditRef.current);
    collab.sendMaskJoin({ caseId: loaded.caseId, stem: loaded.stem, width: w, height: h, base });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabToken, collab.connected, maskRevision]);

  // Default to following the host, so a radiologist opening the link lands on
  // the same slice without having to do anything. Settled once, then it is the
  // participant's own choice.
  const masterId = collab.participants.find((p) => p.role === "MASTER")?.id ?? null;
  useEffect(() => {
    if (followInitialisedRef.current || !collabToken || !isCollaborator || !masterId) return;
    if (masterId === collab.currentUserId) return;
    followInitialisedRef.current = true;
    setFollowUserId(masterId);
  }, [collabToken, isCollaborator, masterId, collab.currentUserId]);

  // Stop following someone who has left.
  useEffect(() => {
    if (!followUserId) return;
    const stillHere = collab.participants.some((p) => p.id === followUserId && p.connected);
    if (!stillHere) setFollowUserId(null);
  }, [collab.participants, followUserId]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Load image and existing mask on slice change
  useEffect(() => {
    if (!selectedRelPath || !selectedCaseId || !selectedStem) return;

    const sliceKey = `${selectedCaseId}/${selectedStem}`;
    if (lastLoadedStemRef.current === sliceKey) {
      return;
    }
    // Claim the slice now so a re-render cannot start a second load, but
    // release the claim below if this run is torn down before it finishes:
    // otherwise a cancelled run (a StrictMode remount, or a fast slice switch)
    // leaves the slice marked as loaded and its mask never renders.
    lastLoadedStemRef.current = sliceKey;
    sliceLoadingRef.current = true;
    let established = false;
    const currentRequestId = ++loadRequestIdRef.current;
    const sliceSnapshot = selectedRef.current;

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = withAccessRef.current(`/api/cases2d?image=${encodeURIComponent(selectedRelPath)}`);

    img.onload = async () => {
      if (cancelled || loadRequestIdRef.current !== currentRequestId) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      imgDimRef.current = { w, h };
      setImgDim({ w, h });

      // Draw background scan
      const bgCanvas = bgCanvasRef.current;
      if (bgCanvas) {
        bgCanvas.width = w;
        bgCanvas.height = h;
        const bgCtx = bgCanvas.getContext("2d");
        if (bgCtx) {
          bgCtx.drawImage(img, 0, 0);
        }
      }

      // Initialize mask array
      const maskCanvas = maskCanvasRef.current;
      if (maskCanvas) {
        maskCanvas.width = w;
        maskCanvas.height = h;
      }

      const overlayCanvas = overlayCanvasRef.current;
      if (overlayCanvas) {
        overlayCanvas.width = w;
        overlayCanvas.height = h;
      }

      const maskArr = new Uint8Array(w * h);
      maskDataRef.current = maskArr;
      loadedSliceRef.current = sliceSnapshot;
      established = true;

      // New buffers: whatever was in step with the live session belonged to the
      // previous slice. Rejoining happens once this load settles.
      maskSyncRef.current?.leave();
      undoStackRef.current = [];
      redoStackRef.current = [];
      isDirtyRef.current = false;
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);

      // Try to load existing mask.
      //
      // Asked for as plain label bytes, never as an image: decoding an image
      // means drawing it to a canvas and reading it back, and privacy-hardened
      // browsers add +/-1 noise to canvas readback. That flips labels stored
      // as 0-3 at random pixels - holes and stray specks - and the next save
      // writes the damage to disk. See decodeMaskPng in src/lib/mask-png.ts.
      try {
        const maskRes = await fetch(
          withAccessRef.current(`/api/annotation2d/${selectedCaseId}?stem=${encodeURIComponent(selectedStem)}&format=labels`),
        );
        if (cancelled || loadRequestIdRef.current !== currentRequestId) return;
        if (maskRes.ok && maskRes.headers.get("content-type")?.includes("application/octet-stream")) {
          const mw = Number(maskRes.headers.get("X-Mask-Width")) || w;
          const mh = Number(maskRes.headers.get("X-Mask-Height")) || h;
          const labels = new Uint8Array(await maskRes.arrayBuffer());
          if (cancelled || loadRequestIdRef.current !== currentRequestId) return;
          if (labels.length !== mw * mh) throw new Error("mask size does not match its header");
          if (mw === w && mh === h) {
            maskArr.set(labels);
          } else {
            // If mask file dimensions differ from base slice, scale proportionally
            const scaleX = mw / w;
            const scaleY = mh / h;
            for (let y = 0; y < h; y++) {
              const sy = Math.min(mh - 1, Math.floor(y * scaleY));
              for (let x = 0; x < w; x++) {
                const sx = Math.min(mw - 1, Math.floor(x * scaleX));
                maskArr[y * w + x] = labels[sy * mw + sx];
              }
            }
          }
          sliceLoadingRef.current = false;
          renderMaskRef.current();
          setMaskRevision((v) => v + 1);
        } else {
          sliceLoadingRef.current = false;
          renderMaskRef.current();
          setMaskRevision((v) => v + 1);
        }
      } catch {
        sliceLoadingRef.current = false;
        if (!cancelled && loadRequestIdRef.current === currentRequestId) renderMaskRef.current();
        setMaskRevision((v) => v + 1);
      }
    };

    return () => {
      cancelled = true;
      if (!established && lastLoadedStemRef.current === sliceKey) {
        lastLoadedStemRef.current = "";
        sliceLoadingRef.current = false;
      }
    };
  }, [selectedRelPath, selectedCaseId, selectedStem]);

  // Clear overlay canvas
  const clearOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // Redraw live pencil polygon outline
  const drawOutlineOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pts = outlineRef.current;
    if (pts.length < 2) return;

    ctx.save();
    const strokeColor = isErasing
      ? "#ef4444"
      : activeLabel === 1
      ? "#10b981"
      : activeLabel === 2
      ? "#ef4444"
      : "#f59e0b";

    const fillColor = isErasing
      ? "rgba(239, 68, 68, 0.15)"
      : activeLabel === 1
      ? "rgba(16, 185, 129, 0.18)"
      : activeLabel === 2
      ? "rgba(239, 68, 68, 0.22)"
      : "rgba(245, 158, 11, 0.20)";

    // Draw polygon fill preview
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    ctx.fill();

    // Draw clear, solid, non-dotted boundary line
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash([]); // SOLID line, NOT dotted

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.stroke();

    ctx.restore();
  }, [isErasing, activeLabel]);

  // Painting drawing logic
  const paintAt = (cx: number, cy: number) => {
    const mask = maskDataRef.current;
    const { w, h } = imgDimRef.current;
    if (!mask || w === 0 || h === 0) return;

    const val = isErasing ? 0 : activeLabel;
    const r = Math.max(1, Math.round(brushSize / 2));
    const r2 = r * r;

    const minX = Math.max(0, cx - r);
    const maxX = Math.min(w - 1, cx + r);
    const minY = Math.max(0, cy - r);
    const maxY = Math.min(h - 1, cy + r);
    const hasBone = countsRef.current.bone > 0;

    for (let y = minY; y <= maxY; y++) {
      const dy2 = (y - cy) * (y - cy);
      const rowOffset = y * w;
      for (let x = minX; x <= maxX; x++) {
        if ((x - cx) * (x - cx) + dy2 <= r2) {
          const idx = rowOffset + x;
          // Only inside bone guard: active only when bone marrow actually exists
          if (maskInside && hasBone && !isErasing && activeLabel !== 1 && mask[idx] !== 1 && mask[idx] !== activeLabel) {
            continue;
          }
          mask[idx] = val;
        }
      }
    }
  };

  /**
   * Pencil: close the traced outline and fill everything inside it using even-odd scanline fill.
   */
  const commitOutline = useCallback(() => {
    const pts = outlineRef.current;
    outlineRef.current = [];
    clearOverlay();

    const mask = maskDataRef.current;
    const { w, h } = imgDimRef.current;
    if (!mask || w === 0 || h === 0 || pts.length < 3) {
      return;
    }

    pushUndo();

    let minB = Infinity,
      maxB = -Infinity;
    for (const [, b] of pts) {
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    minB = Math.max(0, Math.floor(minB));
    maxB = Math.min(h - 1, Math.ceil(maxB));

    const val = isErasing ? 0 : activeLabel;
    const hasBone = countsRef.current.bone > 0;

    for (let b = minB; b <= maxB; b++) {
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[i],
          [bx, by] = pts[j];
        if (ay > b !== by > b) {
          xs.push(ax + ((b - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]));
        const to = Math.min(w - 1, Math.floor(xs[k + 1]));
        const rowOffset = b * w;
        for (let a = from; a <= to; a++) {
          const idx = rowOffset + a;
          if (maskInside && hasBone && !isErasing && activeLabel !== 1 && mask[idx] !== 1 && mask[idx] !== activeLabel) {
            continue;
          }
          mask[idx] = val;
        }
      }
    }

    renderMaskToCanvas();
    if (autoSave && isDirtyRef.current) {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
      const targetSlice = loadedSliceRef.current;
      const pixelSnapshot = maskDataRef.current ? new Uint8Array(maskDataRef.current) : null;
      const dimSnapshot = { ...imgDimRef.current };
      autoSaveTimeoutRef.current = setTimeout(() => {
        const c = countsRef.current;
        if (c.bone + c.bme + c.uncertain > 0 && targetSlice && pixelSnapshot) {
          saveMaskInternal({
            isAuto: true,
            targetSlice,
            pixelData: pixelSnapshot,
            dimensions: dimSnapshot,
          });
        }
      }, 400);
    }
  }, [clearOverlay, isErasing, activeLabel, maskInside, renderMaskToCanvas, autoSave]);

  const triggerAutoSaveIfNeeded = useCallback(() => {
    if (!autoSave) return;
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    const targetSlice = loadedSliceRef.current;
    const pixelSnapshot = maskDataRef.current ? new Uint8Array(maskDataRef.current) : null;
    const dimSnapshot = { ...imgDimRef.current };
    autoSaveTimeoutRef.current = setTimeout(() => {
      const c = countsRef.current;
      const total = c.bone + c.bme + c.uncertain;
      if (total > 0 && isDirtyRef.current && targetSlice && pixelSnapshot) {
        saveMaskInternal({
          isAuto: true,
          targetSlice,
          pixelData: pixelSnapshot,
          dimensions: dimSnapshot,
        });
      }
    }, 400);
  }, [autoSave]);

  const finishLockedDraw = useCallback(() => {
    if (!isLockedDrawRef.current) return;
    isLockedDrawRef.current = false;
    setIsLockedDraw(false);
    isDrawingRef.current = false;
    lastPosRef.current = null;

    if (tool === "pencil") {
      commitOutline();
    } else {
      triggerAutoSaveIfNeeded();
    }
  }, [tool, commitOutline, triggerAutoSaveIfNeeded]);

  const startLockedDraw = useCallback(
    (pos: { x: number; y: number }) => {
      if (tool === "pan") return;
      isLockedDrawRef.current = true;
      setIsLockedDraw(true);
      isDrawingRef.current = true;

      if (tool === "pencil") {
        outlineRef.current = [[pos.x, pos.y]];
        drawOutlineOverlay();
      } else {
        pushUndo();
        lastPosRef.current = pos;
        paintAt(pos.x, pos.y);
        renderMaskToCanvas();
      }
    },
    [tool, drawOutlineOverlay, renderMaskToCanvas],
  );

  // ── Torch ──
  // Drawn with a CSS mask on the annotation canvas, so moving it costs nothing
  // and the mask data is never read or written. Coordinates are in the
  // canvas's own layout box: the zoom/pan transform on its container then
  // scales the hole along with the image.
  const lastTorchPointRef = useRef<{ x: number; y: number } | null>(null);

  const clearTorch = () => {
    lastTorchPointRef.current = null;
    const canvas = maskCanvasRef.current;
    if (canvas) {
      canvas.style.maskImage = "";
      canvas.style.webkitMaskImage = "";
    }
    if (torchRingRef.current) torchRingRef.current.style.display = "none";
  };

  const updateTorch = (clientX: number, clientY: number) => {
    const canvas = maskCanvasRef.current;
    if (!canvas || canvas.width === 0) return;
    lastTorchPointRef.current = { x: clientX, y: clientY };
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (clientX - rect.left) * (canvas.offsetWidth / rect.width);
    const y = (clientY - rect.top) * (canvas.offsetHeight / rect.height);
    // Size is a diameter in image pixels, like the brush.
    const r = (torchSizeRef.current / 2) * (canvas.offsetWidth / canvas.width);
    const hole = `radial-gradient(circle ${r}px at ${x}px ${y}px, transparent ${Math.max(0, r - 1.5)}px, black ${r}px)`;
    canvas.style.maskImage = hole;
    canvas.style.webkitMaskImage = hole;
    const ring = torchRingRef.current;
    if (ring) {
      ring.style.display = "block";
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.width = `${2 * r}px`;
      ring.style.height = `${2 * r}px`;
    }
  };

  // Put the annotation back the moment the torch is put down, and resize the
  // hole in place when the size changes.
  useEffect(() => {
    if (!torchActive) {
      clearTorch();
      return;
    }
    const last = lastTorchPointRef.current;
    if (last) updateTorch(last.x, last.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torchActive, torchSize]);

  const getCanvasCoords = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement> | Touch,
  ) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let clientX = 0;
    let clientY = 0;
    if ("touches" in e) {
      if (e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      }
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: Math.max(0, Math.min(canvas.width - 1, Math.round((clientX - rect.left) * scaleX))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.round((clientY - rect.top) * scaleY))),
    };
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || tool === "pan" || tool === "torch") return;
    if (isCollaborator && !permissions.ANNOTATE) return;
    const pos = getCanvasCoords(e);
    if (isLockedDrawRef.current) {
      finishLockedDraw();
    } else {
      startLockedDraw(pos);
    }
  };

  // Touch handlers for touchscreen devices (smartphones, tablets, touch laptops)
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length > 1) return; // Ignore pinch/multitouch gestures
    e.preventDefault();

    if (tool === "torch") {
      updateTorch(e.touches[0].clientX, e.touches[0].clientY);
      return;
    }

    if (tool === "pan") {
      if (isCollaborator && !permissions.ZOOM_PAN) return;
      setIsPanning(true);
      const touch = e.touches[0];
      panStartRef.current = { x: touch.clientX - pan.x, y: touch.clientY - pan.y };
      return;
    }

    if (isCollaborator && !permissions.ANNOTATE) return;

    const pos = getCanvasCoords(e);

    // If locked draw is already active, tapping once finishes and commits the stroke!
    if (isLockedDrawRef.current) {
      finishLockedDraw();
      lastTapTimeRef.current = 0;
      return;
    }

    // Touchscreen double tap detection (two taps within 350ms)
    const now = Date.now();
    if (now - lastTapTimeRef.current < 350) {
      lastTapTimeRef.current = 0;
      startLockedDraw(pos);
      return;
    }
    lastTapTimeRef.current = now;

    // Single touch start (standard touch draw without locking)
    if (tool === "pencil") {
      isDrawingRef.current = true;
      outlineRef.current = [[pos.x, pos.y]];
      drawOutlineOverlay();
      return;
    }

    pushUndo();
    isDrawingRef.current = true;
    lastPosRef.current = pos;
    paintAt(pos.x, pos.y);
    renderMaskToCanvas();
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length > 1) return;
    e.preventDefault();

    if (tool === "torch") {
      updateTorch(e.touches[0].clientX, e.touches[0].clientY);
      return;
    }

    if (tool === "pan") {
      if (isPanning && e.touches.length === 1 && (!isCollaborator || permissions.ZOOM_PAN)) {
        const touch = e.touches[0];
        setPan({
          x: touch.clientX - panStartRef.current.x,
          y: touch.clientY - panStartRef.current.y,
        });
      }
      return;
    }

    if (isCollaborator && !permissions.ANNOTATE) return;

    if (!isDrawingRef.current) return;
    const pos = getCanvasCoords(e);

    if (tool === "pencil") {
      const pts = outlineRef.current;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(pos.x - last[0], pos.y - last[1]) >= 2) {
        pts.push([pos.x, pos.y]);
        drawOutlineOverlay();
      }
      return;
    }

    const last = lastPosRef.current || pos;
    const dist = Math.hypot(pos.x - last.x, pos.y - last.y);
    const steps = Math.max(1, Math.ceil(dist / 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      paintAt(Math.round(last.x + (pos.x - last.x) * t), Math.round(last.y + (pos.y - last.y) * t));
    }

    lastPosRef.current = pos;
    renderMaskToCanvas();
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    // Lifting the finger puts the annotation back.
    if (tool === "torch") {
      clearTorch();
      return;
    }
    if (isPanning) {
      setIsPanning(false);
    }
    // If locked draw mode is active, lifting finger from touchscreen does not end drawing
    if (isLockedDrawRef.current) {
      return;
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;

    if (tool === "pencil") {
      commitOutline();
    } else {
      triggerAutoSaveIfNeeded();
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (tool === "torch") return;

    if (tool === "pan") {
      if (isCollaborator && !permissions.ZOOM_PAN) return;
      setIsPanning(true);
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      return;
    }

    if (isCollaborator && !permissions.ANNOTATE) return;

    const pos = getCanvasCoords(e);

    // If already in locked touchpad drawing mode, a single tap finishes the stroke!
    if (isLockedDrawRef.current) {
      finishLockedDraw();
      lastTapTimeRef.current = 0;
      return;
    }

    // Double tap detection for touchpads (tap-tap within 320ms)
    const now = Date.now();
    if (now - lastTapTimeRef.current < 320) {
      lastTapTimeRef.current = 0;
      startLockedDraw(pos);
      return;
    }
    lastTapTimeRef.current = now;

    if (tool === "pencil") {
      isDrawingRef.current = true;
      outlineRef.current = [[pos.x, pos.y]];
      drawOutlineOverlay();
      return;
    }

    pushUndo();
    isDrawingRef.current = true;
    lastPosRef.current = pos;
    paintAt(pos.x, pos.y);
    renderMaskToCanvas();
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (torchActiveRef.current) updateTorch(e.clientX, e.clientY);
    if (collabToken && collab.connected) {
      const pos = getCanvasCoords(e);
      const w = imgDim.w || 512;
      const h = imgDim.h || 512;
      collab.updateCursor({ x: pos.x / w, y: pos.y / h, plane: "axial" });
    }

    if (tool === "torch") return;

    if (tool === "pan") {
      if (isPanning && (!isCollaborator || permissions.ZOOM_PAN)) {
        setPan({
          x: e.clientX - panStartRef.current.x,
          y: e.clientY - panStartRef.current.y,
        });
      }
      return;
    }

    if (isCollaborator && !permissions.ANNOTATE) return;

    if (!isDrawingRef.current) return;
    const pos = getCanvasCoords(e);

    if (tool === "pencil") {
      const pts = outlineRef.current;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(pos.x - last[0], pos.y - last[1]) >= 2) {
        pts.push([pos.x, pos.y]);
        drawOutlineOverlay();
      }
      return;
    }

    const last = lastPosRef.current || pos;

    // Line interpolation between mouse move steps
    const dist = Math.hypot(pos.x - last.x, pos.y - last.y);
    const steps = Math.max(1, Math.ceil(dist / 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      paintAt(Math.round(last.x + (pos.x - last.x) * t), Math.round(last.y + (pos.y - last.y) * t));
    }

    lastPosRef.current = pos;
    renderMaskToCanvas();
  };

  const handleMouseUp = () => {
    if (isPanning) {
      setIsPanning(false);
    }
    // If locked touchpad draw mode is active, lifting finger doesn't finish stroke
    if (isLockedDrawRef.current) {
      return;
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;

    if (tool === "pencil") {
      commitOutline();
    } else {
      triggerAutoSaveIfNeeded();
    }
  };

  const saveMaskInternal = async ({
    isAuto = false,
    targetSlice,
    pixelData,
    dimensions,
  }: {
    isAuto?: boolean;
    targetSlice?: Case2DSlice;
    pixelData?: Uint8Array;
    dimensions?: { w: number; h: number };
  } = {}) => {
    const sliceToSave = targetSlice || loadedSliceRef.current || selected;
    const dims = dimensions || imgDimRef.current;
    const pixels = pixelData || (maskDataRef.current ? new Uint8Array(maskDataRef.current) : null);

    if (!sliceToSave || !pixels || dims.w === 0 || dims.h === 0) return;
    const c = countsRef.current;
    const totalPixels = c.bone + c.bme + c.uncertain;

    // Bug fix: if user didn't annotate (0 pixels), never mark as saved & annotated
    if (totalPixels === 0) {
      if (!isAuto) {
        if (sliceToSave.hasMask) {
          if (confirm("This annotation is currently blank. Would you like to delete the saved mask?")) {
            await deleteMask();
          }
        } else {
          toast.error("Cannot save empty annotation. Please paint bone marrow or edema first.");
        }
      }
      return;
    }

    if (isAuto) {
      setAutoSaveStatus("Auto-saving…");
    } else {
      setSaving(true);
      setSavedSuccess(false);
    }

    try {
      const res = await fetch(
        withAccess(`/api/annotation2d/${sliceToSave.caseId}?stem=${encodeURIComponent(sliceToSave.stem)}`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            width: dims.w,
            height: dims.h,
            pixels: Array.from(pixels),
          }),
        },
      );

      if (res.ok) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        isDirtyRef.current = false;
        if (isAuto) {
          setAutoSaveStatus(`Auto-saved ${timeStr}`);
        } else {
          setSavedSuccess(true);
          setTimeout(() => setSavedSuccess(false), 2500);
          toast.success("Mask saved successfully");
        }

        // Refresh local slice state
        setSlices((prev) =>
          prev.map((s) =>
            s.relPath === sliceToSave.relPath
              ? { ...s, hasMask: true, maskSavedAt: now.toISOString() }
              : s,
          ),
        );
        setSelected((prev) =>
          prev && prev.relPath === sliceToSave.relPath
            ? { ...prev, hasMask: true, maskSavedAt: now.toISOString() }
            : prev,
        );
      } else {
        const err = await res.json().catch(() => ({}));
        if (isAuto) {
          setAutoSaveStatus("Auto-save failed");
        } else {
          toast.error(err.error || "Failed to save mask");
        }
      }
    } catch (e) {
      if (isAuto) setAutoSaveStatus("Auto-save failed");
      else toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveMask = async () => {
    return saveMaskInternal({ isAuto: false });
  };

  const deleteMask = async () => {
    if (!selected) return;
    setDeletingMask(true);
    try {
      const res = await fetch(
        withAccess(`/api/annotation2d/${selected.caseId}?stem=${encodeURIComponent(selected.stem)}`),
        { method: "DELETE" },
      );
      if (res.ok) {
        setSlices((prev) =>
          prev.map((s) =>
            s.relPath === selected.relPath ? { ...s, hasMask: false, maskSavedAt: null } : s,
          ),
        );
        setSelected((prev) => (prev ? { ...prev, hasMask: false, maskSavedAt: null } : null));
        clearMask();
        toast.success("Saved mask removed");
      } else {
        toast.error("Failed to delete mask");
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeletingMask(false);
    }
  };

  const handleSaveFlag = async (reason: string, note: string) => {
    if (!selected) return;
    setFlagSaving(true);
    try {
      const res = await fetch(withAccess("/api/annotation2d/flag"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: selected.caseId,
          stem: selected.stem,
          flagged: true,
          reason,
          note,
        }),
      });
      if (res.ok) {
        const now = new Date().toISOString();
        setSlices((prev) =>
          prev.map((s) =>
            s.relPath === selected.relPath
              ? { ...s, flagged: true, flagReason: reason, flagNote: note, flaggedAt: now }
              : s,
          ),
        );
        setSelected((prev) =>
          prev
            ? { ...prev, flagged: true, flagReason: reason, flagNote: note, flaggedAt: now }
            : null,
        );
        setFlagModalOpen(false);
        toast.success("Slice flagged for review");
      } else {
        toast.error("Failed to save flag");
      }
    } finally {
      setFlagSaving(false);
    }
  };

  const handleRemoveFlag = async () => {
    if (!selected) return;
    setFlagSaving(true);
    try {
      const res = await fetch(withAccess("/api/annotation2d/flag"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: selected.caseId,
          stem: selected.stem,
          flagged: false,
        }),
      });
      if (res.ok) {
        setSlices((prev) =>
          prev.map((s) =>
            s.relPath === selected.relPath
              ? { ...s, flagged: false, flagReason: undefined, flagNote: undefined, flaggedAt: undefined }
              : s,
          ),
        );
        setSelected((prev) =>
          prev
            ? { ...prev, flagged: false, flagReason: undefined, flagNote: undefined, flaggedAt: undefined }
            : null,
        );
        setFlagModalOpen(false);
        toast.success("Flag removed");
      } else {
        toast.error("Failed to remove flag");
      }
    } finally {
      setFlagSaving(false);
    }
  };

  // Keyboard shortcuts (including Ctrl+Z Undo, Ctrl+Shift+Z / Ctrl+Y Redo, and Ctrl+S Save)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape" || e.key === "Enter") {
        if (isLockedDrawRef.current) {
          finishLockedDraw();
          return;
        }
      }
      if (e.key === "1") { setActiveLabel(1); setIsErasing(false); }
      else if (e.key === "2") { setActiveLabel(2); setIsErasing(false); }
      else if (e.key === "3") { setActiveLabel(3); setIsErasing(false); }
      else if (e.key === "4" || e.key.toLowerCase() === "b") { setTool("brush"); }
      else if (e.key === "5" || e.key.toLowerCase() === "p") { setTool("pencil"); }
      else if (e.key === "6" || e.key.toLowerCase() === "h") { setTool("pan"); }
      else if (e.key === "7") { setTool("torch"); }
      else if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) { setTorchHeld(true); }
      else if (e.key === "0" || e.key.toLowerCase() === "e") { setIsErasing((prev) => !prev); }
      else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")) { e.preventDefault(); redo(); }
      else if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveMask(); }
      else if (e.key === "[") {
        if (torchActiveRef.current) setTorchSize((t) => Math.max(8, t - 8));
        else setBrushSize((b) => Math.max(2, b - 4));
      }
      else if (e.key === "]") {
        if (torchActiveRef.current) setTorchSize((t) => Math.min(240, t + 8));
        else setBrushSize((b) => Math.min(60, b + 4));
      }
    };
    // Holding T peeks; letting go (or leaving the window) puts the annotation back.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "t") setTorchHeld(false);
    };
    const onBlur = () => setTorchHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [undo, redo, saveMask, finishLockedDraw]);


  const filtered = slices.filter((s) => {
    if (filter === "bme" && s.label !== "bme") return false;
    if (filter === "non_bme" && s.label !== "non_bme") return false;
    if (filter === "annotated" && !s.hasMask) return false;
    if (filter === "unannotated" && s.hasMask) return false;
    if (filter === "flagged" && !s.flagged) return false;
    if (query) {
      const q = query.toLowerCase();
      return (
        s.caseId.toLowerCase().includes(q) ||
        s.stem.toLowerCase().includes(q) ||
        (s.flagReason && s.flagReason.toLowerCase().includes(q)) ||
        (s.flagNote && s.flagNote.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Ending the session or revoking this participant closes their socket, but the
  // study was still rendered - with working tools - until a reload. Take it off
  // the screen the moment either happens. Both are final, so unlike the paused
  // state below there is nothing to wait for.
  if (isCollaborator && (collab.sessionEnded || collab.removed)) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <XCircle className="h-10 w-10 text-red-500" />
        <h1 className="text-lg font-semibold">
          {collab.removed ? "You were removed from this review" : "Review session ended"}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {collab.removed
            ? "The host revoked your access. This link no longer works for you."
            : "The host ended this session. This link no longer works."}
        </p>
      </div>
    );
  }

  // A shared link is only live while the host is in the room. Render nothing of
  // the study when they are not: the scan should not sit unattended on someone
  // else's screen. The session reconnects on its own when the host returns.
  if (isCollaborator && collab.hostOffline) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Lock className="h-10 w-10 text-amber-500" />
        <h1 className="text-lg font-semibold">Review session paused</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The host is not connected. This link stays inactive until they rejoin,
          at which point this page reconnects on its own.
        </p>
        <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Waiting for the host
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 h-full w-full">
      {isCollaborator && (
        <CollaborationViewerHeader
          caseId={selected?.caseId || "Volume Review"}
          masterConnected={collab.participants.some((p) => p.role === "MASTER" && p.connected)}
          followingMaster={Boolean(followUserId)}
          followingName={collab.participants.find((p) => p.id === followUserId)?.name ?? null}
          canFollowMaster={Boolean(masterId) && masterId !== collab.currentUserId}
          onToggleFollowMaster={() => setFollowUserId((curr) => (curr ? null : masterId))}
          permissions={permissions}
        />
      )}

      {/* Mobile/Tablet Floating Bar for Controls */}
      <div className="flex lg:hidden items-center justify-between gap-2 bg-card/90 backdrop-blur p-2 rounded-lg border border-border">
        {(!isCollaborator || permissions.SLICE_CONTROL) && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition shadow-sm cursor-pointer"
          >
            <Layers className="h-3.5 w-3.5 text-primary" />
            <span>{sidebarCollapsed ? `Show Slices (${slices.length})` : "Hide Slices"}</span>
            {sidebarCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => setToolbarCollapsed(!toolbarCollapsed)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition shadow-sm cursor-pointer"
        >
          <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
          <span>{toolbarCollapsed ? "Show Full Tools" : "Compact Tools"}</span>
          {toolbarCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className={`grid gap-3 ${(!isCollaborator || permissions.SLICE_CONTROL) && !sidebarCollapsed ? "lg:grid-cols-[270px_minmax(0,1fr)]" : "grid-cols-1"} min-h-[calc(100vh-140px)] lg:h-[calc(100vh-115px)]`}>
        {/* Left sidebar: Slice list */}
        {(!isCollaborator || permissions.SLICE_CONTROL) && !sidebarCollapsed && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 h-full overflow-hidden">
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    try {
                      localStorage.setItem("bme_painter2d_query", e.target.value);
                    } catch { /* ignore */ }
                  }}
                  placeholder="Search 2D slices..."
                  className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse slice list"
                className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1 text-xs">
              {(["all", "bme", "non_bme", "annotated", "unannotated", "flagged"] as const).map((f) => {
                const count =
                  f === "flagged"
                    ? slices.filter((s) => s.flagged).length
                    : f === "annotated"
                    ? slices.filter((s) => s.hasMask).length
                    : undefined;
                return (
                  <button
                    key={f}
                    onClick={() => {
                      setFilter(f);
                      try {
                        localStorage.setItem("bme_painter2d_filter", f);
                      } catch { /* ignore */ }
                    }}
                    className={`inline-flex items-center gap-1 rounded px-2 py-1 transition ${
                      filter === f
                        ? f === "flagged"
                          ? "bg-amber-500 text-white font-medium"
                          : "bg-primary text-primary-foreground font-medium"
                        : f === "flagged" && (count ?? 0) > 0
                        ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f === "flagged" && <Flag className="h-3 w-3 fill-current" />}
                    <span>{f.replace("_", " ")}</span>
                    {count !== undefined && <span className="opacity-70 text-[10px]">({count})</span>}
                  </button>
                );
              })}
            </div>

            <div className="text-xs text-muted-foreground font-medium flex items-center justify-between">
              <span>
                {filtered.length} of {slices.length} slices
              </span>
              <span className="text-[11px] opacity-75">
                {slices.filter((s) => s.hasMask).length} annotated
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {loading ? (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin mb-2" />
                  Loading 2D slices...
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-12 text-center text-xs text-muted-foreground">No slices match.</div>
              ) : (
                filtered.map((s) => {
                  const active = selected?.relPath === s.relPath;
                  return (
                    <button
                      key={s.relPath}
                      onClick={() => {
                        if (s.relPath === selected?.relPath) return;

                        // Flush any pending auto-save for currently loaded slice
                        if (autoSaveTimeoutRef.current) {
                          clearTimeout(autoSaveTimeoutRef.current);
                          autoSaveTimeoutRef.current = null;
                        }

                        if (autoSave && isDirtyRef.current) {
                          const c = countsRef.current;
                          if (c.bone + c.bme + c.uncertain > 0 && loadedSliceRef.current && maskDataRef.current) {
                            saveMaskInternal({
                              isAuto: true,
                              targetSlice: loadedSliceRef.current,
                              pixelData: new Uint8Array(maskDataRef.current),
                              dimensions: { ...imgDimRef.current },
                            });
                          }
                        }
                        setSelected(s);
                        if (isCollaborator && permissions.SLICE_CONTROL && collabToken && collab.connected) {
                          collab.updateViewpoint({
                            sliceIndex: Math.max(0, slices.findIndex((item) => item.stem === s.stem)),
                            maxSlices: slices.length,
                            selectedCaseId: s.caseId,
                            selectedStem: s.stem,
                            selectedRelPath: s.relPath,
                          }, true);
                        }
                        try {
                          localStorage.setItem("bme_painter2d_selected", `${s.caseId}/${s.stem}`);
                        } catch { /* ignore */ }
                      }}
                      onMouseEnter={(e) => {
                        setHoveredSlice(s);
                        setHoverPos({ x: e.clientX, y: e.clientY });
                      }}
                      onMouseMove={(e) => {
                        setHoverPos({ x: e.clientX, y: e.clientY });
                      }}
                      onMouseLeave={() => setHoveredSlice(null)}
                      className={`w-full group flex items-center justify-between rounded px-2.5 py-2 text-left text-xs transition border ${
                        active
                          ? "border-primary bg-primary/10 text-foreground font-medium"
                          : "border-transparent hover:bg-muted/60 text-muted-foreground"
                      }`}
                    >
                      <div className="truncate pr-2 flex items-center gap-1.5">
                        <Info className="h-3 w-3 text-muted-foreground/40 group-hover:text-primary transition shrink-0" />
                        <div className="truncate">
                          <span className="font-mono font-medium text-foreground">{s.caseId}</span>
                          <span className="ml-1.5 opacity-60 text-[10px] truncate">{s.stem}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {s.flagged && (
                          <span title={`Flagged: ${s.flagReason || "Not Sure"}`}>
                            <Flag className="h-3.5 w-3.5 fill-amber-400 text-amber-400 shrink-0" />
                          </span>
                        )}
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                            s.label === "bme" ? "bg-red-500/15 text-red-400" : "bg-blue-500/15 text-blue-400"
                          }`}
                        >
                          {s.label === "bme" ? "BME" : "Non-BME"}
                        </span>
                        {s.hasMask && (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Right side: 2D Canvas Editor */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 h-full overflow-hidden">
          {/* Editor Toolbar - Compact Bar vs Full Toolbar */}
          {toolbarCollapsed ? (
            <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5 overflow-x-auto py-1">
              <div className="flex items-center gap-1.5 shrink-0">
                {sidebarCollapsed && (!isCollaborator || permissions.SLICE_CONTROL) && (
                  <button
                    type="button"
                    onClick={() => setSidebarCollapsed(false)}
                    title="Show slice list"
                    className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition cursor-pointer"
                  >
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    <span className="hidden sm:inline">Slices</span>
                  </button>
                )}

                {(!isCollaborator || permissions.ANNOTATE) ? (
                  <>
                    {/* Compact Label Pickers */}
                    <div className="flex items-center gap-1 bg-background/80 rounded-md border border-border p-0.5">
                      {LABELS.map((l) => (
                        <button
                          key={l.id}
                          onClick={() => { setActiveLabel(l.id); setIsErasing(false); }}
                          title={`${l.name} (${l.id})`}
                          className={`p-1 rounded transition cursor-pointer ${
                            !isErasing && activeLabel === l.id ? "bg-primary/20 ring-1 ring-primary" : "hover:bg-muted"
                          }`}
                        >
                          <span className="block h-3 w-3 rounded-full" style={{ backgroundColor: l.stroke }} />
                        </button>
                      ))}
                    </div>

                    <div className="h-4 w-px bg-border" />

                    {/* Tools */}
                    <button
                      type="button"
                      onClick={() => { setTool("brush"); setIsErasing(false); }}
                      title="Brush mode (Key 4 or B)"
                      className={`p-1.5 rounded transition border cursor-pointer ${
                        tool === "brush" && !isErasing ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Paintbrush className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setTool("pencil"); setIsErasing(false); }}
                      title="Pencil mode (Key 5 or P)"
                      className={`p-1.5 rounded transition border cursor-pointer ${
                        tool === "pencil" && !isErasing ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Lasso className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool("pan")}
                      title="Hand mode (Key 6 or H)"
                      className={`p-1.5 rounded transition border cursor-pointer ${
                        tool === "pan" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Hand className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool("torch")}
                      title="Torch - see the scan under the annotation (Key 7, or hold T with any tool)"
                      className={`p-1.5 rounded transition border cursor-pointer ${
                        tool === "torch" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Flashlight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsErasing((e) => !e)}
                      title="Eraser (Key 0 or E)"
                      className={`p-1.5 rounded transition border cursor-pointer ${
                        isErasing ? "border-destructive bg-destructive/10 text-destructive ring-1 ring-destructive" : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Eraser className="h-3.5 w-3.5" />
                    </button>

                    <div className="h-4 w-px bg-border" />

                    {/* Undo / Redo */}
                    <button
                      type="button"
                      onClick={undo}
                      title="Undo (Ctrl+Z)"
                      className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={redo}
                      title="Redo (Ctrl+Y)"
                      className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <div className="flex items-center gap-1.5 rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-1 text-xs text-blue-400 font-medium">
                      <Lock className="h-3 w-3 text-blue-400" />
                      <span className="hidden sm:inline">Review Mode</span>
                    </div>
                    <button
                    type="button"
                    onClick={() => setTool((t) => (t === "torch" ? "pan" : "torch"))}
                    title="Torch - see the scan under the annotation. Nothing is changed. (Key 7, or hold T)"
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                      tool === "torch" ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Flashlight className="h-3 w-3" /> Torch
                  </button>
                  </div>
                )}
              </div>

              {/* Compact Right Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Flag Slice Button */}
                <button
                  type="button"
                  onClick={() => {
                    if (selected) {
                      setFlagReason(selected.flagReason || "Not Sure");
                      setFlagNote(selected.flagNote || "");
                      setFlagModalOpen(true);
                    }
                  }}
                  title={selected?.flagged ? `Flagged: ${selected.flagReason || "Not Sure"}` : "Flag slice"}
                  className={`p-1.5 rounded border transition cursor-pointer ${
                    selected?.flagged ? "border-amber-500/50 bg-amber-500/15 text-amber-500" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Flag className={`h-3.5 w-3.5 ${selected?.flagged ? "fill-amber-500 text-amber-500" : ""}`} />
                </button>

                {(!isCollaborator || permissions.DELETE_ANNOTATION) && (
                  <button
                    onClick={clearMask}
                    title="Clear current canvas mask"
                    className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-destructive transition cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
                {selected?.hasMask && (!isCollaborator || permissions.DELETE_ANNOTATION) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete saved mask for ${selected.caseId} (${selected.stem})?`)) {
                        deleteMask();
                      }
                    }}
                    disabled={deletingMask}
                    title="Delete saved mask permanently"
                    className="p-1.5 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 transition cursor-pointer"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                  </button>
                )}
                {!isCollaborator ? (
                  <button
                    type="button"
                    onClick={startCollaboration}
                    disabled={startingCollab}
                    title={collabToken ? "Collab Panel" : "Start Collaboration"}
                    className="p-1.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition cursor-pointer"
                  >
                    <Users className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                {(!isCollaborator || permissions.ANNOTATE || permissions.EDIT_ANNOTATION) && (
                  <button
                    onClick={saveMask}
                    disabled={saving || !selected}
                    title="Save Mask (Ctrl+S)"
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
                      savedSuccess ? "bg-emerald-600 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90"
                    }`}
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : savedSuccess ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                    <span>{savedSuccess ? "Saved" : "Save"}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setToolbarCollapsed(false)}
                  title="Expand full toolbar"
                  className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer ml-1"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
              {(!isCollaborator || permissions.ANNOTATE) ? (
                <div className="flex flex-wrap items-center gap-2">
                  {sidebarCollapsed && (!isCollaborator || permissions.SLICE_CONTROL) && (
                    <button
                      type="button"
                      onClick={() => setSidebarCollapsed(false)}
                      title="Show slice list"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-muted transition mr-1 cursor-pointer"
                    >
                      <Layers className="h-3.5 w-3.5 text-primary" />
                      <span>Slices ({slices.length})</span>
                    </button>
                  )}

                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
                    Label:
                  </span>
                  {LABELS.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => { setActiveLabel(l.id); setIsErasing(false); }}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                        !isErasing && activeLabel === l.id
                          ? `${l.badge} ring-1 ring-primary`
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.stroke }} />
                      {l.name} <span className="text-[10px] opacity-60">({l.id})</span>
                    </button>
                  ))}

                  <div className="mx-1 h-5 w-px bg-border" />

                  {/* Tool Mode: Brush (4) vs Pencil (5) vs Hand (6) */}
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    <button
                      type="button"
                      onClick={() => setTool("brush")}
                      title="Brush mode (Key 4 or B)"
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs transition cursor-pointer ${
                        tool === "brush" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Paintbrush className="h-3 w-3" /> Brush <span className="text-[10px] opacity-60">(4)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool("pencil")}
                      title="Pencil mode — trace an outline, the inside auto-fills (Key 5 or P)"
                      className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-xs transition cursor-pointer ${
                        tool === "pencil" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Lasso className="h-3 w-3" /> Pencil <span className="text-[10px] opacity-60">(5)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool("pan")}
                      title="Hand mode — click & drag to pan canvas (Key 6 or H)"
                      className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-xs transition cursor-pointer ${
                        tool === "pan" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Hand className="h-3 w-3" /> Hand <span className="text-[10px] opacity-60">(6)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTool("torch")}
                      title="Torch - hides the annotation around the cursor so you can see the scan underneath. Nothing is erased. (Key 7, or hold T with any tool)"
                      className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-xs transition cursor-pointer ${
                        tool === "torch" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Flashlight className="h-3 w-3" /> Torch <span className="text-[10px] opacity-60">(7)</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setIsErasing((e) => !e)}
                    title="Toggle eraser mode (Key 0 or E)"
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                      isErasing
                        ? "border-destructive bg-destructive/10 text-destructive ring-1 ring-destructive"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Eraser className="h-3.5 w-3.5" /> Eraser <span className="text-[10px] opacity-60">(0)</span>
                  </button>

                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none ml-1">
                    <input
                      type="checkbox"
                      checked={maskInside}
                      onChange={(e) => setMaskInside(e.target.checked)}
                      className="rounded border-border accent-primary h-3.5 w-3.5"
                    />
                    <span>Only inside bone</span>
                  </label>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-md bg-blue-500/10 border border-blue-500/20 px-3 py-1 text-xs text-blue-400 font-medium">
                    <Lock className="h-3.5 w-3.5 text-blue-400" />
                    <span>Read-Only Review Mode — Drawing locked by Master</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTool((t) => (t === "torch" ? "pan" : "torch"))}
                    title="Torch - see the scan under the annotation. Nothing is changed. (Key 7, or hold T)"
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                      tool === "torch" ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Flashlight className="h-3.5 w-3.5" /> Torch
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3">
                {(!isCollaborator || permissions.ANNOTATE) && tool === "brush" && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Paintbrush className="h-3.5 w-3.5" />
                    <span>Size: {brushSize}px</span>
                    <input
                      type="range"
                      min={2}
                      max={50}
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                      className="w-20 accent-primary"
                    />
                  </div>
                )}
                {tool === "torch" && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Flashlight className="h-3.5 w-3.5" />
                    <span>Torch: {torchSize}px</span>
                    <input
                      type="range"
                      min={8}
                      max={240}
                      step={4}
                      value={torchSize}
                      onChange={(e) => setTorchSize(Number(e.target.value))}
                      className="w-20 accent-primary"
                    />
                  </div>
                )}

                {/* Zoom Controls */}
                <div className="flex items-center gap-1 border-l border-border pl-2">
                  <button
                    type="button"
                    disabled={isCollaborator && !permissions.ZOOM_PAN}
                    onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.2).toFixed(1))))}
                    title={isCollaborator && !permissions.ZOOM_PAN ? "Zoom locked by Master" : "Zoom Out"}
                    className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={isCollaborator && !permissions.ZOOM_PAN}
                    onClick={resetZoom}
                    title="Reset Zoom to 100%"
                    className="px-1.5 py-0.5 rounded text-xs font-mono font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    disabled={isCollaborator && !permissions.ZOOM_PAN}
                    onClick={() => setZoom((z) => Math.min(4, Number((z + 0.2).toFixed(1))))}
                    title={isCollaborator && !permissions.ZOOM_PAN ? "Zoom locked by Master" : "Zoom In"}
                    className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={isCollaborator && !permissions.ZOOM_PAN}
                    onClick={resetZoom}
                    title="Fit / Reset"
                    className="inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-background text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Undo & Redo (only when annotation allowed) */}
                {(!isCollaborator || permissions.ANNOTATE) && (
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    <button
                      type="button"
                      onClick={undo}
                      title="Undo (Ctrl+Z)"
                      className="inline-flex items-center gap-1 bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
                    >
                      <RotateCcw className="h-3 w-3" /> Undo
                    </button>
                    <button
                      type="button"
                      onClick={redo}
                      title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
                      className="inline-flex items-center gap-1 border-l border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
                    >
                      <RotateCw className="h-3 w-3" /> Redo
                    </button>
                  </div>
                )}

                {/* Flag Slice button */}
                <button
                  type="button"
                  onClick={() => {
                    if (selected) {
                      setFlagReason(selected.flagReason || "Not Sure");
                      setFlagNote(selected.flagNote || "");
                      setFlagModalOpen(true);
                    }
                  }}
                  title={
                    selected?.flagged
                      ? `Flagged: ${selected.flagReason || "Not Sure"}`
                      : "Flag this annotation for review (e.g. Not Sure)"
                  }
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                    selected?.flagged
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 ring-1 ring-amber-500/30"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Flag className={`h-3.5 w-3.5 ${selected?.flagged ? "fill-amber-500 text-amber-500" : ""}`} />
                  <span>{selected?.flagged ? "Flagged" : "Flag"}</span>
                </button>

                {/* Auto Save (only when annotation allowed) */}
                {(!isCollaborator || permissions.ANNOTATE) && (
                  <div className="flex items-center gap-1.5 border-l border-border pl-2">
                    <label
                      className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
                      title="Auto-save annotation mask after each stroke/edit"
                    >
                      <input
                        type="checkbox"
                        checked={autoSave}
                        onChange={(e) => {
                          setAutoSave(e.target.checked);
                          try {
                            localStorage.setItem("bme_painter2d_autosave", e.target.checked ? "true" : "false");
                          } catch { /* ignore */ }
                          if (e.target.checked) toast.success("Auto Save enabled");
                          else toast.info("Auto Save disabled");
                        }}
                        className="rounded border-border accent-primary h-3.5 w-3.5"
                      />
                      <span className="font-medium">Auto Save</span>
                    </label>
                    {autoSaveStatus && (
                      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[130px]">
                        {autoSaveStatus}
                      </span>
                    )}
                  </div>
                )}

                {/* Collaboration Button (Master only) vs Participant Indicator (Collaborator) */}
                {!isCollaborator ? (
                  <button
                    type="button"
                    onClick={startCollaboration}
                    disabled={startingCollab}
                    className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-400 hover:bg-blue-500/20 transition-all cursor-pointer"
                  >
                    <Users className="h-3.5 w-3.5" />
                    <span>{collabToken ? "Collab Panel" : "Start Collaboration"}</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-300">
                    <Users className="h-3.5 w-3.5" />
                    <span>Review Session ({collab.participants.length})</span>
                  </div>
                )}

                {/* Clear Mask Button (only if delete permission) */}
                {(!isCollaborator || permissions.DELETE_ANNOTATION) && (
                  <button
                    onClick={clearMask}
                    title="Clear current canvas mask"
                    className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-destructive transition cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}

                {/* Delete Saved Mask (Master only or if delete permission) */}
                {selected?.hasMask && (!isCollaborator || permissions.DELETE_ANNOTATION) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete saved mask for ${selected.caseId} (${selected.stem})?`)) {
                        deleteMask();
                      }
                    }}
                    disabled={deletingMask}
                    title="Delete saved mask permanently from server"
                    className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20 transition cursor-pointer"
                  >
                    <XCircle className="h-3 w-3" />
                    <span className="hidden sm:inline">Delete Mask</span>
                  </button>
                )}

                {/* Save Mask (only if annotate or edit permission) */}
                {(!isCollaborator || permissions.ANNOTATE || permissions.EDIT_ANNOTATION) && (
                  <button
                    onClick={saveMask}
                    disabled={saving || !selected}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer ${
                      savedSuccess
                        ? "bg-emerald-600 text-white"
                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                    }`}
                  >
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : savedSuccess ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {savedSuccess ? "Saved!" : "Save Mask"}
                  </button>
                )}

                {/* Collapse Toolbar Toggle */}
                <button
                  type="button"
                  onClick={() => setToolbarCollapsed(true)}
                  title="Collapse to compact toolbar"
                  className="p-1 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

        {/* Flagged Slice Banner */}
        {selected?.flagged && (
          <div className="flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
            <div className="flex items-center gap-2">
              <Flag className="h-3.5 w-3.5 fill-amber-400 text-amber-400 shrink-0" />
              <span>
                <strong>Flagged for review:</strong> {selected.flagReason || "Not Sure"}
                {selected.flagNote ? ` — "${selected.flagNote}"` : ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setFlagReason(selected.flagReason || "Not Sure");
                setFlagNote(selected.flagNote || "");
                setFlagModalOpen(true);
              }}
              className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30 transition"
            >
              Edit Flag
            </button>
          </div>
        )}

        {/* Info bar */}
        {selected && (
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <div className="flex items-center gap-3">
              <span className="font-mono font-medium text-foreground">{selected.caseId}</span>
              <span>{selected.stem}.png</span>
              <span>{imgDim.w} &times; {imgDim.h} px</span>
            </div>
            <div className="flex items-center gap-3">
              <span>Bone: <strong className="text-emerald-400 font-mono">{counts.bone}</strong> px</span>
              <span>BME: <strong className="text-red-400 font-mono">{counts.bme}</strong> px</span>
              {counts.uncertain > 0 && <span>Uncertain: <strong className="text-amber-400 font-mono">{counts.uncertain}</strong> px</span>}
            </div>
          </div>
        )}

        {/* Viewport Canvas Container with Zoom and Pan */}
        <div
          ref={viewportRef}
          className={`relative flex-1 overflow-hidden rounded border border-border/80 bg-black/95 flex items-center justify-center select-none p-2 ${
            tool === "pan" ? (isPanning ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
          }`}
          onMouseDown={(e) => {
            if (tool === "pan" && e.button === 0) {
              if (isCollaborator && !permissions.ZOOM_PAN) return;
              setIsPanning(true);
              panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
            }
          }}
          onMouseMove={(e) => {
            if (tool === "pan" && isPanning) {
              if (!isCollaborator || permissions.ZOOM_PAN) {
                setPan({
                  x: e.clientX - panStartRef.current.x,
                  y: e.clientY - panStartRef.current.y,
                });
              }
            }
          }}
          onMouseUp={() => {
            if (isPanning) setIsPanning(false);
          }}
          onWheel={(e) => {
            if (isCollaborator && !permissions.ZOOM_PAN) return;
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.15 : -0.15;
            setZoom((z) => Math.min(4, Math.max(0.4, Number((z + delta).toFixed(2)))));
          }}
        >
          <div
            className="relative shadow-2xl inline-block transition-transform duration-75 origin-center"
            style={{
              width: imgDim.w || 512,
              height: imgDim.h || 512,
              transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            {/* Base MRI image as rock-solid <img> element (never blanks or wipes) */}
            {selected && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={withAccess(`/api/cases2d?image=${encodeURIComponent(selected.relPath)}`)}
                alt={selected.stem}
                className="absolute inset-0 block pointer-events-none select-none w-full h-full object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            )}
            {/* Drawing mask layer canvas */}
            <canvas
              ref={maskCanvasRef}
              // Size is set imperatively by the slice loader and by
              // renderMaskToCanvas. Setting it here as well means React
              // re-applies it on the render that follows setImgDim, and
              // assigning canvas.width wipes the canvas - so the mask is
              // cleared a second time, after it has already been drawn.
              style={{ width: "100%", height: "100%", touchAction: "none" }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => {
                clearTorch();
                handleMouseUp();
              }}
              onDoubleClick={handleDoubleClick}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
              className={`absolute inset-0 block ${
                tool === "pan" ? (isPanning ? "cursor-grabbing" : "cursor-grab") : tool === "torch" ? "cursor-none" : "cursor-crosshair"
              }`}
            />
            {/* Live pencil polygon overlay preview canvas */}
            <canvas
              ref={overlayCanvasRef}
              style={{ width: "100%", height: "100%", touchAction: "none" }}
              className="absolute inset-0 block pointer-events-none"
            />
            {/* Torch outline: positioned by updateTorch, hidden until used */}
            <div
              ref={torchRingRef}
              aria-hidden
              className="absolute pointer-events-none rounded-full border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{ display: "none", transform: "translate(-50%, -50%)", borderStyle: "solid", borderWidth: `${1.5 / zoom}px` }}
            />
            {/* Live participant cursors overlay for Master */}
            {collabToken && collab.connected && (
              <LiveCursorsOverlay
                participants={collab.participants}
                currentUserId={collab.currentUserId}
                activePlane="axial"
                containerWidth={imgDim.w || 512}
                containerHeight={imgDim.h || 512}
              />
            )}
          </div>

          {/* Touch / Touchpad Double-Tap Draw Active Indicator */}
          {isLockedDraw && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full border border-sky-500/60 bg-sky-950/90 backdrop-blur-md px-4 py-1.5 text-xs text-sky-200 shadow-xl shadow-sky-950/50 animate-pulse">
              <span className="h-2 w-2 rounded-full bg-sky-400 animate-ping" />
              <span className="font-semibold tracking-wide">Touch / Touchpad Draw Active:</span>
              <span className="text-sky-300">Glide finger to mark &bull; Single Tap or Esc to finish</span>
            </div>
          )}
        </div>
      </div>
    </div>

      {/* Flag Modal Dialog */}
      {flagModalOpen && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Flag className="h-4 w-4 text-amber-500 fill-amber-500" />
                <h3 className="font-semibold text-sm">Flag Slice for Review</h3>
              </div>
              <button
                type="button"
                onClick={() => setFlagModalOpen(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="text-xs text-muted-foreground">
              Slice: <strong className="font-mono text-foreground">{selected.caseId}</strong> / {selected.stem}.png
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-muted-foreground">Reason for flagging:</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  "Not Sure",
                  "Questionable Edema",
                  "Needs Expert Review",
                  "Image Artifact / Quality",
                ].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setFlagReason(r)}
                    className={`rounded-md border p-2 text-left text-xs transition ${
                      flagReason === r
                        ? "border-amber-500 bg-amber-500/15 text-amber-500 font-semibold"
                        : "border-border hover:bg-muted text-muted-foreground"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-muted-foreground">Optional Note / Observation:</label>
              <textarea
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                placeholder="e.g. Unclear edema boundary along lateral condyle..."
                rows={3}
                className="w-full rounded-md border border-border bg-background p-2 text-xs focus:border-primary focus:outline-hidden"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              {selected.flagged ? (
                <button
                  type="button"
                  onClick={handleRemoveFlag}
                  disabled={flagSaving}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 transition"
                >
                  Remove Flag
                </button>
              ) : (
                <div />
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFlagModalOpen(false)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveFlag(flagReason, flagNote)}
                  disabled={flagSaving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 transition"
                >
                  {flagSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save Flag
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Info Tooltip on Slice Hover */}
      {hoveredSlice && (
        <div
          style={{
            top: Math.min(window.innerHeight - 170, Math.max(10, hoverPos.y - 40)),
            left: Math.min(window.innerWidth - 300, hoverPos.x + 18),
          }}
          className="fixed z-50 pointer-events-none w-72 rounded-lg border border-border bg-card/95 p-3 shadow-2xl backdrop-blur text-xs"
        >
          <div className="flex items-center justify-between border-b border-border pb-1.5">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Info className="h-3.5 w-3.5 text-primary" />
              <span className="font-mono font-semibold">{hoveredSlice.caseId}</span>
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                hoveredSlice.label === "bme"
                  ? "bg-red-500/20 text-red-400 border border-red-500/30"
                  : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
              }`}
            >
              {hoveredSlice.label === "bme" ? "BME Positive" : "Non-BME"}
            </span>
          </div>
          <div className="mt-2 space-y-1.5 text-[11px]">
            <div>
              <span className="text-muted-foreground font-medium">Slice stem:</span>
              <div className="font-mono text-foreground font-medium break-all">{hoveredSlice.stem}</div>
            </div>
            <div>
              <span className="text-muted-foreground font-medium">File Path:</span>
              <div className="font-mono text-muted-foreground break-all">{hoveredSlice.relPath}</div>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-border/50">
              <span className="text-muted-foreground">Annotation status:</span>
              <span className={hoveredSlice.hasMask ? "text-emerald-400 font-medium flex items-center gap-1" : "text-amber-400"}>
                {hoveredSlice.hasMask ? (
                  <>
                    <CheckCircle2 className="h-3 w-3" />
                    {hoveredSlice.maskSavedAt ? new Date(hoveredSlice.maskSavedAt).toLocaleDateString() : "Annotated"}
                  </>
                ) : (
                  "Unannotated"
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {showMasterPanel && collabToken && (
        <div
          onClick={() => setShowMasterPanel(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm cursor-pointer animate-in fade-in duration-150"
        >
          <div onClick={(e) => e.stopPropagation()} className="cursor-default">
            <CollaborationMasterPanel
              shareUrl={shareUrl}
              followUserId={followUserId}
              onFollowUser={setFollowUserId}
              participants={collab.participants}
              currentUserId={collab.currentUserId}
              onUpdatePermission={collab.updatePermission}
              onRemoveUser={collab.removeUser}
              onEndSession={() => {
                collab.endSession();
                forgetHostSession();
              }}
              onClose={() => setShowMasterPanel(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

