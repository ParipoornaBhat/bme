/**
 * WebGL 3D rendering pipeline and matrix math helpers for anatomical annotation view.
 * No external libraries.
 */

export type Vec3 = [number, number, number];
export type AxisEnds = { atZero: string; atMax: string };

export type GLMesh = {
  posBuffer: WebGLBuffer;
  normBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
};

export type LineMesh = {
  posBuffer: WebGLBuffer;
  vertexCount: number;
};

export type GLState = {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  isWebGL2: boolean;
  meshProgram: WebGLProgram;
  lineProgram: WebGLProgram;
  meshUniforms: {
    u_model: WebGLUniformLocation | null;
    u_view: WebGLUniformLocation | null;
    u_projection: WebGLUniformLocation | null;
    u_normalMatrix: WebGLUniformLocation | null;
    u_color: WebGLUniformLocation | null;
    u_alpha: WebGLUniformLocation | null;
  };
  meshAttribs: {
    a_position: number;
    a_normal: number;
  };
  lineUniforms: {
    u_viewProj: WebGLUniformLocation | null;
    u_color: WebGLUniformLocation | null;
  };
  lineAttribs: {
    a_position: number;
  };
  boxMesh: LineMesh | null;
};

// ============================================================================
// Matrix 4x4 Math (Column-Major)
// ============================================================================

export function mat4Create(): Float32Array {
  const out = new Float32Array(16);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function mat4Identity(out: Float32Array): Float32Array {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  return out;
}

export function mat4Perspective(
  out: Float32Array,
  fovyRad: number,
  aspect: number,
  near: number,
  far: number
): Float32Array {
  const f = 1.0 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function mat4LookAt(out: Float32Array, eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  const [eyex, eyey, eyez] = eye;
  const [targetx, targety, targetz] = target;
  const [upx, upy, upz] = up;

  let z0 = eyex - targetx;
  let z1 = eyey - targety;
  let z2 = eyez - targetz;
  let len = Math.hypot(z0, z1, z2);
  if (len === 0) {
    z0 = 0; z1 = 1; z2 = 0;
  } else {
    z0 /= len; z1 /= len; z2 /= len;
  }

  let x0 = upy * z2 - upz * z1;
  let x1 = upz * z0 - upx * z2;
  let x2 = upx * z1 - upy * z0;
  len = Math.hypot(x0, x1, x2);
  if (len === 0) {
    x0 = 1; x1 = 0; x2 = 0;
  } else {
    x0 /= len; x1 /= len; x2 /= len;
  }

  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;

  out[0] = x0;
  out[1] = y0;
  out[2] = z0;
  out[3] = 0;
  out[4] = x1;
  out[5] = y1;
  out[6] = z1;
  out[7] = 0;
  out[8] = x2;
  out[9] = y2;
  out[10] = z2;
  out[11] = 0;
  out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
  out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
  out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
  out[15] = 1;

  return out;
}

export function mat3FromMat4(out: Float32Array, a: Float32Array): Float32Array {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = a[4];
  out[4] = a[5];
  out[5] = a[6];
  out[6] = a[8];
  out[7] = a[9];
  out[8] = a[10];
  return out;
}

export function mat3InvertAndTranspose(out: Float32Array, a: Float32Array): Float32Array {
  const a00 = a[0], a01 = a[1], a02 = a[2];
  const a10 = a[3], a11 = a[4], a12 = a[5];
  const a20 = a[6], a21 = a[7], a22 = a[8];

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) {
    out.fill(0);
    out[0] = 1; out[4] = 1; out[8] = 1;
    return out;
  }
  det = 1.0 / det;

  out[0] = b01 * det;
  out[1] = (-a22 * a01 + a02 * a21) * det;
  out[2] = (a12 * a01 - a02 * a11) * det;
  out[3] = b11 * det;
  out[4] = (a22 * a00 - a02 * a20) * det;
  out[5] = (-a12 * a00 + a02 * a10) * det;
  out[6] = b21 * det;
  out[7] = (-a21 * a00 + a01 * a20) * det;
  out[8] = (a11 * a00 - a01 * a10) * det;

  return out;
}

export function projectPoint(
  p: Vec3,
  viewProj: Float32Array,
  width: number,
  height: number
): { x: number; y: number; z: number; visible: boolean } {
  const x = p[0], y = p[1], z = p[2];
  const clipX = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
  const clipY = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
  const clipZ = viewProj[2] * x + viewProj[6] * y + viewProj[10] * z + viewProj[14];
  const clipW = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];

  if (clipW <= 0.001) {
    return { x: 0, y: 0, z: clipZ, visible: false };
  }

  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;

  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1.0 - (ndcY * 0.5 + 0.5)) * height,
    z: clipZ / clipW,
    visible: true,
  };
}

