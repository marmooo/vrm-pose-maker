/**
 * 服・肌の「実際の表面」に沿った SpringBone の当たり判定。
 *
 * カプセルは、断面の太さが部位ごとに 1 つしか持てない(胸は楕円、肩は肩幅、上腕は先細り…)ので、
 * 髪が体から浮かないように半径を決めるのが難しい。ここでは、初期姿勢(Tポーズ)のメッシュの三角形を
 * ボーンの座標系に写して持ち、髪の先端からいちばん近い三角形までの「符号付き距離」で当たり判定をする。
 * 揺れ物の判定は、先端の点なら「表面から hitRadius(+余白)」、毛束の縁の頂点(StrandCollisionShape)なら「表面から余白」の位置にとどまる。
 *
 * - 肌と服は別のメッシュ(層)として扱い、いちばん深くめり込んでいる層の分だけ押し出す(層の和集合)。
 *   肌だけで測ると、服の厚みの分だけ髪が服の中に入ってしまう。
 * - 内外の判定は、頂点の法線ではなく、同じ位置の頂点をまとめて角度で重み付けした疑似法線で行う
 *   (UV の継ぎ目で頂点が分かれていても、符号が破綻しない)。
 * - 三角形は、いちばん強く影響するボーンに固定する(ボーンの動きに剛体で追従する)。
 *
 * three-vrm の SpringBone は `collider.shape.calculateCollision(colliderMatrix, 位置, 半径, 出力先)` を
 * 呼ぶだけなので、同じ形のメソッドを持つオブジェクトをそのまま差し込める。
 */
import * as THREE from "three";

const CELL_WORLD = 0.04; // グリッドの 1 セルの大きさ(ワールド座標の m)
// 髪が表面から離れているべき距離(hitRadius + 余白)に足す、探索の余裕(m)。表面のすぐ内側までの点は、この範囲で見つかる。
const NEAR_REACH = 0.01;
// 押し出す向きを、最近点の面と混ぜる距離の幅(m)。最近点より、これ以内に遠い面まで混ぜる。
const DIRECTION_BLEND = 0.004;
const MAX_FINE_CELLS = 6e6; // 内部判定のセルの数の上限(これを超える層は内部を調べない)
const MAX_TRIANGLE_FINE_CELLS = 20000; // 1 三角形の外接箱のセルの数の上限
const MIN_TRIANGLES = 6; // これより三角形が少ない層は、断片とみなして使わない

function hashCell(ix, iy, iz) {
  return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^
    Math.imul(iz, 83492791)) | 0;
}

/** 1 つのメッシュのうち、1 つのボーンに付いた三角形の集まり(ボーン座標)。 */
export class SurfaceLayer {
  /**
   * @param {Float32Array} positions 三角形ごとに 9 個(a, b, c の xyz)
   * @param {Float32Array} normals 同じ並びの、頂点の疑似法線(長さ 1)
   * @param {number} cellSize グリッドのセルの大きさ(ボーン座標)
   */
  constructor(positions, normals, cellSize) {
    this.positions = positions;
    this.normals = normals;
    this.count = positions.length / 9;
    this.cellSize = cellSize;
    this.grid = new Map();
    this.seen = new Uint32Array(this.count);
    this._stamp = 0;
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];

