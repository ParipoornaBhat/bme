"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Expand, Loader2, Maximize2, RotateCcw, Shrink, Sparkles } from "lucide-react";
import { Pinch } from "~/lib/pinch";
import { wheelZoomFactor } from "~/lib/wheel-zoom";
import {
  initGL,
  createGLMesh,
  destroyGLMesh,
  createBoxMesh,
  destroyLineMesh,
  buildOrientMatrix,
  mat4Create,
  mat4Perspective,
  mat4LookAt,
  mat4Multiply,
  mat3FromMat4,
  mat3InvertAndTranspose,
  getOrientationLetters,
  parseHexColor,
  type AxisEnds,
  type GLState,
  type GLMesh,
  type OrientationLetter,
  type Vec3,
} from "./gl3d";
import type { MeshData, MeshWorkerOutput } from "./mesh3d.worker";

type SegDef = { value: number; label: string; color: string };

type Preset = "A" | "P" | "L" | "R" | "S" | "I";

const PRESET_ANGLES: Record<Preset, { yaw: number; pitch: number }> = {
  A: { yaw: 0, pitch: 0 },
  P: { yaw: Math.PI, pitch: 0 },
  L: { yaw: Math.PI / 2, pitch: 0 },
  R: { yaw: -Math.PI / 2, pitch: 0 },
  S: { yaw: 0, pitch: 1.53 },
  I: { yaw: 0, pitch: -1.53 },
};