// ============================================================================
// Anatomical Orientation Matrix
// World space is RAS+: +x toward Right, +y toward Anterior, +z toward Superior.
// ============================================================================

export function buildOrientMatrix(
  orient: [AxisEnds, AxisEnds, AxisEnds],
  dims: [number, number, number],
  spacing: [number, number, number]
): {
  modelMatrix: Float32Array;
  extents: [number, number, number];
} {
  const mat = mat4Create();
  mat.fill(0);
  mat[15] = 1;

  const mmDimensions: [number, number, number] = [
    dims[0] * spacing[0],
    dims[1] * spacing[1],
    dims[2] * spacing[2],
  ];

  const extents: [number, number, number] = [0, 0, 0];

  for (let a = 0; a < 3; a++) {
    const atMax = orient[a].atMax.toUpperCase();
    let targetRow = 0;
    let sign = 1;

    if (atMax === "R" || atMax === "L") {
      targetRow = 0; // World X
      sign = atMax === "R" ? 1 : -1;
    } else if (atMax === "A" || atMax === "P") {
      targetRow = 1; // World Y
      sign = atMax === "A" ? 1 : -1;
    } else {
      targetRow = 2; // World Z
      sign = atMax === "S" ? 1 : -1;
    }

    const lengthMm = mmDimensions[a];
    extents[targetRow] = lengthMm;

    // In column-major layout:
    // element at row targetRow, column a is out[a * 4 + targetRow]
    mat[a * 4 + targetRow] = sign;

    // Model translation to center the volume at world (0, 0, 0)
    // translation column is 3: out[12 + targetRow]
    mat[12 + targetRow] = -sign * (lengthMm / 2);
  }

  return { modelMatrix: mat, extents };
}

