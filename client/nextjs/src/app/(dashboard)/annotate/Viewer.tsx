"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Keyboard,
  LayoutGrid,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Eraser,
  Flag,
  Flashlight,
  Hand,
  Lasso,
  Layers,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Minus,
  Move,
  Paintbrush,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Users,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "~/lib/auth-client";
import Render3D from "./Render3D";
import CollaborationMasterPanel from "~/components/collaborate/CollaborationMasterPanel";
import CollaborationViewerHeader from "~/components/collaborate/CollaborationViewerHeader";
import { getColorForUser } from "~/components/collaborate/LiveCursorsOverlay";
import { guestSessionScreen } from "~/components/collaborate/GuestSessionScreen";
import {
  useOverlayView,
  isLabelVisible,
  blendLabel,
  hiddenLabelsForView,
  OverlayControls,
} from "~/lib/useOverlayView";
import {
  useCollaboration,
  type Participant,
  type ParticipantPermission,
  type ViewpointState,
} from "~/lib/useCollaboration";
import { MaskSync, type MaskSyncIO } from "~/lib/mask-sync";
import { useGuestUserId, useHostSession, useSessionNotices } from "~/lib/useHostSession";
import { canPaint } from "~/lib/paint-rules";
import { wheelZoomFactor } from "~/lib/wheel-zoom";
import { pencilCursor } from "~/lib/cursors";
import { Pinch } from "~/lib/pinch";
import { usePaintTools, usePencilDottedSetting } from "~/lib/usePaintTools";
import { edgePanStep, useAutoPanSetting, useSpaceHeld } from "~/lib/view-pan";
import { isInTorch, type TorchState } from "~/lib/torch";
import {
  dragBox,
  handleAt,
  placeRegion,
  sameBox,
  selectRegion,
  HANDLE_CURSOR,
  type Box,
  type Handle,
  type Region,
} from "~/lib/region-move";
import type { FlagRecord } from "~/lib/flag-store";
import FlagDialog from "./FlagDialog";
import { drawSuggestionEdges, useSuggestions } from "./suggestions";
import { useFocusMode, type FocusMode } from "~/lib/useFocusMode";

/**
 * Three-plane viewer with painting, modelled on 3D Slicer's Four-Up layout.
 *
 * CROSSHAIR MODEL
 * One voxel position drives all three views — exactly as Slicer does it. Click
 * anywhere in any view and the other two jump to that location, so you are
 * always looking at the same point in the body from three directions. Without
 * this, three independent sliders show three unrelated places and checking a
 * lesion across planes is guesswork.
 *
 * ONE SHARED LABEL VOLUME
 * Painting writes into a single 3D array, so a stroke in the axial view is
 * immediately visible in coronal and sagittal. That only actually appears on
 * screen if every plane is redrawn after a stroke — redrawing just the active
 * one (the earlier bug here) makes the others look stale and the labels look
 * lost.
 *
 * INDEXING
 * Volume and labels are flat typed arrays in i,j,k order with i fastest — the
 * same order NIfTI stores and write_seg.py reshapes with (numpy order="F").
 * If those ever diverge, annotations land in the wrong voxels silently, so the
 * indexing helper below is the single place it is expressed.
 */

export const SEGMENTS = [
  { value: 1, name: "bone_marrow", label: "Bone marrow", color: "#3ddc84", stroke: "#22c55e", badge: "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" },
  { value: 2, name: "bme", label: "Edema (BME)", color: "#f24c38", stroke: "#ef4444", badge: "border-red-500/50 bg-red-500/10 text-red-400" },
  { value: 3, name: "uncertain", label: "Uncertain", color: "#8c8c99", stroke: "#eab308", badge: "border-amber-500/50 bg-amber-500/10 text-amber-400" },
] as const;

type Plane = "axial" | "coronal" | "sagittal";
const PLANES: Plane[] = ["axial", "coronal", "sagittal"];
/** A view that can be shown on its own: one of the planes, or the 3D render. */
export type ViewerView = Plane | "3d";

// Slicer's slice-view colours. Familiar to anyone who has used it, and they
// make "which view am I in" answerable at a glance.
const PLANE_COLOR: Record<Plane, string> = {
  axial: "#f04b4b",
  coronal: "#4bc46b",
  sagittal: "#e8c93a",
};

type Vol = {
  data: Float32Array;
  dims: [number, number, number];
  /** mm per voxel along i, j, k. Needed because our voxels are ~10:1 anisotropic. */
  spacing: [number, number, number];
  /** Which array axis each anatomical plane slices along, and how to lay it out. */
  axes: Record<Plane, PlaneAxes>;
  orient: [AxisEnds, AxisEnds, AxisEnds];
  lo: number; hi: number;
};

/**
 * How one anatomical plane maps onto the array.
 *
 * `slice` is the array axis stepped through; `h` and `v` are the two in-plane
 * axes. Flips put superior/anterior at the top of the image.
 */
type PlaneAxes = { slice: 0 | 1 | 2; h: 0 | 1 | 2; v: 0 | 1 | 2; flipH: boolean; flipV: boolean };

/** Letter on the low-index face and the high-index face of one array axis. */
export type AxisEnds = { atZero: string; atMax: string };

/**
 * RAS: +x right, +y anterior, +z superior. Each array axis gets the letter of
 * the direction it actually points, so a sagittal acquisition is not labelled
 * as if it were axial.
 */
function orientationEnds(affine: number[][]): [AxisEnds, AxisEnds, AxisEnds] {
  const pos = ["R", "A", "S"];
  const neg = ["L", "P", "I"];
  const ends: AxisEnds[] = [];
  for (let a = 0; a < 3; a++) {
    let w = 0;
    let best = -1;
    for (let r = 0; r < 3; r++) {
      const v = Math.abs(affine[r]?.[a] ?? 0);
      if (v > best) { best = v; w = r; }
    }
    const sign = Math.sign(affine[w]?.[a] ?? 1) || 1;
    ends.push(sign > 0
      ? { atZero: neg[w], atMax: pos[w] }
      : { atZero: pos[w], atMax: neg[w] });
  }
  return ends as [AxisEnds, AxisEnds, AxisEnds];
}

/**
 * Work out which array axis corresponds to which anatomical direction.
 *
 * Array axis order is NOT fixed: it follows how the scan was acquired. An
 * axially-acquired volume has k running inferior-superior, but a sagittal
 * acquisition has k running left-right and a coronal one has k running
 * posterior-anterior. Assuming "k is always axial" mislabels every
 * non-axial acquisition — which is why some cases looked correct and others
 * had their three views rotated.
 *
 * The affine's columns give each array axis a direction in world space
 * (x = L-R, y = P-A, z = I-S); the dominant component tells us which one.
 */
function deriveAxes(affine: number[][]): Record<Plane, PlaneAxes> {
  // Greedy assignment over the whole matrix: repeatedly take the largest
  // remaining |value|, bind that (world axis, array axis) pair, and strike both
  // out.
  //
  // Scanning row by row instead was the earlier bug. For an axial knee volume
  // the affine row for left-right is [-0.335, -0.083, 0.495], so that row's
  // largest entry sits in array axis 2 — and left-right would claim it before
  // inferior-superior could, even though axis 2's own column is [0.495, 0.447,
  // 4.147] and overwhelmingly inferior-superior. Comparing globally cannot make
  // that mistake, because 4.147 is picked before 0.495 is ever considered.
  const pairs: Array<{ w: number; a: number; v: number }> = [];
  for (let w = 0; w < 3; w++)
    for (let a = 0; a < 3; a++)
      pairs.push({ w, a, v: Math.abs(affine[w]?.[a] ?? 0) });
  pairs.sort((x, y) => y.v - x.v);

  const forWorld: Array<{ ax: 0 | 1 | 2; sign: number } | null> = [null, null, null];
  const takenW = new Set<number>(), takenA = new Set<number>();
  for (const { w, a } of pairs) {
    if (takenW.has(w) || takenA.has(a)) continue;
    takenW.add(w); takenA.add(a);
    forWorld[w] = { ax: a as 0 | 1 | 2, sign: Math.sign(affine[w]?.[a] ?? 1) || 1 };
    if (takenW.size === 3) break;
  }
  for (let w = 0; w < 3; w++)
    if (!forWorld[w]) {
      const free = [0, 1, 2].find((a) => !takenA.has(a)) ?? w;
      takenA.add(free);
      forWorld[w] = { ax: free as 0 | 1 | 2, sign: 1 };
    }

  const LR = forWorld[0]!, PA = forWorld[1]!, IS = forWorld[2]!;
  return {
    // Axial: step through inferior-superior. Anterior at the top of the image.
    axial: { slice: IS.ax, h: LR.ax, v: PA.ax, flipH: LR.sign < 0, flipV: PA.sign > 0 },
    // Coronal: step through posterior-anterior. Superior at the top.
    coronal: { slice: PA.ax, h: LR.ax, v: IS.ax, flipH: LR.sign < 0, flipV: IS.sign < 0 },
    // Sagittal: step through left-right. Superior at the top.
    sagittal: { slice: LR.ax, h: PA.ax, v: IS.ax, flipH: PA.sign < 0, flipV: IS.sign < 0 },
  };
}

type Cursor = { i: number; j: number; k: number };

// One range for the wheel and the buttons, so neither can reach a zoom the
// other cannot undo.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 6;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z.toFixed(2))));

/** Cursor component along a numeric array axis (0=i, 1=j, 2=k). */
const axisVal = (c: Cursor, ax: 0 | 1 | 2) => (ax === 0 ? c.i : ax === 1 ? c.j : c.k);
const setAxis = (c: Cursor, ax: 0 | 1 | 2, v: number): Cursor =>
  ax === 0 ? { ...c, i: v } : ax === 1 ? { ...c, j: v } : { ...c, k: v };

/**
 * The case's saved annotation (web editor or 3D Slicer) as a label buffer for
 * `n` voxels, or null when nothing is saved. Throws when a file exists but
 * cannot be read, so the caller can refuse to save over it.
 */
async function fetchSavedLabels(
  caseId: string,
  n: number,
  series = "",
  access: (url: string) => string = (url) => url,
): Promise<{ labels: Uint8Array | null; warnings: string[] }> {
  const q = series && series !== "primary" ? `?series=${encodeURIComponent(series)}` : "";
  const res = await fetch(access(`/api/annotation/${caseId}/labels${q}`), { cache: "no-store" });
  if (res.status === 404) return { labels: null, warnings: [] };
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j as { error?: string }).error ?? "could not load the saved annotation");
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== n) throw new Error(`saved annotation has ${buf.length} voxels, the scan has ${n}`);
  let warnings: string[] = [];
  try {
    const info = JSON.parse(decodeURIComponent(res.headers.get("X-Annotation-Info") ?? "")) as { warnings?: string[] };
    warnings = info.warnings ?? [];
  } catch { /* no info header */ }
  return { labels: buf, warnings };
}

function countLabels(l: Uint8Array): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < l.length; i++) {
    const v = l[i];
    if (v) c[v - 1]++;
  }
  return c;
}

function SegmentMeasures({
  counts, spacing,
}: {
  counts: [number, number, number];
  spacing: [number, number, number];
}) {
  const voxel = spacing[0] * spacing[1] * spacing[2];
  const rows = SEGMENTS.map((s, i) => {
    const n = counts[i] ?? 0;
    const mm3 = n * voxel;
    return { ...s, n, mm3, cm3: mm3 / 1000 };
  }).filter((r) => r.n > 0);
  // One line under the 3D view; voxel counts and mm³ are in the tooltip.
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs">
      <span className="font-semibold">Annotated</span>
      {rows.length === 0 ? (
        <span className="text-muted-foreground">nothing painted yet</span>
      ) : (
        rows.map((r) => (
          <span key={r.value} className="inline-flex items-center gap-1.5 tabular-nums"
            title={`${r.n.toLocaleString()} voxels · ${r.mm3.toFixed(1)} mm³`}>
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />
            <span className="text-muted-foreground">{r.label}</span>
            <span className="font-medium">{r.cm3.toFixed(2)} cm³</span>
          </span>
        ))
      )}
    </div>
  );
}

