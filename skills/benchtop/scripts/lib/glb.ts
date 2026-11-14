// Minimal binary glTF 2.0 writer. No dependencies.
//
// Input meshes are in millimetres, Z up (the benchtop convention). Output is metres,
// Y up (glTF): (x, y, z) mm -> (x, z, -y) / 1000, a proper rotation so triangle
// winding is preserved. Normals are flat, one per triangle, so every triangle gets its
// own three vertices (smoothed normals when GlbMesh.smoothAngle is set). One material and
// one node per mesh.

export interface GlbMesh {
  name: string;
  /** xyz triples in mm, Z up. */
  positions: Float32Array;
  /** Triangle vertex indices into positions. */
  indices: Uint32Array;
  /** Linear RGB base colour (glTF baseColorFactor is linear), 0..1 per channel. */
  color: [number, number, number];
  /** glTF metallicFactor, default 0. */
  metallic?: number;
  /** glTF roughnessFactor, default 0.8. */
  roughness?: number;
  /**
   * Smooth the normals across edges shallower than this many degrees (curved walls of
   * cylinders and rounded corners); sharper edges stay crisp. Default: flat normals.
   */
  smoothAngle?: number;
  /** Copied to the node's `extras`, e.g. { ref: "oled", mount: "lid" }. */
  extras?: Record<string, string | number | boolean>;
}

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

interface BuiltMesh {
  pos: Float32Array;
  nor: Float32Array;
  idx: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
}

function build(mesh: GlbMesh): BuiltMesh {
  const tris = Math.floor(mesh.indices.length / 3);
  const smooth = mesh.smoothAngle !== undefined && mesh.smoothAngle > 0;
  const cosLimit = Math.cos(((mesh.smoothAngle ?? 0) * Math.PI) / 180);
  // Face normals as unnormalised cross products (so area-weighted), in glTF axes, and the triangles at each source vertex.
  const faceN = new Float64Array(smooth ? tris * 3 : 0);
  const atVertex = new Map<number, number[]>();
  if (smooth) {
    const P = (i: number, a: number): number => mesh.positions[i * 3 + a]!;
    for (let t = 0; t < tris; t++) {
      const i0 = mesh.indices[t * 3]!;
      const i1 = mesh.indices[t * 3 + 1]!;
      const i2 = mesh.indices[t * 3 + 2]!;
      const a = [P(i1, 0) - P(i0, 0), P(i1, 1) - P(i0, 1), P(i1, 2) - P(i0, 2)];
      const b = [P(i2, 0) - P(i0, 0), P(i2, 1) - P(i0, 1), P(i2, 2) - P(i0, 2)];
      const cx = a[1]! * b[2]! - a[2]! * b[1]!;
      const cy = a[2]! * b[0]! - a[0]! * b[2]!;
      const cz = a[0]! * b[1]! - a[1]! * b[0]!;
      // Z-up mm to Y-up: (x, y, z) -> (x, z, -y), the same rotation the positions get.
      faceN[t * 3] = cx;
      faceN[t * 3 + 1] = cz;
      faceN[t * 3 + 2] = -cy;
      for (const i of [i0, i1, i2]) {
        const list = atVertex.get(i);
        if (list) list.push(t);
        else atVertex.set(i, [t]);
      }
    }
  }
  const pos = new Float32Array(tris * 9);
  const nor = new Float32Array(tris * 9);
  const idx = new Uint32Array(tris * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const v = new Float64Array(9);
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const i = mesh.indices[t * 3 + k]!;
      const x = mesh.positions[i * 3]!;
      const y = mesh.positions[i * 3 + 1]!;
      const z = mesh.positions[i * 3 + 2]!;
      v[k * 3] = x / 1000;
      v[k * 3 + 1] = z / 1000;
      v[k * 3 + 2] = -y / 1000;
    }
    const ax = v[3]! - v[0]!;
    const ay = v[4]! - v[1]!;
    const az = v[5]! - v[2]!;
    const bx = v[6]! - v[0]!;
    const by = v[7]! - v[1]!;
    const bz = v[8]! - v[2]!;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      pos[o] = v[k * 3]!;
      pos[o + 1] = v[k * 3 + 1]!;
      pos[o + 2] = v[k * 3 + 2]!;
      let ox = nx;
      let oy = ny;
      let oz = nz;
      if (smooth && len > 0) {
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const u of atVertex.get(mesh.indices[t * 3 + k]!) ?? []) {
          const gx = faceN[u * 3]!;
          const gy = faceN[u * 3 + 1]!;
          const gz = faceN[u * 3 + 2]!;
          const gl = Math.hypot(gx, gy, gz);
          if (gl > 0 && (gx * nx + gy * ny + gz * nz) / gl >= cosLimit) {
            sx += gx;
            sy += gy;
            sz += gz;
          }
        }
        const sl = Math.hypot(sx, sy, sz);
        if (sl > 0) {
          ox = sx / sl;
          oy = sy / sl;
          oz = sz / sl;
        }
      }
      nor[o] = ox;
      nor[o + 1] = oy;
      nor[o + 2] = oz;
      idx[t * 3 + k] = t * 3 + k;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, pos[o + a]!);
        max[a] = Math.max(max[a]!, pos[o + a]!);
      }
    }
  }
  if (tris === 0) {
    min.fill(0);
    max.fill(0);
  }
  return { pos, nor, idx, min, max };
}

