import * as THREE from "three";

/**
 * 体や物のメッシュの三角形を、世界座標で、格子に入れて持つ。IK で手を面に置くとき、手の頂点が実際の表面からどれだけ離れているか
 * (または食い込んでいるか)を、メッシュそのもので測るのに使う(当たり判定用の近似の形は、メッシュと数 mm ずれる)。
 *
 * 距離は、面の向き n に沿って測る: 点の真上から面の向きと逆に伸ばしたレイが、最初に当たる面までの距離を使う。
 * 閉じていないメッシュや、服が重なったメッシュでも、「いちばん外側の面」までとして決まる(内外の判定がいらない)。
 */
const _box = new THREE.Box3();
const _bonePos = new THREE.Vector3();
const _p = new THREE.Vector3();
const _skinCull = new WeakMap();

/**
 * スキンのメッシュの頂点を、いちばん強く影響を受けるボーンごとに分け、ボーンから頂点までの最大の距離を持つ(初めて使うときに 1 回だけ求める)。
 * 範囲の近くにあるボーンの頂点だけ計算すれば済むようにして、体の全頂点のスキニングを避ける。
 */
function skinCull(mesh) {
  let c = _skinCull.get(mesh);
  if (c) return c;
  const geo = mesh.geometry;
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const bones = mesh.skeleton.bones;
  const count = geo.attributes.position.count;
  const dom = new Uint16Array(count);
  const counts = new Uint32Array(bones.length);
  for (let i = 0; i < count; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    dom[i] = best;
    counts[best]++;
  }
  const byBone = Array.from(counts, (n) => new Uint32Array(n));
  const fill = new Uint32Array(bones.length);
  const boneR = new Float32Array(bones.length);
  const v = new THREE.Vector3();
  const bp = bones.map((b) =>
    new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)
  );
  for (let i = 0; i < count; i++) {
    const b = dom[i];
    byBone[b][fill[b]++] = i;
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    boneR[b] = Math.max(boneR[b], v.distanceTo(bp[b]));
  }
  c = { byBone, boneR, scale: mesh.matrixWorld.getMaxScaleOnAxis() };
  _skinCull.set(mesh, c);
  return c;
}

export class ContactIndex {
  /**
   * @param {THREE.Vector3} center 集める範囲の中心
   * @param {number} radius 集める範囲の半径(m)
   * @param {number} cell 格子の大きさ(m)
   */
  constructor(center, radius = 0.15, cell = 0.02) {
    this._center = center.clone();
    this._radius = radius;
    this._cell = cell;
    this._tris = []; // 9 つずつ: 3 頂点の座標
    this._grid = new Map();
    this._stamp = new Uint32Array(0);
    this._mark = 0;
  }

  get size() {
    return this._tris.length / 9;
  }

