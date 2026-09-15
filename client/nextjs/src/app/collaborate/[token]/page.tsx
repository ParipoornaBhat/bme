"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Eye, Lock, RefreshCw, ShieldAlert, Stethoscope } from "lucide-react";
import CollaborationViewerHeader from "~/components/collaborate/CollaborationViewerHeader";
import LiveCursorsOverlay from "~/components/collaborate/LiveCursorsOverlay";
import { useCollaboration, type ViewpointState } from "~/lib/useCollaboration";

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

  // Volume & canvas state
  const [sliceIndex, setSliceIndex] = useState(0);
  const [maxSlices, setMaxSlices] = useState(100);
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [plane, setPlane] = useState<"axial" | "coronal" | "sagittal">("axial");
  const [windowLevel, setWindowLevel] = useState({ lo: 0, hi: 255 });
  const [followingMaster, setFollowingMaster] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    onViewpointUpdated: (vp) => {
      if (followingMaster) {
        if (vp.sliceIndex !== undefined) setSliceIndex(vp.sliceIndex);
        if (vp.maxSlices !== undefined) setMaxSlices(vp.maxSlices);
        if (vp.zoom !== undefined) setZoom(vp.zoom);
        if (vp.pan !== undefined) setPan(vp.pan);
        if (vp.plane !== undefined) setPlane(vp.plane);
        if (vp.windowLevel !== undefined) setWindowLevel(vp.windowLevel);
      }
    },
  });

  // Fetch initial session info server-side validated
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch(`/api/collaborate/session/${token}`);
        if (!res.ok) {
          const j = await res.json();
          setError(j.error || "Session invalid or expired");
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
    updateViewpoint({ sliceIndex: newSlice });
  };

  // Zoom change (only allowed if permissions.ZOOM_PAN is true)
  const handleZoomChange = (delta: number) => {
    if (!permissions.ZOOM_PAN) return;
    const newZoom = Math.max(0.5, Math.min(4.0, zoom + delta));
    setZoom(newZoom);
    updateViewpoint({ zoom: newZoom });
  };

  const masterConnected = participants.some((p) => p.role === "MASTER" && p.connected);

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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Viewer Header */}
      <CollaborationViewerHeader
        caseId={caseId || sessionData?.caseId || "MRI Review"}
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

          {/* MRI Render Canvas */}
          <div
            className="relative transition-transform duration-75 ease-out"
            style={{
              transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <div className="flex h-[520px] w-[520px] flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900/50 p-6 shadow-2xl backdrop-blur-md">
              <Stethoscope className="h-16 w-16 text-blue-500/40" />
              <span className="mt-4 font-mono text-sm text-blue-400 font-semibold">
                MRI SLICE VIEW [{plane.toUpperCase()}] — Slice {sliceIndex + 1} / {maxSlices}
              </span>
              <span className="mt-1 text-xs text-slate-400">
                Zoom: {(zoom * 100).toFixed(0)}% | W/L: {windowLevel.lo} - {windowLevel.hi}
              </span>

              {/* Mock Scan Visualization Box */}
              <div className="mt-6 flex h-64 w-64 items-center justify-center rounded-lg border border-blue-500/30 bg-blue-950/20 text-slate-500">
                <span className="text-center font-mono text-xs text-slate-400">
                  [Synchronized Real-Time MRI Slice]
                </span>
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
              max={maxSlices - 1}
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
                className="flex flex-1 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                - Zoom Out
              </button>
              <button
                disabled={!permissions.ZOOM_PAN}
                onClick={() => handleZoomChange(0.1)}
                className="flex flex-1 items-center justify-center rounded border border-slate-700 bg-slate-800 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                + Zoom In
              </button>
            </div>
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