    const inv = 1 / cellSize;
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const x = positions[o + k * 3];
        const y = positions[o + k * 3 + 1];
        const z = positions[o + k * 3 + 2];
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        z1 = Math.max(z1, z);
      }
      this.min[0] = Math.min(this.min[0], x0);
      this.min[1] = Math.min(this.min[1], y0);
      this.min[2] = Math.min(this.min[2], z0);
      this.max[0] = Math.max(this.max[0], x1);
      this.max[1] = Math.max(this.max[1], y1);
      this.max[2] = Math.max(this.max[2], z1);
      // 三角形の外接箱が重なるセルすべてに登録する
      for (let ix = Math.floor(x0 * inv); ix <= Math.floor(x1 * inv); ix++) {
        for (let iy = Math.floor(y0 * inv); iy <= Math.floor(y1 * inv); iy++) {
          for (
            let iz = Math.floor(z0 * inv);
            iz <= Math.floor(z1 * inv);
            iz++
          ) {
            const key = hashCell(ix, iy, iz);
            const list = this.grid.get(key);
            if (list) list.push(t);
            else this.grid.set(key, [t]);
          }
        }
      }
    }

    this._buildInterior();

    // closest() の結果
    this.signedDistance = 0;
    this.dirX = 0;
    this.dirY = 0;
    this.dirZ = 1;
  }

  /**
   * 内部の判定用に、細かいセル(三角形の探索用の 1/4)の箱を作り、三角形のあるセルを壁として、箱の外側から塗りつぶす。
   * 塗れずに残ったセルが、層の内部。穴の開いたメッシュ(袖口や首元)では外側が内部へ漏れて、内部が見つからなくなるだけ
   * (深いめり込みを押し出せなくなるが、表面近くは普通に動く)。
   */
  _buildInterior() {
    const fine = this.cellSize / 4;
    this.fine = fine;
    const inv = 1 / fine;
    this.cx0 = Math.floor(this.min[0] * inv) - 1;
    this.cy0 = Math.floor(this.min[1] * inv) - 1;
    this.cz0 = Math.floor(this.min[2] * inv) - 1;
    this.nx = Math.floor(this.max[0] * inv) + 2 - this.cx0 + 1;
    this.ny = Math.floor(this.max[1] * inv) + 2 - this.cy0 + 1;
    this.nz = Math.floor(this.max[2] * inv) + 2 - this.cz0 + 1;
    const { nx, ny, nz } = this;
    this.extent = Math.max(
      this.max[0] - this.min[0],
      this.max[1] - this.min[1],
      this.max[2] - this.min[2],
    ) + this.cellSize * 2;
    if (nx * ny * nz > MAX_FINE_CELLS) {
      this.state = null; // 大きすぎる層は、内部を調べない(深いめり込みを押し出せないだけ)
      return;
    }
    const state = new Uint8Array(nx * ny * nz); // 0: 未訪問(内部の候補) 1: 表面 2: 外側
    const P = this.positions;
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        for (let a = 0; a < 3; a++) {
          const c = P[o + k * 3 + a];
          if (c < lo[a]) lo[a] = c;
          if (c > hi[a]) hi[a] = c;
        }
      }
      const x0 = Math.floor(lo[0] * inv) - this.cx0,
        x1 = Math.floor(hi[0] * inv) - this.cx0;
      const y0 = Math.floor(lo[1] * inv) - this.cy0,
        y1 = Math.floor(hi[1] * inv) - this.cy0;
      const z0 = Math.floor(lo[2] * inv) - this.cz0,
        z1 = Math.floor(hi[2] * inv) - this.cz0;
      if (
        (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_TRIANGLE_FINE_CELLS
      ) {
        continue; // 巨大な三角形は壁にしない(漏れるだけで安全側)
      }
      // 外接箱のうち、三角形に実際に近い(セルの中心が、セルの対角線の半分以内にある)セルだけを壁にする。
      // 外接箱をそのまま壁にすると、大きな三角形のまわりの壁が厚くなり、内部の判定が遅れる。
      const wall2 = (fine * 0.87) * (fine * 0.87);
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const r = closestOnTriangle(
              (x + this.cx0 + 0.5) * fine,
              (y + this.cy0 + 0.5) * fine,
              (z + this.cz0 + 0.5) * fine,
              P[o],
              P[o + 1],
              P[o + 2],
              P[o + 3],
              P[o + 4],
              P[o + 5],
              P[o + 6],
              P[o + 7],
              P[o + 8],
            );
            if (r.d2 <= wall2) state[(z * ny + y) * nx + x] = 1;
          }
        }
      }
    }
    const stack = [0];
    state[0] = 2;
    while (stack.length) {
      const i = stack.pop();
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      const visit = (j) => {
        if (state[j] === 0) {
          state[j] = 2;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < nx - 1) visit(i + 1);
      if (y > 0) visit(i - nx);
      if (y < ny - 1) visit(i + nx);
      if (z > 0) visit(i - nx * ny);
      if (z < nz - 1) visit(i + nx * ny);
    }
    this.state = state;
  }

  /** 点が、この層の(塗りつぶしで見つかった)内部のセルにあるか。表面のセルは含まない(そちらは表面の探索で見つかる)。 */
  isInterior(px, py, pz) {
    if (!this.state) return false;
    const inv = 1 / this.fine;
    const x = Math.floor(px * inv) - this.cx0;
    const y = Math.floor(py * inv) - this.cy0;
    const z = Math.floor(pz * inv) - this.cz0;
    if (
      x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz
    ) {
      return false;
    }
    return this.state[(z * this.ny + y) * this.nx + x] === 0;
  }

  /**
   * 押し出す向きを、最近点の面だけでなく、ほぼ同じ距離にある面の向きと混ぜて滑らかにする(closest の直後に呼ぶ)。
   * 谷(肩と襟の間など)の中間では、最も近い面が左右の面で入れ替わり、最近点の面だけの向きだと、そこで向きが急に変わる。
   * すると、毛束が谷へ滑り込むたびに、別の向きへ蹴り戻されて震える。距離が dmin に近い面ほど重く混ぜると、向きが連続的に変わる。
   * 結果は dirX/Y/Z(長さ 1)に入れる。
   * @param {number} dmin closest が返した距離(正の値)
   * @param {boolean} outside closest が返した符号(外側か)
   * @param {number} band 混ぜる距離の幅(ボーン座標)
   */
  blendDirection(px, py, pz, dmin, outside, band) {
    const reach = dmin + band;
    const inv = 1 / this.cellSize;
    const x0 = Math.floor((px - reach) * inv),
      x1 = Math.floor((px + reach) * inv);
    const y0 = Math.floor((py - reach) * inv),
      y1 = Math.floor((py + reach) * inv);
    const z0 = Math.floor((pz - reach) * inv),
      z1 = Math.floor((pz + reach) * inv);
    const stamp = ++this._stamp;
    const P = this.positions;
    const N = this.normals;
    const sigma = Math.max(band * 0.5, 1e-9);
    let sx = 0, sy = 0, sz = 0;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = this.grid.get(hashCell(ix, iy, iz));
          if (!list) continue;
          for (let n = 0; n < list.length; n++) {
            const t = list[n];
            if (this.seen[t] === stamp) continue;
            this.seen[t] = stamp;
            const o = t * 9;
            const r = closestOnTriangle(
              px,
              py,
              pz,
              P[o],
              P[o + 1],
              P[o + 2],
              P[o + 3],
              P[o + 4],
              P[o + 5],
              P[o + 6],
              P[o + 7],
              P[o + 8],
            );
            const d = Math.sqrt(r.d2);
            if (d > reach) continue;
            const cx = P[o] * r.u + P[o + 3] * r.v + P[o + 6] * r.w;
            const cy = P[o + 1] * r.u + P[o + 4] * r.v + P[o + 7] * r.w;
            const cz = P[o + 2] * r.u + P[o + 5] * r.v + P[o + 8] * r.w;
            let nx = N[o] * r.u + N[o + 3] * r.v + N[o + 6] * r.w;
            let ny = N[o + 1] * r.u + N[o + 4] * r.v + N[o + 7] * r.w;
            let nz = N[o + 2] * r.u + N[o + 5] * r.v + N[o + 8] * r.w;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl;
            ny /= nl;
            nz /= nl;
            const dx = px - cx, dy = py - cy, dz = pz - cz;
            const isOutside = dx * nx + dy * ny + dz * nz >= 0;
            if (isOutside !== outside) continue; // 薄い布の反対側の面などは混ぜない
            let ux, uy, uz;
            if (outside && d > 1e-6) {
              ux = dx / d;
              uy = dy / d;
              uz = dz / d;
            } else {
              ux = nx;
              uy = ny;
              uz = nz;
            }
            const weight = Math.exp(-(d - dmin) / sigma);
            sx += ux * weight;
            sy += uy * weight;
            sz += uz * weight;
          }
        }
      }
    }
    const length = Math.hypot(sx, sy, sz);
    if (length > 1e-9) {
      this.dirX = sx / length;
      this.dirY = sy / length;
      this.dirZ = sz / length;
    }
  }

  /**
   * 点 (px, py, pz) から reach 以内にある、いちばん近い表面を探す。見つかれば true を返し、
   * signedDistance(外側が正)と、押し出す向き(dirX/Y/Z。長さ 1)に結果を入れる。
   */
  closest(px, py, pz, reach) {
    if (
      px < this.min[0] - reach || px > this.max[0] + reach ||
      py < this.min[1] - reach || py > this.max[1] + reach ||
      pz < this.min[2] - reach || pz > this.max[2] + reach
    ) return false;

    const inv = 1 / this.cellSize;
    const x0 = Math.floor((px - reach) * inv);
    const x1 = Math.floor((px + reach) * inv);
    const y0 = Math.floor((py - reach) * inv);
    const y1 = Math.floor((py + reach) * inv);
    const z0 = Math.floor((pz - reach) * inv);
    const z1 = Math.floor((pz + reach) * inv);
    const stamp = ++this._stamp;
    const P = this.positions;
    let best = reach * reach;
    let found = -1;
    let bu = 0, bv = 0, bw = 0;

    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = this.grid.get(hashCell(ix, iy, iz));
          if (!list) continue;
          for (let n = 0; n < list.length; n++) {
            const t = list[n];
            if (this.seen[t] === stamp) continue;
            this.seen[t] = stamp;
            const o = t * 9;
            const r = closestOnTriangle(
              px,
              py,
              pz,
              P[o],
              P[o + 1],
              P[o + 2],
              P[o + 3],
              P[o + 4],
              P[o + 5],
              P[o + 6],
              P[o + 7],
              P[o + 8],
            );
            if (r.d2 < best) {
              best = r.d2;
              found = t;
              bu = r.u;
              bv = r.v;
              bw = r.w;
            }
          }
        }
      }
    }
    if (found < 0) return false;

    const o = found * 9;
    const N = this.normals;
    const cx = P[o] * bu + P[o + 3] * bv + P[o + 6] * bw;
    const cy = P[o + 1] * bu + P[o + 4] * bv + P[o + 7] * bw;
    const cz = P[o + 2] * bu + P[o + 5] * bv + P[o + 8] * bw;
    let nx = N[o] * bu + N[o + 3] * bv + N[o + 6] * bw;
    let ny = N[o + 1] * bu + N[o + 4] * bv + N[o + 7] * bw;
    let nz = N[o + 2] * bu + N[o + 5] * bv + N[o + 8] * bw;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;

    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const d = Math.sqrt(best);
    const outside = dx * nx + dy * ny + dz * nz >= 0;
    this.signedDistance = outside ? d : -d;
    if (outside && d > 1e-6) {
      // 表面の外側では、最近点から離れる向き(辺や角の近くでも滑らかに丸くなる)
      this.dirX = dx / d;
      this.dirY = dy / d;
      this.dirZ = dz / d;
    } else {
      this.dirX = nx;
      this.dirY = ny;
      this.dirZ = nz;
    }
    return true;
  }
}

