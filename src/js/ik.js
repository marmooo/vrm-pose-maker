/**
 * ik.js - 手足を指定した場所に届かせる(IK)
 *
 * 手のひらの中心を目標の点に置き、必要なら手のひらの向きも面に合わせる。
 * 関節ごとの回転(オイラー角)を未知数にして、減衰最小二乗法(DLS)で数回繰り返して解く。
 *   - 可動域(data/bone-limits.json)を、解く途中で守る。限界に達した関節は止めて、ほかの関節で補う。
 *     そのため、肩(鎖骨)・上腕・前腕のひねり・手首が、可動域の範囲で協力して届かせる。
 *   - 今の姿勢から少しずつ解くので、ひじの向きなどは急に変わらない。
 *   - 届かないときは、いちばん近づく姿勢で止まる。
 *
 * 目標点はモデルごとに世界座標で持つ。モデルを動かしても、手足は目標点に留まる。
 * 目標点は画面上の球(マーカー)として見え、ドラッグで動かせる。
 */
import * as THREE from "three";
import { getBoneLimit } from "./bone-limits.js";

/**
 * IK で動かせる部位。
 *   joints: 動かす関節(根元から順)。axes はオイラー角のどの軸を未知数にするかと、その動かしやすさ(重み)。
 *           重みが小さいほど動きにくい(肩のように、できれば使いたくない関節を小さくする)。
 *   end: 先端のボーン。palm があれば、手のひらの中心を先端の点とし、手のひらの向きも合わせられる。
 */
const ARM_AXES = {
  shoulder: { y: 0.2, z: 0.2 },
  upperArm: { x: 0.4, y: 1, z: 1 },
  lowerArm: { x: 0.5, y: 1 },
  hand: { x: 0.5, y: 1, z: 1 },
};
// 体幹: 手が届かないときだけ、少しずつ体を曲げて届かせる(動きにくくしてある)
const TRUNK_AXES = { x: 0.12, y: 0.06, z: 0.12 };
const LEG_AXES = {
  upperLeg: { x: 1, y: 0.4, z: 1 },
  lowerLeg: { x: 1, y: 0.2 },
  foot: { x: 1, y: 0.5, z: 1 },
};
function armChain(side, color) {
  return {
    joints: [
      { bone: "spine", axes: TRUNK_AXES, optional: true },
      { bone: "chest", axes: TRUNK_AXES, optional: true },
      { bone: "upperChest", axes: TRUNK_AXES, optional: true },
      { bone: `${side}Shoulder`, axes: ARM_AXES.shoulder, optional: true },
      { bone: `${side}UpperArm`, axes: ARM_AXES.upperArm },
      { bone: `${side}LowerArm`, axes: ARM_AXES.lowerArm },
      { bone: `${side}Hand`, axes: ARM_AXES.hand },
    ],
    end: `${side}Hand`,
    palm: { child: `${side}MiddleProximal` },
    side,
    collide: true, // 腕が体(胴・頭・脚・反対の腕)を突き抜けないようにする
    color,
  };
}
function legChain(side, color) {
  return {
    joints: [
      { bone: `${side}UpperLeg`, axes: LEG_AXES.upperLeg },
      { bone: `${side}LowerLeg`, axes: LEG_AXES.lowerLeg },
      { bone: `${side}Foot`, axes: LEG_AXES.foot },
    ],
    end: `${side}Foot`,
    side,
    color,
  };
}
export const IK_CHAINS = {
  leftHand: armChain("left", 0x3d6bff),
  rightHand: armChain("right", 0x3da8ff),
  leftFoot: legChain("left", 0xffd23d),
  rightFoot: legChain("right", 0x7dff6a),
};

const MARKER_RADIUS = 0.035;
const MARKER_OPACITY = 0.2; // 目標点の丸の濃さ(手が触れているかを見にくくしないよう、薄く)
// 解の出発点に使う、目標の手前(面の外側)への距離(m)
const VIA_DISTANCE = 0.12;
// 手のメッシュの接触点に合わせて、先端の点をずらす量の上限(m)
const CONTACT_SHIFT_LIMIT = 0.05;
const ROLL_CANDIDATES = 12; // 手のひらの回転を自動で選ぶとき、試す向きの数
const RETRY_ERROR = 0.03; // 今の姿勢から解いて、手の位置がこれ(m)より外れていれば、腕を初期姿勢に戻して解き直してみる
const STUCK_DEPTH = 0.006; // 体への入り込みがこれ(m)より深いまま続けば、はまっているとみなす
const STUCK_FRAMES = 3; // 損失がこれだけ続けて大きいと、局所解にはまっているとみなす
const RETRY_INTERVAL = 24; // 解き直しの間隔(フレーム)
const TRUNK_BONES = ["spine", "chest", "upperChest"];
const EFFORT_WEIGHT = 0.02; // 関節を動かす量(rad)を、損失(m)に対してどれだけ重く見るか
/** 手のひらの面と、置く面とのすきま(m) */
export const SURFACE_OFFSET = 0.0005;
/** 手首のボーンの原点から見た、手のひらの面(指の腹まで含めて、いちばん出っ張る所)までの深さ(m)。手のひらは手のボーンの -Y 側(T ポーズで下向き) */
const PALM_DEPTH = 0.03;
/** 手のひらの法線(手のボーンのローカル座標)。T ポーズで両手とも下向き */
const PALM_NORMAL = new THREE.Vector3(0, -1, 0);
const BACK_NORMAL = new THREE.Vector3(0, 1, 0);

/**
 * 面に触れさせる手の部位。at: 手首から中指の付け根までを 1 としたときの、手首側からの位置、radius: 同じ長さに対する、触れる範囲の半径、
 * normal: その部位が向く方向(手のボーンのローカル座標)。
 * center は剣を握るときなど、heel(掌底)は打撃のように手のひらの下側を当てるとき、back は手の甲で触れるとき。
 */
export const HAND_PARTS = {
  center: { at: 0.6, radius: 0.25, normal: PALM_NORMAL },
  heel: { at: 0.2, radius: 0.3, normal: PALM_NORMAL },
  back: { at: 0.5, radius: 0.5, normal: BACK_NORMAL },
  // 指先(の腹)で触れる。接触は指ごとの頂点で決めるので、at・radius・normal は手の基準点と向きだけに使う
  fingers: { at: 0.6, radius: 0.25, normal: PALM_NORMAL },
};

/** 指の番号(1〜5)の順。UI の 1〜5 に対応する */
export const FINGER_KEYS = ["Thumb", "Index", "Middle", "Ring", "Little"];
/** 指ごとの関節(ボーン名の側より後ろの部分)と、解く軸の重み。曲げの軸だけを使う(親指は 2 軸が連動する) */
const FINGER_JOINTS = {
  Thumb: [
    ["ThumbMetacarpal", { x: 0.4, y: 0.2, z: 0.4 }],
    ["ThumbProximal", { x: 0.5, z: 0.5 }],
    ["ThumbDistal", { x: 0.5, z: 0.5 }],
  ],
  ...Object.fromEntries(
    ["Index", "Middle", "Ring", "Little"].map((f) => [f, [
      [`${f}Proximal`, { z: 1 }],
      [`${f}Intermediate`, { z: 1 }],
      [`${f}Distal`, { z: 1 }],
    ]]),
  ),
};
const FINGER_TILT = 0.5; // 指で触れるとき、手を面に対して傾ける量(rad)。指先から面に当たるように、手首を浮かせる
const FINGER_POINTS_MAX = 40; // 指の骨 1 本あたりの、接触の判定に使う頂点の数
const AVOID_WEIGHT = 0.6; // 触れない指を、面から逃がすための曲げやすさ(触れる指を 1 として)
const AVOID_MARGIN = 0.002; // 触れない指を、面からこれだけ離しておく(m)
const CURL_RATIO = 0.6; // 触れない指を、可動域のどこまで曲げておくか

const MAX_ITERATIONS = 24;
const STALL_LIMIT = 3; // 誤差がほとんど減らない反復がこれだけ続いたら、打ち切る(届かないとき、毎フレーム回し切らないため)
const POS_TOLERANCE = 5e-4; // m
const ROT_TOLERANCE = 0.01; // rad
const ROT_WEIGHT = 0.12; // 向きの誤差(rad)を、位置の誤差(m)に対してどれだけ重く見るか
const DAMPING = 0.04;
const COLLISION_WEIGHT = 1; // 体への突き抜けを避ける力。位置の誤差(m)と同じ重さ
const MAX_STEP = 0.35; // 1回の更新で1つの関節角を動かす上限(rad)
const FD_DELTA = 1e-3;

let rotScale = 1; // 手のひらの向きの合わせる強さ(位置を優先したいとき、一時的に下げる)
const _eul = new THREE.Euler();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _P = new THREE.Vector3();
const _N = new THREE.Vector3();
const _F = new THREE.Vector3(); // 指の向き(手首から指の付け根へ)

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * 回転をオイラー角(未知数)にする。同じ回転を表すオイラー角は2通りあり(中央の軸が ±90° を超える場合)、
 * ひじのように中央の軸の可動域が 90° を超える関節は、可動域に収まるほうを選ぶ。
 * 戻り値は [x*flip, y, z*flip](flip は VRM0 の符号の違い)。
 */
function eulerWithinLimit(q, order, limit, flip) {
  _eul.setFromQuaternion(q, order);
  const a = [_eul.x * flip, _eul.y, _eul.z * flip];
  if (!limit) return a;
  const mid = "xyz".indexOf(order[1].toLowerCase());
  const b = a.map((v, i) => wrap(i === mid ? Math.PI - v : v + Math.PI));
  const violation = (e) =>
    ["x", "y", "z"].reduce((sum, axis, i) => {
      const [lo, hi] = limit[axis];
      return sum + Math.max(0, lo - e[i], e[i] - hi);
    }, 0);
  return violation(b) < violation(a) ? b : a;
}

const HAND_SUPPORT_BONES = [
  "Hand",
  "ThumbMetacarpal",
  "ThumbProximal",
  "IndexProximal",
  "MiddleProximal",
  "RingProximal",
  "LittleProximal",
];
const HAND_SUPPORT_BAND = 0.03; // 手のひら側の端から、この範囲の頂点だけを接触の判定に使う(m)
const HAND_SUPPORT_MAX = 160;