const pad4 = (n: number): number => (n + 3) & ~3;

export function writeGlb(meshes: GlbMesh[]): Uint8Array {
  const built = meshes.map(build);

  // JSON uses plain objects; glTF's schema is open-ended, so the document is typed loosely on purpose.
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const gltfMeshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];

  let total = 0;
  const layout = built.map((b) => {
    const posAt = total;
    total += pad4(b.pos.byteLength);
    const norAt = total;
    total += pad4(b.nor.byteLength);
    const idxAt = total;
    total += pad4(b.idx.byteLength);
    return { posAt, norAt, idxAt };
  });
  const bin = new Uint8Array(total);
  built.forEach((b, m) => {
    const l = layout[m]!;
    bin.set(new Uint8Array(b.pos.buffer, b.pos.byteOffset, b.pos.byteLength), l.posAt);
    bin.set(new Uint8Array(b.nor.buffer, b.nor.byteOffset, b.nor.byteLength), l.norAt);
    bin.set(new Uint8Array(b.idx.buffer, b.idx.byteOffset, b.idx.byteLength), l.idxAt);

    const view = (offset: number, length: number, target: number): number => {
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: length, target });
      return bufferViews.length - 1;
    };
    const posView = view(l.posAt, b.pos.byteLength, ARRAY_BUFFER);
    const norView = view(l.norAt, b.nor.byteLength, ARRAY_BUFFER);
    const idxView = view(l.idxAt, b.idx.byteLength, ELEMENT_ARRAY_BUFFER);
    const acc = (a: Record<string, unknown>): number => {
      accessors.push(a);
      return accessors.length - 1;
    };
    const posAcc = acc({ bufferView: posView, componentType: FLOAT, count: b.pos.length / 3, type: "VEC3", min: b.min, max: b.max });
    const norAcc = acc({ bufferView: norView, componentType: FLOAT, count: b.nor.length / 3, type: "VEC3" });
    const idxAcc = acc({ bufferView: idxView, componentType: UNSIGNED_INT, count: b.idx.length, type: "SCALAR" });
    const src = meshes[m]!;
    materials.push({
      name: src.name,
      pbrMetallicRoughness: { baseColorFactor: [src.color[0], src.color[1], src.color[2], 1], metallicFactor: src.metallic ?? 0, roughnessFactor: src.roughness ?? 0.8 },
    });
    gltfMeshes.push({
      name: src.name,
      primitives: [{ attributes: { POSITION: posAcc, NORMAL: norAcc }, indices: idxAcc, material: m, mode: 4 }],
    });
    nodes.push(src.extras ? { name: src.name, mesh: m, extras: src.extras } : { name: src.name, mesh: m });
  });

  const doc = {
    asset: { version: "2.0", generator: "benchtop" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: total }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(doc));
  const jsonLen = pad4(jsonBytes.length);
  const length = 12 + 8 + jsonLen + (total > 0 ? 8 + total : 0);
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, length, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.fill(0x20, 20, 20 + jsonLen); // JSON chunk pads with spaces
  out.set(jsonBytes, 20);
  if (total > 0) {
    const at = 20 + jsonLen;
    dv.setUint32(at, total, true);
    dv.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
    out.set(bin, at + 8);
  }
  return out;
}