  /**
   * @param {THREE.Mesh[]} meshes SkinnedMesh も含む
   * @param {(mesh: THREE.Mesh, a: number, b: number, c: number) => boolean} [skip] true の三角形は入れない(動かす腕自身など)
   */
  addMeshes(meshes, skip = null) {
    const r2 = this._radius * this._radius;
    const c = this._center;
    const v = new THREE.Vector3();
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const pos = geo?.attributes?.position;
      if (!pos) continue;
      let cull = null;
      if (mesh.isSkinnedMesh) {
        mesh.skeleton.update();
        cull = skinCull(mesh);
      } else {
        // 動かない形は、箱が範囲から離れていれば、頂点を見るまでもなく除く
        if (!geo.boundingBox) geo.computeBoundingBox();
        _box.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (_box.distanceToPoint(c) > this._radius) continue;
      }
      // 頂点の世界座標。必要になった頂点だけ求める(スキンのメッシュは、全頂点を計算すると重い)
      const world = new Float32Array(pos.count * 3);
      const have = new Uint8Array(pos.count);
      const worldOf = (i) => {
        if (have[i]) return;
        have[i] = 1;
        if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, v);
        else v.fromBufferAttribute(pos, i);
        v.applyMatrix4(mesh.matrixWorld);
        world[i * 3] = v.x;
        world[i * 3 + 1] = v.y;
        world[i * 3 + 2] = v.z;
      };
      // 範囲に近い頂点(三角形の頂点のどれかが範囲に入れば、その三角形は入れる)
      const near = new Uint8Array(pos.count);
      if (cull) {
        const scale = mesh.matrixWorld.getMaxScaleOnAxis() / cull.scale;
        cull.byBone.forEach((ids, b) => {
          if (!ids.length) return;
          _bonePos.setFromMatrixPosition(mesh.skeleton.bones[b].matrixWorld);
          const reach = this._radius + cull.boneR[b] * scale * 1.25 + 0.08;
          if (_bonePos.distanceToSquared(c) > reach * reach) return;
          for (const i of ids) {
            worldOf(i);
            _p.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
            if (_p.distanceToSquared(c) <= r2) near[i] = 1;
          }
        });
      } else {
        for (let i = 0; i < pos.count; i++) {
          worldOf(i);
          _p.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
          if (_p.distanceToSquared(c) <= r2) near[i] = 1;
        }
      }
      const index = geo.index;
      const count = index ? index.count / 3 : pos.count / 3;
      for (let f = 0; f < count; f++) {
        const a = index ? index.getX(f * 3) : f * 3;
        const b = index ? index.getX(f * 3 + 1) : f * 3 + 1;
        const d = index ? index.getX(f * 3 + 2) : f * 3 + 2;
        if (!near[a] && !near[b] && !near[d]) continue;
        if (skip?.(mesh, a, b, d)) continue;
        worldOf(a);
        worldOf(b);
        worldOf(d);
        this._add(world, a, b, d);
      }
    }
    this._stamp = new Uint32Array(this._tris.length / 9);
  }

  /**
   * 点 p から真上(+y)へ伸ばしたレイが、三角形と交わる回数(閉じたメッシュの内外判定の偶奇に使う)。
   * 格子の、p の真上の柱だけを調べるので、メッシュの三角形の数に左右されにくい。
   * @param {THREE.Vector3} p
   * @param {number} topY この高さより上は調べない(物の上端)
   */
  countUp(p, topY) {
    const cell = this._cell;
    const ix = Math.floor(p.x / cell), iz = Math.floor(p.z / cell);
    const t = this._tris;
    this._mark++;
    let n = 0;
    for (let iy = Math.floor(p.y / cell); iy <= Math.floor(topY / cell); iy++) {
      const list = this._grid.get(this._key(ix, iy, iz));
      if (!list) continue;
      for (const id of list) {
        if (this._stamp[id] === this._mark) continue;
        this._stamp[id] = this._mark;
        const o = id * 9;
        if (
          rayTriangle(
            p.x,
            p.y,
            p.z,
            0,
            1,
            0,
            t[o],
            t[o + 1],
            t[o + 2],
            t[o + 3],
            t[o + 4],
            t[o + 5],
            t[o + 6],
            t[o + 7],
            t[o + 8],
          ) >= 0
        ) n++;
      }
    }
    return n;
  }

  _key(ix, iy, iz) {
    return ((ix + 4096) * 8192 + (iy + 4096)) * 8192 + (iz + 4096);
  }

  _add(w, a, b, c) {
    const t = this._tris;
    const id = t.length / 9;
    t.push(
      w[a * 3],
      w[a * 3 + 1],
      w[a * 3 + 2],
      w[b * 3],
      w[b * 3 + 1],
      w[b * 3 + 2],
      w[c * 3],
      w[c * 3 + 1],
      w[c * 3 + 2],
    );
    const cell = this._cell;
    const o = id * 9;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      for (let j = 0; j < 3; j++) {
        lo[j] = Math.min(lo[j], t[o + k * 3 + j]);
        hi[j] = Math.max(hi[j], t[o + k * 3 + j]);
      }
    }
    for (
      let ix = Math.floor(lo[0] / cell);
      ix <= Math.floor(hi[0] / cell);
      ix++
    ) {
      for (
        let iy = Math.floor(lo[1] / cell);
        iy <= Math.floor(hi[1] / cell);
        iy++
      ) {
        for (
          let iz = Math.floor(lo[2] / cell);
          iz <= Math.floor(hi[2] / cell);
          iz++
        ) {
          const key = this._key(ix, iy, iz);
          let list = this._grid.get(key);
          if (!list) this._grid.set(key, list = []);
          list.push(id);
        }
      }
    }
  }

  /**
   * 点 p から、面の向き n に沿った、表面までの距離(符号つき)。正なら表面の手前(外側)で離れている、負なら表面より下へ食い込んでいる。
   * p の真上(n 側)range の高さから、-n へレイを伸ばして、最初に当たる面を使う。range 以内に面が無ければ Infinity
   * @param {THREE.Vector3} p
   * @param {THREE.Vector3} n 面の向き(外向き、単位ベクトル)
   * @param {number} range 調べる範囲(m)
   */
  gapAlong(p, n, range = 0.03) {
    const ox = p.x + n.x * range,
      oy = p.y + n.y * range,
      oz = p.z + n.z * range;
    const dx = -n.x, dy = -n.y, dz = -n.z;
    const cell = this._cell;
    const t = this._tris;
    let best = Infinity;
    this._mark++;
    // レイが通る格子(と、その隣)にある三角形だけを調べる
    const steps = Math.ceil((range * 2) / (cell * 0.5));
    for (let s = 0; s <= steps; s++) {
      const u = (s / steps) * range * 2;
      const cx = Math.floor((ox + dx * u) / cell);
      const cy = Math.floor((oy + dy * u) / cell);
      const cz = Math.floor((oz + dz * u) / cell);
      const list = this._grid.get(this._key(cx, cy, cz));
      if (!list) continue;
      for (const id of list) {
        if (this._stamp[id] === this._mark) continue;
        this._stamp[id] = this._mark;
        const o = id * 9;
        const hit = rayTriangle(
          ox,
          oy,
          oz,
          dx,
          dy,
          dz,
          t[o],
          t[o + 1],
          t[o + 2],
          t[o + 3],
          t[o + 4],
          t[o + 5],
          t[o + 6],
          t[o + 7],
          t[o + 8],
        );
        if (hit >= 0 && hit < best) best = hit;
      }
    }
    return Number.isFinite(best) ? best - range : Infinity;
  }
}

/** レイと三角形の交点までの距離(両面)。当たらなければ -1 */
function rayTriangle(
  ox,
  oy,
  oz,
  dx,
  dy,
  dz,
  ax,
  ay,
  az,
  bx,
  by,
  bz,
  cx,
  cy,
  cz,
) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}