// ============================================================================
// WebGL Shader Compilation & Setup
// ============================================================================

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  source: string,
  type: number
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vsSource: string,
  fsSource: string
): WebGLProgram | null {
  const vs = compileShader(gl, vsSource, gl.VERTEX_SHADER);
  const fs = compileShader(gl, fsSource, gl.FRAGMENT_SHADER);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

const VS_MESH_WEBGL2 = `#version 300 es
in vec3 a_position;
in vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat3 u_normalMatrix;
out vec3 v_normal;
out vec3 v_viewPos;

void main() {
  vec4 worldPos = u_model * vec4(a_position, 1.0);
  vec4 viewPos = u_view * worldPos;
  v_viewPos = viewPos.xyz;
  v_normal = normalize(u_normalMatrix * a_normal);
  gl_Position = u_projection * viewPos;
}
`;

const FS_MESH_WEBGL2 = `#version 300 es
precision mediump float;
in vec3 v_normal;
in vec3 v_viewPos;
uniform vec3 u_color;
uniform float u_alpha;
out vec4 fragColor;

void main() {
  vec3 N = normalize(v_normal);
  // Key light in view space (following camera)
  vec3 L = normalize(vec3(0.28, 0.35, 0.89));
  vec3 V = normalize(-v_viewPos);
  vec3 H = normalize(L + V);
  
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 30.0) * 0.28;
  float ambient = 0.32;
  
  vec3 rgb = u_color * (ambient + diff * 0.68) + vec3(spec);
  fragColor = vec4(rgb, u_alpha);
}
`;

const VS_LINE_WEBGL2 = `#version 300 es
in vec3 a_position;
uniform mat4 u_viewProj;

void main() {
  gl_Position = u_viewProj * vec4(a_position, 1.0);
}
`;

const FS_LINE_WEBGL2 = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;

void main() {
  fragColor = u_color;
}
`;

const VS_MESH_WEBGL1 = `
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat3 u_normalMatrix;
varying vec3 v_normal;
varying vec3 v_viewPos;

void main() {
  vec4 worldPos = u_model * vec4(a_position, 1.0);
  vec4 viewPos = u_view * worldPos;
  v_viewPos = viewPos.xyz;
  v_normal = normalize(u_normalMatrix * a_normal);
  gl_Position = u_projection * viewPos;
}
`;

const FS_MESH_WEBGL1 = `
precision mediump float;
varying vec3 v_normal;
varying vec3 v_viewPos;
uniform vec3 u_color;
uniform float u_alpha;

void main() {
  vec3 N = normalize(v_normal);
  vec3 L = normalize(vec3(0.28, 0.35, 0.89));
  vec3 V = normalize(-v_viewPos);
  vec3 H = normalize(L + V);
  
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 30.0) * 0.28;
  float ambient = 0.32;
  
  vec3 rgb = u_color * (ambient + diff * 0.68) + vec3(spec);
  gl_FragColor = vec4(rgb, u_alpha);
}
`;

const VS_LINE_WEBGL1 = `
attribute vec3 a_position;
uniform mat4 u_viewProj;

void main() {
  gl_Position = u_viewProj * vec4(a_position, 1.0);
}
`;

const FS_LINE_WEBGL1 = `
precision mediump float;
uniform vec4 u_color;

