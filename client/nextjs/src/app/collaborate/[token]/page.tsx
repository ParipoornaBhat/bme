"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Download,
  Eye,
  Layers,
  Lock,
  Paintbrush,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Sparkles,
  Stethoscope,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import CollaborationViewerHeader from "~/components/collaborate/CollaborationViewerHeader";
import LiveCursorsOverlay from "~/components/collaborate/LiveCursorsOverlay";
import { useCollaboration, type Participant, type ViewpointState } from "~/lib/useCollaboration";

type Case2DSlice = {
  caseId: string;
  label: "bme" | "non_bme";
  relPath: string;
  stem: string;
  hasMask: boolean;
};

/**
 * Restricted Radiologist Collaboration Viewer Page.
 * Route: /collaborate/[token]
 */
export default function CollaborateViewerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [sessionData, setSessionData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Radiologist Name Sign-in state
  const [userName, setUserName] = useState<string>("");
  const [nameSubmitted, setNameSubmitted] = useState<boolean>(false);
  const [inputName, setInputName] = useState<string>("");

  // Load saved radiologist name from localStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("bme_collab_radiologist_name");
      if (saved) {
        setUserName(saved);
        setInputName(saved);
        setNameSubmitted(true);
      }
    }
  }, []);

  // Slices index
  const [slices, setSlices] = useState<Case2DSlice[]>([]);

  // Volume & canvas state
  const [sliceIndex, setSliceIndex] = useState(0);
  const [maxSlices, setMaxSlices] = useState(100);
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [plane, setPlane] = useState<"axial" | "coronal" | "sagittal">("axial");
  const [windowLevel, setWindowLevel] = useState({ lo: 0, hi: 255 });
  const [followingMaster, setFollowingMaster] = useState(true);

  // Active slice identifiers
  const [activeCaseId, setActiveCaseId] = useState<string>("");
  const [activeStem, setActiveStem] = useState<string>("");
  const [activeRelPath, setActiveRelPath] = useState<string>("");
  const [imgDim, setImgDim] = useState<{ w: number; h: number }>({ w: 512, h: 512 });

  const containerRef = useRef<HTMLDivElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastLoadedRelPathRef = useRef<string>("");

  // Real-time collaboration hook
  const {
    connected,
    role,
    currentUserId,
    permissions,
    viewpoint,
    participants,
    caseId,
    sessionEnded,
    removed,
    updateCursor,
    updateViewpoint,
  } = useCollaboration({
    token,
    userName: nameSubmitted ? userName : undefined,
    onViewpointUpdated: (vp) => {
      if (followingMaster) {
        if (vp.sliceIndex !== undefined) setSliceIndex(vp.sliceIndex);
        if (vp.maxSlices !== undefined) setMaxSlices(vp.maxSlices);
        if (vp.zoom !== undefined) setZoom(vp.zoom);
        if (vp.pan !== undefined) setPan(vp.pan);
        if (vp.plane !== undefined) setPlane(vp.plane);
        if (vp.windowLevel !== undefined) setWindowLevel(vp.windowLevel);
        if (vp.selectedCaseId) setActiveCaseId(vp.selectedCaseId);
        if (vp.selectedStem) setActiveStem(vp.selectedStem);
        if (vp.selectedRelPath) setActiveRelPath(vp.selectedRelPath);
      }
    },
    onMaskUpdated: (data) => {
      if (!data.maskDataUrl) return;
      const maskImg = new Image();
      maskImg.src = data.maskDataUrl;
      maskImg.onload = () => {
        const mw = maskImg.naturalWidth || data.width || 512;
        const mh = maskImg.naturalHeight || data.height || 512;
        const off = document.createElement("canvas");
        off.width = mw;
        off.height = mh;
        const offCtx = off.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(maskImg, 0, 0);
          const pxData = offCtx.getImageData(0, 0, mw, mh).data;
          rawMaskDataRef.current = new Uint8Array(pxData);
          rawMaskDimRef.current = { w: mw, h: mh };
          renderMaskToCanvas();
        }
      };
    },
  });

  // Toast notifications when participants join or leave (keyed by boolean connected state)
  const prevConnectedMapRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (participants.length === 0) return;
    const prevMap = prevConnectedMapRef.current;
    const newMap = new Map<string, boolean>();

    participants.forEach((p) => newMap.set(p.id, p.connected));

    // Notify for new connected participants
    participants.forEach((p) => {
      if (p.id !== currentUserId && p.connected) {
        const wasConn = prevMap.get(p.id);
        if (wasConn === false || (wasConn === undefined && prevMap.size > 0)) {
          toast.info(`🩺 ${p.name} joined the review session`);
        }
      }
    });

    // Notify for disconnected participants
    prevMap.forEach((wasConn, uid) => {
      if (uid !== currentUserId && wasConn) {
        const target = participants.find((p) => p.id === uid);
        if (!target || !target.connected) {
          const name = target?.name || `Participant`;
          toast.warning(`🩺 ${name} left the review session`);
        }
      }
    });

    prevConnectedMapRef.current = newMap;
  }, [participants, currentUserId]);

  // Load available 2D slice index list once on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/cases2d", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data.slices && Array.isArray(data.slices)) {
            setSlices(data.slices);
            if (data.slices.length > 0) {
              setMaxSlices(data.slices.length);
            }
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Sync active slice identifiers whenever viewpoint or sliceIndex or slices change
  useEffect(() => {
    let targetRelPath = viewpoint?.selectedRelPath || "";
    let targetStem = viewpoint?.selectedStem || "";
    let targetCaseId = viewpoint?.selectedCaseId || "";

    // If viewpoint provided stem/caseId but not relPath, resolve from slices list
    if (!targetRelPath && (targetStem || targetCaseId) && slices.length > 0) {
      const found = slices.find(
        (s) => (targetStem && s.stem === targetStem) || (targetCaseId && s.caseId === targetCaseId)
      );
      if (found) {
        targetRelPath = found.relPath;
        targetStem = found.stem;
        targetCaseId = found.caseId;
      }
    }

    // Fallback to sliceIndex in slices array if no viewpoint match
    if (!targetRelPath && slices.length > 0) {
      const idx = Math.min(Math.max(0, sliceIndex), slices.length - 1);
      const s = slices[idx];
      if (s) {
        targetRelPath = s.relPath;
        targetStem = s.stem;
        targetCaseId = s.caseId;
      }
    }

    if (targetRelPath) setActiveRelPath(targetRelPath);
    if (targetStem) setActiveStem(targetStem);
    if (targetCaseId) setActiveCaseId(targetCaseId);
  }, [viewpoint, sliceIndex, slices]);

  const rawMaskDataRef = useRef<Uint8Array | null>(null);
  const rawMaskDimRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  // Render mask data onto HTML5 canvas with exact color mapping
  const renderMaskToCanvas = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (!mc) return;
    const ctx = mc.getContext("2d");
    if (!ctx) return;

    const w = imgDim.w || 512;
    const h = imgDim.h || 512;
    mc.width = w;
    mc.height = h;
    ctx.clearRect(0, 0, w, h);

    const maskData = rawMaskDataRef.current;
    if (!maskData) return;
    const mw = rawMaskDimRef.current.w;
    const mh = rawMaskDimRef.current.h;
    if (mw === 0 || mh === 0) return;

    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    if (mw === w && mh === h) {
      for (let i = 0; i < w * h; i++) {
        const p = i * 4;
        const r = maskData[p];
        const g = maskData[p + 1];
        const b = maskData[p + 2];
        const a = maskData[p + 3];

        if (r === 1 && (g === 1 || g === 0) && (b === 1 || b === 0)) {
          // Bone Marrow raw index 1 -> Green
          data[p] = 16; data[p + 1] = 185; data[p + 2] = 129; data[p + 3] = 175;
        } else if (r === 2 && (g === 2 || g === 0) && (b === 2 || b === 0)) {
          // BME Lesion raw index 2 -> Red
          data[p] = 239; data[p + 1] = 68; data[p + 2] = 68; data[p + 3] = 195;
        } else if (r === 3 && (g === 3 || g === 0) && (b === 3 || b === 0)) {
          // Edema/Subchondral raw index 3 -> Amber
          data[p] = 245; data[p + 1] = 158; data[p + 2] = 11; data[p + 3] = 185;
        } else if (r > 0 || g > 0 || b > 0) {
          // Pre-colored RGB/RGBA pixel from live painter canvas or export
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
          data[p + 3] = a > 0 ? Math.max(a, 175) : 175;
        } else {
          data[p + 3] = 0;
        }
      }
    } else {
      const scaleX = mw / w;
      const scaleY = mh / h;
      for (let y = 0; y < h; y++) {
        const sy = Math.min(mh - 1, Math.floor(y * scaleY));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(mw - 1, Math.floor(x * scaleX));
          const pOrig = (sy * mw + sx) * 4;
          const r = maskData[pOrig];
          const g = maskData[pOrig + 1];
          const b = maskData[pOrig + 2];
          const a = maskData[pOrig + 3];

          const p = (y * w + x) * 4;
          if (r === 1 && (g === 1 || g === 0) && (b === 1 || b === 0)) {
            data[p] = 16; data[p + 1] = 185; data[p + 2] = 129; data[p + 3] = 175;
          } else if (r === 2 && (g === 2 || g === 0) && (b === 2 || b === 0)) {
            data[p] = 239; data[p + 1] = 68; data[p + 2] = 68; data[p + 3] = 195;
          } else if (r === 3 && (g === 3 || g === 0) && (b === 3 || b === 0)) {
            data[p] = 245; data[p + 1] = 158; data[p + 2] = 11; data[p + 3] = 185;
          } else if (r > 0 || g > 0 || b > 0) {
            data[p] = r;
            data[p + 1] = g;
            data[p + 2] = b;
            data[p + 3] = a > 0 ? Math.max(a, 175) : 175;
          } else {
            data[p + 3] = 0;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [imgDim.w, imgDim.h]);

  // Redraw mask whenever image dimensions update
  useEffect(() => {
    if (imgDim.w > 0 && imgDim.h > 0) {
      renderMaskToCanvas();
    }
  }, [imgDim.w, imgDim.h, renderMaskToCanvas]);

  // Fetch mask file whenever active slice identifiers change
  useEffect(() => {
    if (!activeRelPath) return;

    const targetCaseId = activeCaseId || (slices.length > 0 ? slices[sliceIndex]?.caseId : "");
    const targetStem = activeStem || (slices.length > 0 ? slices[sliceIndex]?.stem : "");

    const loadKey = `${targetCaseId}/${targetStem}`;
    if (lastLoadedRelPathRef.current === loadKey) {
      renderMaskToCanvas();
      return;
    }
    lastLoadedRelPathRef.current = loadKey;

    let cancelled = false;

    if (!targetCaseId || !targetStem) {
      rawMaskDataRef.current = null;
      rawMaskDimRef.current = { w: 0, h: 0 };
      renderMaskToCanvas();
      return;
    }

    (async () => {
      try {
        const maskRes = await fetch(
          `/api/annotation2d/${targetCaseId}?stem=${encodeURIComponent(targetStem)}&raw=true`
        );
        if (cancelled) return;
        if (maskRes.ok && maskRes.headers.get("content-type")?.includes("image")) {
          const blob = await maskRes.blob();
          if (cancelled) return;
          const maskImg = new Image();
          const blobUrl = URL.createObjectURL(blob);
          maskImg.src = blobUrl;
          maskImg.onload = () => {
            URL.revokeObjectURL(blobUrl);
            if (cancelled) return;
            const mw = maskImg.naturalWidth;
            const mh = maskImg.naturalHeight;
            const off = document.createElement("canvas");
            off.width = mw;
            off.height = mh;
            const offCtx = off.getContext("2d");
            if (offCtx) {
              offCtx.drawImage(maskImg, 0, 0);
              const pxData = offCtx.getImageData(0, 0, mw, mh).data;
              rawMaskDataRef.current = new Uint8Array(pxData);
              rawMaskDimRef.current = { w: mw, h: mh };
              renderMaskToCanvas();
            }
          };
        } else {
          rawMaskDataRef.current = null;
          rawMaskDimRef.current = { w: 0, h: 0 };
          renderMaskToCanvas();
        }
      } catch {
        rawMaskDataRef.current = null;
        rawMaskDimRef.current = { w: 0, h: 0 };
        renderMaskToCanvas();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeRelPath, activeStem, activeCaseId, slices, sliceIndex, renderMaskToCanvas]);

  // Fetch initial session info server-side validated
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch(`/api/collaborate/session/${token}`);
        if (!res.ok) {
          let errorMsg = "Session invalid or expired";
          try {
            const contentType = res.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
              const j = await res.json();
              errorMsg = j.error || errorMsg;
            }
          } catch { /* fallback */ }
          if (res.status === 502 || res.status === 504) {
            errorMsg = "Backend API server (port 4000) is unreachable. Please make sure the backend server is running via 'pnpm dev'.";
          }
          setError(errorMsg);
          setLoading(false);
          return;
        }
        const data = await res.json();
        setSessionData(data);
        if (data.viewpoint) {
          setSliceIndex(data.viewpoint.sliceIndex ?? 0);
          setMaxSlices(data.viewpoint.maxSlices ?? 100);
          setZoom(data.viewpoint.zoom ?? 1.0);
          setPan(data.viewpoint.pan ?? { x: 0, y: 0 });
          setPlane(data.viewpoint.plane ?? "axial");
          setWindowLevel(data.viewpoint.windowLevel ?? { lo: 0, hi: 255 });
          if (data.viewpoint.selectedCaseId) setActiveCaseId(data.viewpoint.selectedCaseId);
          if (data.viewpoint.selectedStem) setActiveStem(data.viewpoint.selectedStem);
          if (data.viewpoint.selectedRelPath) setActiveRelPath(data.viewpoint.selectedRelPath);
        }
        setLoading(false);
      } catch (err: any) {
        setError("Failed to connect to collaboration server");
        setLoading(false);
      }
    }
    loadSession();
  }, [token]);

  // Handle canvas mouse movements for live cursor
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    updateCursor({ x, y, plane });
  };

  // Slice change (only allowed if permissions.SLICE_CONTROL is true)
  const handleSliceChange = (newSlice: number) => {
    if (!permissions.SLICE_CONTROL) return;
    setSliceIndex(newSlice);
    if (slices[newSlice]) {
      setActiveCaseId(slices[newSlice].caseId);
      setActiveStem(slices[newSlice].stem);
      setActiveRelPath(slices[newSlice].relPath);
      updateViewpoint({
        sliceIndex: newSlice,
        selectedCaseId: slices[newSlice].caseId,
        selectedStem: slices[newSlice].stem,
        selectedRelPath: slices[newSlice].relPath,
      });
    } else {
      updateViewpoint({ sliceIndex: newSlice });
    }
  };

  // Zoom change (only allowed if permissions.ZOOM_PAN is true)
  const handleZoomChange = (delta: number) => {
    if (!permissions.ZOOM_PAN) return;
    const newZoom = Math.max(0.5, Math.min(4.0, zoom + delta));
    setZoom(newZoom);
    updateViewpoint({ zoom: newZoom });
  };

  const masterConnected = participants.some((p) => p.role === "MASTER" && p.connected);

  // 1. Name Sign-In Prompt Modal
  if (!nameSubmitted) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="flex max-w-md w-full flex-col rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl backdrop-blur-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <Stethoscope className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold text-white">
            Join Radiologist Review Session
          </h1>
          <p className="mt-1.5 text-xs text-slate-400">
            Please enter your name or medical title to participate in this real-time MRI consultation.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = inputName.trim() || `Dr. Radiologist`;
              setUserName(trimmed);
              if (typeof window !== "undefined") {
                localStorage.setItem("bme_collab_radiologist_name", trimmed);
              }
              setNameSubmitted(true);
            }}
            className="mt-6 flex flex-col gap-4 text-left"
          >
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Your Name / Title
              </label>
              <input
                type="text"
                required
                autoFocus
                placeholder="e.g. Dr. Sarah Jenkins"
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 py-2.5 px-3.5 text-sm text-slate-100 placeholder-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-lg hover:bg-blue-500 transition-all cursor-pointer active:scale-95"
            >
              <Stethoscope className="h-4 w-4" />
              Join Session
            </button>
          </form>

          <span className="mt-5 text-[11px] text-slate-500">
            Zero Cloud Storage • Local Security Active
          </span>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
        <RefreshCw className="h-8 w-8 animate-spin text-blue-500" />
        <span className="mt-3 text-sm font-medium text-slate-400">
          Connecting to secure collaboration session...
        </span>
      </div>
    );
  }

  if (error || sessionEnded || removed) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="flex max-w-md flex-col items-center rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
          <ShieldAlert className="h-12 w-12 text-red-500" />
          <h1 className="mt-4 text-xl font-bold text-white">
            {removed ? "Access Revoked" : sessionEnded ? "Session Ended" : "Session Unavailable"}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {removed
              ? "You were removed from this collaboration session by the Master."
              : sessionEnded
              ? "The Master radiologist has ended this review session."
              : error}
          </p>
        </div>
      </div>
    );
  }

  const currentCaseName = activeStem || activeCaseId || caseId || sessionData?.caseId || "BME-2D-004";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Viewer Header */}
      <CollaborationViewerHeader
        caseId={currentCaseName}
        masterConnected={masterConnected}
        followingMaster={followingMaster}
        permissions={permissions}
      />

      {/* Main MRI Viewer Canvas Container */}
      <div className="relative flex flex-1 overflow-hidden bg-black">
        {/* Canvas Display Viewport */}
        <div
          ref={containerRef}
          onMouseMove={handleMouseMove}
          className="relative flex flex-1 items-center justify-center overflow-hidden cursor-crosshair"
        >
          {/* Live Participant Cursors Overlay */}
          <LiveCursorsOverlay
            participants={participants}
            currentUserId={currentUserId}
            activePlane={plane}
            containerWidth={containerRef.current?.clientWidth ?? 800}
            containerHeight={containerRef.current?.clientHeight ?? 600}
          />

          {/* MRI Render Canvas Container */}
          <div
            className="relative transition-transform duration-75 ease-out select-none"
            style={{
              transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <div className="relative flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-2xl backdrop-blur-md">
              <div
                className="relative flex items-center justify-center overflow-hidden rounded-lg bg-black shadow-inner"
                style={{
                  width: imgDim.w ? `${Math.min(imgDim.w, 560)}px` : "512px",
                  height: imgDim.h ? `${Math.min(imgDim.h, 560)}px` : "512px",
                  aspectRatio: imgDim.w && imgDim.h ? `${imgDim.w} / ${imgDim.h}` : "1 / 1",
                }}
              >
                {/* Base MRI Image */}
                {activeRelPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/cases2d?image=${encodeURIComponent(activeRelPath)}`}
                    alt={activeStem || "MRI Slice"}
                    onLoad={(e) => {
                      const target = e.currentTarget;
                      if (target.naturalWidth && target.naturalHeight) {
                        setImgDim({ w: target.naturalWidth, h: target.naturalHeight });
                      }
                    }}
                    className="absolute inset-0 block pointer-events-none select-none w-full h-full object-contain rounded-lg"
                    style={{ imageRendering: "pixelated" }}
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-400">
                    <Stethoscope className="h-10 w-10 text-blue-400/50 animate-pulse" />
                    <span className="mt-3 text-xs font-mono">Loading MRI Slice...</span>
                  </div>
                )}

                {/* Mask Overlay Canvas */}
                <canvas
                  ref={maskCanvasRef}
                  width={imgDim.w || 512}
                  height={imgDim.h || 512}
                  className="pointer-events-none absolute inset-0 block rounded-lg opacity-85 w-full h-full object-contain"
                />
              </div>

              <div className="mt-3 flex w-full items-center justify-between px-1 text-xs text-slate-300 font-mono">
                <span className="text-blue-400 font-semibold truncate max-w-[280px]">
                  {activeStem || currentCaseName}
                </span>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" /> Bone Marrow
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-rose-500" /> BME Lesion
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side Control Bar (Restricted based on permissions) */}
        <div className="flex w-72 flex-col border-l border-slate-800 bg-slate-900/95 p-4 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Radiologist Controls
            </span>
            <button
              onClick={() => setFollowingMaster(!followingMaster)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold ${
                followingMaster
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-slate-800 text-slate-300"
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              {followingMaster ? "Following" : "Unfollow"}
            </button>
          </div>

          {/* Slice Controller */}
          <div className="mt-5 flex flex-col">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300">Slice Index</span>
              <span className="font-mono text-blue-400">{sliceIndex + 1}</span>
            </div>
            <input
              type="range"
              min="0"
              max={Math.max(0, maxSlices - 1)}
              value={sliceIndex}
              disabled={!permissions.SLICE_CONTROL}
              onChange={(e) => handleSliceChange(Number(e.target.value))}
              className="mt-2 w-full accent-blue-500 disabled:opacity-30 disabled:cursor-not-allowed"
            />
            {!permissions.SLICE_CONTROL && (
              <span className="mt-1 flex items-center gap-1 text-[11px] text-amber-400/80">
                <Lock className="h-3 w-3" /> Slice locked by Master
              </span>
            )}
          </div>

          {/* Zoom Controller */}
          <div className="mt-5 flex flex-col">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300">Zoom Level</span>
              <span className="font-mono text-blue-400">{(zoom * 100).toFixed(0)}%</span>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                disabled={!permissions.ZOOM_PAN}
                onClick={() => handleZoomChange(-0.1)}
                className="flex flex-1 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                - Zoom Out
              </button>
              <button
                disabled={!permissions.ZOOM_PAN}
                onClick={() => handleZoomChange(0.1)}
                className="flex flex-1 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              >
                + Zoom In
              </button>
            </div>
            {!permissions.ZOOM_PAN && (
              <span className="mt-1 flex items-center gap-1 text-[11px] text-amber-400/80">
                <Lock className="h-3 w-3" /> Zoom locked by Master
              </span>
            )}
          </div>

          {/* Contrast & Window Level */}
          <div className="mt-5 flex flex-col border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Sliders className="h-3.5 w-3.5 text-amber-400" /> Contrast & Window
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {permissions.WINDOW_LEVEL ? "Unlocked" : "Locked"}
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="255"
              value={windowLevel.hi}
              disabled={!permissions.WINDOW_LEVEL}
              onChange={(e) => {
                const hi = Number(e.target.value);
                setWindowLevel((prev) => ({ ...prev, hi }));
                updateViewpoint({ windowLevel: { lo: windowLevel.lo, hi } });
              }}
              className="mt-2 w-full accent-amber-500 disabled:opacity-30 disabled:cursor-not-allowed"
            />
          </div>

          {/* AI Analysis & Model Heatmap */}
          <div className="mt-4 flex flex-col border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-cyan-400" /> AI Lesion Overlay
              </span>
              <button
                disabled={!permissions.AI_ANALYSIS}
                onClick={() => {
                  toast.success("AI heatmap overlay synced with session");
                }}
                className={`rounded px-2 py-0.5 text-[11px] font-medium border ${
                  permissions.AI_ANALYSIS
                    ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30 cursor-pointer"
                    : "bg-slate-800 text-slate-500 border-slate-700 opacity-40 cursor-not-allowed"
                }`}
              >
                {permissions.AI_ANALYSIS ? "Active" : "Locked"}
              </button>
            </div>
          </div>

          {/* Export & Download Slice */}
          <div className="mt-4 flex flex-col border-t border-slate-800 pt-3">
            <button
              disabled={!permissions.DOWNLOAD || !activeRelPath}
              onClick={() => {
                if (activeRelPath) {
                  const link = document.createElement("a");
                  link.href = `/api/cases2d?image=${encodeURIComponent(activeRelPath)}`;
                  link.download = `${activeStem || "mri_slice"}.png`;
                  link.click();
                  toast.success("MRI slice downloaded");
                }
              }}
              className="flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              {permissions.DOWNLOAD ? "Download Slice PNG" : "Export (Locked by Master)"}
            </button>
          </div>

          {/* Active Participants Summary */}
          <div className="mt-auto border-t border-slate-800 pt-4">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Session Participants ({participants.length})
            </span>
            <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto">
              {participants.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between text-xs text-slate-300"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <span>{p.role === "MASTER" ? "👑" : "🩺"}</span>
                    <span>{p.name}</span>
                  </span>
                  <span
                    className={`h-2 w-2 rounded-full ${
                      p.connected ? "bg-emerald-500" : "bg-slate-600"
                    }`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
