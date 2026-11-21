import * as THREE from "three";

// 置いた物のメッシュ表面を、小さな球で敷き詰めて表す。腕や脚が物を通り抜けないように、IK の当たり判定に使う。
// 凹んだ形や斜めの面もそのまま表せる(外形の箱では表せない)。

const CELL = 0.05; // 球を置く格子の大きさ(m)
const RADIUS = 0.6; // 球の半径(格子の大きさに対する割合)
const MAX_SPHERES = 30000; // 球の数の上限。超えるときは格子を粗くする
const HASH_CELL = 0.2; // 近くの球を探すための格子(m)

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** メッシュの表面を、格子ごとに 1 点へ落とす。戻り値は、ルート座標の球の中心(x, y, z の並び)と、半径 */
function tile(root, cell) {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const cells = new Map();
  const put = (p) => {
    const ix = Math.floor(p.x / cell);
    const iy = Math.floor(p.y / cell);
    const iz = Math.floor(p.z / cell);
    const key = `${ix},${iy},${iz}`;
    if (!cells.has(key)) {
      cells.set(key, [(ix + 0.5) * cell, (iy + 0.5) * cell, (iz + 0.5) * cell]);
    }
  };
  const toRoot = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes.position) return;
    const pos = o.geometry.attributes.position;
    const index = o.geometry.index;
    toRoot.multiplyMatrices(inv, o.matrixWorld);
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      _a.fromBufferAttribute(pos, ia).applyMatrix4(toRoot);
      _b.fromBufferAttribute(pos, ib).applyMatrix4(toRoot);
      _c.fromBufferAttribute(pos, ic).applyMatrix4(toRoot);
      const edge = Math.max(
        _a.distanceTo(_b),
        _b.distanceTo(_c),
        _c.distanceTo(_a),
      );
      const n = Math.max(1, Math.ceil(edge / (cell * 0.5)));
      for (let u = 0; u <= n; u++) {
        for (let v = 0; v <= n - u; v++) {
          const w = n - u - v;
          put(
            _hv.set(
              (_a.x * u + _b.x * v + _c.x * w) / n,
              (_a.y * u + _b.y * v + _c.y * w) / n,
              (_a.z * u + _b.z * v + _c.z * w) / n,
            ),
          );
        }
      }
    }
  });
  return cells;
}
const _hv = new THREE.Vector3();

/** メッシュの全頂点を、ルート座標で集める(いちばん低い点を、正確に求めるため) */
function collectVertices(root) {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const toRoot = new THREE.Matrix4();
  const chunks = [];
  let total = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes.position) return;
    const pos = o.geometry.attributes.position;
    toRoot.multiplyMatrices(inv, o.matrixWorld);
    const a = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _hv.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      a[i * 3] = _hv.x;
      a[i * 3 + 1] = _hv.y;
      a[i * 3 + 2] = _hv.z;
    }
    chunks.push(a);
    total += a.length;
  });
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/** 1 つの物の、球の集まり。物が動いたら、世界座標の球を取り直す */
class ObjectGrid {
  constructor(root) {
    this.root = root;
    let cell = CELL;
    let cells = tile(root, cell);
    while (cells.size > MAX_SPHERES) {
      cell *= 1.5;
      cells = tile(root, cell);
    }
    this.local = new Float32Array(cells.size * 3);
    let i = 0;
    for (const c of cells.values()) {
      this.local[i++] = c[0];
      this.local[i++] = c[1];
      this.local[i++] = c[2];
    }
    this.vertices = collectVertices(root);
    this.lowestY = 0; // 物の、いちばん低い点の高さ(ワールド座標の y)
    this.radius = cell * RADIUS;
    this.count = cells.size;
    this.world = new Float32Array(this.local.length);
    this.worldRadius = this.radius;
    this.box = new THREE.Box3();
    this.cells = new Map();
    this._matrix = null;
  }

  /** 物の位置・向き・大きさが変わっていたら、世界座標の球と、近くを探す格子を作り直す */
  update() {
    const root = this.root;
    root.updateWorldMatrix(true, false);
    const e = root.matrixWorld.elements;
    if (this._matrix && this._matrix.every((v, i) => v === e[i])) return this;
    this._matrix = e.slice();
    const m = root.matrixWorld;
    this.worldRadius = this.radius * m.getMaxScaleOnAxis();
    const w = this.world;
    const l = this.local;
    this.cells.clear();
    this.box.makeEmpty();
    for (let i = 0; i < this.count; i++) {
      const x = l[i * 3], y = l[i * 3 + 1], z = l[i * 3 + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      w[i * 3] = wx;
      w[i * 3 + 1] = wy;
      w[i * 3 + 2] = wz;
      this.box.min.x = Math.min(this.box.min.x, wx);
      this.box.min.y = Math.min(this.box.min.y, wy);
      this.box.min.z = Math.min(this.box.min.z, wz);
      this.box.max.x = Math.max(this.box.max.x, wx);
      this.box.max.y = Math.max(this.box.max.y, wy);
      this.box.max.z = Math.max(this.box.max.z, wz);
      const key = hashKey(wx, wy, wz);
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
    this.box.expandByScalar(this.worldRadius);
    let lowest = Infinity;
    const v = this.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const y = e[1] * v[i] + e[5] * v[i + 1] + e[9] * v[i + 2] + e[13];
      if (y < lowest) lowest = y;
    }
    this.lowestY = lowest;
    return this;
  }

  /**
   * 点(x, y, z)・半径 r の球にいちばん深く入り込んでいる球を探す。
   * 見つかったら { depth, dx, dy, dz }(depth は入り込み量、d は押し出す向き)を返す
   */
  deepest(x, y, z, r) {
    const range = r + this.worldRadius;
    const x0 = Math.floor((x - range) / HASH_CELL);
    const x1 = Math.floor((x + range) / HASH_CELL);
    const y0 = Math.floor((y - range) / HASH_CELL);
    const y1 = Math.floor((y + range) / HASH_CELL);
    const z0 = Math.floor((z - range) / HASH_CELL);
    const z1 = Math.floor((z + range) / HASH_CELL);
    const w = this.world;
    let best = 0;
    let bx = 0, by = 0, bz = 0;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = this.cells.get(hashCell(ix, iy, iz));
          if (!list) continue;
          for (const i of list) {
            const dx = x - w[i * 3],
              dy = y - w[i * 3 + 1],
              dz = z - w[i * 3 + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= range * range) continue;
            const dist = Math.sqrt(d2);
            const depth = range - dist;
            if (depth > best) {
              best = depth;
              const s = dist > 1e-9 ? 1 / dist : 0;
              bx = dist > 1e-9 ? dx * s : 0;
              by = dist > 1e-9 ? dy * s : 1;
              bz = dist > 1e-9 ? dz * s : 0;
            }
          }
        }
      }
    }
    return best > 0 ? { depth: best, dx: bx, dy: by, dz: bz } : null;
  }
}

function hashCell(ix, iy, iz) {
  return (ix & 0x3ff) | ((iy & 0x3ff) << 10) | ((iz & 0x3ff) << 20);
}
function hashKey(x, y, z) {
  return hashCell(
    Math.floor(x / HASH_CELL),
    Math.floor(y / HASH_CELL),
    Math.floor(z / HASH_CELL),
  );
}

/** 物ごとの球の集まりを持つ(物のルートごとに、作ったものを使い回す) */
export class ObjectSpheres {
  constructor() {
    this._grids = new WeakMap();
  }

  get(root) {
    let g = this._grids.get(root);
    if (!g) {
      g = new ObjectGrid(root);
      this._grids.set(root, g);
    }
    return g.update();
  }
}