void main() {
  gl_FragColor = u_color;
}
`;

export function initGL(canvas: HTMLCanvasElement): GLState | null {
  let isWebGL2 = true;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    depth: true,
  });

  if (!gl) {
    isWebGL2 = false;
    gl = (canvas.getContext("webgl", {
      antialias: true,
      alpha: false,
      depth: true,
    }) || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;

    if (!gl) return null;

    const uintExt = gl.getExtension("OES_element_index_uint");
    if (!uintExt) {
      // Uint32 index buffer support is required for large surfaces
    }
  }

  const meshProgram = createProgram(
    gl,
    isWebGL2 ? VS_MESH_WEBGL2 : VS_MESH_WEBGL1,
    isWebGL2 ? FS_MESH_WEBGL2 : FS_MESH_WEBGL1
  );

  const lineProgram = createProgram(
    gl,
    isWebGL2 ? VS_LINE_WEBGL2 : VS_LINE_WEBGL1,
    isWebGL2 ? FS_LINE_WEBGL2 : FS_LINE_WEBGL1
  );

  if (!meshProgram || !lineProgram) return null;

  return {
    gl,
    isWebGL2,
    meshProgram,
    lineProgram,
    meshUniforms: {
      u_model: gl.getUniformLocation(meshProgram, "u_model"),
      u_view: gl.getUniformLocation(meshProgram, "u_view"),
      u_projection: gl.getUniformLocation(meshProgram, "u_projection"),
      u_normalMatrix: gl.getUniformLocation(meshProgram, "u_normalMatrix"),
      u_color: gl.getUniformLocation(meshProgram, "u_color"),
      u_alpha: gl.getUniformLocation(meshProgram, "u_alpha"),
    },
    meshAttribs: {
      a_position: gl.getAttribLocation(meshProgram, "a_position"),
      a_normal: gl.getAttribLocation(meshProgram, "a_normal"),
    },
    lineUniforms: {
      u_viewProj: gl.getUniformLocation(lineProgram, "u_viewProj"),
      u_color: gl.getUniformLocation(lineProgram, "u_color"),
    },
    lineAttribs: {
      a_position: gl.getAttribLocation(lineProgram, "a_position"),
    },
    boxMesh: null,
  };
}

export function createGLMesh(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array
): GLMesh | null {
  const posBuffer = gl.createBuffer();
  const normBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  if (!posBuffer || !normBuffer || !indexBuffer) return null;

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  gl.bindBuffer(gl.ARRAY_BUFFER, normBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  return {
    posBuffer,
    normBuffer,
    indexBuffer,
    indexCount: indices.length,
  };
}

export function destroyGLMesh(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  mesh: GLMesh
): void {
  gl.deleteBuffer(mesh.posBuffer);
  gl.deleteBuffer(mesh.normBuffer);
  gl.deleteBuffer(mesh.indexBuffer);
}

export function createBoxMesh(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  extents: [number, number, number]
): LineMesh | null {
  const hx = extents[0] / 2;
  const hy = extents[1] / 2;
  const hz = extents[2] / 2;

  // 12 edges (24 vertices) in world space
  const lines = new Float32Array([
    // Bottom square (-Z)
    -hx, -hy, -hz,  hx, -hy, -hz,
     hx, -hy, -hz,  hx,  hy, -hz,
     hx,  hy, -hz, -hx,  hy, -hz,
    -hx,  hy, -hz, -hx, -hy, -hz,
    // Top square (+Z)
    -hx, -hy,  hz,  hx, -hy,  hz,
     hx, -hy,  hz,  hx,  hy,  hz,
     hx,  hy,  hz, -hx,  hy,  hz,
    -hx,  hy,  hz, -hx, -hy,  hz,
    // Verticals
    -hx, -hy, -hz, -hx, -hy,  hz,
     hx, -hy, -hz,  hx, -hy,  hz,
     hx,  hy, -hz,  hx,  hy,  hz,
    -hx,  hy, -hz, -hx,  hy,  hz,
  ]);

  const posBuffer = gl.createBuffer();
  if (!posBuffer) return null;

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    posBuffer,
    vertexCount: 24,
  };
}

export function destroyLineMesh(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  mesh: LineMesh
): void {
  gl.deleteBuffer(mesh.posBuffer);
}

export function parseHexColor(hex: string): [number, number, number] {
  let clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length === 3) {
    clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  const num = parseInt(clean, 16);
  if (isNaN(num)) return [1, 1, 1];
  return [
    ((num >> 16) & 255) / 255,
    ((num >> 8) & 255) / 255,
    (num & 255) / 255,
  ];
}

export type OrientationLetter = {
  letter: string;
  x: number;
  y: number;
  visible: boolean;
};

export function getOrientationLetters(
  viewProj: Float32Array,
  extents: [number, number, number],
  width: number,
  height: number
): OrientationLetter[] {
  const hx = extents[0] / 2;
  const hy = extents[1] / 2;
  const hz = extents[2] / 2;

  // Six face centres in world RAS+ space:
  // +x: Right (R), -x: Left (L)
  // +y: Anterior (A), -y: Posterior (P)
  // +z: Superior (S), -z: Inferior (I)
  const faces: Array<{ letter: string; pos: Vec3 }> = [
    { letter: "R", pos: [hx, 0, 0] },
    { letter: "L", pos: [-hx, 0, 0] },
    { letter: "A", pos: [0, hy, 0] },
    { letter: "P", pos: [0, -hy, 0] },
    { letter: "S", pos: [0, 0, hz] },
    { letter: "I", pos: [0, 0, -hz] },
  ];

  return faces.map(({ letter, pos }) => {
    const proj = projectPoint(pos, viewProj, width, height);
    return {
      letter,
      x: proj.x,
      y: proj.y,
      visible: proj.visible,
    };
  });
}
