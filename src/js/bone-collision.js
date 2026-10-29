/**
 * bone-collision.js - ポーズが体を突き抜けていないかの簡易判定
 *
 * 体を「カプセル(線分 + 半径)」の集まりで近似し、突き抜けている部位の組を返す。
 * メッシュそのものは使わないので軽く、モデルの大きさ・体型の違いは
 * 体幹の長さ(腰→頭)で半径を拡縮して吸収する。厳密な衝突判定ではなく、
 * 「腕が胴体にめり込む」「手が顔を貫く」「脚が交差して貫き合う」といった
 * 明らかな突き抜けを防ぐのが目的。
 *
 * 判定するのは次の組み合わせ:
 *   腕(上腕・前腕・手・指) × 胴体 / 頭 / 脚 / 反対側の腕
 *   脚(太もも・すね・足) × 反対側の脚 / 頭
 * 同じ腕・脚の中(肘や膝の曲げ)と、脚×胴体(座る・脚を上げる姿勢で接するのが自然)は
 * 判定しない。
 */
import * as THREE from "three";

// 体幹(腰→頭)の長さがこの値のときの半径(メートル)。実際の長さとの比で拡縮する。
const REF_TRUNK = 0.55;
const R = {
  torso: 0.12,
  head: 0.1,
  upperArm: 0.04,
  lowerArm: 0.035,
  hand: 0.035,
  finger: 0.011,
  upperLeg: 0.07,
  lowerLeg: 0.05,
  foot: 0.04,
};
// 皮膚や服は多少は押し込まれるので、半径の合計のこの割合まで近づくのは許す
const TOLERANCE = 0.85;
// 上腕は肩の付け根が胴体のすぐ脇にあるため、付け根側のこの割合は判定から外す
const UPPER_ARM_SKIP = 0.3;

const FINGERS = ["Index", "Middle", "Ring", "Little"];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();

/** 2つの線分 p1-q1 / p2-q2 の最短距離の2乗(Ericson "Real-Time Collision Detection") */
function segmentDistanceSq(p1, q1, p2, q2) {
  const d1 = _a.subVectors(q1, p1);
  const d2 = _b.subVectors(q2, p2);
  const r = _c.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-12;
  let s;
  let t;
  if (a <= EPS && e <= EPS) return r.lengthSq();
  if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const c1 = _d.copy(p1).addScaledVector(d1, s);
  const c2 = _e.copy(p2).addScaledVector(d2, t);
  return c1.distanceToSquared(c2);
}

/**
 * 体のカプセルを作って、突き抜けの判定ができるようにする。
 * @param {import('@pixiv/three-vrm').VRM} vrm
 */