// closestOnTriangle の戻り値(毎回作らず使い回す)
const _hit = { d2: 0, u: 0, v: 0, w: 0 };

/** 点 p から三角形 abc への最近点(Ericson, Real-Time Collision Detection)。重心座標 u, v, w と距離の二乗を返す。 */
function closestOnTriangle(
  px,
  py,
  pz,
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
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w;
  if (d1 <= 0 && d2 <= 0) {
    u = 1;
    v = 0;
    w = 0;
  } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      u = 0;
      v = 1;
      w = 0;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        v = d1 / (d1 - d3);
        u = 1 - v;
        w = 0;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          u = 0;
          v = 0;
          w = 1;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            w = d2 / (d2 - d6);
            u = 1 - w;
            v = 0;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              u = 0;
              v = 1 - w;
            } else {
              const denom = 1 / (va + vb + vc);
              v = vb * denom;
              w = vc * denom;
              u = 1 - v - w;
            }
          }
        }
      }
    }
  }
  const qx = ax * u + bx * v + cx * w - px;
  const qy = ay * u + by * v + cy * w - py;
  const qz = az * u + bz * v + cz * w - pz;
  _hit.d2 = qx * qx + qy * qy + qz * qz;
  _hit.u = u;
  _hit.v = v;
  _hit.w = w;
  return _hit;
}

/**
 * ボーンに付ける SpringBone 用の当たり判定の形(VRMSpringBoneCollider の shape に渡す)。
 * 複数の層(肌・服…)の和集合の外へ、髪の先端を押し出す。
 */
export class SurfaceColliderShape {
  /** @param {SurfaceLayer[]} layers */
  constructor(layers) {
    this.layers = layers;
    /** 髪の hitRadius に足す余白(ワールド座標の m)。正なら表面から浮かせ、負ならめり込みを許す。 */
    this.margin = 0;
  }

  get type() {
    return "surface";
  }