/**
 * 手のひら側の頂点を、手のボーンの座標で集める。面に置くとき、手の実際のメッシュが面に触れるようにするのに使う。
 * 手のひらと指の付け根までを使う(指先は、曲がっていても面に食い込ませる)。
 * @returns {Float32Array|null} 3 つずつ並べた座標
 */
export function collectHandPoints(vrm, chainName, part = "center") {
  const spec = IK_CHAINS[chainName];
  if (!spec?.palm) return null;
  const end = vrm.humanoid.getNormalizedBoneNode(spec.end);
  if (!end) return null;
  const bones = new Set(
    HAND_SUPPORT_BONES.map((n) =>
      vrm.humanoid.getRawBoneNode(`${spec.side}${n}`)
    ).filter(Boolean),
  );
  // メッシュの頂点は生ボーンの姿勢で決まる。生ボーンは vrm.update で正規化ボーンに追いつくので、1 フレーム遅れていることがある。
  // 点を正規化ボーンの座標へ変換するので、先に生ボーンを今の姿勢に合わせる
  vrm.humanoid.update?.();
  vrm.scene.updateMatrixWorld(true);
  const inv = end.matrixWorld.clone().invert();
  const p = new THREE.Vector3();
  const pts = [];
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.skeleton.update();
    const si = o.geometry.attributes.skinIndex,
      sw = o.geometry.attributes.skinWeight;
    if (!si || !sw) return;
    for (let i = 0; i < si.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      if (!bones.has(o.skeleton.bones[best])) continue;
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      pts.push(p.x, p.y, p.z);
    }
  });
  if (!pts.length) return null;
  // 触れる部位のまわり(手首から中指の付け根へ向かう線上の点を中心に、手の大きさに比例した半径)の頂点だけに絞る
  const def = HAND_PARTS[part] ?? HAND_PARTS.center;
  const n = def.normal;
  const finger = vrm.humanoid.getNormalizedBoneNode(spec.palm.child)?.position;
  let region = pts;
  if (finger) {
    const len = finger.length();
    const ax = finger.x * def.at,
      ay = finger.y * def.at,
      az = finger.z * def.at;
    const r = def.radius * len;
    const inRegion = [];
    for (let i = 0; i < pts.length; i += 3) {
      const rx = pts[i] - ax, ry = pts[i + 1] - ay, rz = pts[i + 2] - az;
      const d = rx * n.x + ry * n.y + rz * n.z;
      if (Math.hypot(rx - d * n.x, ry - d * n.y, rz - d * n.z) <= r) {
        inRegion.push(pts[i], pts[i + 1], pts[i + 2]);
      }
    }
    if (inRegion.length) region = inRegion;
  }
  // その部位の面側(部位の向き)の端に近い頂点だけを残す
  let maxD = -Infinity;
  for (let i = 0; i < region.length; i += 3) {
    maxD = Math.max(
      maxD,
      region[i] * n.x + region[i + 1] * n.y + region[i + 2] * n.z,
    );
  }
  const kept = [];
  for (let i = 0; i < region.length; i += 3) {
    const d = region[i] * n.x + region[i + 1] * n.y + region[i + 2] * n.z;
    if (d >= maxD - HAND_SUPPORT_BAND) {
      kept.push(region[i], region[i + 1], region[i + 2]);
    }
  }
  const step = Math.max(1, Math.ceil(kept.length / 3 / HAND_SUPPORT_MAX));
  const out = [];
  for (let i = 0; i < kept.length; i += 3 * step) {
    out.push(kept[i], kept[i + 1], kept[i + 2]);
  }
  return Float32Array.from(out);
}

/**
 * 指ごとの頂点を、指の骨の座標で集める(指を曲げても、頂点は骨についていく)。
 * @param {string[]} keys FINGER_KEYS のうち、集める指
 * @returns {Object<string, {node: THREE.Object3D, pts: Float32Array}[]>|null} 指 → 骨ごとの頂点
 */
export function collectFingerPoints(vrm, chainName, keys) {
  const spec = IK_CHAINS[chainName];
  if (!spec?.palm) return null;
  vrm.humanoid.update?.();
  vrm.scene.updateMatrixWorld(true);
  const sets = {};
  const byRaw = new Map(); // 生ボーン → { node, list }
  for (const key of keys) {
    sets[key] = [];
    for (const [name] of FINGER_JOINTS[key] ?? []) {
      const raw = vrm.humanoid.getRawBoneNode(`${spec.side}${name}`);
      const node = vrm.humanoid.getNormalizedBoneNode(`${spec.side}${name}`);
      if (!raw || !node) continue;
      const entry = { node, list: [], inv: node.matrixWorld.clone().invert() };
      byRaw.set(raw, entry);
      sets[key].push(entry);
    }
  }
  const p = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.skeleton.update();
    const si = o.geometry.attributes.skinIndex,
      sw = o.geometry.attributes.skinWeight;
    if (!si || !sw) return;
    for (let i = 0; i < si.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      const entry = byRaw.get(o.skeleton.bones[best]);
      if (!entry) continue;
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld).applyMatrix4(
        entry.inv,
      );
      entry.list.push(p.x, p.y, p.z);
    }
  });
  const result = {};
  for (const key of keys) {
    result[key] = sets[key].map(({ node, list }) => {
      const step = Math.max(1, Math.ceil(list.length / 3 / FINGER_POINTS_MAX));
      const pts = [];
      for (let i = 0; i < list.length; i += 3 * step) {
        pts.push(list[i], list[i + 1], list[i + 2]);
      }
      return { node, pts: Float32Array.from(pts) };
    }).filter((e) => e.pts.length);
    if (!result[key].length) delete result[key];
  }
  return Object.keys(result).length ? result : null;
}

/** 自分の側の腕(肩・腕・手)か。自分の腕の当たり判定は、体の判定から外す */
function isOwnPart(name, side) {
  return name.startsWith(side) &&
    /(Shoulder|UpperArm|LowerArm|Hand)$/.test(name);
}

/** 1 つの鎖の、先端(手のひら)まわりの情報を用意する */
function prepareEnd(vrm, chainName, end, handPoints, part = "center") {
  const spec = IK_CHAINS[chainName];
  const palmLocal = new THREE.Vector3();
  const fingerLocal = new THREE.Vector3(1, 0, 0);
  const normalLocal = (HAND_PARTS[part] ?? HAND_PARTS.center).normal;
  if (spec.palm) {
    const child = vrm.humanoid.getNormalizedBoneNode(spec.palm.child);
    if (child) {
      palmLocal.copy(child.position).multiplyScalar(
        (HAND_PARTS[part] ?? HAND_PARTS.center).at,
      );
      fingerLocal.copy(child.position).normalize();
    }
    palmLocal.addScaledVector(normalLocal, PALM_DEPTH);
  }
  // 体に当たらないか調べる点(腕の骨に沿った球)。ボーン座標で持つ
  const samples = [];
  if (spec.collide) {
    const bone = (n) => vrm.humanoid.getNormalizedBoneNode(`${spec.side}${n}`);
    const [upper, lower, hand] = [
      bone("UpperArm"),
      bone("LowerArm"),
      bone("Hand"),
    ];
    if (upper && lower && hand) {
      const u = Math.min(
        1.5,
        Math.max(0.6, (lower.position.length() + hand.position.length()) / 0.5),
      );
      const add = (node, from, ts, r) => {
        for (const t of ts) {
          samples.push({
            node,
            local: from.clone().multiplyScalar(t),
            r: r * u,
          });
        }
      };
      add(upper, lower.position, [0.45, 0.8], 0.045);
      add(lower, hand.position, [0], 0.04); // 前腕は手首へ向かって細くなる
      add(lower, hand.position, [0.4], 0.034);
      add(lower, hand.position, [0.75], 0.026);
      add(hand, new THREE.Vector3(), [0], 0.018);
    }
  }
  return {
    name: chainName,
    side: spec.side,
    end,
    palmLocal,
    normalLocal,
    fingerLocal,
    hasPalm: !!spec.palm,
    samples,
    samplePos: new Float64Array(samples.length * 3),
    handPoints,
    contactNormal: null, // 面に置くとき、面の外向きの法線
    P: new THREE.Vector3(), // 今の先端の点(手のメッシュの接触を含む)
    N: new THREE.Vector3(), // 今の手のひらの向き
    F: new THREE.Vector3(), // 今の指の向き
  };
}

/**
 * 解く対象(関節・未知数・各鎖の先端)を用意する。複数の鎖を同時に解くとき、体幹の関節は共有する。
 * ボーンが足りなければ null。
 * @param {{chain:string, handPoints?:Float32Array|null}[]} goals
 * @param {object[]|null} bodySurface Scene.getBodySurface の結果(体幹が曲がったとき、頭などの当たり判定を追随させるのに使う)
 */