export function createBodyProxy(vrm) {
  const node = (name) => vrm.humanoid.getNormalizedBoneNode(name);
  const pos = (name) =>
    node(name)?.getWorldPosition(new THREE.Vector3()) ?? null;

  const segments = [];
  const add = (seg) => {
    segments.push(seg);
    return seg;
  };

  /**
   * 現在のポーズでのカプセルを作り直す(ポーズを変えたら呼ぶ)。
   * @returns {object[]} カプセルの一覧
   */
  function update() {
    vrm.scene.updateMatrixWorld(true);
    segments.length = 0;

    // 体の大きさ: 腰→頭の長さ(骨の長さはポーズで変わらない)
    const trunk = ["hips", "spine", "chest", "upperChest", "neck", "head"]
      .map(pos).filter(Boolean);
    let trunkLength = 0;
    for (let i = 1; i < trunk.length; i++) {
      trunkLength += trunk[i].distanceTo(trunk[i - 1]);
    }
    const u = trunkLength > 0.05 ? trunkLength / REF_TRUNK : 1;

    const hips = pos("hips");
    const neck = pos("neck") ?? pos("head");
    if (hips && neck) {
      add({
        id: "torso",
        owner: "torso",
        a: hips,
        b: neck,
        r: R.torso * u,
        chains: ["trunk"],
      });
    }
    const headNode = node("head");
    const head = pos("head");
    if (headNode && head) {
      const up = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(headNode.getWorldQuaternion(new THREE.Quaternion()));
      const center = head.clone().addScaledVector(up, 0.09 * u);
      add({
        id: "head",
        owner: "head",
        a: center,
        b: center.clone(),
        r: R.head * u,
        chains: ["head"],
      });
    }

    for (const side of ["left", "right"]) {
      const S = side === "left" ? "L" : "R";
      const armOwner = `arm${S}`;
      const legOwner = `leg${S}`;
      const P = (n) => pos(side + n);

      // ---- 腕 ----
      const uArm = P("UpperArm");
      const lArm = P("LowerArm");
      const hand = P("Hand");
      if (uArm && lArm) {
        const a = uArm.clone().lerp(lArm, UPPER_ARM_SKIP);
        add({
          id: `upperArm${S}`,
          owner: armOwner,
          a,
          b: lArm,
          r: R.upperArm * u,
          chains: [`upperArm${S}`],
        });
      }
      if (lArm && hand) {
        add({
          id: `lowerArm${S}`,
          owner: armOwner,
          a: lArm,
          b: hand,
          r: R.lowerArm * u,
          chains: [`forearm${S}`, `upperArm${S}`],
        });
      }
      if (hand) {
        const mid = P("MiddleProximal");
        const dir = lArm
          ? hand.clone().sub(lArm).normalize()
          : new THREE.Vector3(1, 0, 0);
        add({
          id: `hand${S}`,
          owner: armOwner,
          a: hand,
          b: mid ?? hand.clone().addScaledVector(dir, 0.08 * u),
          r: R.hand * u,
          chains: [`wrist${S}`, `forearm${S}`, `upperArm${S}`],
        });
      }
      // 指(各関節を結ぶ線分)。親指は中手骨→基節が手のひらの中なので除く
      const fingerChains = [
        `fingers${S}`,
        `wrist${S}`,
        `forearm${S}`,
        `upperArm${S}`,
      ];
      const addFinger = (joints, tipFrom, tipTo) => {
        const pts = joints.map(P);
        if (pts.some((p) => !p)) return;
        pts.push(
          pts.at(-1).clone().add(
            pts.at(-1).clone().sub(pts[tipFrom]).multiplyScalar(0.9),
          ),
        );
        for (let i = 0; i < pts.length - 1; i++) {
          add({
            id: `finger${S}`,
            owner: armOwner,
            a: pts[i],
            b: pts[i + 1],
            r: R.finger * u,
            chains: fingerChains,
          });
        }
      };
      for (const f of FINGERS) {
        addFinger([f + "Proximal", f + "Intermediate", f + "Distal"], 1);
      }
      addFinger(["ThumbProximal", "ThumbDistal"], 0);

      // ---- 脚 ----
      const uLeg = P("UpperLeg");
      const lLeg = P("LowerLeg");
      const foot = P("Foot");
      const toes = P("Toes");
      if (uLeg && lLeg) {
        add({
          id: `upperLeg${S}`,
          owner: legOwner,
          a: uLeg,
          b: lLeg,
          r: R.upperLeg * u,
          chains: [`thigh${S}`],
        });
      }
      if (lLeg && foot) {
        add({
          id: `lowerLeg${S}`,
          owner: legOwner,
          a: lLeg,
          b: foot,
          r: R.lowerLeg * u,
          chains: [`shin${S}`, `thigh${S}`],
        });
      }
      if (foot && toes) {
        const tip = toes.clone().add(
          toes.clone().sub(foot).multiplyScalar(0.6),
        );
        add({
          id: `foot${S}`,
          owner: legOwner,
          a: foot,
          b: tip,
          r: R.foot * u,
          chains: [`foot${S}`, `shin${S}`, `thigh${S}`],
        });
      }
    }
    return segments;
  }

  const isArm = (s) => s.owner.startsWith("arm");
  const isLeg = (s) => s.owner.startsWith("leg");

  /** この2つの部位の組を調べるか */
  function shouldTest(s1, s2) {
    if (s1.owner === s2.owner) return false;
    const pair = (f) => f(s1) || f(s2);
    if (s1.owner === "torso" || s2.owner === "torso") {
      return pair(isArm); // 胴体 × 脚 は判定しない
    }
    if (s1.owner === "head" || s2.owner === "head") {
      return pair(isArm) || pair(isLeg); // 頭 × 腕 / 脚
    }
    if (isArm(s1) && isArm(s2)) return true;
    if (isLeg(s1) && isLeg(s2)) return true;
    return true; // 腕 × 脚
  }

  /**
   * 現在のポーズで突き抜けている部位の組を返す。
   * @returns {{a: object, b: object, depth: number}[]}
   */
  function findCollisions() {
    update();
    const hits = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const s1 = segments[i];
        const s2 = segments[j];
        if (!shouldTest(s1, s2)) continue;
        const need = (s1.r + s2.r) * TOLERANCE;
        const dSq = segmentDistanceSq(s1.a, s1.b, s2.a, s2.b);
        if (dSq < need * need) {
          hits.push({ a: s1, b: s2, depth: need - Math.sqrt(dSq) });
        }
      }
    }
    return hits;
  }

  return { update, findCollisions };
}
