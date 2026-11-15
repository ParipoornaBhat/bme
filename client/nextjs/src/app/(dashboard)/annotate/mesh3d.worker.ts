/**
 * Web Worker for 3D Surface Net extraction and Taubin smoothing.
 */

export type MeshWorkerInput = {
  requestId: number;
  labels: Uint8Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  values: number[];
  inPlaneStep?: number;
  smoothIters?: number;
};

export type MeshData = {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  voxelCount: number;
};

export type MeshWorkerOutput = {
  requestId: number;
  results: Record<number, MeshData>;
};

// Corner offsets in padded cube:
// 0: (0,0,0), 1: (1,0,0), 2: (0,1,0), 3: (1,1,0)
// 4: (0,0,1), 5: (1,0,1), 6: (0,1,1), 7: (1,1,1)
const CORNER_OFFSETS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

// 12 edges with their endpoint corner indices and midpoints
const CUBE_EDGES: Array<{ c0: number; c1: number; mid: [number, number, number] }> = [
  { c0: 0, c1: 1, mid: [0.5, 0, 0] },
  { c0: 1, c1: 3, mid: [1, 0.5, 0] },
  { c0: 2, c1: 3, mid: [0.5, 1, 0] },
  { c0: 0, c1: 2, mid: [0, 0.5, 0] },
  { c0: 4, c1: 5, mid: [0.5, 0, 1] },
  { c0: 5, c1: 7, mid: [1, 0.5, 1] },
  { c0: 6, c1: 7, mid: [0.5, 1, 1] },
  { c0: 4, c1: 6, mid: [0, 0.5, 1] },
  { c0: 0, c1: 4, mid: [0, 0, 0.5] },
  { c0: 1, c1: 5, mid: [1, 0, 0.5] },
  { c0: 3, c1: 7, mid: [1, 1, 0.5] },
  { c0: 2, c1: 6, mid: [0, 1, 0.5] },
];

function smoothStep(pos: Float32Array<ArrayBuffer>, adj: number[][], factor: number): Float32Array<ArrayBuffer> {
  const n = adj.length;
  const next = new Float32Array(pos.length);
  for (let i = 0; i < n; i++) {
    const neighbors = adj[i];
    const i3 = i * 3;
    if (!neighbors || neighbors.length === 0) {
      next[i3] = pos[i3];
      next[i3 + 1] = pos[i3 + 1];
      next[i3 + 2] = pos[i3 + 2];
      continue;
    }
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < neighbors.length; k++) {
      const nb = neighbors[k] * 3;
      ax += pos[nb];
      ay += pos[nb + 1];
      az += pos[nb + 2];
    }
    const inv = 1 / neighbors.length;
    ax *= inv;
    ay *= inv;
    az *= inv;
    next[i3] = pos[i3] + factor * (ax - pos[i3]);
    next[i3 + 1] = pos[i3 + 1] + factor * (ay - pos[i3 + 1]);
    next[i3 + 2] = pos[i3 + 2] + factor * (az - pos[i3 + 2]);
  }
  return next;
}

