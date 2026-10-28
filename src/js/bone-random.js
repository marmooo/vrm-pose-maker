/**
 * bone-random.js - 可動域(bone-limits.json)の範囲内でランダムなポーズを作る
 */
import * as THREE from "three";
import { getBoneLimit, loadBoneLimits } from "./bone-limits.js";

const FINGER_RE =
  /^(left|right)(Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 範囲の中央寄りに偏らせた乱数(三角分布)。端ばかりの不自然なポーズを避ける */
function triangular(lo, hi, rng) {
  return lo + (hi - lo) * (rng() + rng()) / 2;
}

/**
 * 指定ボーンにランダムな回転を与える。回転は T ポーズ(回転なし)からの絶対値で、
 * 各軸とも可動域の範囲に収まる。
 * @param {import('@pixiv/three-vrm').VRM} vrm
 * @param {string[]} boneNames
 * @param {{rng?: () => number}} [options]
 * @returns {Promise<string[]>} 実際に回転を変更したボーン名
 */
export async function randomizeBones(
  vrm,
  boneNames,
  { rng = Math.random } = {},
) {
  await loadBoneLimits();

  // 指のカール量: 手ごとに「握り具合」を決め、指ごと・関節ごとに少しだけずらす。
  // 関節をバラバラに乱数で決めると、指が不自然に折れ曲がるため。
  const handCurl = { left: rng(), right: rng() };
  const fingerCurl = new Map();
  const curlOf = (name) => {
    const [, side, finger] = name.match(FINGER_RE);
    const key = side + finger;
    if (!fingerCurl.has(key)) {
      fingerCurl.set(key, clamp01(handCurl[side] + (rng() - 0.5) * 0.4));
    }
    return clamp01(fingerCurl.get(key) + (rng() - 0.5) * 0.15);
  };

  const changed = [];
  for (const name of boneNames) {
    const limit = getBoneLimit(name);
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (!limit || !node || !limit.randomize) continue;

    const v = {
      x: triangular(...limit.x, rng),
      y: triangular(...limit.y, rng),
      z: triangular(...limit.z, rng),
    };

    if (limit.curl && FINGER_RE.test(name)) {
      const t = curlOf(name);
      const [lo, hi] = limit[limit.curl];
      const extreme = Math.abs(lo) > Math.abs(hi) ? lo : hi; // 曲げる側の端
      v[limit.curl] = extreme * t;
      // 握るほど指は開きにくい
      for (const axis of ["x", "y", "z"]) {
        if (axis !== limit.curl) v[axis] *= 1 - 0.6 * t;
      }
    }

    node.quaternion.setFromEuler(new THREE.Euler(v.x, v.y, v.z, limit.order));
    changed.push(name);
  }
  return changed;
}