function prepare(vrm, goals, bodySurface = null) {
  const flip = vrm.meta?.metaVersion === "0" ? -1 : 1;
  const joints = [];
  const params = [];
  const byBone = new Map();
  const chains = [];
  for (const goal of goals) {
    const spec = IK_CHAINS[goal.chain];
    let last = null;
    for (const j of spec.joints) {
      const node = vrm.humanoid.getNormalizedBoneNode(j.bone);
      if (!node) {
        if (j.optional) continue; // 肩や上胸は無いモデルもある
        return null;
      }
      last = node;
      if (byBone.has(j.bone)) continue; // 体幹は、鎖どうしで共有する
      const limit = getBoneLimit(j.bone);
      const joint = {
        node,
        order: limit?.order ?? "XYZ",
        e: [0, 0, 0],
        trunk: TRUNK_BONES.includes(j.bone),
      };
      joint.e = eulerWithinLimit(node.quaternion, joint.order, limit, flip);
      byBone.set(j.bone, joint);
      joints.push(joint);
      ["x", "y", "z"].forEach((axis, k) => {
        const w = j.axes[axis];
        if (!w) return;
        const range = limit?.[axis] ?? [-Math.PI, Math.PI]; // 可動域はラジアン
        params.push({ joint, k, w, lo: range[0], hi: range[1] });
      });
    }
    if (!last) return null;
    const chainEnd = prepareEnd(
      vrm,
      goal.chain,
      last,
      goal.handPoints ?? null,
      goal.part ?? "center",
    );
    // 指で触れるときは、触れる指の関節も解く。接触は、指の骨についた頂点のうち、いちばん面に近いもので決める
    if (goal.part === "fingers" && goal.fingerPoints) {
      chainEnd.fingerSets = [];
      for (const key of goal.fingers ?? []) {
        const set = goal.fingerPoints[key];
        if (!set) continue;
        chainEnd.fingerSets.push({ key, parts: set, tip: new THREE.Vector3() });
        for (const [name, axes] of FINGER_JOINTS[key]) {
          const bone = `${chainEnd.side}${name}`;
          const node = vrm.humanoid.getNormalizedBoneNode(bone);
          if (!node || byBone.has(bone)) continue;
          const limit = getBoneLimit(bone);
          const joint = {
            node,
            order: limit?.order ?? "XYZ",
            e: [0, 0, 0],
            trunk: false,
          };
          joint.e = eulerWithinLimit(node.quaternion, joint.order, limit, flip);
          byBone.set(bone, joint);
          joints.push(joint);
          ["x", "y", "z"].forEach((axis, k) => {
            const w = axes[axis];
            if (!w) return;
            const range = limit?.[axis] ?? [-Math.PI, Math.PI];
            params.push({ joint, k, w, lo: range[0], hi: range[1] });
          });
        }
      }
      if (!chainEnd.fingerSets.length) chainEnd.fingerSets = null;
      // 触れない指は、面より下に入らないように、一緒に曲げて逃がす
      chainEnd.avoidSets = [];
      for (const key of FINGER_KEYS) {
        const set = goal.fingerPoints[key];
        if (!set || (goal.fingers ?? []).includes(key)) continue;
        chainEnd.avoidSets.push({ key, parts: set, tip: new THREE.Vector3() });
        for (const [name, axes] of FINGER_JOINTS[key]) {
          const bone = `${chainEnd.side}${name}`;
          const node = vrm.humanoid.getNormalizedBoneNode(bone);
          if (!node || byBone.has(bone)) continue;
          const limit = getBoneLimit(bone);
          const joint = {
            node,
            order: limit?.order ?? "XYZ",
            e: [0, 0, 0],
            trunk: false,
          };
          joint.e = eulerWithinLimit(node.quaternion, joint.order, limit, flip);
          byBone.set(bone, joint);
          joints.push(joint);
          ["x", "y", "z"].forEach((axis, k) => {
            const w = axes[axis];
            if (!w) return;
            const range = limit?.[axis] ?? [-Math.PI, Math.PI];
            params.push({
              joint,
              k,
              w: w * AVOID_WEIGHT,
              lo: range[0],
              hi: range[1],
            });
          });
        }
      }
      chainEnd.samplePos = new Float64Array(
        (chainEnd.samples.length + chainEnd.avoidSets.length) * 3,
      );
    }
    chains.push(chainEnd);
  }
  // 体幹の下にあって、解の途中で動く当たり判定のボーン(頭・首・解かない側の腕など)。体幹が曲がったとき、上から順に行列を更新する
  const jointNodes = new Set(joints.map((j) => j.node));
  const refresh = [];
  for (const entry of bodySurface ?? []) {
    const node = entry.node;
    if (!node || jointNodes.has(node)) continue;
    let depth = 0;
    let under = false;
    for (let o = node.parent; o; o = o.parent) {
      depth++;
      if (jointNodes.has(o)) under = true;
    }
    if (under) refresh.push({ node, depth });
  }
  refresh.sort((a, b) => a.depth - b.depth);
  return {
    joints,
    params,
    chains,
    flip,
    refresh: refresh.map((r) => r.node),
    trunkNodes: joints.filter((j) => j.trunk).map((j) => j.node),
  };
}

/** 指の頂点のうち、法線 cn の方向にいちばん低い(面にいちばん近い)ものを、f.tip に入れる */
function lowestPoint(f, cn) {
  let low = Infinity;
  for (const { node, pts } of f.parts) {
    const w = node.matrixWorld.elements;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      const wx = w[0] * x + w[4] * y + w[8] * z + w[12];
      const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
      const wz = w[2] * x + w[6] * y + w[10] * z + w[14];
      const d = wx * cn.x + wy * cn.y + wz * cn.z;
      if (d < low) {
        low = d;
        f.tip.set(wx, wy, wz);
      }
    }
  }
}

/** 未知数の値から、関節の回転を決めて、各鎖の先端(手のひら)の位置と向き、腕の点の位置を求める */
function forward(ctx) {
  for (const j of ctx.joints) {
    j.node.quaternion.setFromEuler(
      _eul.set(j.e[0] * ctx.flip, j.e[1], j.e[2] * ctx.flip, j.order),
    );
    j.node.updateMatrixWorld(false);
  }
  for (const node of ctx.refresh) node.updateMatrixWorld(false);
  for (const c of ctx.chains) {
    c.P.copy(c.palmLocal).applyMatrix4(c.end.matrixWorld);
    c.N.copy(c.normalLocal).transformDirection(c.end.matrixWorld);
    c.F.copy(c.fingerLocal).transformDirection(c.end.matrixWorld);
    c.excess = 0;
    if (c.contactNormal && c.handPoints) {
      // 手のメッシュのうち、面にいちばん近い(法線の逆向きに、いちばん深い)頂点まで、先端の点をずらす。
      // そうすると、先端の点を面に合わせれば、手のひらの実際の表面が面に触れる
      const w = c.end.matrixWorld.elements;
      const pts = c.handPoints;
      const cn = c.contactNormal;
      let m = Infinity;
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2];
        const wx = w[0] * x + w[4] * y + w[8] * z + w[12] - c.P.x;
        const wy = w[1] * x + w[5] * y + w[9] * z + w[13] - c.P.y;
        const wz = w[2] * x + w[6] * y + w[10] * z + w[14] - c.P.z;
        const d = wx * cn.x + wy * cn.y + wz * cn.z;
        if (d < m) m = d;
      }
      // 手のひらが裏返った姿勢だと、m が極端に大きくなって、位置の誤差をごまかしてしまう。手の厚みの範囲に収める
      if (Number.isFinite(m)) {
        c.P.addScaledVector(
          cn,
          Math.max(-CONTACT_SHIFT_LIMIT, Math.min(CONTACT_SHIFT_LIMIT, m)),
        );
        // 上限を超えた分は、手が面から浮いている(または埋まっている)ことになるので、位置の誤差に足す
        c.excess = Math.max(0, Math.abs(m) - CONTACT_SHIFT_LIMIT);
      }
    }
    if (c.fingerSets && c.cn) {
      // 指ごとに、面にいちばん近い(法線方向にいちばん低い)頂点を、触れる点とする。手の基準点は、その平均
      c.P.set(0, 0, 0);
      for (const f of c.fingerSets) {
        lowestPoint(f, c.cn);
        c.P.add(f.tip);
      }
      c.P.multiplyScalar(1 / c.fingerSets.length);
      c.avoidSets?.forEach((f, j) => {
        lowestPoint(f, c.cn);
        const k = (c.samples.length + j) * 3;
        c.samplePos[k] = f.tip.x;
        c.samplePos[k + 1] = f.tip.y;
        c.samplePos[k + 2] = f.tip.z;
      });
    }
    for (let k = 0; k < c.samples.length; k++) {
      const sm = c.samples[k];
      _v1.copy(sm.local).applyMatrix4(sm.node.matrixWorld);
      c.samplePos[k * 3] = _v1.x;
      c.samplePos[k * 3 + 1] = _v1.y;
      c.samplePos[k * 3 + 2] = _v1.z;
    }
  }
}

/**
 * a を b へ回す回転ベクトル(軸 × 角度)。外積(sin θ)だと、ちょうど裏返った(180°)とき 0 になって、
 * 裏返った姿勢が安定点になってしまうので、実際の角度で測る
 */
function rotationVector(a, b, out) {
  out.crossVectors(a, b);
  const s = out.length();
  const d = a.dot(b);
  if (s < 1e-4) {
    if (d > 0) return out.set(0, 0, 0);
    // 真逆: a に直交する適当な軸のまわりに π
    out.set(1, 0, 0);
    if (Math.abs(a.x) > 0.9) out.set(0, 1, 0);
    return out.cross(a).normalize().multiplyScalar(Math.PI);
  }
  return out.multiplyScalar(Math.atan2(s, d) / s);
}

/** 誤差(位置3 + 向き3)。向きは、手のひらの向きを目標の向きへ回す回転ベクトル */
function residual(c, target, out) {
  out[0] = target.position.x - c.P.x;
  out[1] = target.position.y - c.P.y;
  out[2] = target.position.z - c.P.z;
  if (target.palmNormal) {
    rotationVector(c.N, target.palmNormal, _v1);
    // 指の向きも指定されていれば、手のひらの面内の回転(ロール)も合わせる
    if (target.fingerDir) _v1.add(rotationVector(c.F, target.fingerDir, _v2));
    _v1.multiplyScalar(ROT_WEIGHT * rotScale);
    out[3] = _v1.x;
    out[4] = _v1.y;
    out[5] = _v1.z;
  }
}

/** 今の姿勢での、手のひらの中心と手のひらの向き(世界座標)。確認用 */
export function getEndPoint(vrm, chainName, part = "center") {
  const ctx = prepare(vrm, [{ chain: chainName, part }]);
  if (!ctx) return null;
  vrm.scene.updateMatrixWorld(true);
  const c = ctx.chains[0];
  c.P.copy(c.palmLocal).applyMatrix4(c.end.matrixWorld);
  c.N.copy(c.normalLocal).transformDirection(c.end.matrixWorld);
  c.F.copy(c.fingerLocal).transformDirection(c.end.matrixWorld);
  return {
    position: c.P.clone(),
    palmNormal: c.N.clone(),
    fingerDir: c.F.clone(),
  };
}