  /** three-vrm の他の形(sphere / capsule)と同じ引数と戻り値。戻り値が負なら衝突していて、target(長さ 1)の向きへ -戻り値 だけ押し出す。 */
  calculateCollision(colliderMatrix, objectPosition, objectRadius, target) {
    const e = colliderMatrix.elements;
    const sx2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    const sy2 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
    const sz2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    // ワールド座標の点を、ボーン座標へ(回転 + 軸ごとの拡大縮小の逆変換)
    const wx = objectPosition.x - e[12];
    const wy = objectPosition.y - e[13];
    const wz = objectPosition.z - e[14];
    const lx = (wx * e[0] + wy * e[1] + wz * e[2]) / sx2;
    const ly = (wx * e[4] + wy * e[5] + wz * e[6]) / sy2;
    const lz = (wx * e[8] + wy * e[9] + wz * e[10]) / sz2;
    // 長さはほぼ一様な拡大縮小として、ボーン座標 → ワールド座標の倍率を出す
    const scale = (Math.sqrt(sx2) + Math.sqrt(sy2) + Math.sqrt(sz2)) / 3;
    const clearance = (objectRadius + this.margin) / scale; // 負なら、その深さまでのめり込みを許す
    // 通常は、髪が離れているべき距離(+少し)の範囲だけを探す。範囲内に表面が無いのに点が層の内部にあるときだけ、
    // 深くめり込んでいるので、層全体まで広げて探す(めり込みは稀なので、平均の計算量は小さい)。
    const reach = Math.max(0, clearance) + NEAR_REACH / scale;

    let worst = 0; // いちばん深くめり込んだ層の、押し出す量(ボーン座標)
    let dx = 0, dy = 0, dz = 0;
    let worstLayer = null;
    let worstDistance = 0;
    for (const layer of this.layers) {
      if (!layer.closest(lx, ly, lz, reach)) {
        if (!layer.isInterior(lx, ly, lz)) continue;
        if (!layer.closest(lx, ly, lz, layer.extent)) continue;
      }
      const push = clearance - layer.signedDistance;
      if (push > worst) {
        worst = push;
        worstLayer = layer;
        worstDistance = layer.signedDistance;
        dx = layer.dirX;
        dy = layer.dirY;
        dz = layer.dirZ;
      }
    }
    if (worst <= 0) return 1; // 衝突していない
    // 押し出す向きを、近い面の向きと混ぜて、谷の中間で向きが急に変わらないようにする
    worstLayer.blendDirection(
      lx,
      ly,
      lz,
      Math.abs(worstDistance),
      worstDistance >= 0,
      DIRECTION_BLEND / scale,
    );
    dx = worstLayer.dirX;
    dy = worstLayer.dirY;
    dz = worstLayer.dirZ;

    // 向きを、ボーン座標からワールド座標へ(法線の変換: 逆行列の転置)
    let ox = dx * e[0] / sx2 + dy * e[4] / sy2 + dz * e[8] / sz2;
    let oy = dx * e[1] / sx2 + dy * e[5] / sy2 + dz * e[9] / sz2;
    let oz = dx * e[2] / sx2 + dy * e[6] / sy2 + dz * e[10] / sz2;
    const ol = Math.hypot(ox, oy, oz) || 1;
    target.set(ox / ol, oy / ol, oz / ol);
    return -worst * scale;
  }
}

