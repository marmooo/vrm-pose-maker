/**
 * bone-random.js - 可動域(bone-limits.json)の範囲内でランダムなポーズを作る
 */
import * as THREE from "three";
import { getBoneLimit, loadBoneLimits } from "./bone-limits.js";

const FINGER_RE =
  /^(left|right)(Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;

const EYE_RE = /^(left|right)Eye$/;

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
 * @param {{rng?: () => number, explicit?: boolean}} [options]
 *   explicit: 目のように「その部位を直接指定したときだけ」ランダム化するボーン
 *   (limits の randomize が "explicit")も対象にする
 * @returns {Promise<string[]>} 実際に回転を変更したボーン名
 */
export async function randomizeBones(
  vrm,
  boneNames,
  { rng = Math.random, explicit = false } = {},
) {
  await loadBoneLimits();

  // 可動域は VRM1(+Z 向き)基準。VRM0 はローカルの X/Z の向きが逆(Y 軸まわり180度の
  // 共役)なので、オイラー角の x と z の符号を反転して適用する。
  const flip = vrm.meta?.metaVersion === "0" ? -1 : 1;

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
    if (!limit || !node || limit.randomize === false) continue;
    if (limit.randomize === "explicit" && !explicit) continue;
    if (EYE_RE.test(name)) continue; // 目は下でまとめて(同じ視線方向に)処理する

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

    node.quaternion.setFromEuler(
      new THREE.Euler(v.x * flip, v.y, v.z * flip, limit.order),
    );
    changed.push(name);
  }

  // 目: 左右の目は同じ方向を見る(別々にランダムにすると寄り目・離れ目になって不自然)。
  // 左右の可動域の共通部分から1つの視線を選び、両方の目に同じ回転を与える。
  const eyes = boneNames.filter((n) => EYE_RE.test(n));
  if (explicit && eyes.length) {
    const limits = eyes.map((n) => getBoneLimit(n)).filter(Boolean);
    const gaze = {};
    for (const axis of ["x", "y", "z"]) {
      const lo = Math.max(...limits.map((l) => l[axis][0]));
      const hi = Math.min(...limits.map((l) => l[axis][1]));
      gaze[axis] = lo <= hi ? triangular(lo, hi, rng) : 0;
    }
    for (const name of eyes) {
      const limit = getBoneLimit(name);
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (!limit || !node) continue;
      node.quaternion.setFromEuler(
        new THREE.Euler(gaze.x * flip, gaze.y, gaze.z * flip, limit.order),
      );
      changed.push(name);
    }
  }
  return changed;
}