/** 小さな連立方程式 A x = b(A は n×n)をガウスの消去法で解く */
function solveLinear(A, b, n) {
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    }
    [A[i], A[piv]] = [A[piv], A[i]];
    [b[i], b[piv]] = [b[piv], b[i]];
    const d = A[i][i] || 1e-12;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / d;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let c = i + 1; c < n; c++) sum -= A[i][c] * x[c];
    x[i] = sum / (A[i][i] || 1e-12);
  }
  return x;
}

const _r = new Array(6).fill(0);
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const COLLISION_MARGIN = 0.003; // 体の表面から、これだけ余分に離す(m)
// 表面の手前この距離までは「近づかない」拘束だけ効かせる。入ったり出たりで拘束が点いたり消えたりして、ぷるぷるするのを防ぐ
const COLLISION_BAND = 0.012;
// 腕だけで、これより近くまで届かないときに、体幹も曲げる(m)
const TRUNK_REACH_ERROR = 0.01;
// 目標がこの距離より体の表面に近ければ、その部位の上にある、とみなす(m)
const ATTACH_RADIUS = 0.02;
// 目標点を体の部位につけるとき、当たり判定の形(メッシュより少し内側)からこの距離(m)以内なら、その部位の表面とみなす
const ANCHOR_RADIUS = 0.05;
// 手が目標からこれより遠いときは、先に位置だけで解く(m)
const PRESOLVE_DISTANCE = 0.08;
// 目標が頭や首の上にあるときの、体幹の動かしやすさ(1 が普通、0 で固定)
const ON_TRUNK_WEIGHT = 0;
// 届かないとき、手のひらの向きを合わせる強さをこの倍率に下げて解き直す
const RELAXED_ROT_SCALE = 0.2;

/**
 * 腕の点が体に入り込んでいる所(深さと、押し出す向き)を集める。
 * 体の当たり判定は、今の(解の途中の)正規化ボーンの行列で動かす。前のフレームの行列を使うと、体幹を曲げたとき
 * 1 フレーム遅れて追いかけ合い、ぷるぷるするため。
 */
function findPenetrations(ctx, bodySurface, out) {
  out.length = 0;
  // 指で触れるとき、触れない指が面より下に入っていれば、押し戻す(面の外向き cn の方向へ)
  ctx.chains.forEach((c, ci) => {
    if (!c.cn || !c.plane) return; // 面が決まっていない(解く前の確認など)ときは、何もしない
    c.avoidSets?.forEach((f, j) => {
      const below = _v1.copy(c.plane).sub(f.tip).dot(c.cn) + AVOID_MARGIN;
      if (below > 0) {
        out.push({
          ci,
          k: c.samples.length + j,
          depth: below - COLLISION_MARGIN, // あとで COLLISION_MARGIN が足されるので、引いておく
          dx: c.cn.x,
          dy: c.cn.y,
          dz: c.cn.z,
        });
      }
    });
  });
  if (!bodySurface?.length) return;
  const mats = bodySurface.map((e) =>
    e.node && e.offset
      ? new THREE.Matrix4().multiplyMatrices(e.node.matrixWorld, e.offset)
      : e.bone.matrixWorld
  );
  ctx.chains.forEach((c, ci) => {
    for (let k = 0; k < c.samples.length; k++) {
      _v1.set(
        c.samplePos[k * 3],
        c.samplePos[k * 3 + 1],
        c.samplePos[k * 3 + 2],
      );
      let depth = 0;
      let dx = 0, dy = 0, dz = 0;
      bodySurface.forEach(({ name, shape }, i) => {
        if (isOwnPart(name, c.side)) return;
        const r = shape.calculateCollision(
          mats[i],
          _v1,
          c.samples[k].r + COLLISION_BAND,
          _dir,
        );
        if (r < 0 && -r > depth) {
          depth = -r;
          dx = _dir.x;
          dy = _dir.y;
          dz = _dir.z;
        }
      });
      // depth: 表面に入り込んでいる量(m)。帯の中で入っていなければ負
      if (depth > 0) {
        out.push({ ci, k, depth: depth - COLLISION_BAND, dx, dy, dz });
      }
    }
  });
}

/** 目標の点が、頭か首の表面にあるか(体幹を曲げると、頭ごと目標から逃げてしまう) */
function isOnTrunkPart(ctx, targets, bodySurface) {
  if (!bodySurface?.length || !ctx.trunkNodes.length) return false;
  const trunk = new Set(ctx.trunkNodes);
  const underTrunk = (node) => {
    for (let o = node; o; o = o.parent) if (trunk.has(o)) return true;
    return false;
  };
  return targets.some((t, ci) =>
    bodySurface.some(({ name, node, offset, shape }) => {
      if (name !== "head" && name !== "neck") return false;
      if (!node || !offset || !underTrunk(node)) return false;
      _m.multiplyMatrices(node.matrixWorld, offset);
      return shape.calculateCollision(_m, t.position, ATTACH_RADIUS, _dir) < 0;
    })
  );
}

const _hits = [];

/**
 * 複数の手足を同時に、目標に近づける。体幹の関節は共有するので、両手を同時に置いても、互いに引っ張り合わない。
 * ボーンは正規化済み(vrm.humanoid.getNormalizedBoneNode)の回転を書き換える。
 * @param {object} vrm
 * @param {{chain:string, handPoints?:Float32Array|null, target:{position: THREE.Vector3, palmNormal?: THREE.Vector3|null, fingerDir?: THREE.Vector3|null}}[]} goals
 *   chain は IK_CHAINS のキー。
 *   target.palmNormal は、手のひらを向けたい世界座標の方向(面に置くなら、面の外向きの法線の逆)。
 *   target.fingerDir は、指(手首から指の付け根)を向けたい方向(palmNormal に直交させておく)。省略すれば、ロールは自由。
 *   handPoints は collectHandPoints の結果。あれば、手のメッシュが面に触れるように合わせる。
 * @param {{name:string, bone:THREE.Object3D, node?:THREE.Object3D, offset?:THREE.Matrix4, shape:object}[]} [bodySurface]
 *   体の表面の当たり判定(ボーンごと)。腕が体を突き抜けないようにする
 * @returns {{posErr:number, cost:number, effort:number}[]|null} 鎖ごとの結果(残った位置の誤差 m、位置・向き・入り込みをまとめた損失、関節を動かした量 rad)
 */