function RailButton({
  active = false,
  title,
  onClick,
  disabled,
  children,
}: {
  active?: boolean | "danger";
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border transition disabled:cursor-default disabled:opacity-30 ${
        active === "danger"
          ? "border-destructive bg-destructive/10 text-destructive"
          : active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export default function Viewer({
  caseId,
  onSaved,
  savedOnDisk = false,
  flag: flagFromList = null,
  collabToken: externalCollabToken,
  isCollaborator = false,
  collaboratorUserName,
  focus: focusFromPage,
  onPrevCase,
  onNextCase,
}: {
  caseId: string;
  onSaved?: () => void;
  /** Whether the case already has a saved .seg.nrrd, from the case list. */
  savedOnDisk?: boolean;
  /** The case's review flag, from the case list. */
  flag?: FlagRecord | null;
  /** Set when a guest opens the viewer from a shared review link. */
  collabToken?: string;
  isCollaborator?: boolean;
  collaboratorUserName?: string;
  /** Focus mode owned by the page, so it outlives the viewer across case switches. */
  focus?: FocusMode<ViewerView>;
  /** Neighbouring cases in the page's list; absent at either end. */
  onPrevCase?: () => void;
  onNextCase?: () => void;
}) {
  const { data: session } = useSession();
  const [vol, setVol] = useState<Vol | null>(null);
  const [labels, setLabels] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState("Loading scan…");
  const [busy, setBusy] = useState(true);
  const [seriesChoices, setSeriesChoices] = useState<{ id: string; label: string }[]>([]);
  const [annotatedSeries, setAnnotatedSeries] = useState("");
  const [seriesId, setSeriesId] = useState("");
  const [seg, setSeg] = useState<number>(1);
  const [brush, setBrush] = useState(6);
  const { tool, erasing, drawing, pickTool, toggleEraser, drawWithLabel } =
    usePaintTools(isCollaborator ? "pan" : "brush");
  const { spaceHeld, spaceHeldRef } = useSpaceHeld();
  const { autoPan, setAutoPan } = useAutoPanSetting();
  const { pencilDotted, setPencilDotted } = usePencilDottedSetting();
  const [torchSize, setTorchSize] = useState(48);
  const [torchHeld, setTorchHeld] = useState(false);
  const torchActive = tool === "torch" || torchHeld;
  const torchActiveRef = useRef(torchActive);
  torchActiveRef.current = torchActive;
  const torchSizeRef = useRef(torchSize);
  torchSizeRef.current = torchSize;
  const torchRef = useRef<TorchState | null>(null);
  const lastPointerPosRef = useRef<{ plane: Plane; a: number; b: number } | null>(null);
  const torchRafRef = useRef<number | null>(null);

  const outline = useRef<[number, number][]>([]);
  const [outlineTick, setOutlineTick] = useState(0);
  // Move tool: the selected region, where it sits now, and what it covered.
  // `under` holds the label each touched voxel had before the region landed
  // there (255 = not touched yet), so moving it again puts those back.
  const moveSel = useRef<{
    plane: Plane; region: Region; to: Box; stamped: Int32Array; under: Uint8Array;
  } | null>(null);
  const [moveTick, setMoveTick] = useState(0);
  const [moveAllSlices, setMoveAllSlices] = useState(false);
  const [moveCursorStyle, setMoveCursorStyle] = useState("crosshair");
  // Zoom is per view: you often want a lesion magnified in one plane while
  // keeping the others wide for context.
  const [zoom, setZoom] = useState<Record<Plane, number>>({ axial: 1, coronal: 1, sagittal: 1 });
  // Pan is per view like zoom, in screen pixels.
  const [pan, setPan] = useState<Record<Plane, { x: number; y: number }>>({
    axial: { x: 0, y: 0 }, coronal: { x: 0, y: 0 }, sagittal: { x: 0, y: 0 },
  });
  const [panning, setPanning] = useState<Plane | null>(null);
  const [maskInside, setMaskInside] = useState(false);
  const [protectLesion, setProtectLesion] = useState(true);
  const [hasSaved, setHasSaved] = useState(savedOnDisk);
  useEffect(() => { setHasSaved(savedOnDisk); }, [savedOnDisk]);
  const [flag, setFlag] = useState<FlagRecord | null>(flagFromList);
  useEffect(() => { setFlag(flagFromList); }, [flagFromList]);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [flagSaving, setFlagSaving] = useState(false);

  // Hydrate preferences from localStorage
  const prefsLoaded = useRef(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("bme_protect_lesion");
      if (saved !== null) setProtectLesion(saved === "true");
      const savedTorch = localStorage.getItem("bme_viewer_torch_size");
      if (savedTorch) {
        const n = Number(savedTorch);
        if (!isNaN(n) && n >= 8 && n <= 240) setTorchSize(n);
      }
      const savedTool = localStorage.getItem("bme_viewer_tool");
      if (!isCollaborator && (savedTool === "brush" || savedTool === "pencil" || savedTool === "pan")) pickTool(savedTool);
      const savedBrush = Number(localStorage.getItem("bme_viewer_brush"));
      if (savedBrush >= 1 && savedBrush <= 20) setBrush(savedBrush);
      const savedSeg = Number(localStorage.getItem("bme_viewer_seg"));
      if (savedSeg >= 1 && savedSeg <= 3) setSeg(savedSeg);
      const savedInside = localStorage.getItem("bme_viewer_mask_inside");
      if (savedInside !== null) setMaskInside(savedInside === "true");
      setAutoSave(localStorage.getItem("bme_viewer_autosave") === "true");
    } catch { /* ignore */ }
    prefsLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      // The torch is a momentary peek, so it is not what the next case opens with.
      if (tool !== "torch") localStorage.setItem("bme_viewer_tool", tool);
      localStorage.setItem("bme_viewer_brush", String(brush));
      localStorage.setItem("bme_viewer_seg", String(seg));
      localStorage.setItem("bme_viewer_mask_inside", String(maskInside));
    } catch { /* ignore */ }
  }, [tool, brush, seg, maskInside]);
  // Locked by default: painting should not drag the other two views around.
  // Slicer behaves the same way — the crosshair moves when you deliberately
  // move it, not as a side effect of every brush stroke.
  const [locked, setLocked] = useState(true);
  // Which view the arrow keys act on. Set by hovering, so navigation follows
  // the pointer without needing a click that might paint.
  const [activePlane, setActivePlane] = useState<Plane>("axial");
  const [cursor, setCursor] = useState<Cursor>({ i: 0, j: 0, k: 0 });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [counts, setCounts] = useState<[number, number, number]>([0, 0, 0]);
  const { opacity, view, setOpacity, setView, cycleView } = useOverlayView();
  const cycleViewRef = useRef(cycleView);
  cycleViewRef.current = cycleView;

  // Collaboration: the host starts a review from here; a guest opens this
  // viewer from the shared link. A 3D review covers one case, so each case
  // keeps its own session.
  const host = useHostSession({ storagePrefix: `bme_active_3d_collab_${caseId}`, enabled: !isCollaborator });
  const collabToken = isCollaborator ? (externalCollabToken || null) : host.token;
  const guestUserId = useGuestUserId();
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [deletingMask, setDeletingMask] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [savedLoadError, setSavedLoadError] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState("");
  // Bumped on every edit, so a save knows whether what it wrote is still
  // what is on screen.
  const editVersion = useRef(0);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef(false);
  // Newest edit version queued for auto save, per series: an older snapshot
  // still waiting for an earlier save to finish must not land after it.
  const latestAutoVersion = useRef(new Map<string, number>());
  const scheduleAutoSaveRef = useRef<(source?: Uint8Array) => void>(() => {});
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  // Whose view this client mirrors. Null means moving independently. Either
  // side can follow the other: the host can watch a radiologist work, and a
  // radiologist can watch the host.
  const [followUserId, setFollowUserId] = useState<string | null>(null);
  const followUserIdRef = useRef<string | null>(null);
  followUserIdRef.current = followUserId;
  const followInitialised = useRef(false);
  const lastViewpointByUser = useRef(new Map<string, ViewpointState>());
  const applyViewpointRef = useRef<(vp: ViewpointState) => void>(() => {});
  const appliedRemoteView = useRef<string | null>(null);

  // Keeps this client's label volume in step with a live review; see
  // src/lib/mask-sync.ts. The volume is synced as one flat array per series.
  const labelsRef = useRef<Uint8Array | null>(null);
  labelsRef.current = labels;
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
  const participantsRef = useRef<Participant[]>([]);

  const collab = useCollaboration({
    token: collabToken || "",
    userId: isCollaborator ? guestUserId : host.userId,
    userName: isCollaborator
      ? (collaboratorUserName || (typeof window !== "undefined" && localStorage.getItem("bme_collab_radiologist_name")) || "Dr. Radiologist")
      : host.userName,
    hostKey: isCollaborator ? undefined : (host.hostKey ?? undefined),
    onViewpointUpdated: (vp, updatedBy) => {
      // Remember where everyone is, so choosing to follow someone can jump
      // straight to their view instead of waiting for them to move again.
      if (updatedBy) lastViewpointByUser.current.set(updatedBy, vp);
      if (updatedBy && updatedBy === followUserIdRef.current) applyViewpointRef.current(vp);
    },
    onMaskSnapshot: (d) => {
      const screen = labelsRef.current;
      if (screen) maskSync.onSnapshot(d, screen, canEditRef.current, [undoStack.current, redoStack.current]);
    },
    onMaskOp: (d) => {
      const screen = labelsRef.current;
      if (!screen) return;
      maskSync.onOp(d, screen, canEditRef.current, currentUserIdRef.current, [undoStack.current, redoStack.current]);
      // Someone else's stroke is unsaved work here too, so Save lights up.
      if (d.userId !== currentUserIdRef.current) {
        editVersion.current++;
        setDirty(true);
      }
    },
  });
  useSessionNotices(collab, collabToken, !isCollaborator, host.forget);
  participantsRef.current = collab.participants;

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
  const canAnnotate = !isCollaborator || permissions.ANNOTATE;
  const canZoomPan = !isCollaborator || permissions.ZOOM_PAN;
  const canMoveSlices = !isCollaborator || permissions.SLICE_CONTROL;
  const canDelete = !isCollaborator || permissions.DELETE_ANNOTATION;
  // Viewers without annotate permission never send: the server would refuse,
  // and their edits would sit unconfirmed forever.
  canEditRef.current = canAnnotate;
  currentUserIdRef.current = collab.currentUserId;
  const canZoomPanRef = useRef(canZoomPan);
  canZoomPanRef.current = canZoomPan;

  // Study data routes refuse anyone who is not a signed-in team member unless
  // the request proves the caller is in a live review of this case.
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

  // A guest has no case list to read the flag from, so it is fetched here.
  useEffect(() => {
    if (!isCollaborator || !dataReady) return;
    let cancelled = false;
    fetch(withAccessRef.current(`/api/annotation/${caseId}/flag`), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { flag?: FlagRecord | null } | null) => { if (!cancelled && j) setFlag(j.flag ?? null); })
      .catch(() => { /* flag optional */ });
    return () => { cancelled = true; };
  }, [isCollaborator, dataReady, caseId]);

  // Send what changed since the last flush. Batched, so a brush stroke goes
  // out as a few edits rather than one per mouse event.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = useCallback(() => {
    if (!maskSyncRef.current?.ready || flushTimer.current !== null) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const screen = labelsRef.current;
      if (screen) maskSyncRef.current?.flush(screen, canEditRef.current);
    }, 60);
  }, []);

  const canvases = useRef<Record<Plane, HTMLCanvasElement | null>>({
    axial: null, coronal: null, sagittal: null,
  });
  const viewRefs = useRef<Record<Plane, HTMLDivElement | null>>({
    axial: null, coronal: null, sagittal: null,
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  const ownFocus = useFocusMode<ViewerView>();
  const focus = focusFromPage ?? ownFocus;
  const focusOn = focus.active;
  const focusExitRef = useRef(focus.exit);
  focusExitRef.current = focus.exit;
  const focusToggleRef = useRef(focus.toggle);
  focusToggleRef.current = focus.toggle;
  const focusOnRef = useRef(focusOn);
  focusOnRef.current = focusOn;
  // The settings panel, opened from the toolbar or the focus rail.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // The viewer is portalled through a node of its own, which sits in place
  // normally and is moved to <body> in focus mode. Moving the node, rather
  // than rendering into a different parent, keeps the canvases and the 3D
  // context alive; and from <body> the focus layer is not trapped under the
  // dashboard header by the stacking context the page content sits in.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const d = document.createElement("div");
    d.className = "flex min-h-0 flex-1 flex-col";
    setStage(d);
    return () => d.remove();
  }, []);
  useLayoutEffect(() => {
    const parent = focusOn ? document.body : slot;
    if (stage && parent && stage.parentNode !== parent) parent.appendChild(stage);
  }, [stage, slot, focusOn]);
  // One view shown full size in place of the four-up, or null for all four.
  const expanded = focus.solo;
  const setExpanded = focus.setSolo;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const showShortcutsRef = useRef(showShortcuts);
  showShortcutsRef.current = showShortcuts;
  const toggleExpanded = (v: Plane | "3d") => setExpanded((cur) => (cur === v ? null : v));

  const painting = useRef(false);
  const pencilPlane = useRef<Plane | null>(null);
  const undoStack = useRef<Uint8Array[]>([]);
  const redoStack = useRef<Uint8Array[]>([]);

  const idx = useCallback(
    (d: [number, number, number], i: number, j: number, k: number) => i + d[0] * (j + d[1] * k),
    [],
  );

  // ---- load ------------------------------------------------------------
  useEffect(() => {
    if (!dataReady) return;
    let cancelled = false;
    setBusy(true); setStatus("Loading scan…"); setLabels(null); setVol(null);
    // The previous series' labels are about to be replaced; its live copy
    // stops here and the new one is joined once loaded.
    maskSyncRef.current?.leave();
    // An auto save waiting for the previous series still runs: it carries its
    // own copy of that series' labels. Dropping the handle only stops edits
    // here from cancelling it.
    autoTimer.current = null;
    undoStack.current = []; redoStack.current = [];

    (async () => {
      try {
        const nifti = await import("nifti-reader-js");
        const listed = await fetch(withAccessRef.current(`/api/volume/${caseId}?list=1`), { cache: "no-store" });
        const catalog = listed.ok
          ? await listed.json() as { annotated?: string; series?: { id: string; label: string }[] }
          : { annotated: "", series: [] };
        if (cancelled) return;
        const choices = catalog.series ?? [];
        setSeriesChoices(choices);
        setAnnotatedSeries(catalog.annotated ?? "");
        const pick = seriesId && choices.some((s) => s.id === seriesId)
          ? seriesId
          : (catalog.annotated || choices[0]?.id || "");
        if (pick && pick !== seriesId) {
          setSeriesId(pick);
          return;
        }
        const query = pick && pick !== "primary" ? `?series=${encodeURIComponent(pick)}` : "";
        const res = await fetch(withAccessRef.current(`/api/volume/${caseId}${query}`));
        if (!res.ok) throw new Error((await res.json()).error ?? "load failed");
        let buf = await res.arrayBuffer();
        if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
        if (!nifti.isNIFTI(buf)) throw new Error("not a NIfTI file");

        const hdr = nifti.readHeader(buf)!;
        const raw = nifti.readImage(hdr, buf);
        const dims: [number, number, number] = [hdr.dims[1], hdr.dims[2], hdr.dims[3]];
        // pixDims[1..3] is mm per voxel. Our data is ~0.35 mm in-plane against
        // 3-4 mm slices, so a coronal view is 432 voxels wide and 33 tall but
        // roughly SQUARE in millimetres. Rendering by voxel count alone squashes
        // it into a sliver — which is exactly what it looked like.
        const spacing: [number, number, number] = [
          Math.abs(hdr.pixDims?.[1]) || 1,
          Math.abs(hdr.pixDims?.[2]) || 1,
          Math.abs(hdr.pixDims?.[3]) || 1,
        ];
        const n = dims[0] * dims[1] * dims[2];

        const ctor: Record<number, new (b: ArrayBuffer) => ArrayLike<number>> = {
          2: Uint8Array, 4: Int16Array, 8: Int32Array,
          16: Float32Array, 64: Float64Array, 512: Uint16Array, 768: Uint32Array,
        } as never;
        const Typed = ctor[hdr.datatypeCode] ?? Int16Array;
        const src = new Typed(raw);
        const data = new Float32Array(n);
        for (let i = 0; i < n; i++) data[i] = Number(src[i]);

        const sample = new Float32Array(Math.min(n, 200_000));
        const step = Math.max(1, Math.floor(n / sample.length));
        for (let i = 0, s = 0; s < sample.length; i += step, s++) sample[s] = data[i];
        sample.sort();
        const lo = sample[Math.floor(sample.length * 0.01)];
        const hi = sample[Math.floor(sample.length * 0.99)] || lo + 1;

        // nifti-reader-js exposes the sform/qform-derived affine; fall back to
        // an identity mapping if a file somehow lacks one.
        const aff: number[][] =
          (hdr as unknown as { affine?: number[][] }).affine ??
          [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
        const axes = deriveAxes(aff);
        const orient = orientationEnds(aff);

        if (cancelled) return;
        setStatus("Loading saved annotation…");
        let initial: Uint8Array = new Uint8Array(n);
        let note = "";
        let loadError: string | null = null;
        const edemaHere = !pick || pick === (catalog.annotated || "primary");
        try {
          if (!edemaHere) {
            note = ` · edema is on ${catalog.annotated || "the other scan"}`;
          } else {
            const saved = await fetchSavedLabels(caseId, n, pick, withAccessRef.current);
            if (saved.labels) {
              initial = saved.labels;
              setHasSaved(true);
              note = " · saved annotation loaded";
              for (const w of saved.warnings) toast.warning(w);
            }
          }
        } catch (e) {
          loadError = e instanceof Error ? e.message : "could not load the saved annotation";
          note = ` · saved annotation NOT loaded: ${loadError}`;
          toast.error(`Saved annotation for ${caseId} could not be loaded; saving is disabled so it is not overwritten.`);
        }

        if (cancelled) return;
        setSavedLoadError(loadError);
        setVol({ data, dims, spacing, axes, orient, lo, hi });
        setLabels(initial);
        setCursor({
          i: Math.floor(dims[0] / 2), j: Math.floor(dims[1] / 2), k: Math.floor(dims[2] / 2),
        });
        setCounts([0, 0, 0]);
        // The dimensions are on the info bar already; the status is the news.
        setStatus(note ? note.replace(/^ · /, "").replace(/^./, (c) => c.toUpperCase()) : "No saved annotation yet");
        setDirty(false);
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : "failed to load");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [caseId, seriesId, dataReady]);

  // ---- geometry --------------------------------------------------------
  /**
   * In-plane voxel extent, slice depth, and the PHYSICAL size in millimetres.
   * All of it comes from the affine-derived axis map, so a sagittally-acquired
   * volume shows a true sagittal view rather than whatever array axis happened
   * to be third.
   */
  const planeGeom = useCallback((p: Plane, v: Vol) => {
    const ax = v.axes[p];
    return {
      w: v.dims[ax.h],
      h: v.dims[ax.v],
      depth: v.dims[ax.slice],
      axis: ax,
      mmW: v.dims[ax.h] * v.spacing[ax.h],
      mmH: v.dims[ax.v] * v.spacing[ax.v],
    };
  }, []);

  /** In-plane (a,b) at slice s -> flat array index, honouring axis order and flips. */
  const sampleAt = useCallback((p: Plane, v: Vol, a: number, b: number, s: number) => {
    const ax = v.axes[p];
    const c: [number, number, number] = [0, 0, 0];
    c[ax.slice] = s;
    c[ax.h] = ax.flipH ? v.dims[ax.h] - 1 - a : a;
    c[ax.v] = ax.flipV ? v.dims[ax.v] - 1 - b : b;
    return idx(v.dims, c[0], c[1], c[2]);
  }, [idx]);

  /** Where the crosshair sits within this plane, for the guide lines. */
  const cursorInPlane = useCallback((p: Plane, v: Vol, cur: Cursor) => {
    const ax = v.axes[p];
    const c = [cur.i, cur.j, cur.k];
    const a = ax.flipH ? v.dims[ax.h] - 1 - c[ax.h] : c[ax.h];
    const b = ax.flipV ? v.dims[ax.v] - 1 - c[ax.v] : c[ax.v];
    return { a, b };
  }, []);

  const sliceOf = useCallback((p: Plane, v: Vol, cur: Cursor) => {
    const c = [cur.i, cur.j, cur.k];
    return c[v.axes[p].slice];
  }, []);

  // ---- AI suggestions ---------------------------------------------------
  // Model marks for every axial slice, kept apart from `labels` until a slice
  // is accepted. See ./suggestions.ts.
  const suggestions = useSuggestions({
    caseId,
    series: seriesId,
    dims: vol?.dims ?? null,
    axial: vol?.axes.axial ?? null,
    enabled: !isCollaborator && canAnnotate,
  });
  const suggestion = suggestions.suggestion;
  const suggestJob = suggestions.job;
  const suggestBusy = suggestJob?.state === "queued" || suggestJob?.state === "running";

  // ---- render ----------------------------------------------------------
  const draw = useCallback((p: Plane) => {
    const cv = canvases.current[p];
    if (!cv || !vol || !labels) return;
    const { data, dims, lo, hi } = vol;
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const range = hi - lo || 1;
    const currentTorch = torchRef.current;

    for (let b = 0; b < h; b++) {
      for (let a = 0; a < w; a++) {
        const flat = sampleAt(p, vol, a, b, s);
        const v = data[flat];
        let g = Math.round(((Math.min(Math.max(v, lo), hi) - lo) / range) * 255);
        let r = g, bl = g;
        const lv = labels[flat];
        if (lv && !isInTorch(a, b, p, currentTorch) && isLabelVisible(lv, view)) {
          const segDef = SEGMENTS.find((x) => x.value === lv);
          if (segDef) {
            const c = segDef.color;
            const cr = parseInt(c.slice(1, 3), 16),
              cg = parseInt(c.slice(3, 5), 16),
              cb = parseInt(c.slice(5, 7), 16);
            [r, g, bl] = blendLabel(g, [cr, cg, cb], opacity);
          }
        }
        const o = ((h - 1 - b) * w + a) * 4; // flip so anatomy is upright
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = 255;
      }
    }
    // Pending AI suggestion: dotted outline only, the inside stays as painted.
    if (suggestion && suggestion.caseId === caseId) {
      drawSuggestionEdges(
        img, w, h, suggestion, dims, vol.axes.axial.slice,
        (a, b) => sampleAt(p, vol, a, b, s),
        {
          bone: isLabelVisible(1, view),
          edema: isLabelVisible(2, view),
          skip: currentTorch ? (a, b) => isInTorch(a, b, p, currentTorch) : undefined,
        },
        { bone: SEGMENTS[0].color, edema: SEGMENTS[1].color },
      );
    }
    ctx.putImageData(img, 0, 0);

    // Crosshair, drawn after the pixels so it sits on top.
    const { a: ca, b: cb } = cursorInPlane(p, vol, cursor);
    const y = h - 1 - cb;
    ctx.save();
    ctx.strokeStyle = PLANE_COLOR[p];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, Math.round(w / 400));
    const gap = Math.max(6, Math.round(w / 28));
    ctx.beginPath();
    ctx.moveTo(ca, 0); ctx.lineTo(ca, Math.max(0, y - gap));
    ctx.moveTo(ca, Math.min(h, y + gap)); ctx.lineTo(ca, h);
    ctx.moveTo(0, y); ctx.lineTo(Math.max(0, ca - gap), y);
    ctx.moveTo(Math.min(w, ca + gap), y); ctx.lineTo(w, y);
    ctx.stroke();
    ctx.restore();

    // Live pencil trace on the plane being drawn in, as in the 2D painter:
    // either a dotted edge alone, or a solid edge over the area that will be
    // filled on release.
    if (pencilPlane.current === p && outline.current.length > 1) {
      // Erasing shows as a white outline (over a darkened area): what will be
      // removed, never mistakable for an edema (red) outline.
      const color = erasing ? "#ffffff" : SEGMENTS.find((x) => x.value === seg)!.color;
      const lw = Math.max(1.5, Math.round(w / 300));
      ctx.save();
      ctx.beginPath();
      const [x0, y0] = outline.current[0];
      ctx.moveTo(x0, h - 1 - y0);
      for (const [x, y] of outline.current.slice(1)) ctx.lineTo(x, h - 1 - y);
      ctx.closePath();
      if (!pencilDotted) {
        ctx.globalAlpha = erasing ? 0.4 : 0.22;
        ctx.fillStyle = erasing ? "#000000" : color;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.setLineDash([0, lw * 2.5]);
        ctx.lineCap = "round";
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }

    // Move tool: the selected region's box and its resize handles.
    const sel = moveSel.current;
    if (sel && sel.plane === p && sel.region.masks.has(s)) {
      const { x0, y0, x1, y1 } = sel.to;
      const lw = Math.max(1, Math.round(w / 350));
      const hs = Math.max(4, Math.round(w / 70));
      ctx.save();
      ctx.lineWidth = lw;
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.strokeRect(x0, h - y1, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      for (const [hx, hy] of [[x0, y0], [mx, y0], [x1, y0], [x0, my], [x1, my], [x0, y1], [mx, y1], [x1, y1]]) {
        ctx.fillRect(hx - hs / 2, h - hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, h - hy - hs / 2, hs, hs);
      }
      ctx.restore();
    }

    // Other participants' pointers on this view.
    if (collabToken) {
      for (const pt of participantsRef.current) {
        const c = pt.cursor;
        if (pt.id === currentUserIdRef.current || !pt.connected || !c || c.plane !== p) continue;
        const px = c.x * w;
        const py = h - 1 - c.y * h;
        const r = Math.max(3, w / 110);
        ctx.save();
        ctx.fillStyle = getColorForUser(pt.id);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.lineWidth = Math.max(1, w / 400);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.font = `bold ${Math.max(9, Math.round(w / 40))}px sans-serif`;
        ctx.fillText(pt.initials, px + r + 2, py - r);
        ctx.restore();
      }
    }

    // Torch ring on the plane being viewed with torch
    if (currentTorch && currentTorch.plane === p) {
      const cy = h - 1 - currentTorch.b;
      ctx.save();
      // Outer dark ring
      ctx.beginPath();
      ctx.arc(currentTorch.a, cy, currentTorch.radius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Inner white ring
      ctx.beginPath();
      ctx.arc(currentTorch.a, cy, currentTorch.radius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  }, [vol, labels, cursor, seg, erasing, outlineTick, planeGeom, sampleAt, cursorInPlane, sliceOf, view, opacity,
      collabToken, suggestion, caseId, pencilDotted, moveTick]);

  const drawAll = useCallback(() => { PLANES.forEach(draw); }, [draw]);
  useEffect(() => { drawAll(); }, [drawAll]);

  const scheduleTorchRedraw = useCallback((p: Plane) => {
    if (torchRafRef.current !== null) return;
    torchRafRef.current = requestAnimationFrame(() => {
      torchRafRef.current = null;
      draw(p);
    });
  }, [draw]);

  useEffect(() => {
    return () => {
      if (torchRafRef.current !== null) {
        cancelAnimationFrame(torchRafRef.current);
      }
    };
  }, []);

  // Synchronize torch visibility when tool or torchHeld changes
  useEffect(() => {
    if (tool === "torch" || torchHeld) {
      const lp = lastPointerPosRef.current;
      if (lp) {
        torchRef.current = {
          plane: lp.plane,
          a: lp.a,
          b: lp.b,
          radius: torchSizeRef.current / 2,
        };
        draw(lp.plane);
      }
    } else {
      if (torchRef.current) {
        const p = torchRef.current.plane;
        torchRef.current = null;
        draw(p);
      }
    }
  }, [tool, torchHeld, draw]);

  // Synchronize torch radius changes
  useEffect(() => {
    if (torchActiveRef.current && torchRef.current) {
      torchRef.current.radius = torchSize / 2;
      draw(torchRef.current.plane);
    }
  }, [torchSize, draw]);

  const recount = useCallback(() => {
    if (!labels) return;
    const c: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < labels.length; i++) {
      const v = labels[i];
      if (v) c[v - 1]++;
    }
    setCounts(c);
  }, [labels]);

  // ---- history ---------------------------------------------------------
  const markEdited = useCallback(() => {
    editVersion.current++;
    setDirty(true);
    scheduleFlush();
  }, [scheduleFlush]);

  const pushUndo = useCallback(() => {
    if (!labels) return;
    undoStack.current.push(labels.slice());
    if (undoStack.current.length > 30) undoStack.current.shift();
    redoStack.current = []; // a new stroke invalidates the redo branch
  }, [labels]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev || !labels) return;
    redoStack.current.push(labels.slice());
    setLabels(prev); markEdited();
    scheduleAutoSaveRef.current(prev);
  }, [labels, markEdited]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next || !labels) return;
    undoStack.current.push(labels.slice());
    setLabels(next); markEdited();
    scheduleAutoSaveRef.current(next);
  }, [labels, markEdited]);

  useEffect(() => { recount(); }, [labels, recount]);

  // ---- live review -----------------------------------------------------
  const permsRef = useRef({ annotate: canAnnotate, zoomPan: canZoomPan, slices: canMoveSlices });
  permsRef.current = { annotate: canAnnotate, zoomPan: canZoomPan, slices: canMoveSlices };
  const drawAllRef = useRef(drawAll);
  drawAllRef.current = drawAll;
  const recountRef = useRef(recount);
  recountRef.current = recount;
  const syncStem = `3d-${seriesId || "primary"}`;
  syncIORef.current = {
    sendOp: (opId, runs) => collab.sendMaskOp({ caseId, stem: syncStem, opId, runs }),
    render: () => {
      drawAllRef.current();
      recountRef.current();
    },
    newOpId: () =>
      `${collab.currentUserId || "me"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
  };

  // Undo and redo swap the whole label array, so they reach the session
  // through here rather than through a stroke.
  useEffect(() => { scheduleFlush(); }, [labels, scheduleFlush]);

  // Open the loaded series in the live session - on load, on connecting, and
  // again after a reconnect.
  useEffect(() => {
    if (!collabToken) {
      maskSync.leave();
      return;
    }
    const screen = labelsRef.current;
    if (!collab.connected || !vol || !screen) return;
    const base = maskSync.join(`${caseId}::${syncStem}`, screen, canEditRef.current);
    collab.sendMaskJoin({ caseId, stem: syncStem, width: screen.length, height: 1, base });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabToken, collab.connected, vol]);

  // Share this client's view: crosshair, active view, series, zoom and pan.
  const shareViewpoint = useCallback(() => {
    if (!collabToken || !collab.connected || !vol) return;
    const signature = JSON.stringify([cursor, activePlane, zoom, pan, seriesId]);
    // Do not echo a view we only adopted because we are following someone.
    // Two participants following each other would otherwise bounce the same
    // viewpoint back and forth.
    if (appliedRemoteView.current === signature) {
      appliedRemoteView.current = null;
      return;
    }
    collab.updateViewpoint({
      sliceIndex: axisVal(cursor, vol.axes[activePlane].slice),
      maxSlices: vol.dims[vol.axes[activePlane].slice],
      plane: activePlane,
      zoom: zoom[activePlane],
      pan: pan[activePlane],
      selectedCaseId: caseId,
      seriesId,
      cursor3d: cursor,
      zoom3d: zoom,
      pan3d: pan,
    });
  }, [collabToken, collab.connected, collab.updateViewpoint, vol, cursor, activePlane, zoom, pan, seriesId, caseId]);
  useEffect(() => { shareViewpoint(); }, [shareViewpoint]);

  // Re-broadcast when participants join or reconnect, so they land on the
  // host's view. Masks need no help here: a joiner gets them from the server.
  useEffect(() => {
    if (collab.role === "MASTER") {
      appliedRemoteView.current = null;
      shareViewpoint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.participants.length]);

  applyViewpointRef.current = (vp) => {
    if (!vol || (vp.selectedCaseId && vp.selectedCaseId !== caseId)) return;
    const inBounds = (c: Cursor) =>
      c.i >= 0 && c.j >= 0 && c.k >= 0 && c.i < vol.dims[0] && c.j < vol.dims[1] && c.k < vol.dims[2];
    const nextSeries = vp.seriesId && seriesChoices.some((c) => c.id === vp.seriesId) ? vp.seriesId : seriesId;
    if (nextSeries !== seriesId) {
      // The volume reloads; the view is applied once it has.
      setSeriesId(nextSeries);
      return;
    }
    const nextCursor = vp.cursor3d && inBounds(vp.cursor3d) ? vp.cursor3d : cursor;
    const nextPlane = vp.plane ?? activePlane;
    const nextZoom = (vp.zoom3d as Record<Plane, number> | undefined) ?? zoom;
    const nextPan = (vp.pan3d as Record<Plane, { x: number; y: number }> | undefined) ?? pan;
    appliedRemoteView.current = JSON.stringify([nextCursor, nextPlane, nextZoom, nextPan, nextSeries]);
    setCursor(nextCursor);
    setActivePlane(nextPlane);
    setZoom(nextZoom);
    setPan(nextPan);
  };

  // Snap to the followed participant's last known view the moment we start
  // following them, and again once a series switch has finished loading.
  useEffect(() => {
    if (!followUserId || !vol) return;
    const vp = lastViewpointByUser.current.get(followUserId)
      ?? (collab.participants.find((p) => p.id === followUserId)?.role === "MASTER" ? collab.viewpoint : null);
    if (vp) applyViewpointRef.current(vp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUserId, vol]);

  // Default to following the host, so a radiologist opening the link lands on
  // the same view without having to do anything. Settled once, then it is the
  // participant's own choice.
  const masterId = collab.participants.find((p) => p.role === "MASTER")?.id ?? null;
  useEffect(() => {
    if (followInitialised.current || !collabToken || !isCollaborator || !masterId) return;
    if (masterId === collab.currentUserId) return;
    followInitialised.current = true;
    setFollowUserId(masterId);
  }, [collabToken, isCollaborator, masterId, collab.currentUserId]);

  // Stop following someone who has left.
  useEffect(() => {
    if (!followUserId) return;
    if (!collab.participants.some((p) => p.id === followUserId && p.connected)) setFollowUserId(null);
  }, [collab.participants, followUserId]);

  // Redraw when someone's pointer moves.
  useEffect(() => {
    if (collabToken) drawAllRef.current();
  }, [collab.participants, collabToken]);

  // Ctrl+wheel (or a touchpad pinch) zooms the view under the pointer; a
  // plain wheel scrolls the page. Listeners are non-passive so preventDefault
  // can stop the browser zooming the whole page instead.
  useEffect(() => {
    if (!vol) return;
    const cleanups: Array<() => void> = [];
    for (const p of PLANES) {
      const el = viewRefs.current[p];
      if (!el) continue;
      const onWheel = (e: WheelEvent) => {
        const factor = wheelZoomFactor(e);
        if (factor === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (!canZoomPanRef.current) return;
        setZoom((z) => ({ ...z, [p]: clampZoom(z[p] * factor) }));
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => el.removeEventListener("wheel", onWheel));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [vol]);

  // ---- pan -------------------------------------------------------------
  // Dragging is followed on the window, so the view keeps moving when the
  // pointer runs off the canvas mid-drag.
  const panStart = useRef<{ id: number; plane: Plane; x: number; y: number; ox: number; oy: number } | null>(null);
  const startPan = useCallback((p: Plane, e: React.PointerEvent) => {
    panStart.current = { id: e.pointerId, plane: p, x: e.clientX, y: e.clientY, ox: pan[p].x, oy: pan[p].y };
    setPanning(p);
  }, [pan]);
  const stopPan = useCallback(() => { panStart.current = null; setPanning(null); }, []);
  useEffect(() => {
    if (!panning) return;
    const move = (e: PointerEvent) => {
      const st = panStart.current;
      if (!st || st.id !== e.pointerId) return;
      setPan((cur) => ({ ...cur, [st.plane]: { x: st.ox + e.clientX - st.x, y: st.oy + e.clientY - st.y } }));
    };
    const up = (e: PointerEvent) => { if (panStart.current?.id === e.pointerId) stopPan(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [panning, stopPan]);

  // ---- touch -----------------------------------------------------------
  // Two fingers pinch to zoom and drag to pan. One finger draws, until a
  // stylus has been used: from then on a finger pans and the pen draws, so a
  // palm resting on the screen does not paint.
  const penSeen = useRef(false);
  const pinches = useRef<Record<Plane, Pinch>>({ axial: new Pinch(), coronal: new Pinch(), sagittal: new Pinch() });
  const pinchStart = useRef<{ plane: Plane; zoom: number; pan: { x: number; y: number }; cx: number; cy: number } | null>(null);

  const resetView = (p: Plane) => {
    setZoom((z) => ({ ...z, [p]: 1 }));
    setPan((cur) => ({ ...cur, [p]: { x: 0, y: 0 } }));
  };

  // ---- painting --------------------------------------------------------
  /** The in-plane voxel under a screen point, or null off the image. */
  const toVoxelAt = useCallback((p: Plane, clientX: number, clientY: number) => {
    const cv = canvases.current[p];
    if (!vol || !cv) return null;
    const rect = cv.getBoundingClientRect();
    const { w, h } = planeGeom(p, vol);
    const a = Math.floor(((clientX - rect.left) / rect.width) * w);
    const b = h - 1 - Math.floor(((clientY - rect.top) / rect.height) * h);
    if (a < 0 || b < 0 || a >= w || b >= h) return null;
    return { a, b };
  }, [vol, planeGeom]);
  const toVoxel = useCallback(
    (p: Plane, ev: React.PointerEvent<HTMLCanvasElement>) => toVoxelAt(p, ev.clientX, ev.clientY),
    [toVoxelAt],
  );

  /** Move the crosshair so the other two views follow this click. */
  const moveCursor = useCallback((p: Plane, a: number, b: number) => {
    if (!vol) return;
    const ax = vol.axes[p];
    const ha = ax.flipH ? vol.dims[ax.h] - 1 - a : a;
    const vb = ax.flipV ? vol.dims[ax.v] - 1 - b : b;
    setCursor((c) => setAxis(setAxis(c, ax.h, ha), ax.v, vb));
  }, [vol]);

  /**
   * Whether bone marrow is painted anywhere on this plane's current slice.
   * "Only inside bone" applies only once it is, as in the 2D painter;
   * otherwise a fresh case could not take any edema at all.
   */
  const sliceHasBone = useCallback((p: Plane) => {
    if (!vol || !labels) return false;
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);
    for (let b = 0; b < h; b++)
      for (let a = 0; a < w; a++)
        if (labels[sampleAt(p, vol, a, b, s)] === 1) return true;
    return false;
  }, [vol, labels, cursor, planeGeom, sliceOf, sampleAt]);
  const strokeHasBone = useRef(false);

  const paintAt = useCallback((p: Plane, hit: { a: number; b: number }) => {
    if (!vol || !labels) return;
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);
    const r = brush;

    for (let db = -r; db <= r; db++) {
      for (let da = -r; da <= r; da++) {
        if (da * da + db * db > r * r) continue;
        const a = hit.a + da, b = hit.b + db;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const i = sampleAt(p, vol, a, b, s);
        if (!canPaint(labels[i], seg, { erasing, insideBone: maskInside, hasBone: strokeHasBone.current, protectLesion })) continue;
        labels[i] = erasing ? 0 : seg;
      }
    }
    markEdited();
    // Every plane, not just this one — the label volume is shared, so a stroke
    // here changes what the other two views should be showing.
    drawAll();
  }, [vol, labels, cursor, brush, erasing, seg, maskInside, protectLesion,
      planeGeom, sampleAt, sliceOf, drawAll, markEdited]);

  /** Add a point to the pencil outline being traced, skipping repeats. */
  const traceTo = useCallback((hit: { a: number; b: number }) => {
    const last = outline.current[outline.current.length - 1];
    if (!last || last[0] !== hit.a || last[1] !== hit.b) {
      outline.current.push([hit.a, hit.b]);
      setOutlineTick((n) => n + 1);
    }
  }, []);

  /**
   * Pencil: close the traced outline and fill everything inside it.
   *
   * Even-odd scanline fill rather than flood fill. Flood fill leaks the moment
   * the traced boundary has a single-pixel gap — easy to do with a mouse, and
   * the leak is silent and large. A polygon is closed by definition, so the
   * worst case is a slightly wrong shape rather than a whole slice filled.
   */
  const commitOutline = useCallback(() => {
    const pts = outline.current;
    const p = pencilPlane.current;
    outline.current = [];
    pencilPlane.current = null;
    setOutlineTick((n) => n + 1);
    if (!vol || !labels || !p || pts.length < 3) { drawAll(); return; }
    pushUndo();
    const { w, h } = planeGeom(p, vol);
    const s = sliceOf(p, vol, cursor);
    const hasBone = sliceHasBone(p);

    let minB = Infinity, maxB = -Infinity;
    for (const [, b] of pts) { if (b < minB) minB = b; if (b > maxB) maxB = b; }
    minB = Math.max(0, Math.floor(minB)); maxB = Math.min(h - 1, Math.ceil(maxB));

    for (let b = minB; b <= maxB; b++) {
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[j];
        if ((ay > b) !== (by > b)) xs.push(ax + ((b - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]));
        const to = Math.min(w - 1, Math.floor(xs[k + 1]));
        for (let a = from; a <= to; a++) {
          const flat = sampleAt(p, vol, a, b, s);
          if (!canPaint(labels[flat], seg, { erasing, insideBone: maskInside, hasBone, protectLesion })) continue;
          labels[flat] = erasing ? 0 : seg;
        }
      }
    }
    markEdited();
    drawAll();
    recount();
    scheduleAutoSaveRef.current();
  }, [vol, labels, cursor, erasing, maskInside, protectLesion, seg, planeGeom, sliceOf, sampleAt, drawAll,
      pushUndo, sliceHasBone, recount, markEdited]);

  // ---- strokes ---------------------------------------------------------
  // A stroke ends when the mouse button is released anywhere, not when the
  // pointer leaves the image: slipping off the edge mid-trace, or the view
  // moving under the pointer, must not fill a half-drawn outline.
  const strokePlane = useRef<Plane | null>(null);
  const [stroking, setStroking] = useState(false);
  const lastClient = useRef<{ plane: Plane; x: number; y: number } | null>(null);
  const areaRefs = useRef<Record<Plane, HTMLDivElement | null>>({ axial: null, coronal: null, sagittal: null });

  // The pointer drawing the stroke. Other fingers, or a palm under the pen,
  // neither extend nor end it.
  const strokePointer = useRef<{ id: number; type: string } | null>(null);

  const beginStroke = (p: Plane, e: React.PointerEvent) => {
    window.getSelection()?.removeAllRanges();
    strokePlane.current = p;
    strokePointer.current = { id: e.pointerId, type: e.pointerType };
    painting.current = true;
    setStroking(true);
  };
  const endStroke = () => {
    if (!painting.current) return;
    const wasTracing = tool === "pencil";
    painting.current = false;
    strokePlane.current = null;
    strokePointer.current = null;
    setStroking(false);
    if (wasTracing) {
      commitOutline();
    } else {
      drawAll();
      // Labels are edited in place, so counts are refreshed when a stroke
      // ends rather than on every mouse move.
      recount();
      scheduleAutoSaveRef.current();
    }
  };
  /**
   * A second finger landing mid-stroke means a pinch, not a drawing: drop the
   * outline, or put back what the brush already painted.
   */
  const cancelStroke = () => {
    if (!painting.current) return;
    if (tool === "brush" && labels) {
      const before = undoStack.current.pop();
      if (before) { labels.set(before); markEdited(); recount(); }
    }
    outline.current = []; pencilPlane.current = null; painting.current = false;
    strokePlane.current = null; strokePointer.current = null; setStroking(false);
    setOutlineTick((n) => n + 1); drawAll();
  };
  // The undo snapshots of the last two brush strokes. A double-click to open a
  // view full size starts two strokes first; their dots are taken back.
  const recentTaps = useRef<{ at: number; snap: Uint8Array }[]>([]);
  const takeBackDoubleClickDots = () => {
    const taps = recentTaps.current;
    recentTaps.current = [];
    const st = undoStack.current;
    if (taps.length < 2 || !labels) return;
    const [a, b] = taps;
    if (b.at - a.at > 600 || st[st.length - 1] !== b.snap || st[st.length - 2] !== a.snap) return;
    st.length -= 2;
    labels.set(a.snap);
    markEdited(); recount(); drawAll();
    scheduleAutoSaveRef.current();
  };
  const endStrokeRef = useRef(endStroke);
  endStrokeRef.current = endStroke;
  useEffect(() => {
    const up = (e: PointerEvent) => {
      if (strokePointer.current && strokePointer.current.id !== e.pointerId) return;
      endStrokeRef.current();
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  /** Keep drawing under a pointer that is still while the view moves under it. */
  const followPointer = (p: Plane, x: number, y: number) => {
    if (!painting.current || strokePlane.current !== p) return;
    const hit = toVoxelAt(p, x, y);
    if (!hit) return;
    if (tool === "pencil") traceTo(hit);
    else if (tool === "brush") paintAt(p, hit);
  };
  const followPointerRef = useRef(followPointer);
  followPointerRef.current = followPointer;

  // Auto-pan: while drawing, a pointer near the edge of a view slides the
  // image towards whatever is out of sight, and the stroke carries on.
  useEffect(() => {
    if (!stroking || !autoPan) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;
      const ptr = lastClient.current;
      const p = strokePlane.current;
      if (ptr && p && ptr.plane === p && painting.current && !spaceHeldRef.current && canZoomPanRef.current) {
        const area = areaRefs.current[p];
        const cv = canvases.current[p];
        if (area && cv) {
          const step = edgePanStep(ptr, area.getBoundingClientRect(), cv.getBoundingClientRect(), dt);
          if (step) {
            setPan((cur) => ({ ...cur, [p]: { x: cur[p].x + step.dx, y: cur[p].y + step.dy } }));
            followPointerRef.current(p, ptr.x, ptr.y);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stroking, autoPan, spaceHeldRef]);

  // ---- move / resize ---------------------------------------------------
  // Click a painted region to select it, drag inside its box to move it, drag
  // an edge or corner to resize it. Each drag is one undo step. The label
  // volume is edited live, so the other views and the 3D render follow.
  const dropSelection = useCallback(() => {
    if (!moveSel.current) return;
    moveSel.current = null;
    setMoveTick((n) => n + 1);
  }, []);

  /** A screen point in this plane's voxel units, unclamped, and 8 px in voxels. */
  const toPlanePoint = useCallback((p: Plane, clientX: number, clientY: number) => {
    const cv = canvases.current[p];
    if (!vol || !cv) return null;
    const rect = cv.getBoundingClientRect();
    const { w, h } = planeGeom(p, vol);
    return {
      x: ((clientX - rect.left) / rect.width) * w,
      y: h - ((clientY - rect.top) / rect.height) * h,
      tol: (8 * w) / rect.width,
    };
  }, [vol, planeGeom]);

  /** Lift the selection off where it was and stamp it at `to`. */
  const placeSelection = useCallback((to: Box) => {
    const sel = moveSel.current;
    if (!sel || !vol || !labels) return;
    const { under, stamped } = sel;
    for (let n = 0; n < stamped.length; n++) labels[stamped[n]] = under[stamped[n]];
    const { w, h } = planeGeom(sel.plane, vol);
    const out: number[] = [];
    placeRegion(sel.region, to, w, h, (a, b, sl, v) => {
      const f = sampleAt(sel.plane, vol, a, b, sl);
      if (under[f] === 255) under[f] = labels[f];
      if (!canPaint(under[f], v, { erasing: false, insideBone: false, hasBone: false, protectLesion })) return;
      labels[f] = v;
      out.push(f);
    });
    sel.stamped = Int32Array.from(out);
    sel.to = to;
    markEdited();
    drawAll();
  }, [vol, labels, planeGeom, sampleAt, protectLesion, markEdited, drawAll]);

  const moveDrag = useRef<{
    id: number; plane: Plane; handle: Handle; x: number; y: number; start: Box; pushed: boolean;
  } | null>(null);
  const [moveDragging, setMoveDragging] = useState(false);

  /** Grab the selection's box or handle, or select the region under the pointer. */
  const startMove = (p: Plane, e: React.PointerEvent) => {
    if (!vol || !labels) return;
    const pt = toPlanePoint(p, e.clientX, e.clientY);
    if (!pt) return;
    const s = sliceOf(p, vol, cursor);
    let sel = moveSel.current;
    let handle = sel && sel.plane === p && sel.region.masks.has(s) ? handleAt(sel.to, pt.x, pt.y, pt.tol) : null;
    if (!handle) {
      const hit = toVoxelAt(p, e.clientX, e.clientY);
      const { w, h, depth } = planeGeom(p, vol);
      const region = hit && selectRegion(
        { a: hit.a, b: hit.b, s },
        { w, h, depth, labels, flat: (a, b, sl) => sampleAt(p, vol, a, b, sl) },
        moveAllSlices,
        (v) => isLabelVisible(v, view),
      );
      if (!region) { dropSelection(); return; }
      const under = new Uint8Array(labels.length).fill(255);
      const stamped = new Int32Array(region.size);
      let n = 0;
      placeRegion(region, region.from, w, h, (a, b, sl) => {
        const f = sampleAt(p, vol, a, b, sl);
        under[f] = 0;
        stamped[n++] = f;
      });
      sel = { plane: p, region, to: region.from, stamped, under };
      moveSel.current = sel;
      setMoveTick((t) => t + 1);
      handle = "move";
    }
    moveDrag.current = { id: e.pointerId, plane: p, handle, x: pt.x, y: pt.y, start: sel!.to, pushed: false };
    setMoveDragging(true);
  };

  const moveDragStep = useRef<(e: PointerEvent) => void>(() => {});
  moveDragStep.current = (e) => {
    const st = moveDrag.current;
    const sel = moveSel.current;
    if (!st || !sel || st.id !== e.pointerId) return;
    const pt = toPlanePoint(st.plane, e.clientX, e.clientY);
    if (!pt) return;
    const to = dragBox(st.start, st.handle, Math.round(pt.x - st.x), Math.round(pt.y - st.y), e.shiftKey);
    if (sameBox(to, sel.to)) return;
    if (!st.pushed) { pushUndo(); st.pushed = true; }
    placeSelection(to);
  };
  const endMoveDrag = useRef<(e: PointerEvent) => void>(() => {});
  endMoveDrag.current = (e) => {
    const st = moveDrag.current;
    if (!st || st.id !== e.pointerId) return;
    moveDrag.current = null;
    setMoveDragging(false);
    if (!st.pushed) return;
    recount();
    scheduleAutoSaveRef.current();
  };
  useEffect(() => {
    if (!moveDragging) return;
    const move = (e: PointerEvent) => moveDragStep.current(e);
    const up = (e: PointerEvent) => endMoveDrag.current(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [moveDragging]);

  // The selection describes the label volume as it was when taken. A new
  // volume (load, undo, redo, import), another tool, or a change of scope
  // makes it stale, so it is dropped.
  useEffect(() => { dropSelection(); }, [labels, dropSelection]);
  useEffect(() => { if (tool !== "move") dropSelection(); }, [tool, dropSelection]);
  useEffect(() => { dropSelection(); }, [moveAllSlices, dropSelection]);

  const clearMask = useCallback(() => {
    if (!labels) return;
    dropSelection();
    pushUndo();
    labels.fill(0);
    setCounts([0, 0, 0]);
    drawAll();
    markEdited();
    scheduleAutoSaveRef.current();
    toast.info("Cleared 3D canvas mask");
  }, [labels, pushUndo, drawAll, markEdited, dropSelection]);

  /**
   * Copy one axial slice of the suggestion into the real mask. Voxels the
   * model left empty are not touched, and Protect lesion holds as it does for
   * the brush. One undo step, and saved like any other edit.
   */
  const acceptSuggestion = useCallback((s: number) => {
    if (!suggestion || !vol || !labels || suggestion.caseId !== caseId) return;
    if (suggestion.decisions[s] !== "pending") return;
    const { w, h } = planeGeom("axial", vol);
    dropSelection();
    pushUndo();
    for (let b = 0; b < h; b++)
      for (let a = 0; a < w; a++) {
        const f = sampleAt("axial", vol, a, b, s);
        const v = suggestion.labels[f];
        if (v && canPaint(labels[f], v, { erasing: false, insideBone: false, hasBone: false, protectLesion })) {
          labels[f] = v;
        }
      }
    markEdited();
    recount();
    suggestions.decide(s, "accepted");
    scheduleAutoSaveRef.current();
  }, [suggestion, suggestions.decide, vol, labels, caseId, planeGeom, sampleAt, pushUndo, protectLesion,
      markEdited, recount, dropSelection]);

  /** Move the axial view to the next (or previous) slice still waiting for a decision. */
  const gotoPendingSlice = (dir: 1 | -1) => {
    if (!suggestion || !vol) return;
    const ax = vol.axes.axial.slice;
    const n = suggestion.decisions.length;
    const from = axisVal(cursor, ax);
    for (let k = 1; k <= n; k++) {
      const s = (from + dir * k + n) % n;
      if (suggestion.decisions[s] === "pending") {
        setCursor((c) => setAxis(c, ax, s));
        setActivePlane("axial");
        return;
      }
    }
  };

  const deleteMask = async (ask = true) => {
    if (ask && !confirm(`Delete saved 3D mask for ${caseId}?`)) return;
    setDeletingMask(true);
    try {
      const res = await fetch(withAccess(`/api/annotation/${encodeURIComponent(caseId)}`), {
        method: "DELETE",
      });
      if (res.ok) {
        clearMask();
        setDirty(false);
        setHasSaved(false);
        toast.success(`Deleted saved 3D mask for ${caseId}`);
        onSaved?.();
      } else {
        toast.error("Failed to delete mask from server");
      }
    } catch {
      toast.error("Error deleting mask");
    } finally {
      setDeletingMask(false);
    }
  };

  // ---- save ------------------------------------------------------------
  /** Write a label snapshot for one series and record it in the ledger. */
  const persist = useCallback(async (snap: Uint8Array, series: string) => {
    const me = (isCollaborator ? collaboratorUserName : null) || session?.user?.name || session?.user?.email || "unknown";
    const seriesQ = series && series !== "primary" ? `&series=${encodeURIComponent(series)}` : "";
    const res = await fetch(withAccessRef.current(`/api/annotation/${caseId}?by=${encodeURIComponent(me)}${seriesQ}`), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(snap),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? "save failed");

    let logged = false;
    // The ledger is for the team; a guest's save is recorded on disk only.
    if (!isCollaborator) try {
      const c = countLabels(snap);
      const logRes = await fetch("/api/annotation-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId, annotator: me,
          counts: { bone_marrow: c[0], bme: c[1], uncertain: c[2] },
        }),
      });
      logged = (await logRes.json())?.ok === true;
    } catch { /* ledger unavailable */ }
    return { me, logged };
  }, [caseId, session, isCollaborator, collaboratorUserName]);

  const seriesRef = useRef(seriesId);
  seriesRef.current = seriesId;

  const save = useCallback(async () => {
    if (!labels) return;
    if (savedLoadError) {
      toast.error("The saved annotation for this case could not be loaded, so saving would overwrite it. Re-import it or fix the file first.");
      return;
    }
    // Brush strokes write the mask in place and do not replace the array, so the
    // displayed counts can still be zero after a real stroke. Count the buffer.
    const live: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < labels.length; i++) {
      const v = labels[i];
      if (v >= 1 && v <= 3) live[v - 1]++;
    }
    setCounts(live);
    const total = live[0] + live[1] + live[2];
    if (total === 0) {
      if (hasSaved) {
        if (confirm("This annotation is now blank. Delete the saved mask?")) await deleteMask(false);
      } else {
        toast.error("Cannot save empty annotation: No voxels annotated yet.");
        setStatus("Cannot save empty annotation: No voxels annotated yet.");
      }
      return;
    }
    if (annotatedSeries && seriesId && seriesId !== annotatedSeries && seriesId !== "primary") {
      const ok = confirm(`Edema is stored on ${annotatedSeries}. Saving on ${seriesId} replaces that outline with this scan. Continue?`);
      if (!ok) return;
    }
    setSaving(true);
    saveInFlight.current = true;
    const version = editVersion.current;

    try {
      const { me, logged } = await persist(labels.slice(), seriesId);
      setStatus(logged
        ? `Saved — recorded as annotated by ${me}`
        : "Saved to disk (not recorded: database unreachable)");
      if (editVersion.current === version) setDirty(false);
      setHasSaved(true);
      if (seriesId) setAnnotatedSeries(seriesId);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
      toast.success(`Saved 3D mask for ${caseId}`);
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "save failed";
      setStatus(msg);
      toast.error(msg);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [labels, counts, caseId, onSaved, savedLoadError, seriesId, annotatedSeries, hasSaved, persist]);

  // Auto save: a short pause after each stroke, undo or clear. The snapshot,
  // case and series are fixed when it is queued, so it lands on the scan it
  // was drawn on even if the user has moved on by then.
  scheduleAutoSaveRef.current = (source) => {
    const current = source ?? labels;
    if (!autoSave || !current || savedLoadError) return;
    if (annotatedSeries && seriesId && seriesId !== annotatedSeries && seriesId !== "primary") {
      setAutoSaveStatus(`Auto save off here: edema is on ${annotatedSeries}`);
      return;
    }
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = null;
    const snap = current.slice();
    // A blank volume is never auto saved; Save offers to delete the file instead.
    if (!snap.some((v) => v !== 0)) return;
    const version = editVersion.current;
    const series = seriesId;
    latestAutoVersion.current.set(series, version);

    const run = async () => {
      if ((latestAutoVersion.current.get(series) ?? version) > version) return;
      if (saveInFlight.current) {
        setTimeout(run, 500);
        return;
      }
      saveInFlight.current = true;
      setAutoSaveStatus("Auto-saving…");
      try {
        await persist(snap, series);
        const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        setAutoSaveStatus(`Auto-saved ${time}`);
        if (seriesRef.current === series && editVersion.current === version) setDirty(false);
        setHasSaved(true);
        onSaved?.();
      } catch {
        setAutoSaveStatus("Auto-save failed");
      } finally {
        saveInFlight.current = false;
      }
    };
    autoTimer.current = setTimeout(run, 1000);
  };

  // ---- review flag -----------------------------------------------------
  // One flag per case. It notes the view and slice it was raised on, so the
  // reviewer knows where to look.
  const flagWhere = () => {
    if (!vol) return "";
    const s = sliceOf(activePlane, vol, cursor);
    const series = seriesChoices.find((c) => c.id === seriesId)?.label;
    return `${activePlane} ${s + 1}/${vol.dims[vol.axes[activePlane].slice]}${series ? ` (${series})` : ""}`;
  };

  const writeCaseFlag = async (body: Record<string, unknown>) => {
    setFlagSaving(true);
    try {
      const res = await fetch(withAccess(`/api/annotation/${caseId}/flag`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { flag?: FlagRecord | null; error?: string };
      if (!res.ok) throw new Error(j.error ?? "could not save the flag");
      setFlag(j.flag ?? null);
      setFlagModalOpen(false);
      toast.success(j.flag ? "Case flagged for review" : "Flag removed");
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "could not save the flag");
    } finally {
      setFlagSaving(false);
    }
  };

  // ---- import from 3D Slicer ---------------------------------------------
  const importSlicer = async (file: File) => {
    if (!vol) return;
    if (!file.name.toLowerCase().endsWith(".nrrd")) {
      toast.error("Choose a .seg.nrrd saved from 3D Slicer.");
      return;
    }
    const hasWork = counts[0] + counts[1] + counts[2] > 0;
    if ((hasWork || savedLoadError) &&
        !confirm(`Replace the current annotation for ${caseId} with the imported file? The current one is overwritten.`)) {
      return;
    }
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = null;
    latestAutoVersion.current.set(seriesId, editVersion.current + 1);
    setImporting(true);
    setStatus("Importing from 3D Slicer…");
    try {
      const me = session?.user?.name || session?.user?.email || "unknown";
      const res = await fetch(`/api/annotation/${caseId}/import?by=${encodeURIComponent(me)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const j = (await res.json()) as {
        error?: string;
        counts?: Record<string, number>;
        warnings?: string[];
      };
      if (!res.ok) throw new Error(j.error ?? "import failed");

      const saved = await fetchSavedLabels(caseId, vol.dims[0] * vol.dims[1] * vol.dims[2]);
      if (!saved.labels) throw new Error("import finished but no annotation was written");
      undoStack.current = [];
      redoStack.current = [];
      setLabels(saved.labels);
      setSavedLoadError(null);
      setDirty(false);
      setHasSaved(true);
      for (const w of j.warnings ?? []) toast.warning(w);

      try {
        await fetch("/api/annotation-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseId, annotator: me, counts: j.counts ?? {} }),
        });
      } catch { /* ledger unavailable */ }

      setStatus(`Imported from 3D Slicer and saved as ${caseId}.seg.nrrd`);
      toast.success(`Imported 3D Slicer annotation for ${caseId}`);
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "import failed";
      setStatus(msg);
      toast.error(msg);
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  // ---- keyboard shortcuts (identical to 2D) ------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Keys for tools a guest has not been granted do nothing.
      const annotateKey = mod ? ["z", "y", "s"].includes(k) : ["1", "2", "3", "4", "5", "8", "0", "b", "p", "m", "e"].includes(k);
      if (annotateKey && !permsRef.current.annotate) return;
      if (!mod && (k === "6" || k === "h") && !permsRef.current.zoomPan) return;
      if (!mod && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(e.key)
          && !permsRef.current.slices) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault(); redo(); return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (mod) return;
      if (e.key === "1") { setSeg(1); drawWithLabel(); }
      else if (e.key === "2") { setSeg(2); drawWithLabel(); }
      else if (e.key === "3") { setSeg(3); drawWithLabel(); }
      else if (e.key === "4" || e.key.toLowerCase() === "b") { pickTool("brush"); }
      else if (e.key === "5" || e.key.toLowerCase() === "p") { pickTool("pencil"); }
      else if (e.key === "6" || e.key.toLowerCase() === "h") { pickTool("pan"); }
      else if (e.key === "7") { pickTool("torch"); }
      else if (e.key === "8" || e.key.toLowerCase() === "m") { pickTool("move"); }
      else if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) { setTorchHeld(true); }
      else if (e.key === "0" || e.key.toLowerCase() === "e") toggleEraser();
      else if (e.key.toLowerCase() === "v") cycleViewRef.current();
      else if (e.key.toLowerCase() === "l") setLocked((v) => !v);
      else if (e.key.toLowerCase() === "f" && !painting.current) focusToggleRef.current();
      else if (e.key === "Escape" && showShortcutsRef.current) {
        setShowShortcuts(false);
      }
      else if (e.key === "Escape" && moveSel.current && !moveDrag.current) dropSelection();
      // Esc leaves focus mode outright, not one layout at a time: in browser
      // fullscreen the browser takes Esc and leaves anyway.
      else if (e.key === "Escape" && focusOnRef.current && !painting.current) {
        setSettingsOpen(false);
        focusExitRef.current();
      }
      else if (e.key === "Escape" && expandedRef.current && !painting.current) {
        setExpanded(null);
      }
      else if (e.key === "Escape") {
        outline.current = []; pencilPlane.current = null; painting.current = false;
        strokePlane.current = null; setStroking(false);
        setOutlineTick((n) => n + 1); drawAll();
      }
      else if (e.key === "[") {
        if (torchActiveRef.current) {
          setTorchSize((t) => {
            const next = Math.max(8, t - 8);
            try { localStorage.setItem("bme_viewer_torch_size", String(next)); } catch {}
            return next;
          });
        } else {
          setBrush((b) => Math.max(1, b - 1));
        }
      }
      else if (e.key === "]") {
        if (torchActiveRef.current) {
          setTorchSize((t) => {
            const next = Math.min(240, t + 8);
            try { localStorage.setItem("bme_viewer_torch_size", String(next)); } catch {}
            return next;
          });
        } else {
          setBrush((b) => Math.min(20, b + 1));
        }
      }
      else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                "PageUp", "PageDown"].includes(e.key)) {
        if (!vol) return;
        e.preventDefault();
        const ax = vol.axes[activePlane].slice;
        const depth = vol.dims[ax];
        const big = e.key.startsWith("Page") ? 10 : 1;
        const dir = (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "PageUp") ? 1 : -1;
        setCursor((c) => setAxis(c, ax, Math.min(depth - 1, Math.max(0, axisVal(c, ax) + dir * big))));
      }
    };
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
  }, [undo, redo, drawAll, vol, activePlane, save, dropSelection]);

  if (isCollaborator) {
    const screen = guestSessionScreen(collab);
    if (screen) return screen;
  }

  const changeProtectLesion = (on: boolean) => {
    setProtectLesion(on);
    try {
      localStorage.setItem("bme_protect_lesion", String(on));
    } catch {}
  };
  const changeAutoSave = (on: boolean) => {
    setAutoSave(on);
    try {
      localStorage.setItem("bme_viewer_autosave", on ? "true" : "false");
    } catch { /* ignore */ }
    if (on) toast.success("Auto Save enabled");
    else toast.info("Auto Save disabled");
  };
  // Switching case drops edits that are neither saved nor queued for auto save.
  const switchCase = (go?: () => void) => {
    if (!go) return;
    if (dirty && !autoSave && !confirm(`${caseId} has unsaved changes. Switch case and lose them?`)) return;
    go();
  };

  const guestHeader = isCollaborator && (
    <CollaborationViewerHeader
      caseId={caseId}
      masterConnected={collab.participants.some((p) => p.role === "MASTER" && p.connected)}
      followingMaster={Boolean(followUserId)}
      followingName={collab.participants.find((p) => p.id === followUserId)?.name ?? null}
      canFollowMaster={Boolean(masterId) && masterId !== collab.currentUserId}
      onToggleFollowMaster={() => setFollowUserId((curr) => (curr ? null : masterId))}
      permissions={permissions}
      onLeave={collab.leave}
    />
  );

  const placed = (content: React.ReactNode) => (
    <>
      <div ref={setSlot} className="flex min-h-0 flex-1 flex-col" />
      {stage && createPortal(content, stage)}
    </>
  );

  if (busy) {
    return placed(
      <div className={`flex items-center justify-center gap-2 text-sm text-muted-foreground ${
        focusOn ? "fixed inset-0 z-50 bg-background" : "h-96"
      }`}>
        <Loader2 className="h-4 w-4 animate-spin" /> {status}
      </div>
    );
  }
  if (!vol) {
    return placed(
      <div className={focusOn ? "fixed inset-0 z-50 flex items-center justify-center bg-background p-10 text-sm text-muted-foreground" : "rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground"}>
        {status}
        {focusOn && (
          <button type="button" onClick={focus.exit} className="ml-3 rounded border border-border px-2 py-1 text-xs hover:text-foreground">
            Leave focus mode
          </button>
        )}
      </div>
    );
  }

  const railCheck = (label: string, checked: boolean, onChange: (on: boolean) => void, title?: string) => (
    <label className="flex cursor-pointer select-none items-center gap-2 text-muted-foreground hover:text-foreground" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border accent-primary"
      />
      <span>{label}</span>
    </label>
  );
  const railDivider = <div className="my-1 h-px w-6 shrink-0 bg-border" />;
  const stepTorch = (d: number) => setTorchSize((t) => {
    const next = Math.min(240, Math.max(8, t + d));
    try { localStorage.setItem("bme_viewer_torch_size", String(next)); } catch {}
    return next;
  });
  const railSize = (what: string, value: number, step: (d: number) => void) => (
    <div className="flex shrink-0 flex-col items-center">
      <RailButton title={`Larger ${what} (])`} onClick={() => step(1)}><Plus className="h-3 w-3" /></RailButton>
      <span className="text-[10px] tabular-nums text-muted-foreground" title={`${what} size`}>{value}</span>
      <RailButton title={`Smaller ${what} ([)`} onClick={() => step(-1)}><Minus className="h-3 w-3" /></RailButton>
    </div>
  );

  const MOVE_TITLE = "Move / resize: click a painted region to select it, drag to move, drag a handle to resize; Shift keeps proportions, Esc deselects (Key 8 or M)";
  const moveScopeTitle = moveAllSlices
    ? "Selecting through all slices: click to select on this slice only"
    : "Selecting on this slice only: click to select through all slices";
  const paintTools = [
    { id: "brush", Icon: Paintbrush, title: "Brush (Key 4 or B)", show: canAnnotate },
    { id: "pencil", Icon: Lasso, title: "Pencil: trace an outline, the inside fills (Key 5 or P)", show: canAnnotate },
    { id: "move", Icon: Move, title: MOVE_TITLE, show: canAnnotate },
    { id: "pan", Icon: Hand, title: "Hand: drag to move the view (Key 6 or H)", show: canZoomPan },
    { id: "torch", Icon: Flashlight, title: "Torch: see the scan under the labels (Key 7, or hold T)", show: true },
  ] as const;

  // What is set once and then left alone. Shared by the toolbar's Settings
  // button and the focus rail; the rail also carries Flag and AI suggestions,
  // which the toolbar shows as buttons of their own.
  const settingsBody = (withActions: boolean) => (
    <>
      <div className="[&>div]:flex-wrap [&>div]:gap-y-2">
        <OverlayControls view={view} setView={setView} opacity={opacity} setOpacity={setOpacity} compact />
      </div>
      {canAnnotate && (
        <div className="space-y-1.5">
          {railCheck("Only inside bone", maskInside, setMaskInside)}
          {railCheck("Protect lesion", protectLesion, changeProtectLesion)}
          {railCheck("Auto-pan", autoPan, setAutoPan, "While drawing in a zoomed view, slide the image when the pointer nears an edge")}
          {railCheck("Dotted pencil trace", pencilDotted, setPencilDotted, "While tracing, show only a dotted outline instead of a solid edge over a tinted fill preview")}
          {railCheck("Auto Save", autoSave, changeAutoSave, "Save the mask shortly after each edit")}
        </div>
      )}
      <button
        type="button"
        onClick={() => setLocked((v) => !v)}
        title="Key L"
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-left transition ${
          locked ? "border-border text-muted-foreground hover:text-foreground" : "border-primary bg-primary/20 text-primary"
        }`}
      >
        {locked ? <Link2Off className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
        {locked ? "Crosshair stays put while painting" : "Crosshair follows the brush"}
      </button>
      {withActions && canAnnotate && (
        <button
          type="button"
          onClick={() => { setSettingsOpen(false); setFlagModalOpen(true); }}
          className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-2 py-1 transition ${
            flag ? "border-amber-500/50 bg-amber-500/15 text-amber-500" : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <Flag className={`h-3.5 w-3.5 ${flag ? "fill-amber-500" : ""}`} />
          {flag ? `Flagged: ${flag.reason || "Not Sure"}` : "Flag case"}
        </button>
      )}
      {withActions && !isCollaborator && canAnnotate && (
        <button
          type="button"
          onClick={() => { setSettingsOpen(false); void suggestions.request(); }}
          disabled={suggestBusy}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-40"
        >
          {suggestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          AI suggestions
        </button>
      )}
    </>
  );

  // Focus mode keeps only what painting needs within reach. Settings that are
  // set once per session sit behind one button; anything destructive or
  // session-level (delete, import, collaboration) is left to the normal view.
  const focusRail = focusOn && (
    <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border bg-card py-2">
      {canAnnotate && (
        <>
          {SEGMENTS.map((sg, i) => (
            <button
              key={sg.value}
              type="button"
              onClick={() => { setSeg(sg.value); drawWithLabel(); }}
              title={`${sg.label} (Key ${i + 1}) - ${counts[sg.value - 1].toLocaleString()} voxels`}
              className={`flex h-7 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition ${
                seg === sg.value && !erasing && drawing ? "bg-muted ring-1 ring-primary" : "hover:bg-muted"
              }`}
            >
              <span className="block h-3.5 w-3.5 rounded-full" style={{ backgroundColor: sg.color }} />
            </button>
          ))}
          {railDivider}
        </>
      )}
      {paintTools.filter((t) => t.show).map(({ id, Icon, title }) => (
        <RailButton key={id} active={tool === id} title={title} onClick={() => pickTool(id)}>
          <Icon className="h-4 w-4" />
        </RailButton>
      ))}
      {canAnnotate && (
        <RailButton active={erasing ? "danger" : false} title="Eraser (Key 0 or E)" onClick={() => toggleEraser()}>
          <Eraser className="h-4 w-4" />
        </RailButton>
      )}
      {torchActive
        ? railSize("torch", torchSize, (d) => stepTorch(d * 8))
        : canAnnotate && tool === "brush" ? railSize("brush", brush, (d) => setBrush((b) => Math.min(20, Math.max(1, b + d))))
        : canAnnotate && tool === "move" && (
          <RailButton active={moveAllSlices} title={moveScopeTitle} onClick={() => setMoveAllSlices((v) => !v)}>
            <Layers className="h-4 w-4" />
          </RailButton>
        )}
      {canAnnotate && (
        <>
          {railDivider}
          <RailButton title="Undo (Ctrl+Z)" onClick={undo}><RotateCcw className="h-4 w-4" /></RailButton>
          <RailButton title="Redo (Ctrl+Y)" onClick={redo}><RotateCw className="h-4 w-4" /></RailButton>
        </>
      )}

      <div className="flex-1" />

      <RailButton active={expanded === null} title="All four views (double-click a view to show it alone)" onClick={() => setExpanded(null)}>
        <LayoutGrid className="h-4 w-4" />
      </RailButton>
      <div className="grid shrink-0 grid-cols-2 gap-0.5">
        {([...PLANES, "3d"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setExpanded(v)}
            title={v === "3d" ? "3D view alone" : `${v[0].toUpperCase()}${v.slice(1)} view alone`}
            className={`flex h-6 w-5 cursor-pointer items-center justify-center rounded border text-[10px] font-bold transition ${
              expanded === v ? "bg-muted" : "border-transparent hover:bg-muted"
            }`}
            style={v === "3d" ? undefined : { color: PLANE_COLOR[v], borderColor: expanded === v ? PLANE_COLOR[v] : undefined }}
          >
            {v === "3d" ? "3D" : v[0].toUpperCase()}
          </button>
        ))}
      </div>
      {railDivider}

      {(onPrevCase || onNextCase) && (
        <RailButton title="Previous case" disabled={!onPrevCase} onClick={() => switchCase(onPrevCase)}>
          <ChevronUp className="h-4 w-4" />
        </RailButton>
      )}
      <span className="w-full truncate px-0.5 text-center font-mono text-[9px] text-muted-foreground" title={caseId}>
        {caseId}
      </span>
      {(onPrevCase || onNextCase) && (
        <RailButton title="Next case" disabled={!onNextCase} onClick={() => switchCase(onNextCase)}>
          <ChevronDown className="h-4 w-4" />
        </RailButton>
      )}
      {canAnnotate && (
        <RailButton
          active={dirty && !saving}
          title={saving ? "Saving…" : dirty ? "Save (Ctrl+S)" : autoSaveStatus || status}
          onClick={() => { if (dirty && !saving) void save(); }}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" />
            : dirty ? <Save className="h-4 w-4" />
            : <Check className="h-4 w-4 text-emerald-500" />}
        </RailButton>
      )}
      <RailButton active={settingsOpen} title="View and painting settings" onClick={() => setSettingsOpen((v) => !v)}>
        <SlidersHorizontal className="h-4 w-4" />
      </RailButton>
      {settingsOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setSettingsOpen(false)} />
          <div className="fixed bottom-2 left-14 z-20 w-72 space-y-3 rounded-lg border border-border bg-card p-3 text-xs shadow-xl">
            {settingsBody(true)}
          </div>
        </>
      )}
      <RailButton title="Leave focus mode (F or Esc)" onClick={() => { setSettingsOpen(false); focus.exit(); }}>
        <Minimize className="h-4 w-4" />
      </RailButton>
    </div>
  );

  return placed(
    <div className={focusOn ? "fixed inset-0 z-50 flex bg-background text-foreground" : "flex min-h-0 flex-1 flex-col"}>
      {focusRail}
      <div className={focusOn ? "flex min-w-0 flex-1 flex-col gap-1 p-1" : "flex min-h-0 flex-1 flex-col gap-2"}>
      {!focusOn && guestHeader}
      {!focusOn && seriesChoices.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {seriesChoices.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSeriesId(s.id)}
              disabled={!canMoveSlices}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                seriesId === s.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}{s.id === annotatedSeries ? " · edema" : ""}
            </button>
          ))}
        </div>
      )}
      <input
        ref={importInput}
        type="file"
        accept=".nrrd"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importSlicer(f);
        }}
      />
      {/* 3D Toolbar - Compact Bar vs Full Toolbar; focus mode has its own rail */}
      {focusOn ? null : toolbarCollapsed ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-2 overflow-x-auto py-1.5 [&_button]:whitespace-nowrap [&_label]:whitespace-nowrap">
          <div className="flex items-center gap-1.5 shrink-0">
            {canAnnotate && (
              <>
                {/* Compact Segment Pickers */}
                <div className="flex items-center gap-1 bg-background/80 rounded-md border border-border p-0.5">
                  {SEGMENTS.map((s, i) => (
                    <button
                      key={s.value}
                      onClick={() => { setSeg(s.value); drawWithLabel(); }}
                      title={`${s.label} (Key ${i + 1}) - ${counts[s.value - 1].toLocaleString()} voxels`}
                      className={`p-1 rounded transition cursor-pointer ${
                        seg === s.value && !erasing && drawing ? "bg-primary/20 ring-1 ring-primary" : "hover:bg-muted"
                      }`}
                    >
                      <span className="block h-3 w-3 rounded-full" style={{ backgroundColor: s.color }} />
                    </button>
                  ))}
                </div>
    
                <div className="h-4 w-px bg-border" />
    
              </>
            )}
            {!canAnnotate && (
              <div className="flex items-center gap-1.5 rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-1 text-xs text-blue-400 font-medium">
                <Lock className="h-3 w-3 text-blue-400" />
                <span className="hidden sm:inline">Review Mode</span>
              </div>
            )}
            {/* Tools */}
            {canAnnotate && (
              <>
                <button
                  type="button"
                  onClick={() => { pickTool("brush"); }}
                  title="Brush mode (Key 4 or B)"
                  className={`p-1.5 rounded transition border cursor-pointer ${
                    tool === "brush" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Paintbrush className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => { pickTool("pencil"); }}
                  title="Pencil mode (Key 5 or P)"
                  className={`p-1.5 rounded transition border cursor-pointer ${
                    tool === "pencil" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Lasso className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => { pickTool("move"); }}
                  title={MOVE_TITLE}
                  className={`p-1.5 rounded transition border cursor-pointer ${
                    tool === "move" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Move className="h-3.5 w-3.5" />
                </button>
                {tool === "move" && (
                  <button
                    type="button"
                    onClick={() => setMoveAllSlices((v) => !v)}
                    title={moveScopeTitle}
                    className={`p-1.5 rounded transition border cursor-pointer ${
                      moveAllSlices ? "border-primary bg-primary/20 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Layers className="h-3.5 w-3.5" />
                  </button>
                )}
              </>
            )}
            {canZoomPan && (
              <>
                <button
                  type="button"
                  onClick={() => pickTool("pan")}
                  title="Hand mode (Key 6 or H)"
                  className={`p-1.5 rounded transition border cursor-pointer ${
                    tool === "pan" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Hand className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => { pickTool("torch"); }}
              title="Torch — see scan under annotation (Key 7, or hold T)"
              className={`p-1.5 rounded transition border cursor-pointer ${
                tool === "torch" ? "bg-primary text-primary-foreground border-primary font-medium" : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Flashlight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setLocked((v) => !v)}
              title={locked ? "Views locked: click to link (Key L)" : "Views linked: click to lock (Key L)"}
              className={`p-1.5 rounded transition border cursor-pointer ${
                !locked ? "border-primary bg-primary/20 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {locked ? <Link2Off className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
            </button>
            {canAnnotate && (
              <>
                <button
                  type="button"
                  onClick={() => toggleEraser()}
                  title="Eraser (Key 0 or E)"
                  className={`p-1.5 rounded transition border cursor-pointer ${
                    erasing ? "border-destructive bg-destructive/10 text-destructive ring-1 ring-destructive" : "border-border bg-background text-muted-foreground hover:text-foreground"
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
            )}
          </div>

          {/* Compact Right Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {canAnnotate && (
              <>
                <button
                  type="button"
                  onClick={() => setFlagModalOpen(true)}
                  title={flag ? `Flagged: ${flag.reason || "Not Sure"}` : "Flag case"}
                  className={`p-1.5 rounded border transition cursor-pointer ${
                    flag ? "border-amber-500/50 bg-amber-500/15 text-amber-500" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Flag className={`h-3.5 w-3.5 ${flag ? "fill-amber-500 text-amber-500" : ""}`} />
                </button>
              </>
            )}
            {!isCollaborator && canAnnotate && (
              <button
                type="button"
                onClick={() => void suggestions.request()}
                disabled={suggestBusy}
                title="AI suggestions: run the 2D models on every axial slice of this scan"
                className="p-1.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition cursor-pointer disabled:opacity-40"
              >
                {suggestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              </button>
            )}
            {!isCollaborator && (
              <>
                <button
                  type="button"
                  onClick={() => importInput.current?.click()}
                  disabled={importing}
                  title="Import a .seg.nrrd from 3D Slicer"
                  className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer disabled:opacity-40"
                >
                  {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                </button>
              </>
            )}
            {canDelete && (
              <>
                <button
                  onClick={clearMask}
                  title="Clear current 3D mask"
                  className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-destructive transition cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {hasSaved && canDelete && (
              <button
                type="button"
                onClick={() => deleteMask()}
                disabled={deletingMask}
                title="Delete saved 3D mask permanently"
                className="p-1.5 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 transition cursor-pointer"
              >
                <XCircle className="h-3.5 w-3.5" />
              </button>
            )}
            {!isCollaborator && (
              <>
                <button
                  type="button"
                  onClick={() => host.start(caseId, "3d")}
                  disabled={host.starting}
                  title={collabToken ? "Collab Panel" : "Start Collaboration"}
                  className="relative p-1.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition cursor-pointer"
                >
                  <Users className="h-3.5 w-3.5" />
                  {collab.joinRequests.length > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                      {collab.joinRequests.length}
                    </span>
                  )}
                </button>
              </>
            )}
            {canAnnotate && (
              <>
                <button
                  onClick={save}
                  disabled={saving || !dirty}
                  title="Save 3D Mask (Ctrl+S)"
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
                    savedSuccess ? "bg-emerald-600 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                  }`}
                >
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : savedSuccess ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                  <span>{savedSuccess ? "Saved!" : dirty ? "Save" : "Saved"}</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={focus.enter}
              title="Focus mode: full screen with only the painting tools (F)"
              className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer"
            >
              <Maximize className="h-3.5 w-3.5" />
            </button>
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
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs [&_button]:whitespace-nowrap">
          <div className="flex flex-wrap items-center gap-2">
            {canAnnotate ? (
              <div className="flex items-center gap-1">
                {SEGMENTS.map((s, i) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => { setSeg(s.value); drawWithLabel(); }}
                    title={`${s.label} (Key ${i + 1})`}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium transition cursor-pointer ${
                      seg === s.value && !erasing && drawing
                        ? `${s.badge} ring-1 ring-primary`
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                    <span className="text-[10px] tabular-nums opacity-60">{counts[s.value - 1].toLocaleString()}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/10 px-3 py-1 font-medium text-blue-400">
                <Lock className="h-3.5 w-3.5" />
                <span>Read-Only Review Mode — Drawing locked by Master</span>
              </div>
            )}

            <div className="h-5 w-px bg-border" />

            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {paintTools.filter((t) => t.show).map(({ id, Icon, title }, i) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => pickTool(id)}
                  title={title}
                  className={`px-2 py-1.5 transition cursor-pointer ${i > 0 ? "border-l border-border" : ""} ${
                    tool === id ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
            {canAnnotate && (
              <button
                type="button"
                onClick={() => toggleEraser()}
                title="Eraser (Key 0 or E)"
                className={`rounded-md border px-2 py-1.5 transition cursor-pointer ${
                  erasing
                    ? "border-destructive bg-destructive/10 text-destructive ring-1 ring-destructive"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <Eraser className="h-3.5 w-3.5" />
              </button>
            )}

            {torchActive ? (
              <label className="flex items-center gap-1.5 text-muted-foreground" title="Torch size ([ and ])">
                <Flashlight className="h-3.5 w-3.5" />
                <input
                  type="range"
                  min={8}
                  max={240}
                  step={4}
                  value={torchSize}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setTorchSize(v);
                    try { localStorage.setItem("bme_viewer_torch_size", String(v)); } catch {}
                  }}
                  className="w-20 accent-primary"
                />
                <span className="w-9 tabular-nums">{torchSize}px</span>
              </label>
            ) : canAnnotate && tool === "brush" && (
              <label className="flex items-center gap-1.5 text-muted-foreground" title="Brush size ([ and ])">
                <Paintbrush className="h-3.5 w-3.5" />
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={brush}
                  onChange={(e) => setBrush(Number(e.target.value))}
                  className="w-20 accent-primary"
                />
                <span className="w-9 tabular-nums">{brush}px</span>
              </label>
            )}
            {canAnnotate && tool === "move" && (
              <div className="inline-flex overflow-hidden rounded-md border border-border" title="What a click selects">
                {([false, true] as const).map((all, i) => (
                  <button
                    key={String(all)}
                    type="button"
                    onClick={() => setMoveAllSlices(all)}
                    className={`px-2 py-1 transition cursor-pointer ${i > 0 ? "border-l border-border" : ""} ${
                      moveAllSlices === all ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {all ? "All slices" : "This slice"}
                  </button>
                ))}
              </div>
            )}

            {canAnnotate && (
              <div className="inline-flex overflow-hidden rounded-md border border-border">
                <button
                  type="button"
                  onClick={undo}
                  title="Undo (Ctrl+Z)"
                  className="bg-background px-2 py-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={redo}
                  title="Redo (Ctrl+Y)"
                  className="border-l border-border bg-background px-2 py-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                title="Label view, opacity and painting settings"
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 transition cursor-pointer ${
                  settingsOpen ? "border-primary text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>Settings</span>
              </button>
              {settingsOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setSettingsOpen(false)} />
                  <div className="absolute left-0 top-full z-30 mt-1 w-72 space-y-3 rounded-lg border border-border bg-card p-3 shadow-xl">
                    {settingsBody(false)}
                  </div>
                </>
              )}
            </div>

            {canAnnotate && (
              <button
                type="button"
                onClick={() => setFlagModalOpen(true)}
                title={flag ? `Flagged: ${flag.reason || "Not Sure"}` : "Flag this case for review (e.g. Not Sure)"}
                className={`rounded-md border px-2 py-1.5 transition cursor-pointer ${
                  flag
                    ? "border-amber-500/50 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <Flag className={`h-3.5 w-3.5 ${flag ? "fill-amber-500" : ""}`} />
              </button>
            )}

            {!isCollaborator && canAnnotate && (
              <button
                type="button"
                onClick={() => void suggestions.request()}
                disabled={suggestBusy}
                title="Run the 2D models on every axial slice of this scan. The marks are suggestions: nothing changes until you accept a slice."
                className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-violet-300 transition hover:bg-violet-500/20 cursor-pointer disabled:opacity-40"
              >
                {suggestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                <span>AI</span>
              </button>
            )}

            {!isCollaborator ? (
              <button
                type="button"
                onClick={() => host.start(caseId, "3d")}
                disabled={host.starting}
                title={collabToken ? "Collaboration panel" : "Start a live review with a radiologist"}
                className="relative inline-flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 font-medium text-blue-400 transition hover:bg-blue-500/20 cursor-pointer"
              >
                <Users className="h-3.5 w-3.5" />
                <span>{collabToken ? "Collab" : "Collaborate"}</span>
                {collab.joinRequests.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {collab.joinRequests.length}
                  </span>
                )}
              </button>
            ) : (
              <div className="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 font-medium text-blue-300">
                <Users className="h-3.5 w-3.5" />
                <span>Review Session ({collab.participants.length})</span>
              </div>
            )}

            {(!isCollaborator || canDelete) && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  title="Import, clear or delete the mask"
                  className={`rounded-md border px-2 py-1.5 transition cursor-pointer ${
                    moreOpen ? "border-primary text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {importing || deletingMask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ellipsis className="h-3.5 w-3.5" />}
                </button>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setMoreOpen(false)} />
                    <div className="absolute right-0 top-full z-30 mt-1 w-56 space-y-1 rounded-lg border border-border bg-card p-1.5 shadow-xl">
                      {!isCollaborator && (
                        <button
                          type="button"
                          onClick={() => { setMoreOpen(false); importInput.current?.click(); }}
                          disabled={importing}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground cursor-pointer disabled:opacity-40"
                        >
                          <Upload className="h-3.5 w-3.5" /> Import from 3D Slicer
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => { setMoreOpen(false); clearMask(); }}
                          title="Clear what is painted on screen; the saved file is untouched until you save"
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-destructive cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Clear the mask
                        </button>
                      )}
                      {hasSaved && canDelete && (
                        <button
                          type="button"
                          onClick={() => { setMoreOpen(false); void deleteMask(); }}
                          disabled={deletingMask}
                          title="Delete the saved 3D mask permanently from the server"
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-destructive transition hover:bg-destructive/10 cursor-pointer disabled:opacity-40"
                        >
                          <XCircle className="h-3.5 w-3.5" /> Delete saved mask
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {canAnnotate && (
              <button
                type="button"
                onClick={save}
                disabled={saving || !dirty}
                title="Save 3D Mask (Ctrl+S)"
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition cursor-pointer ${
                  savedSuccess
                    ? "bg-emerald-600 text-white"
                    : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                }`}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : savedSuccess ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {savedSuccess ? "Saved!" : dirty ? "Save" : "Saved"}
              </button>
            )}

            <button
              type="button"
              onClick={focus.enter}
              title="Focus mode: full screen with only the painting tools (F)"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-muted-foreground transition hover:text-foreground cursor-pointer"
            >
              <Maximize className="h-3.5 w-3.5" />
              <span>Focus</span>
            </button>
            <button
              type="button"
              onClick={() => setToolbarCollapsed(true)}
              title="Collapse to compact toolbar"
              className="rounded-md border border-border bg-background p-1.5 text-muted-foreground transition hover:text-foreground cursor-pointer"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {!focusOn && flag && (
        <div className="flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
          <div className="flex items-center gap-2">
            <Flag className="h-3.5 w-3.5 fill-amber-400 text-amber-400 shrink-0" />
            <span>
              <strong>Flagged for review:</strong> {flag.reason || "Not Sure"}
              {flag.where ? ` at ${flag.where}` : ""}
              {flag.note ? ` — "${flag.note}"` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setFlagModalOpen(true)}
            className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30 transition"
          >
            Edit Flag
          </button>
        </div>
      )}

      {(suggestJob || suggestion) && (() => {
        const count = (d: string) => suggestion?.decisions.filter((x) => x === d).length ?? 0;
        return (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200">
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-300" />
              {suggestion ? (
                <span>
                  <strong>AI suggestions</strong> ({suggestion.models}): {count("pending")} axial slices to review,
                  {" "}{count("accepted")} accepted, {count("rejected")} rejected or empty. The dotted outlines are
                  not saved; Accept copies that slice into your mask.
                </span>
              ) : suggestJob?.state === "queued" ? (
                <span>
                  AI suggestions queued: {suggestJob.waiting ??
                    (suggestJob.position > 0 ? `${suggestJob.position} ahead of you` : "next in line")}
                </span>
              ) : suggestJob?.state === "running" ? (
                <span>
                  Running the 2D models on the axial slices
                  {suggestJob.progress ? ` (${suggestJob.progress.done}/${suggestJob.progress.total})` : ""}…
                </span>
              ) : suggestJob?.state === "failed" ? (
                <span>AI suggestions failed: {suggestJob.error}</span>
              ) : (
                <span>AI suggestions {suggestJob?.state}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {suggestion && count("pending") > 0 && (
                <>
                  <button type="button" onClick={() => gotoPendingSlice(-1)} title="Previous slice to review"
                    className="rounded border border-violet-500/40 p-0.5 hover:bg-violet-500/20">
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => gotoPendingSlice(1)} title="Next slice to review"
                    className="rounded border border-violet-500/40 p-0.5 hover:bg-violet-500/20">
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              {suggestBusy ? (
                <button type="button" onClick={() => void suggestions.cancel()}
                  className="rounded bg-violet-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-violet-500/30">
                  Cancel
                </button>
              ) : (
                <button type="button" onClick={suggestions.discard}
                  title="Drop every suggestion still waiting. Slices already accepted stay in your mask."
                  className="rounded bg-violet-500/20 px-2 py-0.5 text-[11px] font-medium hover:bg-violet-500/30">
                  {suggestion ? "Discard" : "Dismiss"}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Info bar: which scan, its geometry, and the latest load/save message. */}
      {!focusOn && (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="font-mono font-medium text-foreground">{caseId}</span>
          <span className="tabular-nums">
            {vol.dims.join(" × ")} &middot; {vol.spacing.map((s) => s.toFixed(2)).join(" × ")} mm
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate" title={status}>{status}</span>
          {autoSave && autoSaveStatus && (
            <span className="shrink-0 font-mono text-[10px]">{autoSaveStatus}</span>
          )}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowShortcuts((v) => !v)}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 transition ${
                showShortcuts ? "border-primary text-foreground" : "border-border hover:text-foreground"
              }`}
            >
              <Keyboard className="h-3 w-3" /> Shortcuts
            </button>
            {showShortcuts && (
              <div className="absolute right-0 top-full z-30 mt-1 w-[34rem] max-w-[90vw] rounded-lg border border-border bg-card p-3 text-xs shadow-xl">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground sm:grid-cols-[auto_1fr_auto_1fr]">
                  <kbd className="font-mono">Ctrl+Z / Ctrl+Y</kbd><span>Undo / redo</span>
                  <kbd className="font-mono">Ctrl+S</kbd><span>Save</span>
                  <kbd className="font-mono">1 2 3</kbd><span>Pick label (and draw)</span>
                  <kbd className="font-mono">B P H 7</kbd><span>Brush / pencil / hand / torch</span>
                  <kbd className="font-mono">M</kbd><span>Move / resize a painted region</span>
                  <kbd className="font-mono">E</kbd><span>Eraser on/off (brush or pencil)</span>
                  <kbd className="font-mono">T (hold)</kbd><span>Peek under the labels</span>
                  <kbd className="font-mono">[ ]</kbd><span>Brush or torch size</span>
                  <kbd className="font-mono">V</kbd><span>Cycle which labels show</span>
                  <kbd className="font-mono">&uarr;&darr;&larr;&rarr;</kbd><span>Step slice (hovered view)</span>
                  <kbd className="font-mono">PgUp/PgDn</kbd><span>Step 10 slices</span>
                  <kbd className="font-mono">Shift+click</kbd><span>Move crosshair</span>
                  <kbd className="font-mono">L</kbd><span>Lock / link views</span>
                  <kbd className="font-mono">Ctrl+wheel</kbd><span>Zoom the view (or pinch)</span>
                  <kbd className="font-mono">Space (hold)</kbd><span>Pan with the mouse, even mid-trace</span>
                  <kbd className="font-mono">Two fingers</kbd><span>Pinch to zoom, drag to pan (touch)</span>
                  <kbd className="font-mono">One finger</kbd><span>Draws; pans once a stylus has been used</span>
                  <kbd className="font-mono">Double-click</kbd><span>View full size, and back</span>
                  <kbd className="font-mono">Esc</kbd><span>Discard an outline, or deselect</span>
                  <kbd className="font-mono">F</kbd><span>Focus mode: full screen, tools only</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Four-Up: three orthogonal views plus the 3D view, as in Slicer */}
      {/* On a wide screen it fills the window down to the bottom edge; 400px
          still leaves each view about 200px on a short laptop screen. */}
      {/* Unselectable, and no native drags: with a canvas inside a page
          selection (a stray drag, Ctrl+A), pressing the brush dragged a
          ghost copy of the slice and the stroke stopped after one dot. */}
      <div
        onDragStart={(e) => e.preventDefault()}
        className={focusOn
          ? `grid min-h-0 flex-1 select-none gap-1 ${expanded ? "grid-cols-1" : "grid-cols-2 grid-rows-2"}`
          : `grid select-none gap-2 grid-cols-1 lg:min-h-[400px] lg:flex-1 ${expanded ? "" : "md:grid-cols-2 lg:grid-rows-2"}`}
      >
        {PLANES.map((p) => {
          const g = planeGeom(p, vol);
          const depth = g.depth;
          const s = sliceOf(p, vol, cursor);
          return (
            <div key={p}
              ref={(el) => { viewRefs.current[p] = el; }}
              onMouseEnter={() => setActivePlane(p)}
              onPointerMove={(e) => {
                if (strokePointer.current && strokePointer.current.id !== e.pointerId) return;
                // Hold Space and move to pan this view - mid-stroke too.
                const last = lastClient.current;
                lastClient.current = { plane: p, x: e.clientX, y: e.clientY };
                if (spaceHeldRef.current && canZoomPan && last?.plane === p) {
                  const dx = e.clientX - last.x;
                  const dy = e.clientY - last.y;
                  if (dx || dy) setPan((cur) => ({ ...cur, [p]: { x: cur[p].x + dx, y: cur[p].y + dy } }));
                }
              }}
              onDoubleClick={(e) => {
                const t = e.target as HTMLElement;
                if (t.closest("button, input")) return;
                takeBackDoubleClickDots();
                toggleExpanded(p);
              }}
              className={`${expanded && expanded !== p ? "hidden" : "flex"} min-h-0 flex-col overflow-hidden rounded-lg border-2 bg-black p-1.5`}
              style={{
                borderColor: PLANE_COLOR[p],
                opacity: activePlane === p ? 1 : 0.94,
                boxShadow: activePlane === p ? `0 0 0 1px ${PLANE_COLOR[p]}` : undefined,
              }}>
              <div className="mb-1 flex h-6 shrink-0 select-none items-center justify-between gap-2 px-1"
                title="Double-click the view for full size">
                <span className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: PLANE_COLOR[p] }}>{p}</span>
                  <span className="text-[11px] tabular-nums text-neutral-400">{s + 1} / {depth}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-flex h-5 items-center overflow-hidden rounded border border-neutral-700 text-neutral-300">
                    <button type="button" disabled={!canZoomPan} title="Zoom out"
                      onClick={() => setZoom((z) => ({ ...z, [p]: clampZoom(z[p] - 0.25) }))}
                      className="flex h-full items-center px-1 hover:bg-neutral-800 disabled:opacity-40">
                      <Minus className="h-3 w-3" />
                    </button>
                    <button type="button" disabled={!canZoomPan} title="Reset zoom and pan"
                      onClick={() => resetView(p)}
                      className="h-full w-9 border-x border-neutral-700 text-[10px] tabular-nums hover:bg-neutral-800 disabled:opacity-40">
                      {zoom[p].toFixed(1)}x
                    </button>
                    <button type="button" disabled={!canZoomPan} title="Zoom in"
                      onClick={() => setZoom((z) => ({ ...z, [p]: clampZoom(z[p] + 0.25) }))}
                      className="flex h-full items-center px-1 hover:bg-neutral-800 disabled:opacity-40">
                      <Plus className="h-3 w-3" />
                    </button>
                  </span>
                  <button type="button"
                    title={expanded === p ? `Back to all four views${focusOn ? "" : " (Esc)"}` : "Full view (or double-click the view)"}
                    onClick={() => toggleExpanded(p)}
                    className="flex h-5 w-6 items-center justify-center rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white">
                    {expanded === p ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
                  </button>
                </span>
              </div>
              <div ref={(el) => { areaRefs.current[p] = el; }}
                className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
                style={{ touchAction: "none" }}
                // Capture phase, so the canvas below already knows a pinch has
                // begun when the second finger's pointerdown reaches it.
                onPointerDownCapture={(e) => {
                  if (e.pointerType !== "touch") return;
                  if (painting.current && strokePointer.current?.type === "pen") return; // palm under the pen
                  const pz = pinches.current[p];
                  pz.down(e);
                  if (!pz.active) return;
                  cancelStroke();
                  stopPan();
                  const r = e.currentTarget.getBoundingClientRect();
                  pinchStart.current = { plane: p, zoom: zoom[p], pan: pan[p], cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
                }}
                onPointerMove={(e) => {
                  if (e.pointerType !== "touch") return;
                  const f = pinches.current[p].move(e);
                  const st = pinchStart.current;
                  if (!f || !st || st.plane !== p || !canZoomPan) return;
                  // Zoom about the fingers: the image point under the starting
                  // midpoint stays under the current one.
                  const z = clampZoom(st.zoom * f.scale);
                  const k = z / st.zoom;
                  setZoom((cur) => ({ ...cur, [p]: z }));
                  setPan((cur) => ({ ...cur, [p]: {
                    x: f.mid.x - st.cx - k * (f.mid0.x - st.cx - st.pan.x),
                    y: f.mid.y - st.cy - k * (f.mid0.y - st.cy - st.pan.y),
                  } }));
                }}
                onPointerUp={(e) => { if (e.pointerType === "touch") pinches.current[p].up(e); }}
                onPointerCancel={(e) => { if (e.pointerType === "touch") pinches.current[p].up(e); }}>
              <div className="flex h-full w-full items-center justify-center"
                style={{ transform: `translate(${pan[p].x}px, ${pan[p].y}px) scale(${zoom[p]})`, transformOrigin: "center" }}>
              <canvas
                ref={(el) => { canvases.current[p] = el; }}
                className={`${
                  tool === "pan" || (spaceHeld && canZoomPan) ? (panning === p ? "cursor-grabbing" : "cursor-grab")
                    : tool === "torch" ? "cursor-none" : "cursor-crosshair"
                } rounded`}
                style={{
                  imageRendering: "auto",
                  // Fill the square tile while keeping true physical proportions.
                  aspectRatio: `${g.mmW} / ${g.mmH}`,
                  maxWidth: "100%", maxHeight: "100%",
                  margin: "0 auto", display: "block",
                  ...(tool === "pencil" && !(spaceHeld && canZoomPan)
                    ? { cursor: pencilCursor(erasing ? "#ffffff" : SEGMENTS.find((x) => x.value === seg)!.color) }
                    : {}),
                  ...(tool === "move" && !(spaceHeld && canZoomPan) ? { cursor: moveCursorStyle } : {}),
                  touchAction: "none",
                }}
                onPointerDown={(e) => {
                  setActivePlane(p);
                  const touch = e.pointerType === "touch";
                  if (e.pointerType === "pen") {
                    penSeen.current = true;
                    if (panStart.current) stopPan(); // the pen wins over a resting palm
                  }
                  if (touch && (pinches.current[p].count > 1 || painting.current)) return;
                  if (tool === "torch") return; // Pitfall-1: mouse down with torch tool does nothing
                  if (spaceHeldRef.current) return; // Space is panning, not drawing
                  if (tool === "pan" || (touch && (penSeen.current || !canAnnotate))) {
                    if (e.button === 0 && canZoomPan) startPan(p, e);
                    return;
                  }
                  if (tool === "move" && !e.shiftKey) {
                    if (e.button === 0 && canAnnotate) startMove(p, e);
                    return;
                  }
                  const hit = toVoxel(p, e);
                  if (!hit) return;
                  if (e.shiftKey) {
                    if (canMoveSlices) moveCursor(p, hit.a, hit.b);
                    return;
                  }
                  if (e.button !== 0 || !canAnnotate) return;
                  if (tool === "pencil") {
                    pencilPlane.current = p;
                    outline.current = [[hit.a, hit.b]];
                    beginStroke(p, e);
                    setOutlineTick((n) => n + 1);
                  } else {
                    pushUndo();
                    recentTaps.current = [
                      ...recentTaps.current.slice(-1),
                      { at: e.timeStamp, snap: undoStack.current[undoStack.current.length - 1] },
                    ];
                    strokeHasBone.current = sliceHasBone(p);
                    beginStroke(p, e);
                    paintAt(p, hit);
                    if (!locked && canMoveSlices) moveCursor(p, hit.a, hit.b);
                  }
                }}
                onPointerMove={(e) => {
                  const hit = toVoxel(p, e);
                  if (hit && collabToken && collab.connected) {
                    const g = planeGeom(p, vol);
                    collab.updateCursor({ x: hit.a / g.w, y: hit.b / g.h, plane: p });
                  }
                  if (tool === "move" && !moveDrag.current) {
                    const sel = moveSel.current;
                    const pt = sel && sel.plane === p && sel.region.masks.has(s) ? toPlanePoint(p, e.clientX, e.clientY) : null;
                    const over = pt && sel ? handleAt(sel.to, pt.x, pt.y, pt.tol) : null;
                    const next = over ? HANDLE_CURSOR[over] : hit && labels?.[sampleAt(p, vol, hit.a, hit.b, s)] ? "pointer" : "crosshair";
                    if (next !== moveCursorStyle) setMoveCursorStyle(next);
                  }
                  if (hit) {
                    lastPointerPosRef.current = { plane: p, a: hit.a, b: hit.b };
                    if (torchActiveRef.current) {
                      torchRef.current = {
                        plane: p,
                        a: hit.a,
                        b: hit.b,
                        radius: torchSizeRef.current / 2,
                      };
                      scheduleTorchRedraw(p);
                    }
                  }
                  if (!painting.current || spaceHeldRef.current) return;
                  if (strokePointer.current?.id !== e.pointerId) return;
                  // The button was released outside the window, where no
                  // pointerup reached us: end the stroke now.
                  if (e.buttons === 0) { endStroke(); return; }
                  if (!hit || strokePlane.current !== p) return;
                  if (tool === "pencil") traceTo(hit);
                  else if (tool === "brush") paintAt(p, hit);
                }}
                onPointerLeave={() => {
                  // Leaving the image does not end a stroke; releasing the
                  // mouse button or lifting the pen does, wherever it happens.
                  if (torchRef.current?.plane === p) {
                    torchRef.current = null;
                    draw(p);
                  }
                }}
                // Deliberately no onWheel. Scrolling stepped the slice, which
                // fought with page scrolling and moved the image out from under
                // the brush mid-stroke. Arrow keys step slices instead.
                onMouseEnter={() => setActivePlane(p)}
              />
              </div>
              </div>
              <input type="range" min={0} max={depth - 1} value={s}
                disabled={!canMoveSlices}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCursor((c) => setAxis(c, g.axis.slice, v));
                }}
                className="mt-1 w-full shrink-0" />
              {p === "axial" && suggestion && suggestion.slices[s] && (() => {
                const d = suggestion.decisions[s];
                const info = suggestion.slices[s];
                const marked = info.bone + info.lesion > 0;
                return (
                  <div className="mt-1 flex shrink-0 flex-wrap items-center justify-between gap-1 px-1 text-[10px] text-neutral-300">
                    <span className="tabular-nums">
                      Suggestion: bone {info.bone.toLocaleString()} px · edema {info.lesion.toLocaleString()} px
                      {info.prob !== null ? ` · BME ${info.prob >= 0.5 ? "present" : "absent"} (${info.prob.toFixed(2)})` : ""}
                    </span>
                    {d === "pending" ? (
                      <span className="flex items-center gap-1">
                        <button type="button" onClick={() => acceptSuggestion(s)}
                          title="Copy this slice's suggested bone and edema into the mask"
                          className="rounded border border-emerald-600 bg-emerald-600/20 px-1.5 py-0.5 text-emerald-300 hover:bg-emerald-600/30">
                          Accept
                        </button>
                        <button type="button" onClick={() => suggestions.decide(s, "rejected")}
                          title="Drop this slice's suggestion; the mask is not changed"
                          className="rounded border border-neutral-600 px-1.5 py-0.5 hover:bg-neutral-800">
                          Reject
                        </button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <span className="text-neutral-500">{marked ? d : "nothing marked"}</span>
                        {marked && (
                          <button type="button" onClick={() => suggestions.decide(s, "pending")}
                            title="Show this slice's suggestion again"
                            className="rounded border border-neutral-600 px-1.5 py-0.5 hover:bg-neutral-800">
                            Restore
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}

        <div className={`${expanded && expanded !== "3d" ? "hidden" : "flex"} min-h-0 flex-col gap-2 overflow-y-auto`}>
          <div className="flex min-h-[320px] flex-1 flex-col lg:min-h-0">
            <Render3D
              labels={labels}
              dims={vol.dims}
              spacing={vol.spacing}
              orient={vol.orient}
              segments={SEGMENTS}
              hidden={hiddenLabelsForView(view)}
              expanded={expanded === "3d"}
              onToggleExpand={() => toggleExpanded("3d")}
              fill
            />
          </div>
          {!focusOn && <SegmentMeasures counts={counts} spacing={vol.spacing} />}
        </div>
      </div>


      {flagModalOpen && (
        <FlagDialog
          title="Flag Case for Review"
          subject={
            <>
              Case: <strong className="font-mono text-foreground">{caseId}</strong>
              {" "}&middot; {flag?.where ?? flagWhere()}
            </>
          }
          flagged={Boolean(flag)}
          initialReason={flag?.reason}
          initialNote={flag?.note}
          saving={flagSaving}
          onSave={(reason, note) => writeCaseFlag({ flagged: true, reason, note, where: flagWhere() })}
          onRemove={() => writeCaseFlag({ flagged: false })}
          onClose={() => setFlagModalOpen(false)}
        />
      )}

      {host.showPanel && collabToken && (
        <div
          onClick={() => host.setShowPanel(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm cursor-pointer animate-in fade-in duration-150"
        >
          <div onClick={(e) => e.stopPropagation()} className="cursor-default">
            <CollaborationMasterPanel
              shareUrl={host.shareUrl}
              followUserId={followUserId}
              onFollowUser={setFollowUserId}
              participants={collab.participants}
              currentUserId={collab.currentUserId}
              onUpdatePermission={collab.updatePermission}
              onRemoveUser={collab.removeUser}
              onEndSession={() => {
                collab.endSession();
                host.forget();
              }}
              onClose={() => host.setShowPanel(false)}
              joinRequests={collab.joinRequests}
              leftList={collab.leftList}
              onAdmit={collab.admit}
              onDeny={collab.deny}
            />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