/** 三角形の疑似法線(同じ位置の頂点をまとめ、角度で重み付けした面法線の和)を、頂点ごとに(長さ 1 で)返す。 */
function weldedNormals(world, index, flip) {
  const vertexCount = world.length / 3;
  const weld = new Int32Array(vertexCount);
  const ids = new Map();
  for (let i = 0; i < vertexCount; i++) {
    const key = `${Math.round(world[i * 3] * 1e5)},${
      Math.round(world[i * 3 + 1] * 1e5)
    },${Math.round(world[i * 3 + 2] * 1e5)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    weld[i] = id;
  }
  const sums = new Float64Array(ids.size * 3);
  const triCount = index.length / 3;
  for (let t = 0; t < triCount; t++) {
    const i = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = i[k] * 3, b = i[(k + 1) % 3] * 3, c = i[(k + 2) % 3] * 3;
      const e1x = world[b] - world[a],
        e1y = world[b + 1] - world[a + 1],
        e1z = world[b + 2] - world[a + 2];
      const e2x = world[c] - world[a],
        e2y = world[c + 1] - world[a + 1],
        e2z = world[c + 2] - world[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue; // つぶれた三角形
      const dot = e1x * e2x + e1y * e2y + e1z * e2z;
      const angle = Math.atan2(len, dot);
      const s = weld[i[k]] * 3;
      sums[s] += nx / len * angle;
      sums[s + 1] += ny / len * angle;
      sums[s + 2] += nz / len * angle;
    }
  }
  const normals = new Float32Array(vertexCount * 3);
  const sign = flip ? -1 : 1;
  for (let i = 0; i < vertexCount; i++) {
    const s = weld[i] * 3;
    const len = Math.hypot(sums[s], sums[s + 1], sums[s + 2]);
    if (len < 1e-12) continue; // 後で面の法線で補う
    normals[i * 3] = sums[s] / len * sign;
    normals[i * 3 + 1] = sums[s + 1] / len * sign;
    normals[i * 3 + 2] = sums[s + 2] / len * sign;
  }
  return normals;
}

/**
 * メッシュが、揺れ物(髪など)のメッシュか。頂点のうち、揺れ物のボーンが最も強く影響するものの割合で決める。
 * 髪のメッシュには、揺れない根元の部分もあるので、頂点ごとではなく、メッシュ全体で見る。
 */
export function isSpringMesh(mesh, springBones, ratio = 0.2) {
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
  if (!skinIndex || !skinWeight || !position.count) return false;
  let count = 0;
  for (let i = 0; i < position.count; i++) {
    let top = 0;
    let best = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w > best) {
        best = w;
        top = skinIndex.getComponent(i, k);
      }
    }
    if (springBones.has(mesh.skeleton.bones[top])) count++;
  }
  return count / position.count > ratio;
}

/**
 * 初期姿勢の、肌・服の表面までの符号付き距離(外側が正、m)を返す関数を作る(ワールド座標)。揺れ物の頂点は使わない。
 * 表面から reach より遠い点は Infinity。球などの判定が、服の表面から飛び出していないかの確認に使う。
 *
 * @param {object} vrm
 * @param {Set<THREE.Object3D>} skipBones 揺れ物のボーン
 * @param {number} reach
 */
export function buildWorldSurface(vrm, skipBones, reach = 0.06) {
  vrm.scene.updateMatrixWorld(true);
  const layers = [];
  const v = new THREE.Vector3();
  vrm.scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.visible) return;
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    if (!position || !skinIndex || !skinWeight || !mesh.geometry.index) return;
    if (isSpringMesh(mesh, skipBones)) return; // 髪などのメッシュは、服の表面ではない
    mesh.skeleton.update();
    const world = new Float32Array(position.count * 3);
    const skipped = new Uint8Array(position.count);
    for (let i = 0; i < position.count; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      world.set([v.x, v.y, v.z], i * 3);
      let top = 0;
      let best = -1;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > best) {
          best = w;
          top = skinIndex.getComponent(i, k);
        }
      }
      skipped[i] = skipBones.has(mesh.skeleton.bones[top]) ? 1 : 0;
    }
    const index = mesh.geometry.index.array;
    const normals = weldedNormals(
      world,
      index,
      mesh.matrixWorld.determinant() < 0,
    );
    const pos = [];
    const nor = [];
    for (let t = 0; t < index.length; t += 3) {
      if (skipped[index[t]] || skipped[index[t + 1]] || skipped[index[t + 2]]) {
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const i = index[t + k];
        pos.push(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
        nor.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      }
    }
    if (pos.length >= 54) {
      layers.push(
        new SurfaceLayer(Float32Array.from(pos), Float32Array.from(nor), 0.04),
      );
    }
  });
  return (x, y, z) => {
    let best = Infinity;
    for (const layer of layers) {
      if (layer.closest(x, y, z, reach) && layer.signedDistance < best) {
        best = layer.signedDistance;
      }
    }
    return best;
  };
}

/**
 * VRM の肌・服のメッシュから、ボーンごとの表面の当たり判定を作る。初期姿勢(Tポーズ)にした状態で呼ぶこと。
 *
 * @param {object} vrm
 * @param {string[]} targetNames 当たり判定を付けるヒューマノイドのボーン名
 * @param {Set<THREE.Object3D>} skipBones 揺れ物(髪・服の SpringBone)のボーン。これに強く付いた三角形は、
 *   自分自身(髪など)が当たり判定になってしまうので使わない。
 * @returns {{ bone: THREE.Object3D, shape: SurfaceColliderShape }[]}
 */
export function buildSurfaceShapes(vrm, targetNames, skipBones) {
  const humanoidNodes = new Set(
    Object.values(vrm.humanoid.rawHumanBones ?? {}).map((b) => b?.node)
      .filter(Boolean),
  );
  const targetSet = new Set(
    targetNames.map((n) => vrm.humanoid.getRawBoneNode(n)).filter(Boolean),
  );
  if (!targetSet.size) return [];

  // 任意のボーン → 当たり判定を付けるヒューマノイドのボーン(対象外なら null、揺れ物なら SKIP)
  const SKIP = "skip";
  const resolved = new Map();
  const resolve = (bone) => {
    if (resolved.has(bone)) return resolved.get(bone);
    let result = null;
    for (let n = bone; n; n = n.parent) {
      if (skipBones.has(n)) {
        result = SKIP;
        break;
      }
      if (humanoidNodes.has(n)) {
        result = targetSet.has(n) ? n : null;
        break;
      }
    }
    resolved.set(bone, result);
    return result;
  };

  vrm.scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const perBone = new Map(); // ボーン → [{ pos: number[], nor: number[] }](メッシュごとに 1 つ)
  const inverses = new Map();

  vrm.scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.visible) return;
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    if (!position || !skinIndex || !skinWeight) return;

    const vertexCount = position.count;
    const world = new Float32Array(vertexCount * 3);
    const owner = new Array(vertexCount); // 頂点 → いちばん強く影響するボーンの行き先
    for (let i = 0; i < vertexCount; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      world[i * 3] = v.x;
      world[i * 3 + 1] = v.y;
      world[i * 3 + 2] = v.z;
      let top = 0;
      let topWeight = -1;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > topWeight) {
          topWeight = w;
          top = skinIndex.getComponent(i, k);
        }
      }
      owner[i] = resolve(mesh.skeleton.bones[top]);
    }

    const index = mesh.geometry.index
      ? mesh.geometry.index.array
      : Uint32Array.from({ length: vertexCount }, (_, i) => i);
    const flip = mesh.matrixWorld.determinant() < 0; // 鏡像(負の拡大縮小)なら、面の表裏が逆になる
    const normals = weldedNormals(world, index, flip);

    const groups = new Map(); // ボーン → この メッシュの三角形
    for (let t = 0; t < index.length / 3; t++) {
      const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
      const oa = owner[a], ob = owner[b], oc = owner[c];
      if (oa === SKIP || ob === SKIP || oc === SKIP) continue;
      const bone = oa === ob || oa === oc ? oa : ob === oc ? ob : oa;
      if (!bone) continue;
      let group = groups.get(bone);
      if (!group) groups.set(bone, group = { tri: [] });
      group.tri.push(a, b, c);
    }

    for (const [bone, group] of groups) {
      let inverse = inverses.get(bone);
      if (!inverse) {
        inverse = new THREE.Matrix4().copy(bone.matrixWorld).invert();
        inverses.set(bone, inverse);
      }
      // 面の法線で補う(疑似法線が求まらなかった頂点用)
      const pos = [];
      const nor = [];
      const tmp = new THREE.Vector3();
      const nrm = new THREE.Vector3();
      for (let t = 0; t < group.tri.length; t += 3) {
        const corners = [group.tri[t], group.tri[t + 1], group.tri[t + 2]];
        const local = corners.map((i) =>
          tmp.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2])
            .applyMatrix4(inverse).clone()
        );
        const face = new THREE.Vector3()
          .subVectors(local[1], local[0])
          .cross(new THREE.Vector3().subVectors(local[2], local[0]));
        if (face.lengthSq() < 1e-16) continue; // つぶれた三角形
        face.normalize();
        for (let k = 0; k < 3; k++) {
          const i = corners[k];
          // 疑似法線は、ワールド座標のもの。ボーン座標へは、回転・拡大縮小を逆変換して向きだけ移す
          nrm.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
          if (nrm.lengthSq() < 0.5) {
            nrm.copy(face);
          } else {
            nrm.transformDirection(inverse);
          }
          pos.push(local[k].x, local[k].y, local[k].z);
          nor.push(nrm.x, nrm.y, nrm.z);
        }
      }
      if (pos.length / 9 < 1) continue;
      let layers = perBone.get(bone);
      if (!layers) perBone.set(bone, layers = []);
      layers.push({ pos, nor });
    }
  });

  const shapes = [];
  const worldScale = new THREE.Vector3();
  for (const [bone, layers] of perBone) {
    bone.getWorldScale(worldScale);
    const cellSize = CELL_WORLD / (worldScale.x || 1);
    const built = layers
      .filter((l) => l.pos.length / 9 >= MIN_TRIANGLES)
      .map((l) =>
        new SurfaceLayer(
          Float32Array.from(l.pos),
          Float32Array.from(l.nor),
          cellSize,
        )
      );
    if (built.length) {
      shapes.push({ bone, shape: new SurfaceColliderShape(built) });
    }
  }
  return shapes;
}

// ---------------------------------------------------------------------------------------------
// 毛束(揺れ物のボーン)の縁の頂点を使った判定
// ---------------------------------------------------------------------------------------------

const STRAND_SAMPLES = 8; // 1 つのボーンに付ける、毛束の縁の点の数
const MIN_STRAND_VERTICES = 6; // これより頂点が少ないボーンは、点を作らない(ボーンの先端だけで判定する)
// 根元から先端までを 0〜1 としたとき、これより根元寄りの点は使わない。先端を押しても、根元寄りの点はほとんど動かないので、
// 押し出す量が過大になる。根元寄りの部分は、一つ手前のジョイントの先端が受け持つ。
const STRAND_MIN_T = 0.5;
const STRAND_MAX_T = 1.5;
// 押し出し量を二分法で求めるときの、向きを変えて繰り返す回数と、二分法の回数・上限(m)・許容する残り(m)。
const STRAND_DIRECTIONS = 3;
const STRAND_BISECT = 7;
const STRAND_MAX_PUSH = 0.12;
// 球の判定を、先端から bound + この距離より遠いものは外す(押し出しで先端が動く範囲。ここを超えて動くのは、深く刺さったときだけ)
const STRAND_CULL_MARGIN = 0.04;
const STRAND_TOLERANCE = 1e-4;

/**
 * 揺れ物のジョイントごとに、毛束の縁にある頂点を数点選ぶ(初期姿勢で呼ぶ)。
 * three-vrm の揺れ物の判定は、ボーンの先端の「点」と hitRadius の球だけで、モデルの hitRadius は毛束の実際の太さより小さいことが多く
 * (VRoid の髪は 1cm、毛束は 2〜4cm)、毛束の縁だけが服に刺さる。かといって半径を一律に広げると、体に沿って寝た毛束まで浮いてしまう。
 * そこで、毛束のメッシュの頂点そのものを調べる。体に平行な毛束は縁が表面に届かず動かず、刺さっている縁だけが押し出される。
 *
 * @returns {Map} joint → { offsets: Float32Array(ボーン座標の、先端からの位置×3), ts: Float32Array(根元〜先端の割合), bound: number, tailLocal: Float32Array(ボーン座標の先端の位置) }
 */
export function measureStrandSamples(vrm, joints) {
  vrm.scene.updateMatrixWorld(true);
  const entries = new Map(); // bone → { joint, tail, inverse, points: [] }
  const w = new THREE.Vector3();
  for (const joint of joints) {
    const bone = joint.bone;
    let tail;
    if (joint.child) {
      tail = joint.child.getWorldPosition(w).clone().applyMatrix4(
        new THREE.Matrix4().copy(bone.matrixWorld).invert(),
      );
    } else {
      tail = joint.initialLocalChildPosition.clone();
    }
    if (tail.lengthSq() < 1e-10) continue;
    entries.set(bone, {
      joint,
      tail,
      inverse: new THREE.Matrix4().copy(bone.matrixWorld).invert(),
      points: [],
    });
  }

  const v = new THREE.Vector3();
  vrm.scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    if (!skinIndex || !skinWeight) return;
    mesh.skeleton.update();
    for (let i = 0; i < position.count; i++) {
      let top = 0;
      let topWeight = -1;
      for (let k = 0; k < 4; k++) {
        const wt = skinWeight.getComponent(i, k);
        if (wt > topWeight) {
          topWeight = wt;
          top = skinIndex.getComponent(i, k);
        }
      }
      const entry = entries.get(mesh.skeleton.bones[top]);
      if (!entry) continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld)
        .applyMatrix4(entry.inverse); // ボーン座標
      entry.points.push(v.clone());
    }
  });

  const result = new Map();
  for (const { joint, tail, points } of entries.values()) {
    if (points.length < MIN_STRAND_VERTICES) continue;
    const tailLength2 = tail.lengthSq();
    // 根元寄りすぎる点は使わない
    const usable = points.filter((p) => {
      const t = p.dot(tail) / tailLength2;
      return t >= STRAND_MIN_T;
    });
    // 先端そのもの(ずれ 0)と、そこから遠い順に散らばった点(最遠点サンプリング)
    const chosen = [new THREE.Vector3()]; // 先端からのずれ
    const pool = usable.map((p) => p.clone().sub(tail));
    const minDist = new Float32Array(pool.length).fill(Infinity);
    for (let n = 0; n < STRAND_SAMPLES && pool.length; n++) {
      let best = -1;
      let bestD = 1e-8;
      for (let i = 0; i < pool.length; i++) {
        minDist[i] = Math.min(
          minDist[i],
          pool[i].distanceToSquared(chosen[chosen.length - 1]),
        );
        if (minDist[i] > bestD) {
          bestD = minDist[i];
          best = i;
        }
      }
      if (best < 0) break;
      chosen.push(pool[best]);
    }
    const offsets = new Float32Array(chosen.length * 3);
    const ts = new Float32Array(chosen.length);
    let bound = 0;
    chosen.forEach((o, i) => {
      offsets.set([o.x, o.y, o.z], i * 3);
      const t = (o.clone().add(tail)).dot(tail) / tailLength2;
      ts[i] = Math.min(STRAND_MAX_T, Math.max(STRAND_MIN_T, t));
      bound = Math.max(bound, o.length());
    });
    result.set(joint, {
      offsets,
      ts,
      bound,
      tailLocal: Float32Array.of(tail.x, tail.y, tail.z),
    });
  }
  return result;
}

/**
 * 1 つの揺れ物のジョイントのための当たり判定の形。毛束の縁の点(measureStrandSamples)が、表面の外にあるかを調べ、
 * 全部の点が外に出る、ぎりぎりの先端の位置から、押し出す量と向きを返す。
 *
 * three-vrm の揺れ物は、ボーンの根元を固定して、先端を押し出した分だけボーンが回る。縁の点はボーンに付いているので、
 * 押し出すと点の位置も動く(根元寄りの点ほど少ししか動かない)。そこで、先端を動かした後のボーンの向き
 * (今の向きから、新しい軸の向きへの最小の回転)を予測して点の位置を計算し、押し出し量は二分法で「ちょうど外に出る量」を求める。
 * 押し出し量を決め打ちの係数で推定すると、行き過ぎた分が(three-vrm は位置の変化を次のフレームの速度にするので)外向きの速度として残り、
 * 浮いては沈む往復で髪が震える。今のボーンの向きのまま調べると、押し出すたびに数 mm ずれて、これも震えの元になる。
 */
export class StrandCollisionShape {
  /**
   * @param {{ shape: SurfaceColliderShape, colliderMatrix: THREE.Matrix4 }[]} carriers 表面の当たり判定(ボーンに付けたコライダー)
   * @param {object} joint 毛束の揺れ物のジョイント(VRMSpringBoneJoint。bone の今の向きと拡大を matrixWorld から読む)
   */
  constructor(carriers, joint, { offsets, ts, bound, tailLocal }) {
    this.carriers = carriers;
    this.joint = joint;
    this.bone = joint.bone;
    // ボーン座標での縁の点の位置(先端の位置 + 先端からのずれ)
    this.locals = new Float32Array(ts.length * 3);
    for (let k = 0; k < ts.length; k++) {
      for (let a = 0; a < 3; a++) {
        this.locals[k * 3 + a] = offsets[k * 3 + a] + tailLocal[a];
      }
    }
    this._exact = typeof joint._boneAxis === "object" &&
      !!joint._initialLocalMatrix &&
      !!joint._initialLocalRotation;
    this._parentWorld = new THREE.Matrix4();
    this._initialInverse = new THREE.Matrix4();
    this._local = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
    this.offsets = offsets;
    this.ts = ts;
    this.bound = bound;
    this.tailLocal = tailLocal;
    this._normal = new THREE.Vector3();
    this._point = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._push = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._rotated = new THREE.Vector3();
    this._base = new THREE.Vector3();
    this._heading = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._world = new Float32Array(ts.length * 3);
    this._nearby = []; // 今のフレームで、先端に近い判定
  }

  get type() {
    return "strand";
  }

  /** base から heading の向きへ amount だけ動かした先端(根元からの距離はボーンの長さのまま)を out に入れる。 */
  _shifted(out, base, heading, amount, head, length) {
    out.copy(base).addScaledVector(heading, amount).sub(head).normalize()
      .multiplyScalar(length).add(head);
    return out;
  }

  /**
   * 先端が tip にあるときの、縁の点のうち表面にいちばん深く刺さっている点の深さ(負。刺さっていなければ 0 以上)を返し、
   * その点を押し出す向きを normalOut に入れる。ボーンの向きは、今の向きから tip の向きへの最小の回転で予測する。
   */
  _depthAt(tip, head, axis, length, normalOut) {
    const p = this._point;
    const n = this._normal;
    const world = this._world;
    let quat = null;
    let matrix = null;
    if (this._exact) {
      // three-vrm と同じ式: 先端を初期姿勢の座標に写した向きへ、初期の軸から最小の回転 → 初期の回転に掛ける。
      // 「今の向きからの最小の回転」だと、ねじれ方が違い、縁の点が数 mm ずれる。
      const j = this.joint;
      const local = this._local.copy(tip).applyMatrix4(this._initialInverse)
        .normalize();
      const q = this._quat.setFromUnitVectors(j._boneAxis, local).premultiply(
        j._initialLocalRotation,
      );
      matrix = this._matrix.compose(this.bone.position, q, this.bone.scale)
        .premultiply(this._parentWorld);
    } else {
      const dir = this._dir.subVectors(tip, head).normalize();
      quat = this._quat.setFromUnitVectors(axis, dir);
    }
    const rotated = this._rotated;
    let worst = 1;
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < this.ts.length; k++) {
      if (matrix) {
        p.set(
          this.locals[k * 3],
          this.locals[k * 3 + 1],
          this.locals[k * 3 + 2],
        ).applyMatrix4(matrix);
      } else {
        rotated.set(world[k * 3], world[k * 3 + 1], world[k * 3 + 2])
          .applyQuaternion(quat);
        p.set(tip.x + rotated.x, tip.y + rotated.y, tip.z + rotated.z);
      }
      for (const c of this._nearby) {
        const d = c.shape.calculateCollision(c.colliderMatrix, p, 0, n);
        if (d >= 0) continue;
        if (d < worst) worst = d;
        // 押し出す向きは、刺さっている点すべての法線を、深さで重み付けして平均する。いちばん深い点の法線だけだと、
        // 2 つの点の深さの順位が入れ替わるたびに向きが急に変わり、谷を滑る毛束が、向きの切り替わりで周期的に震える。
        sx += n.x * -d;
        sy += n.y * -d;
        sz += n.z * -d;
      }
    }
    if (worst < 0) {
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-12) normalOut.set(sx / l, sy / l, sz / l);
    }
    return worst;
  }

  calculateCollision(_colliderMatrix, tail, objectRadius, target) {
    const e = this.bone.matrixWorld.elements;
    const scale = (Math.hypot(e[0], e[1], e[2]) + Math.hypot(e[4], e[5], e[6]) +
      Math.hypot(e[8], e[9], e[10])) / 3;
    const n = this._normal;

    // 先端が、毛束の広がり(bound)以内まで表面に近づいていなければ、どの点も刺さらない。
    // 球の判定は多いので、先端から遠い球は、以降の計算(縁の点・押し出しの二分探索)から外す。
    const reach = this.bound * scale + STRAND_CULL_MARGIN * scale;
    const nearby = this._nearby;
    nearby.length = 0;
    let near = false;
    for (const c of this.carriers) {
      const radius = c.shape.radius;
      if (typeof radius === "number") {
        const m = c.colliderMatrix.elements;
        const dx = m[12] - tail.x;
        const dy = m[13] - tail.y;
        const dz = m[14] - tail.z;
        const limit = radius + reach;
        if (dx * dx + dy * dy + dz * dz > limit * limit) continue;
      }
      nearby.push(c);
      if (
        !near &&
        c.shape.calculateCollision(
            c.colliderMatrix,
            tail,
            this.bound * scale,
            n,
          ) < 0
      ) {
        near = true;
      }
    }
    if (!near) return 1;

    const count = this.ts.length;
    const head = this._head.set(e[12], e[13], e[14]);
    const length = tail.distanceTo(head);
    if (length < 1e-8) return 1;
    // ボーンの今の向き(先端への軸)と、縁の点のずれ(今の向きでのワールド座標のベクトル)
    const tl = this.tailLocal;
    const axis = this._axis.set(
      e[0] * tl[0] + e[4] * tl[1] + e[8] * tl[2],
      e[1] * tl[0] + e[5] * tl[1] + e[9] * tl[2],
      e[2] * tl[0] + e[6] * tl[1] + e[10] * tl[2],
    ).normalize();
    const world = this._world;
    for (let k = 0; k < count; k++) {
      const ox = this.offsets[k * 3];
      const oy = this.offsets[k * 3 + 1];
      const oz = this.offsets[k * 3 + 2];
      world[k * 3] = e[0] * ox + e[4] * oy + e[8] * oz;
      world[k * 3 + 1] = e[1] * ox + e[5] * oy + e[9] * oz;
      world[k * 3 + 2] = e[2] * ox + e[6] * oy + e[10] * oz;
    }

    if (this._exact) {
      const parent = this.bone.parent;
      if (parent) this._parentWorld.copy(parent.matrixWorld);
      else this._parentWorld.identity();
      this._initialInverse.multiplyMatrices(
        this._parentWorld,
        this.joint._initialLocalMatrix,
      ).invert();
    }
    const tip = this._tip.copy(tail);
    const push = this._push;
    const base = this._base.copy(tail);
    for (let direction = 0; direction < STRAND_DIRECTIONS; direction++) {
      // いちばん深く刺さっている点の向きへ、ちょうど外に出る量だけ押し出す(出なければ、別の点の向きでもう一度)
      let depth = this._depthAt(tip, head, axis, length, push);
      if (depth >= -STRAND_TOLERANCE) break;
      const heading = this._heading.copy(push);
      base.copy(tip);
      let low = 0;
      let high = Math.min(STRAND_MAX_PUSH, -depth * 2);
      for (let k = 0; k < 6; k++) {
        this._shifted(tip, base, heading, high, head, length);
        if (
          this._depthAt(tip, head, axis, length, this._probe) >= 0 ||
          high >= STRAND_MAX_PUSH
        ) break;
        low = high;
        high = Math.min(STRAND_MAX_PUSH, high * 2);
      }
      for (let k = 0; k < STRAND_BISECT; k++) {
        const mid = (low + high) / 2;
        this._shifted(tip, base, heading, mid, head, length);
        if (this._depthAt(tip, head, axis, length, this._probe) >= 0) {
          high = mid;
        } else low = mid;
      }
      this._shifted(tip, base, heading, high, head, length);
    }

    push.subVectors(tip, tail);
    let moved = push.length();
    if (moved < 1e-7) return 1;
    // 向きを変えて何度か押すと、途中で必要以上に動くことがある(谷の両側の壁を順に避けるときなど)。
    // 行き過ぎた分は、次のフレームで浮いた毛束が戻ってくるときの震えになるので、最終的に動かした向きに沿って、
    // ちょうど外に出る量まで引き戻す。
    const heading = this._heading.copy(push).multiplyScalar(1 / moved);
    base.copy(tail);
    let low = 0;
    let high = moved;
    for (let k = 0; k < STRAND_BISECT; k++) {
      const mid = (low + high) / 2;
      this._shifted(tip, base, heading, mid, head, length);
      if (this._depthAt(tip, head, axis, length, this._probe) >= 0) high = mid;
      else low = mid;
    }
    this._shifted(tip, base, heading, high, head, length);
    push.subVectors(tip, tail);
    moved = push.length();
    if (moved < 1e-7) return 1;
    target.copy(push).multiplyScalar(1 / moved);
    return -moved;
  }
}