export default function Render3D({
  labels,
  dims,
  spacing,
  orient,
  segments,
  hidden: controlledHidden,
  expanded = false,
  onToggleExpand,
  fill = false,
}: {
  labels: Uint8Array | null;
  dims: [number, number, number];
  spacing: [number, number, number];
  /** Letter at the low and high end of array axes i, j, k. From the scan affine. */
  orient: [AxisEnds, AxisEnds, AxisEnds];
  segments: ReadonlyArray<SegDef>;
  hidden?: Set<number>;
  /** Shown full size in place of the four-up. */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Grow to fill a flex parent, drawing at that size. Otherwise a fixed 460px square. */
  fill?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const [webglAvailable, setWebglAvailable] = useState(true);
  const [built, setBuilt] = useState(false);
  const [building, setBuilding] = useState(false);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [internalHidden, setInternalHidden] = useState<Set<number>>(new Set());
  const hidden = controlledHidden !== undefined ? controlledHidden : internalHidden;

  const [smooth, setSmooth] = useState(true);
  const [fit, setFit] = useState(false);
  const [letters, setLetters] = useState<OrientationLetter[]>([]);

  // Camera state refs
  const yawRef = useRef<number>(0);
  const pitchRef = useRef<number>(0);
  const targetRef = useRef<Vec3>([0, 0, 0]);
  const zoomRef = useRef<number>(1);
  const isFitRef = useRef<boolean>(false);

  // Worker and WebGL state
  const workerRef = useRef<Worker | null>(null);
  const activeRequestId = useRef<number>(0);
  const glStateRef = useRef<GLState | null>(null);
  const glMeshesRef = useRef<Record<number, GLMesh>>({});
  const meshDataMapRef = useRef<Record<number, MeshData>>({});

  // Interaction refs
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    isPan: boolean;
  } | null>(null);

  const pinch = useRef(new Pinch());
  const pinchZoom0 = useRef(1);

  const inertiaRef = useRef<{ velYaw: number; velPitch: number } | null>(null);
  const animRef = useRef<{
    startTime: number;
    duration: number;
    startYaw: number;
    startPitch: number;
    endYaw: number;
    endPitch: number;
  } | null>(null);

  const renderQueuedRef = useRef(false);

  // Clean up WebGL resources
  const cleanupGL = useCallback(() => {
    const glState = glStateRef.current;
    if (!glState) return;
    const { gl, meshProgram, lineProgram, boxMesh } = glState;

    for (const mesh of Object.values(glMeshesRef.current)) {
      destroyGLMesh(gl, mesh);
    }
    glMeshesRef.current = {};

    if (boxMesh) {
      destroyLineMesh(gl, boxMesh);
    }

    gl.deleteProgram(meshProgram);
    gl.deleteProgram(lineProgram);
    glStateRef.current = null;
  }, []);

  // Update GL meshes when worker finishes
  const updateGLMeshes = useCallback((results: Record<number, MeshData>) => {
    const glState = glStateRef.current;
    if (!glState) return;
    const { gl } = glState;

    // Destroy existing segment meshes
    for (const mesh of Object.values(glMeshesRef.current)) {
      destroyGLMesh(gl, mesh);
    }
    glMeshesRef.current = {};

    for (const [valStr, data] of Object.entries(results)) {
      const v = Number(valStr);
      if (data.positions.length > 0 && data.indices.length > 0) {
        const mesh = createGLMesh(gl, data.positions, data.normals, data.indices);
        if (mesh) {
          glMeshesRef.current[v] = mesh;
        }
      }
    }
  }, []);

  // Trigger frame rendering
  const requestRender = useCallback(() => {
    if (renderQueuedRef.current) return;
    renderQueuedRef.current = true;
    requestAnimationFrame(() => {
      renderQueuedRef.current = false;
      drawScene();
    });
  }, []);

  // Main WebGL drawing function
  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    const glState = glStateRef.current;
    if (!canvas || !glState) return;

    const { gl, meshProgram, lineProgram, meshUniforms, meshAttribs, lineUniforms, lineAttribs } = glState;

    const width = canvas.width;
    const height = canvas.height;
    if (width <= 0 || height <= 0) return;

    // Handle smooth view preset animation
    let needNextFrame = false;
    const now = performance.now();
    const anim = animRef.current;
    if (anim) {
      const elapsed = now - anim.startTime;
      const progress = Math.min(1, elapsed / anim.duration);
      // Cubic ease out
      const ease = 1 - Math.pow(1 - progress, 3);
      yawRef.current = anim.startYaw + (anim.endYaw - anim.startYaw) * ease;
      pitchRef.current = anim.startPitch + (anim.endPitch - anim.startPitch) * ease;
      if (progress < 1) {
        needNextFrame = true;
      } else {
        animRef.current = null;
      }
    }

    // Handle trackball inertia
    const inertia = inertiaRef.current;
    if (inertia) {
      yawRef.current += inertia.velYaw;
      pitchRef.current = Math.max(-1.55, Math.min(1.55, pitchRef.current + inertia.velPitch));
      inertia.velYaw *= 0.91;
      inertia.velPitch *= 0.91;
      if (Math.hypot(inertia.velYaw, inertia.velPitch) > 0.0001) {
        needNextFrame = true;
      } else {
        inertiaRef.current = null;
      }
    }

    const { modelMatrix, extents } = buildOrientMatrix(orient, dims, spacing);

    // Update bounding box line mesh if extents changed
    if (!glState.boxMesh) {
      glState.boxMesh = createBoxMesh(gl, extents);
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.02, 0.03, 0.04, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = width / height;
    const fov = (35 * Math.PI) / 180;
    const maxDim = Math.max(extents[0], extents[1], extents[2]);
    const baseDistance = (maxDim * 1.3) / (2 * Math.tan(fov / 2));
    const dist = baseDistance / Math.max(0.1, zoomRef.current);

    const near = Math.max(1, dist * 0.05);
    const far = Math.max(1000, dist * 10);

    const projMatrix = mat4Perspective(mat4Create(), fov, aspect, near, far);

    // Spherical camera positioning around target
    const yaw = yawRef.current;
    const pitch = pitchRef.current;
    const target = targetRef.current;

    const eye: Vec3 = [
      target[0] - dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.cos(pitch) * Math.cos(yaw),
      target[2] + dist * Math.sin(pitch),
    ];
    const up: Vec3 = [0, 0, 1];

    const viewMatrix = mat4LookAt(mat4Create(), eye, target, up);
    const viewProjMatrix = mat4Multiply(mat4Create(), projMatrix, viewMatrix);

    // Update HTML overlay orientation letters
    const cssW = canvas.clientWidth || width;
    const cssH = canvas.clientHeight || height;
    const overlayLetters = getOrientationLetters(viewProjMatrix, extents, cssW, cssH);
    setLetters(overlayLetters);

    // 1. Draw volume bounding box wireframe
    if (glState.boxMesh) {
      gl.useProgram(lineProgram);
      gl.uniformMatrix4fv(lineUniforms.u_viewProj, false, viewProjMatrix);
      gl.uniform4f(lineUniforms.u_color, 0.706, 0.333, 0.784, 0.45);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      gl.bindBuffer(gl.ARRAY_BUFFER, glState.boxMesh.posBuffer);
      gl.enableVertexAttribArray(lineAttribs.a_position);
      gl.vertexAttribPointer(lineAttribs.a_position, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.LINES, 0, glState.boxMesh.vertexCount);

      gl.disableVertexAttribArray(lineAttribs.a_position);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    // 2. Draw 3D surface meshes
    const normalMatrix = mat3InvertAndTranspose(
      mat3FromMat4(new Float32Array(9), mat4Multiply(mat4Create(), viewMatrix, modelMatrix)),
      mat3FromMat4(new Float32Array(9), mat4Multiply(mat4Create(), viewMatrix, modelMatrix))
    );

    gl.useProgram(meshProgram);
    gl.uniformMatrix4fv(meshUniforms.u_model, false, modelMatrix);
    gl.uniformMatrix4fv(meshUniforms.u_view, false, viewMatrix);
    gl.uniformMatrix4fv(meshUniforms.u_projection, false, projMatrix);
    gl.uniformMatrix3fv(meshUniforms.u_normalMatrix, false, normalMatrix);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Pass 1: Opaque segments (edema: 2, uncertain: 3, and any non-bone segments)
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.uniform1f(meshUniforms.u_alpha, 1.0);

    for (const seg of segments) {
      if (seg.value === 1) continue; // Bone marrow is drawn in Pass 2
      if (hidden.has(seg.value)) continue;

      const mesh = glMeshesRef.current[seg.value];
      if (!mesh || mesh.indexCount === 0) continue;

      const [r, g, b] = parseHexColor(seg.color);
      gl.uniform3f(meshUniforms.u_color, r, g, b);

      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
      gl.enableVertexAttribArray(meshAttribs.a_position);
      gl.vertexAttribPointer(meshAttribs.a_position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normBuffer);
      gl.enableVertexAttribArray(meshAttribs.a_normal);
      gl.vertexAttribPointer(meshAttribs.a_normal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
    }

    // Pass 2: Semi-transparent bone marrow (segment value 1)
    // alpha 0.35, depth write off, back faces culled
    const boneSeg = segments.find((s) => s.value === 1);
    if (boneSeg && !hidden.has(1)) {
      const boneMesh = glMeshesRef.current[1];
      if (boneMesh && boneMesh.indexCount > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);

        const [r, g, b] = parseHexColor(boneSeg.color);
        gl.uniform3f(meshUniforms.u_color, r, g, b);
        gl.uniform1f(meshUniforms.u_alpha, 0.35);

        gl.bindBuffer(gl.ARRAY_BUFFER, boneMesh.posBuffer);
        gl.enableVertexAttribArray(meshAttribs.a_position);
        gl.vertexAttribPointer(meshAttribs.a_position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, boneMesh.normBuffer);
        gl.enableVertexAttribArray(meshAttribs.a_normal);
        gl.vertexAttribPointer(meshAttribs.a_normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boneMesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, boneMesh.indexCount, gl.UNSIGNED_INT, 0);

        gl.depthMask(true);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    if (needNextFrame) {
      requestRender();
    }
  }, [orient, dims, spacing, segments, hidden, requestRender]);

  // Canvas resize with ResizeObserver and devicePixelRatio
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;

    const onResize = () => {
      const rect = box.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(80, Math.floor(rect.width));
      const h = Math.max(80, Math.floor(rect.height));

      const pw = Math.floor(w * dpr);
      const ph = Math.floor(h * dpr);

      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        requestRender();
      }
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(box);
    onResize();

    return () => ro.disconnect();
  }, [fill, requestRender]);

  // Initialise WebGL
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    cleanupGL();
    const state = initGL(canvas);
    if (!state) {
      setWebglAvailable(false);
      return;
    }
    setWebglAvailable(true);
    glStateRef.current = state;
    requestRender();

    return () => {
      cleanupGL();
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [cleanupGL, requestRender]);

  // Re-render when hidden segments or labels change
  useEffect(() => {
    requestRender();
  }, [hidden, requestRender]);

  // Worker mesh builder
  const build = useCallback(() => {
    if (!labels) return;
    setBuilding(true);
    const reqId = ++activeRequestId.current;

    if (workerRef.current) {
      workerRef.current.terminate();
    }

    const worker = new Worker(new URL("./mesh3d.worker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<MeshWorkerOutput>) => {
      if (e.data.requestId !== activeRequestId.current) return;
      const res = e.data.results;
      meshDataMapRef.current = res;

      const newCounts: Record<number, number> = {};
      for (const [valStr, data] of Object.entries(res)) {
        newCounts[Number(valStr)] = data.voxelCount;
      }
      setCounts(newCounts);
      setBuilt(true);
      setBuilding(false);

      updateGLMeshes(res);
      requestRender();
    };

    worker.onerror = () => {
      setBuilding(false);
    };

    // Transfer a copy of labels so original memory remains intact
    const copy = labels.slice();
    worker.postMessage(
      {
        requestId: reqId,
        labels: copy,
        dims,
        spacing,
        values: segments.map((s) => s.value),
        smoothIters: smooth ? 6 : 0,
      },
      [copy.buffer]
    );
  }, [labels, dims, spacing, segments, smooth, updateGLMeshes, requestRender]);

  // Rebuild if smooth setting changes while meshes are already built
  useEffect(() => {
    if (built) {
      build();
    }
  }, [smooth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom via wheel
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;

    const onWheel = (e: WheelEvent) => {
      const factor = wheelZoomFactor(e);
      if (factor === null) return;
      e.preventDefault();
      zoomRef.current = Math.max(0.2, Math.min(10, zoomRef.current * factor));
      requestRender();
    };

    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [requestRender]);

  // Camera presets animation (250 ms)
  const setPreset = useCallback(
    (preset: Preset) => {
      const targetAngles = PRESET_ANGLES[preset];
      const curYaw = yawRef.current;
      const curPitch = pitchRef.current;

      let deltaYaw = ((targetAngles.yaw - curYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
      if (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;

      animRef.current = {
        startTime: performance.now(),
        duration: 250,
        startYaw: curYaw,
        startPitch: curPitch,
        endYaw: curYaw + deltaYaw,
        endPitch: targetAngles.pitch,
      };
      requestRender();
    },
    [requestRender]
  );

  // Reset to full volume framing
  const resetView = useCallback(() => {
    targetRef.current = [0, 0, 0];
    zoomRef.current = 1;
    yawRef.current = 0;
    pitchRef.current = 0;
    inertiaRef.current = null;
    animRef.current = null;
    isFitRef.current = false;
    setFit(false);
    requestRender();
  }, [requestRender]);

  // Fit camera to visible meshes
  const toggleFit = useCallback(() => {
    if (isFitRef.current) {
      resetView();
      return;
    }

    const { modelMatrix, extents } = buildOrientMatrix(orient, dims, spacing);
    const maxDim = Math.max(extents[0], extents[1], extents[2]);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasPoints = false;

    for (const seg of segments) {
      if (hidden.has(seg.value)) continue;
      const data = meshDataMapRef.current[seg.value];
      if (!data || data.positions.length === 0) continue;

      const pos = data.positions;
      for (let i = 0; i < pos.length; i += 3) {
        const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
        const wx = modelMatrix[0] * px + modelMatrix[4] * py + modelMatrix[8] * pz + modelMatrix[12];
        const wy = modelMatrix[1] * px + modelMatrix[5] * py + modelMatrix[9] * pz + modelMatrix[13];
        const wz = modelMatrix[2] * px + modelMatrix[6] * py + modelMatrix[10] * pz + modelMatrix[14];

        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        hasPoints = true;
      }
    }

    if (!hasPoints) {
      resetView();
      return;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const fitExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) * 1.35;

    targetRef.current = [cx, cy, cz];
    zoomRef.current = Math.max(0.2, Math.min(10, maxDim / fitExtent));
    isFitRef.current = true;
    setFit(true);
    requestRender();
  }, [orient, dims, spacing, segments, hidden, resetView, requestRender]);

  // Volume format calculation (exact)
  const voxelVolumeMm3 = spacing[0] * spacing[1] * spacing[2];
  const mm = [dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]];

  const formatVolume = (voxelCount: number) => {
    const ml = (voxelCount * voxelVolumeMm3) / 1000;
    const decimals = ml < 0.1 ? 3 : 2;
    const mlStr = ml.toFixed(decimals);
    return `${voxelCount.toLocaleString()} voxels, ${mlStr} ml (${mlStr} cm³)`;
  };

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded-lg border-2 border-neutral-700 bg-black p-1.5 ${
        fill ? "flex-1" : ""
      }`}
      onDoubleClick={(e) => {
        if (onToggleExpand && !(e.target as HTMLElement).closest("button")) onToggleExpand();
      }}
    >
      {/* Top Header & View Controls */}
      <div
        className="mb-1 flex h-6 shrink-0 select-none items-center justify-between gap-1.5 px-1 text-neutral-400"
        title={onToggleExpand ? "Double-click the view for full size" : undefined}
      >
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
          <Box className="h-3.5 w-3.5 text-neutral-400" /> 3D
        </span>

        {/* View Presets & Action Buttons */}
        <div className="flex items-center gap-1 text-[11px]">
          <div className="inline-flex rounded border border-neutral-700 bg-neutral-900/60 p-0.5">
            {(["A", "P", "L", "R", "S", "I"] as Preset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                title={`Orient view ${p}`}
                className="h-4.5 min-w-[17px] rounded px-1 text-[10px] font-medium text-neutral-300 transition hover:bg-neutral-800 hover:text-white"
              >
                {p}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleFit}
            disabled={!built}
            title={fit ? "Show at true size in volume" : "Zoom to visible painted segments"}
            className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 disabled:opacity-40 ${
              fit ? "border-primary text-primary" : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            <Maximize2 className="h-3 w-3" /> Fit
          </button>

          <button
            type="button"
            onClick={resetView}
            title="Reset view to whole volume center"
            className="flex h-5 w-5 items-center justify-center rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            <RotateCcw className="h-3 w-3" />
          </button>

          <button
            type="button"
            onClick={() => setSmooth((s) => !s)}
            title={smooth ? "Smooth surfaces on (Taubin filter)" : "Raw voxel surfaces"}
            className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 ${
              smooth ? "border-neutral-700 text-neutral-300 hover:bg-neutral-800" : "border-neutral-800 text-neutral-500"
            }`}
          >
            <Sparkles className="h-2.5 w-2.5" />
            <span>Smooth: {smooth ? "On" : "Off"}</span>
          </button>

          <button
            type="button"
            onClick={build}
            disabled={building || !labels}
            className={`h-5 rounded border px-2 disabled:opacity-40 ${
              built
                ? "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                : "border-primary bg-primary/15 text-primary hover:bg-primary/25"
            }`}
          >
            {building ? "Building…" : built ? "Rebuild" : "Build"}
          </button>

          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              title={expanded ? "Back to all four views" : "Full view (or double-click header)"}
              className="flex h-5 w-6 items-center justify-center rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white"
            >
              {expanded ? <Shrink className="h-3 w-3" /> : <Expand className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Canvas Area with HTML Orientation Letters Overlay */}
      <div
        ref={boxRef}
        className={fill ? "relative min-h-[120px] flex-1" : "relative flex min-h-0 flex-1 items-center justify-center"}
      >
        <canvas
          ref={canvasRef}
          className={`${fill ? "absolute inset-0 h-full w-full" : ""} cursor-grab rounded active:cursor-grabbing`}
          style={{ ...(fill ? {} : { width: "460px", height: "460px", maxWidth: "100%", maxHeight: "100%" }), touchAction: "none" }}
          onContextMenu={(e) => e.preventDefault()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            resetView();
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            if (e.pointerType === "touch") {
              pinch.current.down(e);
              if (pinch.current.active) {
                dragRef.current = null;
                pinchZoom0.current = zoomRef.current;
                return;
              }
            }
            inertiaRef.current = null;
            animRef.current = null;

            const isPan = e.button === 2 || (e.button === 0 && e.shiftKey);
            dragRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              lastX: e.clientX,
              lastY: e.clientY,
              isPan,
            };
          }}
          onPointerMove={(e) => {
            if (e.pointerType === "touch") {
              const f = pinch.current.move(e);
              if (f) {
                zoomRef.current = Math.max(0.2, Math.min(10, pinchZoom0.current * f.scale));
                requestRender();
                return;
              }
            }
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;

            const dx = e.clientX - drag.lastX;
            const dy = e.clientY - drag.lastY;
            drag.lastX = e.clientX;
            drag.lastY = e.clientY;

            if (drag.isPan) {
              // Pan target in camera space
              const yaw = yawRef.current;
              const pitch = pitchRef.current;
              const dist =
                (Math.max(mm[0], mm[1], mm[2]) * 1.3) /
                (2 * Math.tan(((35 * Math.PI) / 180) / 2) * Math.max(0.1, zoomRef.current));
              const cv = canvasRef.current;
              const scale = (dist * 0.0016) / (cv ? cv.clientHeight / 460 : 1);

              // Camera right and up in world space
              const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
              const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
              const right: Vec3 = [-cosY, -sinY, 0];
              const camUp: Vec3 = [-sinP * sinY, sinP * cosY, cosP];

              targetRef.current = [
                targetRef.current[0] - right[0] * dx * scale - camUp[0] * dy * scale,
                targetRef.current[1] - right[1] * dx * scale - camUp[1] * dy * scale,
                targetRef.current[2] - right[2] * dx * scale - camUp[2] * dy * scale,
              ];
            } else {
              // Orbit rotation
              yawRef.current += dx * 0.008;
              pitchRef.current = Math.max(-1.55, Math.min(1.55, pitchRef.current + dy * 0.008));
              inertiaRef.current = { velYaw: dx * 0.008, velPitch: dy * 0.008 };
            }

            requestRender();
          }}
          onPointerUp={(e) => {
            pinch.current.up(e);
            if (dragRef.current?.pointerId === e.pointerId) {
              dragRef.current = null;
            }
            requestRender();
          }}
          onPointerCancel={(e) => {
            pinch.current.up(e);
            if (dragRef.current?.pointerId === e.pointerId) {
              dragRef.current = null;
            }
          }}
        />

        {/* Orientation Letters Overlay */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {letters.map(({ letter, x, y, visible }) => {
            if (!visible) return null;
            return (
              <span
                key={letter}
                className="absolute font-semibold text-[12px] text-[#c07dd4] select-none"
                style={{
                  left: `${x}px`,
                  top: `${y}px`,
                  transform: "translate(-50%, -50%)",
                  textShadow: "0 0 3px rgba(0,0,0,0.9)",
                }}
              >
                {letter}
              </span>
            );
          })}
        </div>

        {/* Fallback when WebGL is unavailable */}
        {!webglAvailable && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
            3D view needs WebGL
          </div>
        )}

        {/* Build guidance badge */}
        {!built && webglAvailable && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-5 text-center text-[11px] text-neutral-400">
            <span className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-black/80 px-3 py-1">
              {building ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> building surface…
                </>
              ) : (
                "Press Build to see everything painted, in 3D"
              )}
            </span>
          </div>
        )}
      </div>

      {/* Numbers under the view, per segment */}
      <div className="mt-1 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-1 text-[10px] text-neutral-500">
        {built && Object.keys(counts).length > 0 ? (
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
            {segments.map((seg) => {
              const count = counts[seg.value] ?? 0;
              const off = hidden.has(seg.value);
              const text = `${seg.label}: ${formatVolume(count)}`;

              if (controlledHidden !== undefined) {
                return (
                  <span
                    key={seg.value}
                    title={off ? "Hidden by view filter" : seg.label}
                    className={`inline-flex items-center gap-1 ${off ? "opacity-35" : ""}`}
                  >
                    <span className="h-2 w-2 rounded-sm" style={{ background: seg.color }} />
                    <span className="tabular-nums text-neutral-400">{text}</span>
                  </span>
                );
              }

              return (
                <button
                  key={seg.value}
                  type="button"
                  onClick={() =>
                    setInternalHidden((h) => {
                      const next = new Set(h);
                      if (next.has(seg.value)) next.delete(seg.value);
                      else next.add(seg.value);
                      return next;
                    })
                  }
                  title={off ? `Show ${seg.label}` : `Hide ${seg.label}`}
                  className={`inline-flex items-center gap-1 ${off ? "opacity-35" : ""}`}
                >
                  <span className="h-2 w-2 rounded-sm" style={{ background: seg.color }} />
                  <span className="tabular-nums text-neutral-400">{text}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div>volume {mm.map((v) => v.toFixed(0)).join(" x ")} mm</div>
        )}
        <span className="text-[9.5px]">
          {fit ? "fitted" : "true size"} &middot; drag to orbit &middot; right-drag to pan &middot; wheel/pinch to zoom
        </span>
      </div>
    </div>
  );
}