function solveCore(vrm, goals, bodySurface) {
  const ctx = prepare(vrm, goals, bodySurface);
  if (!ctx) return null;
  const ts = goals.map((g, i) => {
    const c = ctx.chains[i];
    const withRot = !!(g.target.palmNormal && c.hasPalm);
    if (withRot && g.handPoints) {
      c.contactNormal = g.target.palmNormal.clone().negate();
    }
    if (c.fingerSets) {
      c.cn = g.target.surfaceNormal ?? null;
      c.plane = g.target.position;
    }
    if (!c.cn) c.fingerSets = null;
    return {
      position: g.target.position,
      palmNormal: withRot ? g.target.palmNormal : null,
      fingerDir: withRot ? g.target.fingerDir ?? null : null,
      rows: withRot ? 6 : 3,
      extra: c.fingerSets?.length ?? 0, // 指の先ごとに、面に乗せる行を 1 つ足す
    };
  });
  const baseOffset = [];
  let baseRows = 0;
  for (const t of ts) {
    baseOffset.push(baseRows);
    baseRows += t.rows + t.extra;
  }
  const { params } = ctx;
  const n = params.length;
  const initial = params.map((p) => p.joint.e[p.k]);
  const pinned = new Array(n).fill(false);
  const nC = ctx.chains.length;
  const snapshotOut = () =>
    ctx.chains.map((c) => ({
      P: c.P.clone(),
      N: c.N.clone(),
      F: c.F.clone(),
      S: Float64Array.from(c.samplePos),
      T: c.fingerSets?.map((f) => f.tip.clone()),
    }));

  /** 鎖ごとの誤差と、全体の損失 */
  const evaluate = () => {
    const per = ts.map((t, i) => {
      residual(ctx.chains[i], t, _r);
      let posErr = Math.hypot(_r[0], _r[1], _r[2]) + ctx.chains[i].excess;
      const rotErr = t.rows === 6
        ? Math.hypot(_r[3], _r[4], _r[5]) / (ROT_WEIGHT * rotScale)
        : 0;
      const r = _r.slice(0, t.rows);
      // 指の先を、面(目標の点を通る、法線 cn の平面)に乗せる
      ctx.chains[i].fingerSets?.forEach((f) => {
        const g = _v1.copy(f.tip).sub(t.position).dot(ctx.chains[i].cn);
        r.push(-g);
        posErr += Math.abs(g);
      });
      return { posErr, rotErr, r };
    });
    findPenetrations(ctx, bodySurface, _hits);
    const maxDepth = _hits.reduce((m, h) => Math.max(m, h.depth), 0); // 入り込みの最大(帯の中は 0)
    return { per, maxDepth };
  };
  const costOf = ({ per, maxDepth }) =>
    per.reduce((sum, p) => sum + p.posErr + p.rotErr * ROT_WEIGHT, 0) +
    maxDepth;

  // 一番よかった姿勢にそろえるまでを 1 回の解として、体幹を固定した解 → 届かなければ体幹も使った解、の順に行う。
  // 腕だけで届くのに体幹まで曲げると、頭などが動いてしまうため
  const run = () => {
    pinned.fill(false);
    let lastCost = Infinity;
    let stalled = 0;
    // 一番よかった姿勢を覚えておき、最後にそこへ戻す(悪くなる方向へ動いたまま止まって、ぷるぷるするのを防ぐ)
    let best = { cost: Infinity, e: null };
    const snapshot = () => ctx.joints.map((j) => j.e.slice());
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      forward(ctx);
      const ev = evaluate();
      if (
        ev.per.every((p) =>
          p.posErr < POS_TOLERANCE && p.rotErr < ROT_TOLERANCE
        ) && ev.maxDepth < 1e-3
      ) break;
      const cost = costOf(ev);
      if (cost < best.cost) best = { cost, e: snapshot() };
      stalled = cost > lastCost * 0.99 ? stalled + 1 : 0;
      if (stalled >= STALL_LIMIT) break;
      lastCost = cost;

      const hits = _hits.slice();
      const rows = baseRows + hits.length;
      const rhs = new Array(rows).fill(0);
      ev.per.forEach((p, i) =>
        p.r.forEach((v, k) => (rhs[baseOffset[i] + k] = v))
      );
      hits.forEach((
        h,
        i,
      ) => (rhs[baseRows + i] = Math.max(0, h.depth + COLLISION_MARGIN) *
        COLLISION_WEIGHT)
      );

      // ヤコビ行列(rows × n): 各未知数を少し動かしたときの、位置・向き・腕の点の変化(数値微分)
      const base = snapshotOut();
      const J = Array.from({ length: rows }, () => new Array(n).fill(0));
      for (let c = 0; c < n; c++) {
        if (pinned[c]) continue;
        const p = params[c];
        const old = p.joint.e[p.k];
        p.joint.e[p.k] = old + FD_DELTA;
        forward(ctx);
        p.joint.e[p.k] = old;
        for (let i = 0; i < nC; i++) {
          const ch = ctx.chains[i], b = base[i], o = baseOffset[i];
          J[o][c] = (ch.P.x - b.P.x) / FD_DELTA;
          J[o + 1][c] = (ch.P.y - b.P.y) / FD_DELTA;
          J[o + 2][c] = (ch.P.z - b.P.z) / FD_DELTA;
          ch.fingerSets?.forEach((f, fi) => {
            J[o + ts[i].rows + fi][c] =
              _v1.copy(f.tip).sub(b.T[fi]).dot(ch.cn) /
              FD_DELTA;
          });
          if (ts[i].rows === 6) {
            // 向きの変化は、手のひらの向き N の変化 dN から、N × dN(N に直交する回転ベクトル)で表す
            _v1.copy(ch.N).sub(b.N);
            _v2.crossVectors(b.N, _v1);
            if (ts[i].fingerDir) {
              _v1.copy(ch.F).sub(b.F);
              _v2.add(_v3.crossVectors(b.F, _v1));
            }
            _v2.multiplyScalar(ROT_WEIGHT * rotScale / FD_DELTA);
            J[o + 3][c] = _v2.x;
            J[o + 4][c] = _v2.y;
            J[o + 5][c] = _v2.z;
          }
        }
        // 衝突は腕の関節だけで避ける。体幹を曲げて頭などごと逃げると、頭の上に手を置けなくなる
        if (!p.joint.trunk) {
          hits.forEach((h, i) => {
            const k = h.k * 3;
            const ch = ctx.chains[h.ci], b = base[h.ci];
            J[baseRows + i][c] = ((ch.samplePos[k] - b.S[k]) * h.dx +
              (ch.samplePos[k + 1] - b.S[k + 1]) * h.dy +
              (ch.samplePos[k + 2] - b.S[k + 2]) * h.dz) *
              COLLISION_WEIGHT / FD_DELTA;
          });
        }
      }

      // 減衰最小二乗: dθ = W Jᵀ (J W Jᵀ + λ²I)⁻¹ r 。可動域の端で外へ向かう未知数は固定して、解き直す
      let step = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const A = Array.from(
          { length: rows },
          (_, i) =>
            Array.from({ length: rows }, (_, k) => {
              let sum = i === k ? DAMPING * DAMPING : 0;
              for (let c = 0; c < n; c++) {
                if (!pinned[c]) sum += J[i][c] * params[c].w * J[k][c];
              }
              return sum;
            }),
        );
        const y = solveLinear(A, rhs.slice(), rows);
        step = params.map((p, c) => {
          if (pinned[c]) return 0;
          let sum = 0;
          for (let i = 0; i < rows; i++) sum += J[i][c] * y[i];
          return Math.max(-MAX_STEP, Math.min(MAX_STEP, sum * p.w));
        });
        let newlyPinned = false;
        params.forEach((p, c) => {
          if (pinned[c]) return;
          const v = p.joint.e[p.k] + step[c];
          if ((v < p.lo && step[c] < 0) || (v > p.hi && step[c] > 0)) {
            pinned[c] = true;
            newlyPinned = true;
          }
        });
        if (!newlyPinned) break;
      }
      params.forEach((p, c) => {
        const v = p.joint.e[p.k] + step[c];
        p.joint.e[p.k] = Math.max(p.lo, Math.min(p.hi, v));
      });
    }
    // 最後の更新後の姿勢も評価して、一番よかった姿勢にそろえる
    forward(ctx);
    let ev = evaluate();
    let cost = costOf(ev);
    if (best.e && best.cost < cost) {
      ctx.joints.forEach((j, i) => (j.e = best.e[i]));
      forward(ctx);
      ev = evaluate();
      cost = best.cost;
    }
    return { ev, cost };
  };
  // 目標が頭や首の上にあるときは、体幹を曲げても届きやすくならず、頭ごと目標から逃げてしまうので、体幹は動かさない
  // それ以外の目標では、体幹も普通に使う(体幹を固定した段を挟むと、計算が倍になる)
  let ev, cost;
  if (goals.some((g) => g.lockTrunk) || isOnTrunkPart(ctx, ts, bodySurface)) {
    const trunkW = params.map((p) => p.w);
    params.forEach((p) => {
      if (p.joint.trunk) p.w = 0;
    });
    ({ ev, cost } = run());
    if (ev.per.some((p) => p.posErr > TRUNK_REACH_ERROR)) {
      params.forEach((
        p,
        i,
      ) => (p.w = trunkW[i] * (p.joint.trunk ? ON_TRUNK_WEIGHT : 1)));
      ({ ev, cost } = run());
    }
  } else {
    ({ ev, cost } = run());
  }
  // それでも届かないときは、手のひらの向きの優先度を下げて、位置を優先する(向きが少しずれても、手が目標の近くへ行く方がよい)
  if (
    !globalThis.__noRelax && ts.some((t) => t.rows === 6) &&
    ev.per.some((p) => p.posErr > TRUNK_REACH_ERROR)
  ) {
    rotScale = RELAXED_ROT_SCALE;
    try {
      ({ ev, cost } = run());
    } finally {
      rotScale = 1;
    }
  }
  const effort = params.reduce(
    (sum, p, i) => sum + Math.abs(p.joint.e[p.k] - initial[i]),
    0,
  ); // 関節を動かした量(rad)
  return ev.per.map((p) => ({
    posErr: p.posErr,
    cost: p.posErr + p.rotErr * ROT_WEIGHT + ev.maxDepth,
    totalCost: cost,
    depth: ev.maxDepth, // 体への入り込みの最大(m)
    effort,
  }));
}

/** 複数の手足を同時に解く(体幹は共有)。引数と返り値は solveCore と同じ */
export function solveChains(
  vrm,
  goals,
  bodySurface = null,
  { presolve = true } = {},
) {
  const probe = presolve && goals.some((g) => g.target.palmNormal)
    ? prepare(vrm, goals, bodySurface)
    : null;
  if (!probe) return solveCore(vrm, goals, bodySurface);
  forward(probe);
  const far = goals.some((g, i) =>
    probe.chains[i].P.distanceTo(g.target.position) > PRESOLVE_DISTANCE
  );
  if (!far) return solveCore(vrm, goals, bodySurface);
  // 目標まで遠いとき、初期姿勢から向きまで一度に合わせると、局所解(腕がよじれた姿勢)にはまることがある。
  // そこで、「そのまま解く」と「先に向きを無視して位置だけで解いてから、向きも合わせる」の両方を試し、損失の小さいほうを採る
  const nodes = [...new Set(probe.joints.map((j) => j.node))];
  const initial = nodes.map((n) => n.quaternion.clone());
  const direct = solveCore(vrm, goals, bodySurface);
  const directPose = nodes.map((n) => n.quaternion.clone());
  nodes.forEach((n, i) => n.quaternion.copy(initial[i]));
  vrm.scene.updateMatrixWorld(true);
  solveCore(
    vrm,
    goals.map((g) => ({ ...g, target: { position: g.target.position } })),
    bodySurface,
  );
  const staged = solveCore(vrm, goals, bodySurface);
  if (staged && direct && staged[0].totalCost >= direct[0].totalCost) {
    nodes.forEach((n, i) => n.quaternion.copy(directPose[i]));
    vrm.scene.updateMatrixWorld(true);
    return direct;
  }
  return staged ?? direct;
}

/** 1 つの手足だけ解く(solveChains の簡易版) */
export function solveChain(
  vrm,
  chainName,
  target,
  bodySurface = null,
  handPoints = null,
  part = "center",
) {
  return solveChains(
    vrm,
    [{ chain: chainName, target, handPoints, part }],
    bodySurface,
  )?.[0] ?? null;
}

/** 今の姿勢で、腕の点が体に入り込んでいる量(確認用)。[{ k: 点の番号, depth: m }] */
export function getPenetrations(vrm, chainName, bodySurface) {
  const ctx = prepare(vrm, [{ chain: chainName }], bodySurface);
  if (!ctx) return [];
  vrm.scene.updateMatrixWorld(true);
  forward(ctx);
  const hits = [];
  findPenetrations(ctx, bodySurface, hits);
  return hits.map(({ k, depth }) => ({ k, depth: +depth.toFixed(4) }));
}

/** 腕の骨に沿った線分と太さ(世界座標)。面を選ぶとき、動かしている腕自身に当たらないようにするのに使う */
export function armSegments(vrm, chainName) {
  const ctx = prepare(vrm, [{ chain: chainName }]);
  const c = ctx?.chains[0];
  if (!c?.samples.length) return [];
  vrm.scene.updateMatrixWorld(true);
  const bone = (n) => vrm.humanoid.getNormalizedBoneNode(`${c.side}${n}`);
  const pos = (node) => node.getWorldPosition(new THREE.Vector3());
  const hand = bone("Hand");
  const tip = c.palmLocal.clone().multiplyScalar(2).applyMatrix4(
    hand.matrixWorld,
  );
  return [
    [pos(bone("UpperArm")), pos(bone("LowerArm")), 0.055],
    [pos(bone("LowerArm")), pos(hand), 0.045],
    [pos(hand), tip, 0.05],
  ];
}