self.onmessage = (e: MessageEvent<MeshWorkerInput>) => {
  const { requestId, labels, dims, spacing, values, inPlaneStep, smoothIters } = e.data;
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;

  // Determine slice axis (axis with maximum spacing)
  let sliceAxis = 2;
  let maxSpacing = sz;
  if (sx > maxSpacing) {
    sliceAxis = 0;
    maxSpacing = sx;
  }
  if (sy > maxSpacing) {
    sliceAxis = 1;
    maxSpacing = sy;
  }

  // In-plane dimensions
  let ni = 0, nj = 0;
  if (sliceAxis === 2) {
    ni = nx; nj = ny;
  } else if (sliceAxis === 1) {
    ni = nx; nj = nz;
  } else {
    ni = ny; nj = nz;
  }

  // Downsample only the two in-plane axes:
  // inPlaneStep = max(1, ceil(sqrt((ni*nj) / 160000)))
  const defaultInPlaneStep = Math.max(1, Math.ceil(Math.sqrt((ni * nj) / 160_000)));
  const effectiveInPlaneStep = inPlaneStep && inPlaneStep >= 1 ? inPlaneStep : defaultInPlaneStep;

  const step: [number, number, number] = [
    sliceAxis === 0 ? 1 : effectiveInPlaneStep,
    sliceAxis === 1 ? 1 : effectiveInPlaneStep,
    sliceAxis === 2 ? 1 : effectiveInPlaneStep,
  ];

  // 1. Exact full-resolution voxel counts
  const exactCounts: Record<number, number> = {};
  for (const v of values) {
    exactCounts[v] = 0;
  }
  for (let idx = 0; idx < labels.length; idx++) {
    const val = labels[idx];
    if (exactCounts[val] !== undefined) {
      exactCounts[val]++;
    }
  }

  const results: Record<number, MeshData> = {};
  const transferables: Transferable[] = [];

  const G0 = Math.ceil(nx / step[0]);
  const G1 = Math.ceil(ny / step[1]);
  const G2 = Math.ceil(nz / step[2]);

  // Padded grid for Surface Nets (0-padded on all boundaries)
  const DimX = G0 + 2;
  const DimY = G1 + 2;
  const DimZ = G2 + 2;
  const dX = 1;
  const dY = DimX;
  const dZ = DimX * DimY;

  const CubeX = G0 + 1;
  const CubeY = G1 + 1;
  const CubeZ = G2 + 1;

  for (const v of values) {
    const count = exactCounts[v] ?? 0;
    if (count === 0) {
      const emptyMesh: MeshData = {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        voxelCount: 0,
      };
      results[v] = emptyMesh;
      transferables.push(emptyMesh.positions.buffer, emptyMesh.normals.buffer, emptyMesh.indices.buffer);
      continue;
    }

    // Downsampled binary grid:
    // A coarse cell counts as inside if ANY of its voxels has the value.
    const coarse = new Uint8Array(G0 * G1 * G2);
    let labelIdx = 0;
    for (let k = 0; k < nz; k++) {
      const gk = Math.floor(k / step[2]);
      const kOffset = gk * G0 * G1;
      for (let j = 0; j < ny; j++) {
        const gj = Math.floor(j / step[1]);
        const jOffset = kOffset + gj * G0;
        for (let i = 0; i < nx; i++, labelIdx++) {
          if (labels[labelIdx] === v) {
            const gi = Math.floor(i / step[0]);
            coarse[jOffset + gi] = 1;
          }
        }
      }
    }

    // Populate padded grid
    const padded = new Uint8Array(DimX * DimY * DimZ);
    for (let gz = 0; gz < G2; gz++) {
      const pzOffset = (gz + 1) * dZ;
      const czOffset = gz * G0 * G1;
      for (let gy = 0; gy < G1; gy++) {
        const pyOffset = pzOffset + (gy + 1) * dY;
        const cyOffset = czOffset + gy * G0;
        for (let gx = 0; gx < G0; gx++) {
          padded[pyOffset + (gx + 1)] = coarse[cyOffset + gx];
        }
      }
    }

    // Surface Nets:
    // 1 vertex per elementary cube that intersects the boundary
    const cubeVerts = new Int32Array(CubeX * CubeY * CubeZ).fill(-1);
    const posList: number[] = [];
    let vertexCount = 0;

    for (let cz = 0; cz < CubeZ; cz++) {
      for (let cy = 0; cy < CubeY; cy++) {
        for (let cx = 0; cx < CubeX; cx++) {
          const p000 = cx + cy * dY + cz * dZ;
          const v0 = padded[p000];
          const v1 = padded[p000 + dX];
          const v2 = padded[p000 + dY];
          const v3 = padded[p000 + dX + dY];
          const v4 = padded[p000 + dZ];
          const v5 = padded[p000 + dX + dZ];
          const v6 = padded[p000 + dY + dZ];
          const v7 = padded[p000 + dX + dY + dZ];

          const mask = v0 | (v1 << 1) | (v2 << 2) | (v3 << 3) | (v4 << 4) | (v5 << 5) | (v6 << 6) | (v7 << 7);
          if (mask === 0 || mask === 255) continue;

          const cornerVals = [v0, v1, v2, v3, v4, v5, v6, v7];
          let sumX = 0, sumY = 0, sumZ = 0, edgeCount = 0;

          for (let eIdx = 0; eIdx < 12; eIdx++) {
            const edge = CUBE_EDGES[eIdx];
            if (cornerVals[edge.c0] !== cornerVals[edge.c1]) {
              sumX += edge.mid[0];
              sumY += edge.mid[1];
              sumZ += edge.mid[2];
              edgeCount++;
            }
          }

          if (edgeCount === 0) continue;

          const localX = cx + sumX / edgeCount;
          const localY = cy + sumY / edgeCount;
          const localZ = cz + sumZ / edgeCount;

          // Map continuous padded coordinates (where 1 is coarse 0) to original voxel units:
          const uX = localX - 1.0;
          const uY = localY - 1.0;
          const uZ = localZ - 1.0;

          const origI = Math.min(nx, Math.max(0, uX * step[0]));
          const origJ = Math.min(ny, Math.max(0, uY * step[1]));
          const origK = Math.min(nz, Math.max(0, uZ * step[2]));

          // Vertices in millimetres (index * spacing)
          posList.push(origI * sx, origJ * sy, origK * sz);
          cubeVerts[cx + CubeX * (cy + CubeY * cz)] = vertexCount++;
        }
      }
    }

    if (vertexCount === 0) {
      const emptyMesh: MeshData = {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        voxelCount: count,
      };
      results[v] = emptyMesh;
      transferables.push(emptyMesh.positions.buffer, emptyMesh.normals.buffer, emptyMesh.indices.buffer);
      continue;
    }

    // Connect quads around crossing edges
    const indexList: number[] = [];

    // Edges along X
    for (let cz = 1; cz < DimZ - 1; cz++) {
      for (let cy = 1; cy < DimY - 1; cy++) {
        for (let cx = 0; cx < DimX - 1; cx++) {
          const v0 = padded[cx + cy * dY + cz * dZ];
          const v1 = padded[(cx + 1) + cy * dY + cz * dZ];
          if (v0 === v1) continue;

          const cA = cubeVerts[cx + CubeX * ((cy - 1) + CubeY * (cz - 1))];
          const cB = cubeVerts[cx + CubeX * (cy + CubeY * (cz - 1))];
          const cC = cubeVerts[cx + CubeX * (cy + CubeY * cz)];
          const cD = cubeVerts[cx + CubeX * ((cy - 1) + CubeY * cz)];
          if (cA < 0 || cB < 0 || cC < 0 || cD < 0) continue;

          if (v0 > v1) {
            indexList.push(cA, cB, cC, cA, cC, cD);
          } else {
            indexList.push(cA, cD, cC, cA, cC, cB);
          }
        }
      }
    }

    // Edges along Y
    for (let cz = 1; cz < DimZ - 1; cz++) {
      for (let cy = 0; cy < DimY - 1; cy++) {
        for (let cx = 1; cx < DimX - 1; cx++) {
          const v0 = padded[cx + cy * dY + cz * dZ];
          const v1 = padded[cx + (cy + 1) * dY + cz * dZ];
          if (v0 === v1) continue;

          const cA = cubeVerts[(cx - 1) + CubeX * (cy + CubeY * (cz - 1))];
          const cB = cubeVerts[(cx - 1) + CubeX * (cy + CubeY * cz)];
          const cC = cubeVerts[cx + CubeX * (cy + CubeY * cz)];
          const cD = cubeVerts[cx + CubeX * (cy + CubeY * (cz - 1))];
          if (cA < 0 || cB < 0 || cC < 0 || cD < 0) continue;

          if (v0 > v1) {
            indexList.push(cA, cB, cC, cA, cC, cD);
          } else {
            indexList.push(cA, cD, cC, cA, cC, cB);
          }
        }
      }
    }

    // Edges along Z
    for (let cz = 0; cz < DimZ - 1; cz++) {
      for (let cy = 1; cy < DimY - 1; cy++) {
        for (let cx = 1; cx < DimX - 1; cx++) {
          const v0 = padded[cx + cy * dY + cz * dZ];
          const v1 = padded[cx + cy * dY + (cz + 1) * dZ];
          if (v0 === v1) continue;

          const cA = cubeVerts[(cx - 1) + CubeX * ((cy - 1) + CubeY * cz)];
          const cB = cubeVerts[cx + CubeX * ((cy - 1) + CubeY * cz)];
          const cC = cubeVerts[cx + CubeX * (cy + CubeY * cz)];
          const cD = cubeVerts[(cx - 1) + CubeX * (cy + CubeY * cz)];
          if (cA < 0 || cB < 0 || cC < 0 || cD < 0) continue;

          if (v0 > v1) {
            indexList.push(cA, cB, cC, cA, cC, cD);
          } else {
            indexList.push(cA, cD, cC, cA, cC, cB);
          }
        }
      }
    }

    let positions: Float32Array<ArrayBuffer> = new Float32Array(posList);
    const indices: Uint32Array<ArrayBuffer> = new Uint32Array(indexList);

    // Taubin smoothing (volume-preserving)
    const iters = smoothIters !== undefined ? smoothIters : 6;
    if (iters > 0 && vertexCount > 0 && indices.length > 0) {
      const adj: number[][] = Array.from({ length: vertexCount }, () => []);
      for (let idx = 0; idx < indices.length; idx += 3) {
        const a = indices[idx], b = indices[idx + 1], c = indices[idx + 2];
        adj[a].push(b, c);
        adj[b].push(a, c);
        adj[c].push(a, b);
      }
      for (let i = 0; i < vertexCount; i++) {
        if (adj[i].length > 0) {
          adj[i] = Array.from(new Set(adj[i]));
        }
      }

      const lambda = 0.5;
      const mu = -0.53;
      for (let iter = 0; iter < iters; iter++) {
        positions = smoothStep(positions, adj, lambda);
        positions = smoothStep(positions, adj, mu);
      }
    }

    // Per-vertex normals
    const normals: Float32Array<ArrayBuffer> = new Float32Array(positions.length);
    for (let idx = 0; idx < indices.length; idx += 3) {
      const i0 = indices[idx] * 3;
      const i1 = indices[idx + 1] * 3;
      const i2 = indices[idx + 2] * 3;

      const e1x = positions[i1] - positions[i0];
      const e1y = positions[i1 + 1] - positions[i0 + 1];
      const e1z = positions[i1 + 2] - positions[i0 + 2];

      const e2x = positions[i2] - positions[i0];
      const e2y = positions[i2 + 1] - positions[i0 + 1];
      const e2z = positions[i2 + 2] - positions[i0 + 2];

      const fnx = e1y * e2z - e1z * e2y;
      const fny = e1z * e2x - e1x * e2z;
      const fnz = e1x * e2y - e1y * e2x;

      normals[i0] += fnx; normals[i0 + 1] += fny; normals[i0 + 2] += fnz;
      normals[i1] += fnx; normals[i1 + 1] += fny; normals[i1 + 2] += fnz;
      normals[i2] += fnx; normals[i2 + 1] += fny; normals[i2 + 2] += fnz;
    }

    for (let i = 0; i < normals.length; i += 3) {
      const nxVal = normals[i];
      const nyVal = normals[i + 1];
      const nzVal = normals[i + 2];
      const len = Math.sqrt(nxVal * nxVal + nyVal * nyVal + nzVal * nzVal);
      if (len > 1e-6) {
        normals[i] = nxVal / len;
        normals[i + 1] = nyVal / len;
        normals[i + 2] = nzVal / len;
      } else {
        normals[i] = 0;
        normals[i + 1] = 0;
        normals[i + 2] = 1;
      }
    }

    const meshData: MeshData = {
      positions,
      normals,
      indices,
      voxelCount: count,
    };
    results[v] = meshData;
    transferables.push(positions.buffer, normals.buffer, indices.buffer);
  }

  const output: MeshWorkerOutput = { requestId, results };
  (self as unknown as { postMessage: (msg: unknown, transfer: Transferable[]) => void }).postMessage(
    output,
    transferables
  );
};
