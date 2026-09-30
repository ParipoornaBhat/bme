"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Keyboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eraser,
  Flag,
  Flashlight,
  Hand,
  Lasso,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Paintbrush,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  SlidersHorizontal,
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
import { usePaintTools } from "~/lib/usePaintTools";
import { isInTorch, type TorchState } from "~/lib/torch";
import type { FlagRecord } from "~/lib/flag-store";
import FlagDialog from "./FlagDialog";

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
  return (
    <div className="shrink-0 rounded-lg border border-border bg-card p-3 text-xs">
      <div className="mb-2 font-semibold">Annotated region</div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nothing painted yet.</p>
      ) : (
        <table className="w-full tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1 font-medium">Segment</th>
              <th className="pb-1 text-right font-medium">Voxels</th>
              <th className="pb-1 text-right font-medium">mm³</th>
              <th className="pb-1 text-right font-medium">cm³</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.value}>
                <td className="py-0.5">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />
                  {r.label}
                </td>
                <td className="py-0.5 text-right">{r.n.toLocaleString()}</td>
                <td className="py-0.5 text-right">{r.mm3.toFixed(4)}</td>
                <td className="py-0.5 text-right">{r.cm3.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
  // One view shown full size in place of the four-up, or null for all four.
  const [expanded, setExpanded] = useState<Plane | "3d" | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const showShortcutsRef = useRef(showShortcuts);
  showShortcutsRef.current = showShortcuts;
  const toggleExpanded = (v: Plane | "3d") => setExpanded((cur) => (cur === v ? null : v));

  // On a wide screen the four-up is sized to end at the bottom of the window,
  // so the views fit without scrolling the page. Measured rather than a fixed
  // calc(): the toolbar wraps to one or two rows, and banners come and go.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [gridHeight, setGridHeight] = useState<number | null>(null);
  const fitGrid = useCallback(() => {
    const el = gridRef.current;
    if (!el) return;
    if (window.innerWidth < 1024) {
      setGridHeight(null);
      return;
    }
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const scrolled = scroller ? scroller.scrollTop : window.scrollY;
    const viewportBottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    const top = el.getBoundingClientRect().top + scrolled;
    // A laptop screen still fits: 400 leaves each view about 200px, and any
    // one of them can go full size.
    const h = Math.max(400, Math.floor(viewportBottom - top - 12));
    setGridHeight((cur) => (cur !== null && Math.abs(cur - h) < 2 ? cur : h));
  }, []);
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

    // Live pencil trace on the plane being drawn in: the area that will be
    // filled on release, and a solid edge, as in the 2D painter.
    if (pencilPlane.current === p && outline.current.length > 1) {
      // Erasing shows as a white outline over a darkened area: what will be
      // removed, never mistakable for an edema (red) outline.
      const color = erasing ? "#ffffff" : SEGMENTS.find((x) => x.value === seg)!.color;
      ctx.save();
      ctx.beginPath();
      const [x0, y0] = outline.current[0];
      ctx.moveTo(x0, h - 1 - y0);
      for (const [x, y] of outline.current.slice(1)) ctx.lineTo(x, h - 1 - y);
      ctx.closePath();
      ctx.globalAlpha = erasing ? 0.4 : 0.22;
      ctx.fillStyle = erasing ? "#000000" : color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, Math.round(w / 300));
      ctx.lineJoin = "round";
      ctx.stroke();
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
      collabToken]);

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

  useEffect(() => {
    if (!vol) return;
    fitGrid();
    const ro = new ResizeObserver(() => fitGrid());
    if (rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("resize", fitGrid);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fitGrid);
    };
  }, [vol, fitGrid]);

  // ---- pan -------------------------------------------------------------
  // Dragging is followed on the window, so the view keeps moving when the
  // pointer runs off the canvas mid-drag.
  const panStart = useRef<{ plane: Plane; x: number; y: number; ox: number; oy: number } | null>(null);
  const startPan = useCallback((p: Plane, e: React.MouseEvent) => {
    panStart.current = { plane: p, x: e.clientX, y: e.clientY, ox: pan[p].x, oy: pan[p].y };
    setPanning(p);
  }, [pan]);
  useEffect(() => {
    if (!panning) return;
    const move = (e: MouseEvent) => {
      const st = panStart.current;
      if (!st) return;
      setPan((cur) => ({ ...cur, [st.plane]: { x: st.ox + e.clientX - st.x, y: st.oy + e.clientY - st.y } }));
    };
    const up = () => { panStart.current = null; setPanning(null); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [panning]);

  const resetView = (p: Plane) => {
    setZoom((z) => ({ ...z, [p]: 1 }));
    setPan((cur) => ({ ...cur, [p]: { x: 0, y: 0 } }));
  };

  // ---- painting --------------------------------------------------------
  const toVoxel = useCallback((p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!vol) return null;
    const rect = ev.currentTarget.getBoundingClientRect();
    const { w, h } = planeGeom(p, vol);
    const a = Math.floor(((ev.clientX - rect.left) / rect.width) * w);
    const b = h - 1 - Math.floor(((ev.clientY - rect.top) / rect.height) * h);
    if (a < 0 || b < 0 || a >= w || b >= h) return null;
    return { a, b };
  }, [vol, planeGeom]);

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

  const paintAt = useCallback((p: Plane, ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!vol || !labels) return;
    const hit = toVoxel(p, ev);
    if (!hit) return;
    const { dims } = vol;
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
      planeGeom, sampleAt, sliceOf, toVoxel, drawAll, markEdited]);

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

  const clearMask = useCallback(() => {
    if (!labels) return;
    pushUndo();
    labels.fill(0);
    setCounts([0, 0, 0]);
    drawAll();
    markEdited();
    scheduleAutoSaveRef.current();
    toast.info("Cleared 3D canvas mask");
  }, [labels, pushUndo, drawAll, markEdited]);

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
      const annotateKey = mod ? ["z", "y", "s"].includes(k) : ["1", "2", "3", "4", "5", "0", "b", "p", "e"].includes(k);
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
      else if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) { setTorchHeld(true); }
      else if (e.key === "0" || e.key.toLowerCase() === "e") toggleEraser();
      else if (e.key.toLowerCase() === "v") cycleViewRef.current();
      else if (e.key.toLowerCase() === "l") setLocked((v) => !v);
      else if (e.key === "Escape" && showShortcutsRef.current) {
        setShowShortcuts(false);
      }
      else if (e.key === "Escape" && expandedRef.current && !painting.current) {
        setExpanded(null);
      }
      else if (e.key === "Escape") {
        outline.current = []; pencilPlane.current = null; painting.current = false;
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
  }, [undo, redo, drawAll, vol, activePlane, save]);

  if (isCollaborator) {
    const screen = guestSessionScreen(collab);
    if (screen) return screen;
  }

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

  if (busy) {
    return (
      <div className="flex h-96 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {status}
      </div>
    );
  }
  if (!vol) {
    return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">{status}</div>;
  }

  return (
    <div ref={rootRef} className="space-y-2">
      {guestHeader}
      {seriesChoices.length > 1 && (
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
      {/* 3D Toolbar - Compact Bar vs Full Toolbar */}
      {toolbarCollapsed ? (
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
              onClick={() => setToolbarCollapsed(false)}
              title="Expand full toolbar"
              className="p-1.5 rounded border border-border bg-background text-muted-foreground hover:text-foreground transition cursor-pointer ml-1"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5 [&_button]:whitespace-nowrap [&_label]:whitespace-nowrap">
          <div className="flex flex-wrap items-center gap-2">
            {canAnnotate && (
              <>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
                  Label:
                </span>
                {SEGMENTS.map((s, i) => (
                  <button
                    key={s.value}
                    onClick={() => { setSeg(s.value); drawWithLabel(); }}
                    title={`${s.label} (Key ${i + 1})`}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                      seg === s.value && !erasing && drawing
                        ? `${s.badge} ring-1 ring-primary`
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                    <span className="text-[10px] opacity-60 tabular-nums">
                      ({counts[s.value - 1].toLocaleString()})
                    </span>
                  </button>
                ))}
    
                <div className="mx-1 h-5 w-px bg-border" />
              </>
            )}

            {!canAnnotate && (
              <div className="flex items-center gap-2 rounded-md bg-blue-500/10 border border-blue-500/20 px-3 py-1 text-xs text-blue-400 font-medium">
                <Lock className="h-3.5 w-3.5 text-blue-400" />
                <span>Read-Only Review Mode — Drawing locked by Master</span>
              </div>
            )}

            {/* Tool Mode: Brush vs Pencil vs Hand vs Torch */}
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {canAnnotate && (
                <>
                  <button
                    type="button"
                    onClick={() => { pickTool("brush"); }}
                    title="Brush mode (Key 4 or B)"
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs transition cursor-pointer ${
                      tool === "brush" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Paintbrush className="h-3 w-3" /> Brush <span className="text-[10px] opacity-60">(4)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { pickTool("pencil"); }}
                    title="Pencil mode — trace an outline, the inside auto-fills (Key 5 or P)"
                    className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-xs transition cursor-pointer ${
                      tool === "pencil" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Lasso className="h-3 w-3" /> Pencil <span className="text-[10px] opacity-60">(5)</span>
                  </button>
                </>
              )}
              {canZoomPan && (
                <>
                  <button
                    type="button"
                    onClick={() => pickTool("pan")}
                    title="Hand mode — drag to move the view (Key 6 or H)"
                    className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-xs transition cursor-pointer ${
                      tool === "pan" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Hand className="h-3 w-3" /> Hand <span className="text-[10px] opacity-60">(6)</span>
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => { pickTool("torch"); }}
                title="Torch — see the scan under the annotation (Key 7, or hold T)"
                className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 text-xs transition cursor-pointer ${
                  tool === "torch" ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                <Flashlight className="h-3 w-3" /> Torch <span className="text-[10px] opacity-60">(7)</span>
              </button>
            </div>

            {canAnnotate && (
              <>
                <button
                  onClick={() => toggleEraser()}
                  title="Toggle eraser mode (Key 0 or E)"
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                    erasing
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
    
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none ml-1">
                  <input
                    type="checkbox"
                    checked={protectLesion}
                    onChange={(e) => {
                      setProtectLesion(e.target.checked);
                      try {
                        localStorage.setItem("bme_protect_lesion", String(e.target.checked));
                      } catch {}
                    }}
                    className="rounded border-border accent-primary h-3.5 w-3.5"
                  />
                  <span>Protect lesion</span>
                </label>
              </>
            )}

            <button
              type="button"
              onClick={() => setLocked((v) => !v)}
              title={locked ? "Views locked: painting leaves other slices unchanged (Key L)" : "Views linked: clicking moves crosshair across all planes (Key L)"}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition cursor-pointer ${
                locked ? "border-border bg-background text-muted-foreground hover:text-foreground" : "border-primary bg-primary/20 text-primary font-medium"
              }`}
            >
              {locked ? <Link2Off className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
              <span>{locked ? "Locked" : "Linked"}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {canAnnotate && tool === "brush" && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Paintbrush className="h-3.5 w-3.5" />
                <span>Size: {brush}px</span>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={brush}
                  onChange={(e) => setBrush(Number(e.target.value))}
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
                  onChange={(e) => {
                    const s = Number(e.target.value);
                    setTorchSize(s);
                    try { localStorage.setItem("bme_viewer_torch_size", String(s)); } catch {}
                  }}
                  className="w-20 accent-primary"
                />
              </div>
            )}

            {/* Overlay View and Opacity Controls */}
            <OverlayControls
              view={view}
              setView={setView}
              opacity={opacity}
              setOpacity={setOpacity}
            />

            {canAnnotate && (
              <>
                {/* Undo & Redo */}
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
                    title="Redo (Ctrl+Y)"
                    className="inline-flex items-center gap-1 border-l border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
                  >
                    <RotateCw className="h-3 w-3" /> Redo
                  </button>
                </div>
              </>
            )}

            {canAnnotate && (
              <>
                {/* Flag Case */}
                <button
                  type="button"
                  onClick={() => setFlagModalOpen(true)}
                  title={flag ? `Flagged: ${flag.reason || "Not Sure"}` : "Flag this case for review (e.g. Not Sure)"}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition cursor-pointer ${
                    flag
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 ring-1 ring-amber-500/30"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Flag className={`h-3.5 w-3.5 ${flag ? "fill-amber-500 text-amber-500" : ""}`} />
                  <span>{flag ? "Flagged" : "Flag"}</span>
                </button>
              </>
            )}

            {canAnnotate && (
              <>
                {/* Auto Save */}
                <div className="flex items-center gap-1.5 border-l border-border pl-2">
                  <label
                    className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
                    title="Auto-save the 3D mask shortly after each stroke/edit"
                  >
                    <input
                      type="checkbox"
                      checked={autoSave}
                      onChange={(e) => {
                        setAutoSave(e.target.checked);
                        try {
                          localStorage.setItem("bme_viewer_autosave", e.target.checked ? "true" : "false");
                        } catch { /* ignore */ }
                        if (e.target.checked) toast.success("Auto Save enabled");
                        else toast.info("Auto Save disabled");
                      }}
                      className="rounded border-border accent-primary h-3.5 w-3.5"
                    />
                    <span className="font-medium">Auto Save</span>
                  </label>
                  {autoSaveStatus && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[160px]">
                      {autoSaveStatus}
                    </span>
                  )}
                </div>
              </>
            )}

            {/* Collaboration Button (host) vs Participant Indicator (guest) */}
            {!isCollaborator ? (
              <button
                type="button"
                onClick={() => host.start(caseId, "3d")}
                disabled={host.starting}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-400 hover:bg-blue-500/20 transition-all cursor-pointer"
              >
                <Users className="h-3.5 w-3.5" />
                <span>{collabToken ? "Collab Panel" : "Start Collaboration"}</span>
                {collab.joinRequests.length > 0 && (
                  <span className="ml-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                    {collab.joinRequests.length}
                  </span>
                )}
              </button>
            ) : (
              <div className="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-300">
                <Users className="h-3.5 w-3.5" />
                <span>Review Session ({collab.participants.length})</span>
              </div>
            )}

            {!isCollaborator && (
              <>
                {/* Import from 3D Slicer */}
                <button
                  type="button"
                  onClick={() => importInput.current?.click()}
                  disabled={importing}
                  title="Import a .seg.nrrd saved in 3D Slicer"
                  className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition cursor-pointer disabled:opacity-40"
                >
                  {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                  <span className="hidden sm:inline">Import from Slicer</span>
                </button>
              </>
            )}

            {canDelete && (
              <>
                {/* Clear Mask Button */}
                <button
                  onClick={clearMask}
                  title="Clear current 3D canvas mask"
                  className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-destructive transition cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </>
            )}

            {/* Delete Saved Mask */}
            {hasSaved && canDelete && (
              <button
                type="button"
                onClick={() => deleteMask()}
                disabled={deletingMask}
                title="Delete saved 3D mask permanently from server"
                className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20 transition cursor-pointer"
              >
                <XCircle className="h-3 w-3" />
                <span className="hidden sm:inline">Delete Mask</span>
              </button>
            )}

            {canAnnotate && (
              <>
                {/* Save Mask */}
                <button
                  onClick={save}
                  disabled={saving || !dirty}
                  title="Save 3D Mask (Ctrl+S)"
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer ${
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
                  {savedSuccess ? "Saved!" : dirty ? "Save Mask" : "Saved"}
                </button>
              </>
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

      {flag && (
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

      {/* Info bar: which scan, its geometry, and the latest load/save message. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="font-mono font-medium text-foreground">{caseId}</span>
          <span className="tabular-nums">
            {vol.dims.join(" × ")} &middot; {vol.spacing.map((s) => s.toFixed(2)).join(" × ")} mm
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate">{status}</span>
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
                  <kbd className="font-mono">E</kbd><span>Eraser on/off (brush or pencil)</span>
                  <kbd className="font-mono">T (hold)</kbd><span>Peek under the labels</span>
                  <kbd className="font-mono">[ ]</kbd><span>Brush or torch size</span>
                  <kbd className="font-mono">V</kbd><span>Cycle which labels show</span>
                  <kbd className="font-mono">&uarr;&darr;&larr;&rarr;</kbd><span>Step slice (hovered view)</span>
                  <kbd className="font-mono">PgUp/PgDn</kbd><span>Step 10 slices</span>
                  <kbd className="font-mono">Shift+click</kbd><span>Move crosshair</span>
                  <kbd className="font-mono">L</kbd><span>Lock / link views</span>
                  <kbd className="font-mono">Ctrl+wheel</kbd><span>Zoom the view (or pinch)</span>
                  <kbd className="font-mono">Dbl-click title</kbd><span>Full view (Esc to go back)</span>
                  <kbd className="font-mono">Esc</kbd><span>Discard an outline while tracing</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Four-Up: three orthogonal views plus the 3D view, as in Slicer */}
      <div
        ref={gridRef}
        className={`grid gap-2 grid-cols-1 min-h-0 ${expanded ? "" : "md:grid-cols-2 lg:grid-rows-2"}`}
        style={gridHeight !== null ? { height: gridHeight } : undefined}
      >
        {PLANES.map((p) => {
          const g = planeGeom(p, vol);
          const depth = g.depth;
          const s = sliceOf(p, vol, cursor);
          return (
            <div key={p}
              ref={(el) => { viewRefs.current[p] = el; }}
              onMouseEnter={() => setActivePlane(p)}
              className={`${expanded && expanded !== p ? "hidden" : "flex"} min-h-0 flex-col overflow-hidden rounded-lg border-2 bg-black p-1.5`}
              style={{
                borderColor: PLANE_COLOR[p],
                opacity: activePlane === p ? 1 : 0.94,
                boxShadow: activePlane === p ? `0 0 0 1px ${PLANE_COLOR[p]}` : undefined,
              }}>
              <div className="mb-1 flex shrink-0 select-none items-center justify-between gap-1 px-1 text-[10px] uppercase tracking-wider"
                style={{ color: PLANE_COLOR[p] }}
                onDoubleClick={() => toggleExpanded(p)}
                title="Double-click for full view">
                <span>{p}</span>
                <span className="flex items-center gap-0.5">
                  <button type="button" disabled={!canZoomPan} title="Zoom out"
                    onClick={() => setZoom((z) => ({ ...z, [p]: clampZoom(z[p] - 0.25) }))}
                    className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800">
                    <Minus className="h-2.5 w-2.5" />
                  </button>
                  <button type="button" disabled={!canZoomPan} title="Reset zoom and pan"
                    onClick={() => resetView(p)}
                    className="w-8 rounded border border-neutral-700 text-[9px] tabular-nums text-neutral-300 hover:bg-neutral-800">
                    {zoom[p].toFixed(1)}x
                  </button>
                  <button type="button" disabled={!canZoomPan} title="Zoom in"
                    onClick={() => setZoom((z) => ({ ...z, [p]: clampZoom(z[p] + 0.25) }))}
                    className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800">
                    <Plus className="h-2.5 w-2.5" />
                  </button>
                  <span className="ml-1 tabular-nums text-neutral-400">{s + 1}/{depth}</span>
                  <button type="button"
                    title={expanded === p ? "Back to all four views (Esc)" : "Full view"}
                    onClick={() => toggleExpanded(p)}
                    className="ml-1 rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800">
                    {expanded === p ? <Minimize2 className="h-2.5 w-2.5" /> : <Maximize2 className="h-2.5 w-2.5" />}
                  </button>
                </span>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              <div className="flex h-full w-full items-center justify-center"
                style={{ transform: `translate(${pan[p].x}px, ${pan[p].y}px) scale(${zoom[p]})`, transformOrigin: "center" }}>
              <canvas
                ref={(el) => { canvases.current[p] = el; }}
                className={`${
                  tool === "pan" ? (panning === p ? "cursor-grabbing" : "cursor-grab")
                    : tool === "torch" ? "cursor-none" : "cursor-crosshair"
                } rounded`}
                style={{
                  imageRendering: "auto",
                  // Fill the square tile while keeping true physical proportions.
                  aspectRatio: `${g.mmW} / ${g.mmH}`,
                  maxWidth: "100%", maxHeight: "100%",
                  margin: "0 auto", display: "block",
                  ...(tool === "pencil"
                    ? { cursor: pencilCursor(erasing ? "#ffffff" : SEGMENTS.find((x) => x.value === seg)!.color) }
                    : {}),
                }}
                onMouseDown={(e) => {
                  if (tool === "torch") return; // Pitfall-1: mouse down with torch tool does nothing
                  if (tool === "pan") {
                    if (e.button === 0 && canZoomPan) startPan(p, e);
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
                    painting.current = true;
                    setOutlineTick((n) => n + 1);
                  } else {
                    pushUndo();
                    strokeHasBone.current = sliceHasBone(p);
                    painting.current = true;
                    paintAt(p, e);
                    if (!locked && canMoveSlices) moveCursor(p, hit.a, hit.b);
                  }
                }}
                onMouseMove={(e) => {
                  const hit = toVoxel(p, e);
                  if (hit && collabToken && collab.connected) {
                    const g = planeGeom(p, vol);
                    collab.updateCursor({ x: hit.a / g.w, y: hit.b / g.h, plane: p });
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
                  if (!painting.current) return;
                  if (tool === "pencil") {
                    if (!hit) return;
                    const last = outline.current[outline.current.length - 1];
                    // Skip duplicate points so the polygon stays cheap to fill.
                    if (!last || last[0] !== hit.a || last[1] !== hit.b) {
                      outline.current.push([hit.a, hit.b]);
                      setOutlineTick((n) => n + 1);
                    }
                  } else if (tool === "brush") {
                    paintAt(p, e);
                  }
                }}
                onMouseUp={() => {
                  // Pencil fills the traced outline on release, as in 2D.
                  const wasTracing = painting.current && tool === "pencil";
                  const wasBrushing = painting.current && tool === "brush";
                  painting.current = false;
                  if (wasTracing) commitOutline();
                  else drawAll();
                  // Labels are edited in place, so counts are refreshed when a
                  // stroke ends rather than on every mouse move.
                  if (wasBrushing) {
                    recount();
                    scheduleAutoSaveRef.current();
                  }
                }}
                onMouseLeave={() => {
                  if (painting.current && tool === "pencil") commitOutline();
                  else if (painting.current) {
                    recount();
                    scheduleAutoSaveRef.current();
                  }
                  painting.current = false;
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
          <SegmentMeasures counts={counts} spacing={vol.spacing} />
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
  );
}