/**
 * レイの当たり(hit: three のレイキャストの結果)が、その腕(上腕・前腕・手・指)のメッシュかどうか。
 * 手のひらを置いた点を動かすとき、動かす対象の腕自身に当たって狂わないよう、その腕は無視するために使う。
 * 表面の位置ではなく、当たった三角形がどのボーンにつくかで見分ける(手は表面に接しているので、位置では体と区別できない)
 */
export function isArmHit(vrm, chainName, hit) {
  const mesh = hit?.object;
  const face = hit?.face;
  if (!mesh?.isSkinnedMesh || !face) return false;
  const side = IK_CHAINS[chainName].side;
  const names = ["UpperArm", "LowerArm", "Hand"];
  for (const f of ["Thumb", "Index", "Middle", "Ring", "Little"]) {
    for (const n of ["Metacarpal", "Proximal", "Intermediate", "Distal"]) {
      names.push(`${f}${n}`);
    }
  }
  const raw = new Set(
    names.map((n) => vrm.humanoid.getRawBoneNode(`${side}${n}`)).filter(
      Boolean,
    ),
  );
  const bones = mesh.skeleton?.bones;
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  if (!bones || !si || !sw) return false;
  // 三角形の 3 頂点の、手のボーンへの重みの平均が半分を超えれば、手のメッシュとみなす
  let w = 0;
  for (const v of [face.a, face.b, face.c]) {
    for (let k = 0; k < 4; k++) {
      if (raw.has(bones[si.getComponent(v, k)])) w += sw.getComponent(v, k);
    }
  }
  return w / 3 > 0.5;
}

/** モデルごとの IK 目標点と、その印(マーカー)を管理する */
export class IkManager {
  /** 微調整(丸をつかんで動かす)の間は、体幹を固定して腕だけで合わせる */
  fixTrunk = true;

  /**
   * @param {THREE.Scene} threeScene マーカーを置くシーン
   * @param {{onChange?:()=>void}} callbacks 目標点や状態が変わったとき
   */
  constructor(threeScene, callbacks = {}) {
    this._threeScene = threeScene;
    this._callbacks = callbacks;
    // vrm → { vrm, chains: { [chain]: { target: Vector3, enabled: boolean, marker: Mesh } } }
    this._states = new Map();
    this._activeVrm = null;
    this._geometry = new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
  }

  /** 編集中のモデル。マーカーはこのモデルのものだけ見せる */
  setActiveVrm(vrm) {
    this._activeVrm = vrm;
    this._refreshMarkers();
    this._callbacks.onChange?.();
  }

  _chains(vrm, create = false) {
    let s = this._states.get(vrm);
    if (!s && create) {
      s = { vrm, chains: {} };
      this._states.set(vrm, s);
    }
    return s?.chains;
  }

  _refreshMarkers() {
    for (const { vrm, chains } of this._states.values()) {
      for (const e of Object.values(chains)) {
        // 手が触れているかを見る邪魔にならないよう、丸は薄くする(つかんで動かすのには使える)
        // 手を置く場所がオフのときは、丸も出さない(消せなくなる)
        e.marker.visible = vrm === this._activeVrm &&
          (e.enabled || !!e.deferred);
        e.marker.material.opacity = e.deferred ? 0.6 : MARKER_OPACITY; // つかんで動かしている間は、見やすく濃くする
      }
    }
  }

