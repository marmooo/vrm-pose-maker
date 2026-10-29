/**
 * bone-random.js - 可動域(bone-limits.json)の範囲内でランダムなポーズを作る
 */
import * as THREE from "three";
import { getBoneLimit, loadBoneLimits } from "./bone-limits.js";
import { createBodyProxy } from "./bone-collision.js";

const FINGER_RE =
  /^(left|right)(Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;

const EYE_RE = /^(left|right)Eye$/;

// 突き抜けの解消の設定
const MAX_RESOLVE_ITER = 40; // 判定→修正を繰り返す最大回数
const MAX_REDRAW = 3; // 連鎖ごとの引き直し回数(これを超えたら縮める)
const SHRINK = 0.8; // 1回に縮める割合
const MIN_SCALE = 0.05; // これ以下まで縮んだ連鎖は 0(T ポーズ)にして、それ以上は動かさない

/** ボーン名 → 連鎖の ID(左右付き) */
function chainOf(name) {
  const S = name.startsWith("left") ? "L" : "R";
  if (/Thumb|Index|Middle|Ring|Little/.test(name)) return `fingers${S}`;
  if (/Hand$/.test(name)) return `wrist${S}`;
  if (/LowerArm$/.test(name)) return `forearm${S}`;
  if (/(Shoulder|UpperArm)$/.test(name)) return `upperArm${S}`;
  if (/UpperLeg$/.test(name)) return `thigh${S}`;
  if (/LowerLeg$/.test(name)) return `shin${S}`;
  if (/(Foot|Toes)$/.test(name)) return `foot${S}`;
  if (/^(neck|head|jaw)$/.test(name)) return "head";
  return "trunk"; // hips, spine, chest, upperChest
}

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
 * @param {{rng?: () => number, explicit?: boolean, avoidCollision?: boolean}} [options]
 *   explicit: 目のように「その部位を直接指定したときだけ」ランダム化するボーン
 *   (limits の randomize が "explicit")も対象にする
 *   avoidCollision: 体を突き抜けるポーズを避ける(既定 true。bone-collision.js 参照)
 * @returns {Promise<string[]>} 実際に回転を変更したボーン名
 */
export async function randomizeBones(
  vrm,
  boneNames,
  { rng = Math.random, explicit = false, avoidCollision = true } = {},
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

  /** 1つのボーンの回転(オイラー角, ラジアン)を、可動域の範囲内で引く */
  const draw = (name, limit) => {
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
    return v;
  };

  // 対象ボーンを「連鎖(chain)」にまとめる。突き抜けたときは、突き抜けた部位の連鎖を
  // 引き直す/縮める(下の「突き抜けの解消」参照)。
  const chains = new Map(); // id → { names, scale, tries }
  const items = new Map(); // ボーン名 → { node, limit, chain, v }
  for (const name of boneNames) {
    const limit = getBoneLimit(name);
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (!limit || !node || limit.randomize === false) continue;
    if (limit.randomize === "explicit" && !explicit) continue;
    if (EYE_RE.test(name)) continue; // 目は下でまとめて(同じ視線方向に)処理する

    const id = chainOf(name);
    if (!chains.has(id)) chains.set(id, { names: [], scale: 1, tries: 0 });
    chains.get(id).names.push(name);
    items.set(name, { node, limit, chain: id, v: draw(name, limit) });
  }

  // scale(0〜1)は、回転を T ポーズ(0)に向けて縮める割合。可動域は 0 を含むので、
  // 縮めた値も可動域の範囲内に収まる。
  const applyChain = (id) => {
    const c = chains.get(id);
    for (const name of c.names) {
      const { node, limit, v } = items.get(name);
      const k = c.scale;
      node.quaternion.setFromEuler(
        new THREE.Euler(v.x * k * flip, v.y * k, v.z * k * flip, limit.order),
      );
    }
  };
  for (const id of chains.keys()) applyChain(id);

  // 突き抜けの解消: 体を突き抜けている部位があれば、その腕・脚などを
  //   (1) 数回までは別の値で引き直し(ポーズの多様性を保つ)、
  //   (2) それでも突き抜けるなら、T ポーズ側へ少しずつ縮める。
  // 突き抜けの判定に関わる部位のうち、動かせる(今回ランダム化した)ものだけを動かす。
  // 手足と体幹の組なら手足を優先して動かし、体幹は動かさない。
  if (avoidCollision && chains.size) {
    const proxy = createBodyProxy(vrm);
    for (let iter = 0; iter < MAX_RESOLVE_ITER; iter++) {
      const involved = new Set();
      for (const hit of proxy.findCollisions()) {
        const movable = [hit.a, hit.b].map((seg) =>
          seg.chains?.find((id) => chains.get(id)?.scale > MIN_SCALE)
        ).filter(Boolean);
        const limbs = movable.filter((id) => id !== "trunk" && id !== "head");
        for (const id of limbs.length ? limbs : movable) involved.add(id);
      }
      if (!involved.size) break; // 突き抜けなし(または動かせる部位がない)
      for (const id of involved) {
        const c = chains.get(id);
        if (c.tries < MAX_REDRAW) {
          c.tries++;
          if (id.startsWith("fingers")) {
            const side = id.endsWith("L") ? "left" : "right";
            handCurl[side] = rng();
            for (const key of [...fingerCurl.keys()]) {
              if (key.startsWith(side)) fingerCurl.delete(key);
            }
          }
          for (const name of c.names) {
            const item = items.get(name);
            item.v = draw(name, item.limit);
          }
        } else {
          c.scale *= SHRINK;
          if (c.scale <= MIN_SCALE) c.scale = 0;
        }
        applyChain(id);
      }
    }
  }

  const changed = [...items.keys()];

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