  _makeMarker(chain) {
    const material = new THREE.MeshBasicMaterial({
      color: IK_CHAINS[chain].color,
      transparent: true,
      opacity: MARKER_OPACITY,
      depthTest: false,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(this._geometry, material);
    marker.renderOrder = 999;
    marker.userData.ikMarker = true;
    this._threeScene.add(marker);
    return marker;
  }

  /** 目標点を置く(なければ作る)。置いた時点で有効になる */
  setTarget(vrm, chain, position, normal = null, extra = {}) {
    if (!IK_CHAINS[chain]) return;
    const chains = this._chains(vrm, true);
    let e = chains[chain];
    if (!e) {
      e = chains[chain] = {
        target: new THREE.Vector3(),
        chain,
        normal: null,
        fingerBase: null,
        roll: 0,
        manualRoll: false, // 手のひらの回転を自分で決めたか(まだなら、いちばん無理のない向きを自動で選ぶ)
        handPoints: null, // 手のメッシュの接触用の点(最初に解くときに集める)
        part: "center", // 面に触れさせる手の部位(HAND_PARTS)
        fingers: ["Index"], // part が "fingers" のとき、触れる指(FINGER_KEYS)
        fingerPoints: null, // 指ごとの接触用の頂点
        fingerBackup: null, // 指で触れる前の、指の姿勢(部位を戻すときに戻す)
        anchor: null, // 目標点が触れている体の部位。体が動いたら、目標点もついていく
        enabled: true,
        marker: this._makeMarker(chain),
      };
    }
    e.target.copy(position);
    e.marker.position.copy(position);
    this._setNormal(e, normal);
    e.roll = extra.roll ?? 0;
    e.manualRoll = extra.manualRoll ?? false;
    if (HAND_PARTS[extra.part]) e.part = extra.part;
    if (Array.isArray(extra.fingers)) {
      const keys = FINGER_KEYS.filter((k) => extra.fingers.includes(k));
      if (keys.length) e.fingers = keys;
    }
    e.handPoints = null;
    e.fingerPoints = null;
    e.anchor = null;
    // 指の向き(ロール)は、離して確定するまで決めない(それまでは、その手の届きやすい向きに任せる)
    e.fingerBase = e.normal && extra.fingerBase
      ? extra.fingerBase.clone()
      : null;
    e.enabled = true;
    this._refreshMarkers();
    this._callbacks.onChange?.();
  }

  /** 面の外向きの法線を持たせる(null なら、手のひらの向きは指定しない) */
  _setNormal(e, normal) {
    e.normal = normal ? normal.clone().normalize() : null;
  }

  /**
   * 指の向きの基準(ロール 0°)。壁のような面では上向き、床や天井のような面ではモデルの正面の向きを、面の上に落としたもの。
   * 手のひらの回転のスライダーは、これからの角度を表す。
   */
  _canonicalBase(vrm, normal) {
    const f = Math.abs(normal.y) > 0.8
      ? new THREE.Vector3(0, 0, 1).applyQuaternion(
        vrm.scene.getWorldQuaternion(new THREE.Quaternion()),
      )
      : new THREE.Vector3(0, 1, 0);
    f.addScaledVector(normal, -f.dot(normal));
    if (f.lengthSq() < 1e-4) f.set(1, 0, 0).addScaledVector(normal, -normal.x);
    return f.normalize();
  }

  /** 指の向き(基準を、法線まわりにロールの角度だけ回したもの) */
  _fingerDir(e) {
    if (!e.normal || !e.fingerBase) return null;
    return e.fingerBase.clone().applyAxisAngle(e.normal, e.roll);
  }

  /** 手のひらの回転(ロール)を変える。ラジアン。初めて回すときは、今の指の向きを0°にする */
  setRoll(vrm, chain, roll) {
    const e = this._chains(vrm)?.[chain];
    if (!e?.normal) return;
    e.fingerBase ??= this._canonicalBase(vrm, e.normal);
    e.manualRoll = true; // 自分で回したら、自動の推定はもうしない
    e.roll = roll;
  }

  /** 目標点を追随させ始める。手のひらの回転を自分で決めていなければ、動かしている間は向きを縛らない */
  beginFollow(vrm, chain, refine = false) {
    const e = this._chains(vrm)?.[chain];
    if (!e) return;
    // 置いた点を微調整するときは、決めた手のひらの向きを保ったまま動かす(向きまで自由にすると、体が大きく動いてしまう)
    e.refine = refine && !!e.fingerBase;
    // 微調整のドラッグ中は丸だけ動かし、手は離したときに動かす(動かしながら解くと、手が体の裏へ回り込むことがある)
    e.deferred = refine;
    e.pending = null;
    this._refreshMarkers();
    if (e.manualRoll || e.refine) return;
    e.fingerBase = null;
  }

  /** 追随を終える(離した)。手の点を取り直し、手のひらの回転を自分で決めていなければ、いちばん無理のない向きを選ぶ */
  endFollow(vrm, chain) {
    const e = this._chains(vrm)?.[chain];
    if (!e) return;
    if (e.deferred) {
      const pending = e.pending;
      e.deferred = false;
      e.pending = null;
      this._refreshMarkers();
      if (pending) {
        this.moveTarget(vrm, chain, pending.position, pending.normal);
      }
    }
    this._collectPoints(vrm, chain, e);
    this._attach(vrm, chain, e); // 体幹につく部位なら、向きを選ぶときも体幹を固定する
    const refine = e.refine;
    // 微調整のあとは、今の向きのまま届いていれば、向きは選び直さない(選び直すと、姿勢が大きく変わる)
    let keep = false;
    if (refine && e.fingerBase) {
      this._ensurePoints(vrm, chain, e);
      const r = solveChains(
        vrm,
        [this._goal(chain, e)],
        this._callbacks.getBodySurface?.(vrm) ?? null,
      )?.[0];
      keep = !!r && r.posErr <= RETRY_ERROR && r.depth <= STUCK_DEPTH;
    }
    e.refine = false;
    if (!keep && e.normal && !e.manualRoll) this.autoRoll(vrm, chain);
    if (e.anchor && e.fingerBase) e.anchor.b0 = e.fingerBase.clone();
  }

  /**
   * 目標点を、いちばん近い体の部位につける。その部位が動いたとき(ポーズを変える、モデルを動かす)、目標点もついていく。
   * 体の表面から離れている(床や物の上など)ときは、つけない(ワールドに固定)
   */
  _attach(vrm, chain, e) {
    e.anchor = null;
    const bodySurface = this._callbacks.getBodySurface?.(vrm);
    if (!bodySurface?.length) return;
    vrm.scene.updateMatrixWorld(true);
    const side = IK_CHAINS[chain].side;
    let best = null;
    let bestName = null;
    let bestDist = 0;
    for (const { name, node, offset, shape } of bodySurface) {
      if (!node || !offset || !name || isOwnPart(name, side)) continue;
      _m.multiplyMatrices(node.matrixWorld, offset);
      const r = shape.calculateCollision(_m, e.target, ANCHOR_RADIUS, _dir);
      if (r < bestDist) {
        bestDist = r;
        best = node;
        bestName = name;
      }
    }
    if (!best) return;
    const trunk = TRUNK_BONES.map((b) => vrm.humanoid.getNormalizedBoneNode(b))
      .filter(Boolean);
    e.anchor = {
      name: bestName,
      node: best,
      trunk: trunk.some((t) => {
        for (let o = best; o; o = o.parent) if (o === t) return true;
        return false;
      }),
      inv: best.matrixWorld.clone().invert(),
      p0: e.target.clone(),
      n0: e.normal?.clone() ?? null,
      b0: e.fingerBase?.clone() ?? null,
    };
  }

  /** 目標点を、つけた体の部位の動きに合わせて動かす */
  _followAnchor(e) {
    const a = e.anchor;
    if (!a || e.deferred) return; // 微調整のドラッグ中は、丸を引き戻さない
    _m.multiplyMatrices(a.node.matrixWorld, a.inv);
    e.target.copy(a.p0).applyMatrix4(_m);
    e.marker.position.copy(e.target);
    if (a.n0 && e.normal) e.normal.copy(a.n0).transformDirection(_m);
    if (a.b0 && e.fingerBase) e.fingerBase.copy(a.b0).transformDirection(_m);
  }

  /** 接触用の頂点を、今の姿勢で集め直す(部位に合わせて、手のひら側か、指ごと) */
  _collectPoints(vrm, chain, e) {
    if (e.part === "fingers") {
      e.fingerPoints = collectFingerPoints(vrm, chain, FINGER_KEYS);
    } else {
      e.handPoints = collectHandPoints(vrm, chain, e.part);
    }
  }

  /** 接触用の頂点が無ければ集める */
  _ensurePoints(vrm, chain, e) {
    if (e.part === "fingers") {
      e.fingerPoints ??= collectFingerPoints(vrm, chain, FINGER_KEYS);
    } else {
      e.handPoints ??= collectHandPoints(vrm, chain, e.part);
    }
  }

  /** 触れる指のボーン名(解くときに、姿勢を保存・復元する対象) */
  _fingerBoneNames(chain, e) {
    if (e.part !== "fingers") return [];
    const side = IK_CHAINS[chain].side;
    return FINGER_KEYS.flatMap((k) =>
      FINGER_JOINTS[k].map(([n]) => `${side}${n}`)
    );
  }

  /**
   * 指で触れるための指の準備。触れる指はまっすぐに伸ばし(そこから曲げて面に合わせる)、触れない指(親指以外)は軽く曲げておく。
   * 元の指の姿勢は、部位を戻すときのために覚えておく
   */
  _prepareFingers(vrm, chain, e) {
    const side = IK_CHAINS[chain].side;
    const flip = vrm.meta?.metaVersion === "0" ? -1 : 1;
    e.fingerBackup ??= new Map(
      FINGER_KEYS.flatMap((k) =>
        FINGER_JOINTS[k].map(([n]) => {
          const node = vrm.humanoid.getNormalizedBoneNode(`${side}${n}`);
          return node ? [node, node.quaternion.clone()] : null;
        }).filter(Boolean)
      ),
    );
    for (const key of FINGER_KEYS) {
      const touching = e.fingers.includes(key);
      for (const [name] of FINGER_JOINTS[key]) {
        const node = vrm.humanoid.getNormalizedBoneNode(`${side}${name}`);
        if (!node) continue;
        if (touching) {
          node.quaternion.identity();
        } else if (key !== "Thumb") {
          const limit = getBoneLimit(`${side}${name}`);
          const [lo, hi] = limit?.z ?? [0, 0];
          const flex = Math.abs(lo) > Math.abs(hi) ? lo : hi; // 曲げる側の端
          node.quaternion.setFromEuler(
            _eul.set(0, 0, flex * CURL_RATIO * flip, limit?.order ?? "XYZ"),
          );
        }
      }
    }
    vrm.scene.updateMatrixWorld(true);
  }

  /** 指で触れる前の指の姿勢に戻す */
  _restoreFingers(vrm, e) {
    if (!e.fingerBackup) return;
    for (const [node, q] of e.fingerBackup) node.quaternion.copy(q);
    e.fingerBackup = null;
    vrm.scene.updateMatrixWorld(true);
  }

  /**
   * 手のひらの回転(ロール)を、30° ごとに試して、いちばん損失(届かなさ・体への入り込み・関節を動かす量)の少ない向きにする。
   * 試した姿勢は元に戻す(本当の姿勢は、そのあと毎フレームの解で、選んだ向きへ落ち着く)。
   */
  autoRoll(vrm, chain) {
    const e = this._chains(vrm)?.[chain];
    if (!e?.normal) return;
    const bodySurface = this._callbacks.getBodySurface?.(vrm) ?? null;
    // 他の手も有効なら、体幹を共有するので一緒に解く(他の手の目標は、今のロールのまま)
    const others = Object.entries(this._chains(vrm)).filter(([c, o]) =>
      c !== chain && o.enabled
    );
    const boneNames = new Set(IK_CHAINS[chain].joints.map((j) => j.bone));
    for (const [c] of others) {
      IK_CHAINS[c].joints.forEach((j) => boneNames.add(j.bone));
    }
    for (const n of this._fingerBoneNames(chain, e)) boneNames.add(n);
    for (const [c, o] of others) {
      for (const n of this._fingerBoneNames(c, o)) boneNames.add(n);
    }
    const nodes = [...boneNames].map((b) =>
      vrm.humanoid.getNormalizedBoneNode(b)
    ).filter(Boolean);
    const arm = IK_CHAINS[chain].joints
      .filter((j) => !TRUNK_BONES.includes(j.bone))
      .map((j) => vrm.humanoid.getNormalizedBoneNode(j.bone))
      .filter(Boolean);
    const savedPose = nodes.map((n) => n.quaternion.clone());
    const setPose = (pose) =>
      nodes.forEach((n, i) => n.quaternion.copy(pose[i]));
    vrm.scene.updateMatrixWorld(true);
    const base = this._canonicalBase(vrm, e.normal);
    const palmNormal = e.normal.clone().negate();
    for (const [c, o] of others) this._ensurePoints(vrm, c, o);

    // 向きを 30° ごとに試す。seed は解の出発点: 'current' は今の姿勢、'rest' は腕を初期姿勢に戻す、
    // 'via' は初期姿勢から、いったん目標の手前(面の外側)へ手を持っていってから目標へ向かう(頭の上など、まっすぐ解くと腕がはまる所用)
    const search = (seed) => {
      let best = null;
      // 位置だけで先に解く段は、初期姿勢からのときだけ使う(今の姿勢の近くを試すだけなら、いらない。重い)
      const options = { presolve: seed === "rest" };
      for (let i = 0; i < ROLL_CANDIDATES; i++) {
        const roll = -Math.PI + (i * 2 * Math.PI) / ROLL_CANDIDATES;
        const fingerDir = base.clone().applyAxisAngle(e.normal, roll);
        setPose(savedPose);
        if (seed !== "current") arm.forEach((n) => n.quaternion.identity());
        vrm.scene.updateMatrixWorld(true);
        const goals = [
          {
            ...this._goal(chain, e),
            target: this._target(e, fingerDir),
          },
          ...others.map(([c, o]) => this._goal(c, o)),
        ];
        if (seed === "via") {
          const via = [{
            ...goals[0],
            target: {
              ...goals[0].target,
              position: e.target.clone().addScaledVector(
                e.normal,
                VIA_DISTANCE,
              ),
            },
          }, ...goals.slice(1)];
          for (let pass = 0; pass < 2; pass++) {
            solveChains(vrm, via, bodySurface, options);
          }
        }
        let results = null;
        for (let pass = 0; pass < 2; pass++) {
          results = solveChains(vrm, goals, bodySurface, options);
        }
        if (!results) continue;
        const score = results[0].totalCost + EFFORT_WEIGHT * results[0].effort;
        if (!best || score < best.score) {
          best = {
            roll,
            score,
            posErr: results[0].posErr,
            pose: nodes.map((n) => n.quaternion.clone()),
          };
        }
      }
      return best;
    };
    let best = search("current");
    if (best && best.posErr > RETRY_ERROR) {
      for (const seed of ["rest", "via"]) {
        const retry = search(seed);
        if (retry && retry.score < best.score * 0.7) best = retry;
      }
    }
    if (!best) {
      setPose(savedPose);
      return;
    }
    setPose(best.pose);
    vrm.scene.updateMatrixWorld(true);
    e.fingerBase = base;
    e.roll = best.roll;
  }

  /** 解くための目標(solveChains の goals の 1 つ)を作る */
  _goal(chain, e) {
    return {
      chain,
      handPoints: e.handPoints,
      part: e.part,
      fingers: e.fingers,
      fingerPoints: e.fingerPoints,
      // 目標が体幹について動く部位につけてあれば、体幹を曲げても届きやすくならず、目標ごと動いてずれていくだけなので、体幹は固定する
      lockTrunk: !!e.anchor?.trunk || (!!e.refine && this.fixTrunk),
      // 手のひらを面に向けたまま、指を面の上でどちらへ向けるか(ロール)
      target: this._target(e, this._fingerDir(e)),
    };
  }

  /**
   * 手のひらの向きと指の向きの目標。指の向き flat は、面の上での向き。
   * 指で触れるときは、指先から面に当たるように、手を面に対して傾ける(手首が浮く)
   */
  _target(e, flat) {
    const target = {
      position: e.target,
      palmNormal: e.normal ? e.normal.clone().negate() : null,
      fingerDir: flat,
    };
    if (e.part === "fingers" && e.normal) target.surfaceNormal = e.normal;
    if (e.part === "fingers" && e.normal && flat) {
      const c = Math.cos(FINGER_TILT), s = Math.sin(FINGER_TILT);
      target.palmNormal = e.normal.clone().multiplyScalar(-c)
        .addScaledVector(flat, -s);
      target.fingerDir = flat.clone().multiplyScalar(c)
        .addScaledVector(e.normal, -s);
    }
    return target;
  }

  /** ドラッグ中の移動(UI の更新はしない)。normal を渡せば、手のひらの向きも更新する(指の向きの基準は、新しい面へ落とし直す) */
  moveTarget(vrm, chain, position, normal = undefined) {
    const e = this._chains(vrm)?.[chain];
    if (!e) return;
    if (e.deferred) {
      e.marker.position.copy(position);
      e.pending = { position: position.clone(), normal: normal?.clone() };
      return;
    }
    e.target.copy(position);
    e.marker.position.copy(position);
    e.anchor = null; // 動かしている間は、体にはつけない(離したときにつけ直す)
    if (!normal) return;
    this._setNormal(e, normal);
    if (e.fingerBase) {
      e.fingerBase.addScaledVector(e.normal, -e.fingerBase.dot(e.normal));
      if (e.fingerBase.lengthSq() < 1e-4) {
        e.fingerBase = this._canonicalBase(vrm, e.normal);
      } else {
        e.fingerBase.normalize();
      }
    }
  }

  /** 面に触れさせる手の部位を変える(HAND_PARTS のキー)。接触の点を取り直して、向きを選び直す */
  setPart(vrm, chain, part) {
    const e = this._chains(vrm)?.[chain];
    if (!e || !HAND_PARTS[part] || e.part === part) return;
    const was = e.part;
    e.part = part;
    if (part === "fingers") this._prepareFingers(vrm, chain, e);
    else if (was === "fingers") this._restoreFingers(vrm, e);
    this.endFollow(vrm, chain);
    this._callbacks.onChange?.();
  }

  /** 指で触れるときの、触れる指を決める(FINGER_KEYS のうち 1 本以上) */
  setFingers(vrm, chain, keys) {
    const e = this._chains(vrm)?.[chain];
    const next = FINGER_KEYS.filter((k) => keys.includes(k));
    if (!e || !next.length || next.join() === e.fingers.join()) return;
    e.fingers = next;
    if (e.part === "fingers") {
      this._prepareFingers(vrm, chain, e);
      this.endFollow(vrm, chain);
    }
    this._callbacks.onChange?.();
  }

  getTarget(vrm, chain) {
    const e = this._chains(vrm)?.[chain];
    return e
      ? {
        position: e.target,
        part: e.part,
        fingers: e.fingers,
        normal: e.normal,
        roll: e.roll,
        fingerBase: e.fingerBase,
        enabled: e.enabled,
      }
      : null;
  }

  setEnabled(vrm, chain, enabled) {
    const e = this._chains(vrm)?.[chain];
    if (!e) return;
    e.enabled = !!enabled;
    this._refreshMarkers();
    this._callbacks.onChange?.();
  }

  remove(vrm, chain) {
    const chains = this._chains(vrm);
    const e = chains?.[chain];
    if (!e) return;
    this._threeScene.remove(e.marker);
    e.marker.material.dispose();
    delete chains[chain];
    this._callbacks.onChange?.();
  }

  clear(vrm) {
    for (const chain of Object.keys(IK_CHAINS)) this.remove(vrm, chain);
  }

  /** 読み込み直しなどでモデルが無くなったとき、そのモデルの目標点とマーカーを捨てる */
  forget(vrm) {
    this.clear(vrm);
    this._states.delete(vrm);
  }

  /** 編集中のモデルのマーカー(クリック判定用) */
  activeMarkers() {
    const chains = this._activeVrm && this._chains(this._activeVrm);
    if (!chains) return [];
    return Object.entries(chains).filter(([, e]) => e.enabled).map((
      [chain, e],
    ) => ({
      chain,
      marker: e.marker,
    }));
  }

  /** 有効な目標点に向けて、手足を解く。vrm.update の前に呼ぶ(正規化ボーンの回転を書き換えるため)。複数あれば、体幹を共有して同時に解く */
  apply(vrm) {
    const chains = this._chains(vrm);
    if (!chains) return;
    const active = Object.entries(chains).filter(([, e]) => e.enabled);
    if (!active.length) return;
    vrm.scene.updateMatrixWorld(true);
    const bodySurface = this._callbacks.getBodySurface?.(vrm) ?? null;
    for (const [, e] of active) this._followAnchor(e);
    const goals = active.map(([chain, e]) => {
      this._ensurePoints(vrm, chain, e);
      return this._goal(chain, e);
    });
    const results = solveChains(vrm, goals, bodySurface);
    if (!results) return;
    active.forEach(([chain, e], i) => {
      // 局所解にはまって、ずっと届かないときは、腕を初期姿勢に戻して解き直してみる(間隔をあけて、良くなったときだけ採用)
      const bad = results[i].posErr > RETRY_ERROR ||
        results[i].depth > STUCK_DEPTH;
      e.stuck = bad ? (e.stuck ?? 0) + 1 : 0;
      e.cooldown = Math.max(0, (e.cooldown ?? 0) - 1);
      if (e.stuck >= STUCK_FRAMES && e.cooldown === 0) {
        e.cooldown = RETRY_INTERVAL;
        this._retryFromRest(
          vrm,
          chain,
          i,
          goals,
          bodySurface,
          e,
          results[i].posErr + 2 * results[i].depth,
        );
      }
    });
  }

  /** 腕を初期姿勢に戻して解き直し、今より明らかに良くなったときだけ、その姿勢にする */
  _retryFromRest(vrm, chain, index, goals, bodySurface, e, currentErr) {
    const nodes = IK_CHAINS[chain].joints
      .filter((j) => !TRUNK_BONES.includes(j.bone))
      .map((j) => vrm.humanoid.getNormalizedBoneNode(j.bone))
      .filter(Boolean);
    const all = new Set(
      goals.flatMap((g) => [
        ...IK_CHAINS[g.chain].joints.map((j) =>
          vrm.humanoid.getNormalizedBoneNode(j.bone)
        ),
        ...(g.part === "fingers"
          ? FINGER_KEYS.flatMap((k) =>
            FINGER_JOINTS[k].map(([n]) =>
              vrm.humanoid.getNormalizedBoneNode(
                `${IK_CHAINS[g.chain].side}${n}`,
              )
            )
          )
          : []),
      ]),
    );
    const keep = [...all].filter(Boolean);
    const saved = keep.map((n) => n.quaternion.clone());
    // 初期姿勢から、そのまま解く → 目標の手前を経由して解く、の順に試す。今より明らかに良くなったときだけ採用する
    let adopted = false;
    // 体幹についた目標は、体幹を動かすと目標ごと動いて、いつまでも届かず揺れ続けるので、体幹は動かさない
    const seeds = e.anchor?.trunk ? ["rest", "via"] : ["rest", "via", "free"];
    for (const seed of seeds) {
      // free: 体幹を固定していると届かないときの最後の手段として、体幹も動かして解く
      const gs = seed === "free"
        ? goals.map((g) => ({ ...g, lockTrunk: false }))
        : goals;
      nodes.forEach((n) => n.quaternion.identity());
      vrm.scene.updateMatrixWorld(true);
      if (seed === "via" && e.normal) {
        const via = goals.map((g, i) =>
          i === index
            ? {
              ...g,
              target: {
                ...g.target,
                position: e.target.clone().addScaledVector(
                  e.normal,
                  VIA_DISTANCE,
                ),
              },
            }
            : g
        );
        for (let pass = 0; pass < 2; pass++) solveChains(vrm, via, bodySurface);
      }
      let results = null;
      for (let pass = 0; pass < 2; pass++) {
        results = solveChains(vrm, gs, bodySurface);
      }
      if (
        results &&
        results[index].posErr + 2 * results[index].depth < currentErr * 0.5
      ) {
        adopted = true;
        break;
      }
    }
    if (adopted) {
      e.stuck = 0;
    } else {
      keep.forEach((n, i) => n.quaternion.copy(saved[i]));
    }
    vrm.scene.updateMatrixWorld(true);
  }

  /** プロジェクト保存用 */
  serialize(vrm) {
    const chains = this._chains(vrm);
    if (!chains) return null;
    const out = {};
    for (const [chain, e] of Object.entries(chains)) {
      out[chain] = {
        position: e.target.toArray(),
        normal: e.normal?.toArray() ?? null,
        fingerBase: e.fingerBase?.toArray() ?? null,
        roll: e.roll,
        manualRoll: e.manualRoll,
        part: e.part,
        fingers: e.fingers,
        anchor: e.anchor
          ? {
            bone: e.anchor.name,
            trunk: e.anchor.trunk,
            inv: e.anchor.inv.toArray(),
            p0: e.anchor.p0.toArray(),
            n0: e.anchor.n0?.toArray() ?? null,
            b0: e.anchor.b0?.toArray() ?? null,
          }
          : null,
        enabled: e.enabled,
      };
    }
    return Object.keys(out).length ? out : null;
  }

  restore(vrm, data) {
    this.clear(vrm);
    for (const [chain, e] of Object.entries(data ?? {})) {
      if (!IK_CHAINS[chain] || !Array.isArray(e?.position)) continue;
      this.setTarget(
        vrm,
        chain,
        new THREE.Vector3().fromArray(e.position),
        Array.isArray(e.normal)
          ? new THREE.Vector3().fromArray(e.normal)
          : null,
        {
          roll: e.roll ?? 0,
          manualRoll: !!e.manualRoll,
          part: e.part,
          fingers: e.fingers,
          fingerBase: Array.isArray(e.fingerBase)
            ? new THREE.Vector3().fromArray(e.fingerBase)
            : null,
        },
      );
      const a = e.anchor;
      const node = a && vrm.humanoid.getNormalizedBoneNode(a.bone);
      if (node && Array.isArray(a.inv) && Array.isArray(a.p0)) {
        this._chains(vrm)[chain].anchor = {
          name: a.bone,
          node,
          trunk: !!a.trunk,
          inv: new THREE.Matrix4().fromArray(a.inv),
          p0: new THREE.Vector3().fromArray(a.p0),
          n0: Array.isArray(a.n0) ? new THREE.Vector3().fromArray(a.n0) : null,
          b0: Array.isArray(a.b0) ? new THREE.Vector3().fromArray(a.b0) : null,
        };
      }
      if (e.enabled === false) this.setEnabled(vrm, chain, false);
    }
  }
}
