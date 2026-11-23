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
import { ContactIndex } from "./contact-index.js";

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
// 股関節から体を曲げる(前屈): 骨盤を前へ倒し、脚は今の向きのまま残す。つま先や低い所へ届かせる
const HIP_BEND_AXES = { x: 0.02 }; // 腕や背骨で届くうちは使わず、届かないときだけ曲げる
const SHIFT_WEIGHT = 0.01; // 置いていない足を動かす量の動きやすさ。届かない・胴にめり込むときだけ使うよう、小さくする
const SHIFT_OUT = 0.4; // 置いていない足を、外へ広げる量の上限(脚の長さに対する割合)
const SHIFT_FRONT = 0.6; // 置いていない足を、前へ出す量の上限(同)
const SHIFT_BACK = 0.3; // 置いていない足を、後ろへ引く量の上限(同)
const HIP_MOVE_AXES = { x: 0.001, y: 0.02, z: 0.003 }; // 腰の平行移動(m)。前屈と同じく、腕や背骨で届かないときだけ使う
const LIMB_ROT_RETRY = 0.35; // 膝・すねの向きがこれ(rad)以上ずれたまま続けば、初期姿勢から解き直す
const RETRY_SUPPORT_MOVE = 0.03; // 解き直しで、支えの足がこれ(m)以上動いた解は採らない
const HIP_RELEASE_CAP = 0.02; // 腰を戻す条件に足す、今の姿勢の誤差の上限(m)
const HIP_BENT_MIN = 0.03; // これ以上(rad)曲げていたら、曲げている状態とみなす
const HIP_RELEASE_ERROR = 0.002; // 曲げている腰を戻すには、曲げなくても誤差がこれ以下(m)で届くこと
const HIP_BEND_RANGE = [0, 1.4]; // rad(0° 〜 80°。後ろへは反らさない)。背骨(最大60°)と合わせて、深い前屈になる
// 立ち位置の障害物の判定。体の足元の円(半径 m)が、物の箱や他のモデルの体にかからないところを選ぶ
const STANCE_RADIUS = 0.2;
const BLOCK_DEPTH = 0.01; // 腕の入り込みがこれ(m)より深いと、体を突き抜けているとみなして、立ち位置を変える
const SELF_TRUNK = ["spine", "chest", "upperChest"];
const SELF_WEIGHT = 2; // 太ももや膝が自分の胴にめり込む深さ(m)を、目標の誤差(m)に対してどれだけ重く見るか
// [脚の骨, 次の骨(あれば、その間の t の位置), t, 半径]
const SELF_LEG_SAMPLES = [
  ["upper", "lower", 0.6, 0.08],
  ["upper", "lower", 0.9, 0.07],
  ["lower", null, 0, 0.06],
];
const DEPENETRATE_ITERATIONS = 4;
const DEPENETRATE_MIN = 0.003; // 体が他のモデルにこれ(m)より入り込んでいれば、押し出す
const CLEAR_TRIES = 8;
const CLEAR_SEARCHES = 2; // 同じ目標で、立ち位置を探す回数の上限 // 突き抜けないときに試す、立ち位置の数
const STANCE_STEP = Math.PI / 9; // 立ち位置の候補を探す角度の刻み
const STANCE_SHRINK = [1, 0.85, 0.7]; // 目標からの距離を、遠い順に(近いほど届きやすい)
const STANCE_INSIDE = 0.05; // 腰が物の中に入っているとみなす、物の縁からの距離(m)
const STANCE_LEAVE_RADII = [0.8, 0.7, 0.6, 0.5]; // 物の中から出るときに、手の目標から離れる距離の候補(m)
const STANCE_LOW = 0.15; // この高さより低い物(敷物など)は、またいで立てるので障害物にしない
const FOOT_SQUAT_ALLOWANCE = 0.15; // 腰を下げて届かせる分(脚の長さに対する割合)
const FOOT_ANKLE_RATIO = 0.12; // 足首の高さ(脚の長さに対する割合)
const FOOT_STAND_RATIO = 0.97; // 足を置くとき、脚をここまで伸ばせば届くとみなす
const FOOT_SQUAT_STARTS = [0.025, 0.05, 0.1, 0.2]; // 足を置くとき、腰を下げる量の初期値(脚の長さに対する割合)
const LIMB_SQUAT_STARTS = [0.1, 0.2, 0.3, 0.4, 0.5]; // 膝・すねを床に付けるときの、腰を下げる量の初期値(深く下げる)
const FOOT_HIP_MOVE_Y = 0.1; // 足を置くときの、腰を下げやすさ(手のときより大きく動かす)
const LEG_AXES = {
  upperLeg: { x: 1, y: 0.4, z: 1 },
  lowerLeg: { x: 1, y: 0.2 },
  foot: { x: 1, y: 0.5, z: 1 },
};
function armChain(side, color) {
  return {
    joints: [
      { bone: "hips", axes: HIP_MOVE_AXES, hipMove: true, optional: true },
      {
        bone: "hips",
        axes: HIP_BEND_AXES,
        range: { x: HIP_BEND_RANGE },
        hipBend: true,
        optional: true,
      },
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
      // 足が脚の長さで届かないときは、腰を下げる(しゃがむ)。反対の足は、その場に残る
      {
        bone: "hips",
        axes: { y: FOOT_HIP_MOVE_Y },
        hipMove: true,
        optional: true,
      },
      { bone: "hips", axes: {}, hipBend: true, optional: true },
      { bone: `${side}UpperLeg`, axes: LEG_AXES.upperLeg },
      { bone: `${side}LowerLeg`, axes: LEG_AXES.lowerLeg },
      { bone: `${side}Foot`, axes: LEG_AXES.foot },
    ],
    end: `${side}Foot`,
    side,
    foot: true, // 足の鎖(先端は、足裏・かかと・つま先の接触点)
    collide: true, // 脚が体(胴・反対の脚・他のモデル)を突き抜けないようにする
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
const WALK_TRIGGER = 0.02; // 手がこれ(m)以上届かないとき、届く立ち位置へ移動する
// 移動先の、目標までの水平距離(腕の長さに対する割合)。最初は楽に届く距離、それでも届かなければ、さらに近づく
// (これより近いと、目標が体の幅の中に入って、手が置けなくなる)
const STAND_RATIOS = [1.0, 0.7];
// 立ったままでは届かないとき、体を横たえて届かせる(うつ伏せ・仰向け・横向き)。頭の向きは水平に 8 方向、腹の向きを 4 通りから選ぶ
const LIE_HEADINGS = 8;
const LIE_PREFERENCE = { prone: 0, left: 0.1, right: 0.1, supine: 0.4 }; // 同じくらい届くなら、うつ伏せ・横向きを選ぶ
const LIE_SHOULDER_RATIO = 0.6; // 肩から目標までの水平距離(腕の長さに対する割合)
const LIE_CANDIDATES = 3;
const LIE_AFTER = 12; // 立ったままで届かない状態が、解く呼び出しでこれだけ続いたら、体を横たえてみる
const LIE_PATIENCE = 8; // 横たえたあと、届かないままこれだけ続いたら、立ち姿に戻す(回数は、解く呼び出しの数)
const LIE_PASSES = 6; // 候補を解く回数の上限(届いたら、そこで止める)
const LIE_DONE_ERROR = 0.015; // 手の位置の誤差がこれ(m)より小さければ、届いたとみなす // 届くかの簡単な判定を通った候補のうち、実際に解いて比べる数
const LIE_BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const RETRY_BUDGET_MS = 600; // 初期姿勢から解き直す試しの、時間の上限
const RETRY_INTERVAL = 24; // 解き直しの間隔(フレーム)
const TRUNK_BONES = ["spine", "chest", "upperChest"];
// 手足の関節ではなく、体を曲げる関節(初期姿勢に戻す対象から外す)
const BEND_BONES = [...TRUNK_BONES, "hips"];

// 腰の動き(前屈としゃがみ): 骨盤(hips)は、両脚の付け根の中点を中心に回し(前屈)、さらに平行移動できる(しゃがみ)。
// 脚は、前屈だけなら今の向きのまま残し、平行移動があれば、足首を元の位置に置いたまま、膝を曲げ伸ばしして追随させる。
// hips の回転と移動だけから脚と位置が決まるようにして(syncHipBend)、姿勢を戻すときも、それだけ戻せばよいようにする
const hipBendState = new WeakMap(); // hips ノード → 基準になる値
const LEG_REACH_RATIO = 0.998; // 脚が伸び切る手前(脚の長さの割合)から、足が浮かないよう、解にペナルティをかける
const LEG_REACH_WEIGHT = 20; // 足が浮く長さ(m)を、目標の誤差(m)に対してどれだけ重く見るか
const HIP_MOVE_MIN = 0.01; // これ以上(m)動かしていたら、しゃがんでいる状態とみなす
const HIP_MIN_HEIGHT = 0.4; // しゃがんだときの腰の高さの下限(脚の長さに対する割合。床からの高さ)
const HIP_MOVE_RANGE = {
  // 脚の長さ(付け根から足首まで)に対する割合
  x: [-0.12, 0.12],
  y: [-0.55, 0.1], // 下へ(しゃがむ)。上は、脚が伸び切るところまで
  z: [-0.3, 0.3], // 前後(しゃがむときに、お尻を引く)
};
const _hv1 = new THREE.Vector3();
const _hv2 = new THREE.Vector3();
const _hv3 = new THREE.Vector3();
const _hv4 = new THREE.Vector3();
const _hv5 = new THREE.Vector3();
const _hq1 = new THREE.Quaternion();
const _hq2 = new THREE.Quaternion();
const _hq3 = new THREE.Quaternion();
const _hq4 = new THREE.Quaternion();

/** 足首の位置(親の座標系)と、脚の各骨の向き(親の座標系)。hips の親から見た座標で求める */
function legPose(hips, leg, out) {
  out.hip.copy(leg.upper.position).applyQuaternion(hips.quaternion).add(
    hips.position,
  );
  out.Qu.copy(hips.quaternion).multiply(leg.upper.quaternion);
  out.knee.copy(leg.lower.position).applyQuaternion(out.Qu).add(out.hip);
  out.Ql.copy(out.Qu).multiply(leg.lower.quaternion);
  out.ankle.copy(leg.foot.position).applyQuaternion(out.Ql).add(out.knee);
  out.Qf.copy(out.Ql).multiply(leg.foot.quaternion);
  return out;
}
const legPoseOut = () => ({
  hip: new THREE.Vector3(),
  knee: new THREE.Vector3(),
  ankle: new THREE.Vector3(),
  Qu: new THREE.Quaternion(),
  Ql: new THREE.Quaternion(),
  Qf: new THREE.Quaternion(),
});
const _lp = legPoseOut();

/** ボーンの向きを、可動域(bone-limits.json)の中へ収める */
const _fe = new THREE.Euler();
function clampToLimit(node, name) {
  const lim = getBoneLimit(name);
  if (!lim) return;
  _fe.setFromQuaternion(node.quaternion, lim.order);
  let changed = false;
  for (const axis of ["x", "y", "z"]) {
    const v = _fe[axis];
    const c = Math.min(lim[axis][1], Math.max(lim[axis][0], v));
    if (c !== v) {
      _fe[axis] = c;
      changed = true;
    }
  }
  if (changed) node.quaternion.setFromEuler(_fe);
}

function captureHipBend(vrm) {
  const hm = vrm.humanoid;
  const hips = hm.getNormalizedBoneNode("hips");
  const legNodes = ["left", "right"].map((side) => ({
    upper: hm.getNormalizedBoneNode(`${side}UpperLeg`),
    lower: hm.getNormalizedBoneNode(`${side}LowerLeg`),
    foot: hm.getNormalizedBoneNode(`${side}Foot`),
    footName: `${side}Foot`,
  }));
  if (!hips) return null;
  for (const { upper, lower, foot } of legNodes) {
    if (
      !upper || upper.parent !== hips || !lower || lower.parent !== upper ||
      !foot || foot.parent !== lower
    ) return null;
  }
  // 前の基準が、今の姿勢とまだ合っていれば(解の続き)、それを使い続ける。
  // 合っていなければ(ポーズの読み込みや、手動の回転があった)、今の姿勢を新しい基準にする
  const old = hipBendState.get(hips);
  if (old && hipStateMatches(hips, old)) return hips;
  const [l, r] = legNodes;
  const pivot = l.upper.position.clone().add(r.upper.position).multiplyScalar(
    0.5,
  );
  const q0 = hips.quaternion.clone();
  const legs = legNodes.map((n) => {
    const leg = {
      ...n,
      qU: n.upper.quaternion.clone(),
      qL: n.lower.quaternion.clone(),
      qF: n.foot.quaternion.clone(),
      l1: n.lower.position.length(),
      l2: n.foot.position.length(),
    };
    const lp = legPose(hips, leg, legPoseOut());
    leg.pin = lp.ankle.clone(); // 足首の位置(基準の姿勢のとき)
    leg.footQ = lp.Qf.clone(); // 足の向き
    return leg;
  });
  // 体の前方(膝が曲がる向き): 左脚から右脚への向き × 上 の逆 = 左 × 上
  // 足首ではなく股関節の位置から求める(足が左右で入れ替わった姿勢で取り直しても、前後が反転しない)
  const side = _hv1.copy(l.upper.position).sub(r.upper.position)
    .applyQuaternion(q0);
  const fwd = side.clone().cross(_hv2.set(0, 1, 0));
  if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, 1);
  hipBendState.set(hips, {
    pivot,
    // 親から見た、脚の付け根の中点の位置(曲げても動かない)
    center: hips.position.clone().add(pivot.clone().applyQuaternion(q0)),
    q0,
    legs,
    fwd: fwd.normalize(),
    len: Math.max(...legs.map((x) => x.l1 + x.l2)),
    t: new THREE.Vector3(), // 基準の姿勢からの、腰の平行移動
    shift: [0, 0, 0, 0], // 置いていない足を動かす量(m)。[左脚の外向き, 左脚の前向き, 右脚の外向き, 右脚の前向き]
    side: side.clone().setY(0).normalize(), // 左脚へ向く水平の向き(親の座標系)
    sig: new Float64Array(7 + 2 * 12),
  });
  const st = hipBendState.get(hips);
  hipValues(hips, st, st.sig);
  return hips;
}
/** hips と脚の、位置と向きを並べた値(sig と比べるため) */
function hipValues(hips, st, out) {
  let i = 0;
  out[i++] = hips.position.x;
  out[i++] = hips.position.y;
  out[i++] = hips.position.z;
  out[i++] = hips.quaternion.x;
  out[i++] = hips.quaternion.y;
  out[i++] = hips.quaternion.z;
  out[i++] = hips.quaternion.w;
  for (const l of st.legs) {
    for (const n of [l.upper, l.lower, l.foot]) {
      const q = n.quaternion;
      out[i++] = q.x;
      out[i++] = q.y;
      out[i++] = q.z;
      out[i++] = q.w;
    }
  }
  return out;
}
/** 最後に syncHipBend が書いた値と、今の値が同じなら、外から(ポーズの読み込みや手動の回転で)変えられていない */
function hipStateMatches(hips, st) {
  const now = hipValues(hips, st, _hipNow);
  for (let i = 0; i < now.length; i++) {
    if (Math.abs(now[i] - st.sig[i]) > 1e-9) return false;
  }
  return true;
}
const _hipNow = new Float64Array(7 + 2 * 12);
/** 腰の平行移動に合わせて、足首が元の位置のまま動かないように、脚の 2 本の骨を曲げ直す */
function solveLeg(hips, st, leg) {
  const lp = legPose(hips, leg, _lp);
  const { l1, l2 } = leg;
  const to = _hv1.copy(leg.pin).sub(lp.hip);
  const li = leg === st.legs[0] ? 0 : 1;
  const out = st.shift[li * 2], front = st.shift[li * 2 + 1];
  if (out || front) {
    to.addScaledVector(st.side, li === 0 ? out : -out).addScaledVector(
      st.fwd,
      front,
    );
  }
  const dist = to.length();
  if (dist < 1e-6) return;
  const dirT = to.multiplyScalar(1 / dist);
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, dist)); // 届かなければ、伸び切るところまで
  leg.over = Math.max(0, dist - (l1 + l2) * LEG_REACH_RATIO); // 足が元の位置に届かない分(伸び切る手前から数える)
  // 膝は、体の前へ曲げる(足首までの線に垂直な成分)。今の膝の出っ張りを手がかりにすると、腰が後ろへ動いたときに逆向きになる
  const pole = _hv3.copy(st.fwd);
  pole.addScaledVector(dirT, -pole.dot(dirT)).normalize();
  const cosA = Math.max(
    -1,
    Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)),
  );
  const sinA = Math.sqrt(1 - cosA * cosA);
  const knee = _hv4.copy(dirT).multiplyScalar(l1 * cosA).addScaledVector(
    pole,
    l1 * sinA,
  )
    .add(lp.hip);
  // 太もも: 付け根から今の膝へ向いていたのを、新しい膝へ向ける
  const cur = _hv5.copy(lp.knee).sub(lp.hip).normalize();
  const want = _hv2.copy(knee).sub(lp.hip).normalize();
  const Qu2 = _hq1.setFromUnitVectors(cur, want).multiply(lp.Qu);
  leg.upper.quaternion.copy(_hq2.copy(hips.quaternion).invert()).multiply(Qu2);
  // すね: 新しい膝から今の足首へ向いていたのを、目標の足首へ向ける
  const Ql1 = _hq3.copy(Qu2).multiply(leg.lower.quaternion);
  const ankle1 = _hv5.copy(leg.foot.position).applyQuaternion(Ql1).add(knee);
  const target = _hv3.copy(dirT).multiplyScalar(d).add(lp.hip);
  const cur2 = ankle1.sub(knee).normalize();
  const want2 = _hv2.copy(target).sub(knee).normalize();
  const Ql2 = _hq4.setFromUnitVectors(cur2, want2).multiply(Ql1);
  leg.lower.quaternion.copy(_hq2.copy(Qu2).invert()).multiply(Ql2);
  // 足: 世界での向きは、基準のときのまま
  leg.foot.quaternion.copy(_hq2.copy(Ql2).invert()).multiply(leg.footQ);
  // 深くしゃがむと、足を水平に保つには、足首を可動域より曲げることになる。可動域で止める(かかとが浮く)
  clampToLimit(leg.foot, leg.footName);
}
function syncHipBend(hips) {
  const st = hipBendState.get(hips);
  if (!st) return;
  const q = hips.quaternion;
  hips.position.copy(st.center).sub(_v1.copy(st.pivot).applyQuaternion(q));
  // 脚の世界での向き = 基準のときと同じ
  const comp = _q1.copy(q).invert().multiply(st.q0);
  for (const leg of st.legs) {
    leg.over = 0;
    leg.upper.quaternion.copy(comp).multiply(leg.qU);
    leg.lower.quaternion.copy(leg.qL);
    leg.foot.quaternion.copy(leg.qF);
  }
  if (st.t.lengthSq() > 1e-10 || st.shift.some((v) => v !== 0)) {
    hips.position.add(st.t);
    for (const leg of st.legs) if (!leg.free) solveLeg(hips, st, leg); // 足を動かす脚は、鎖の関節で決める
  }
  hipValues(hips, st, st.sig);
}
/** 今の腰の平行移動(姿勢を覚えておくとき用) */
function hipOffset(vrm) {
  const hips = vrm.humanoid.getNormalizedBoneNode("hips");
  const st = hipBendState.get(hips);
  if (!st) return null;
  const t = st.t.clone();
  t.shift = st.shift.slice();
  return t;
}
/** 解の途中で hips の回転(と平行移動 t)を戻したあと、脚と位置を合わせ直す */
function settleHipBend(vrm, t = null) {
  const hips = vrm.humanoid.getNormalizedBoneNode("hips");
  const st = hips && hipBendState.get(hips);
  if (!st) return;
  if (t) {
    st.t.copy(t);
    st.shift = t.shift ? t.shift.slice() : [0, 0, 0, 0];
  }
  syncHipBend(hips);
  hips.updateMatrixWorld(true);
}
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
  // 手以外の部位。node: 接触点がついているボーン、child: その次のボーン(骨の向きと長さを決める)、
  // t: 骨の長さに対する、触れる範囲(node の原点側が 0)、normal: 部位が向く方向(ボーンのローカル座標。VRM0 は前後が逆)、
  // noAutoRoll: 面の上での回転(部位の骨の向き)は、自分で回すまで決めない(自動では選ばない)、skip: 体の当たり判定から外す点(samples の番号。触れる部位自身)、
  // reach: 肩から接触点までの届く長さ(上腕・前腕の長さに対する割合)
  elbow: {
    node: "LowerArm",
    child: "Hand",
    t: [-0.1, 0.25],
    normal: new THREE.Vector3(0, 0, -1),
    noAutoRoll: true,
    skip: [1, 2],
    reach: [1, 0],
  },
  forearm: {
    node: "LowerArm",
    child: "Hand",
    t: [0.2, 0.9],
    normal: PALM_NORMAL,
    noAutoRoll: true,
    skip: [2, 3, 4],
    reach: [1, 0.55],
  },
};

/**
 * 面に触れさせる足の部位。tilt: つま先を上げる角度(rad。負ならかかとを上げる)。
 * sole は足裏全体(かかととつま先の両方)、heel はかかとだけ(つま先を上げる)、toe はつま先だけ(かかとを上げる)。
 */
export const FOOT_PARTS = {
  sole: { tilt: 0 },
  heel: { tilt: 0.5 },
  toe: { tilt: -0.7 },
  // 脚の途中で触れる部位(HAND_PARTS の肘・前腕と同じ書き方)。膝・すねは、面に向かう側が正面
  knee: {
    node: "LowerLeg",
    child: "Foot",
    t: [-0.05, 0.2],
    normal: new THREE.Vector3(0, 0, 1),
    noAutoRoll: true,
    skip: [1, 2],
  },
  shin: {
    node: "LowerLeg",
    child: "Foot",
    t: [0.25, 0.85],
    normal: new THREE.Vector3(0, 0, 1),
    noAutoRoll: true,
    skip: [2, 3, 4],
  },
};

/** 脚・腕の途中(膝・すね・肘・前腕)で触れる部位の定義。手のひら・足裏などなら null */
function limbPart(chainName, part) {
  const table = IK_CHAINS[chainName]?.foot ? FOOT_PARTS : HAND_PARTS;
  return table[part]?.node ? table[part] : null;
}
const FOOT_BAND = 0.01; // 足裏とみなす、いちばん低い点からの厚み(m)
const FOOT_POINTS_MAX = 1500;
const _footCache = new WeakMap();

/**
 * 足(足首のボーン)の座標で、足のメッシュの頂点を集める。足首のボーンも向きも変えて使うので、ボーンの座標のまま持つ。
 * 足の向き(つま先の向き)は、つま先のボーンがあればそこへ、なければ、モデルの正面とする
 */
function footGeometry(vrm, side) {
  let byVrm = _footCache.get(vrm);
  if (!byVrm) _footCache.set(vrm, byVrm = {});
  if (byVrm[side]) return byVrm[side];
  const foot = vrm.humanoid.getNormalizedBoneNode(`${side}Foot`);
  const toes = vrm.humanoid.getNormalizedBoneNode(`${side}Toes`);
  const rawFoot = vrm.humanoid.getRawBoneNode(`${side}Foot`);
  const rawToes = vrm.humanoid.getRawBoneNode(`${side}Toes`);
  if (!foot) return null;
  vrm.humanoid.update?.();
  vrm.scene.updateMatrixWorld(true);
  const flip = vrm.meta?.metaVersion === "0" ? -1 : 1;
  const fwd = new THREE.Vector3(0, 0, flip);
  if (toes) {
    const f = toes.position.clone();
    f.y = 0;
    if (f.lengthSq() > 1e-8) fwd.copy(f.normalize());
  }
  const inv = foot.matrixWorld.clone().invert();
  const raw = [];
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
      const b = o.skeleton.bones[best];
      if (b !== rawFoot && b !== rawToes) continue;
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      raw.push(p.x, p.y, p.z);
    }
  });
  let pts;
  if (raw.length >= 30) {
    const step = Math.max(1, Math.ceil(raw.length / 3 / FOOT_POINTS_MAX));
    const out = [];
    for (let i = 0; i < raw.length; i += 3 * step) {
      out.push(raw[i], raw[i + 1], raw[i + 2]);
    }
    pts = Float32Array.from(out);
  } else {
    // メッシュが見つからなければ、足首からつま先までの長さに合わせた、およその箱
    const len = toes ? Math.max(0.1, toes.position.length() * 2) : 0.2;
    const h = len * 0.4, back = len * 0.3, front = len * 0.8, w = len * 0.2;
    pts = Float32Array.from([
      ...[-w, w].flatMap((x) =>
        [-back, front].flatMap((z) => [x, -h, z * flip])
      ),
    ]);
  }
  return byVrm[side] = { pts, fwd };
}

/**
 * 足の部位の接触点(足首のボーンの座標)。
 * 面へ向かう方向(つま先を tilt だけ上げたときの、足の座標での「下」)にいちばん突き出た頂点のまわり。
 * sole は、足裏のいちばん低い面の、かかとからつま先までの中心。
 */
function footContactPoint(geo, part) {
  const { pts, fwd } = geo;
  const side = new THREE.Vector3(0, 1, 0).cross(fwd).normalize();
  const tilt = (FOOT_PARTS[part] ?? FOOT_PARTS.sole).tilt;
  const out = new THREE.Vector3();
  if (!tilt) {
    let minY = Infinity;
    for (let i = 0; i < pts.length; i += 3) minY = Math.min(minY, pts[i + 1]);
    let lo = Infinity, hi = -Infinity, lat = 0, n = 0;
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i + 1] > minY + FOOT_BAND) continue;
      const f = pts[i] * fwd.x + pts[i + 2] * fwd.z;
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
      lat += pts[i] * side.x + pts[i + 2] * side.z;
      n++;
    }
    return out.set(0, minY, 0).addScaledVector(fwd, (lo + hi) / 2)
      .addScaledVector(side, lat / n);
  }
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const d = new THREE.Vector3(0, -c, 0).addScaledVector(fwd, -s);
  let max = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    max = Math.max(max, pts[i] * d.x + pts[i + 1] * d.y + pts[i + 2] * d.z);
  }
  let n = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] * d.x + pts[i + 1] * d.y + pts[i + 2] * d.z < max - FOOT_BAND) {
      continue;
    }
    out.x += pts[i];
    out.y += pts[i + 1];
    out.z += pts[i + 2];
    n++;
  }
  return out.multiplyScalar(1 / n);
}

/** 指の番号(1〜5)の順。UI の 1〜5 に対応する */
export const FINGER_KEYS = ["Thumb", "Index", "Middle", "Ring", "Little"];
/** 指ごとの関節(ボーン名の側より後ろの部分)と、解く軸の重み。曲げの軸だけを使う(親指は 2 軸が連動する) */
const FINGER_JOINTS = {
  Thumb: [
    ["ThumbMetacarpal", { x: 0.3, y: 0.5, z: 0.3 }],
    ["ThumbProximal", { y: 1 }], // 親指の先の 2 つの関節は、y 軸まわりに曲がる
    ["ThumbDistal", { y: 1 }],
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
// 握る(指を曲げていく)ときの、関節ごとの曲げの割合(可動域の曲げる側の端に対して)。指の先ほど少し浅く曲がる
const GRIP_RATIO = {
  Thumb: [1, 1, 1],
  Index: [1, 1, 0.7],
  Middle: [1, 1, 0.7],
  Ring: [1, 1, 0.7],
  Little: [1, 1, 0.7],
};
// 置いたあと、手のひら(手の骨)の実際のメッシュと、触れる面のメッシュを突き合わせて、隙間・食い込みをなくすように目標点を寄せる
const REFINE_ITERATIONS = 8; // 寄せて解き直す最大の回数
const REFINE_TOLERANCE = 0.0004; // これ以下の隙間・食い込みになれば終わり(m)
const REFINE_RADIUS = 0.12; // 目標点からこの範囲の三角形と頂点だけ調べる(m)
const GRIP_STEPS = 14; // 指を閉じていくとき、接触を調べる刻み
const GRIP_BISECT = 5; // 接触した刻みの中を、さらに二分して詰める回数
const GRIP_POINTS = 30; // 指の骨 1 本あたり、接触の判定に使う頂点の数
const GRIP_INTERVAL = 150; // 接触を調べ直す間隔(ms)。手のひらの回転をドラッグしている間などに、毎フレーム調べないため
const THUMB_CANDIDATES = 24; // 親指の姿勢の候補のうち、途中の接触まで調べて比べる数
const THUMB_PAD_GAP = 0.012; // 親指の腹と、向かい合う指の腹の間に空ける距離(m)
const GRIP_MARGIN = 0.0005; // 握るとき、体の表面からこれより内側に入ったら接触とする(m)

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
const _q1 = new THREE.Quaternion();
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
  const limb = limbPart(chainName, part);
  if (!spec || (!spec.palm && !limb)) return null;
  const end = vrm.humanoid.getNormalizedBoneNode(
    limb ? `${spec.side}${limb.node}` : spec.end,
  );
  if (!end) return null;
  const bones = new Set(
    (limb ? [limb.node] : HAND_SUPPORT_BONES).map((n) =>
      vrm.humanoid.getRawBoneNode(
        limb ? `${spec.side}${n}` : `${spec.side}${n}`,
      )
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
  const def = limb ?? HAND_PARTS[part] ?? HAND_PARTS.center;
  const n = limb
    ? def.normal.clone().setZ(
      def.normal.z * (vrm.meta?.metaVersion === "0" ? -1 : 1),
    )
    : def.normal;
  let region = pts;
  if (limb) {
    // 骨の向きに沿った範囲(t)の頂点だけを使う
    const axis = vrm.humanoid.getNormalizedBoneNode(`${spec.side}${limb.child}`)
      ?.position;
    if (axis) {
      const len = axis.length();
      const inRegion = [];
      for (let i = 0; i < pts.length; i += 3) {
        const t =
          (pts[i] * axis.x + pts[i + 1] * axis.y + pts[i + 2] * axis.z) /
          (len * len);
        if (t >= limb.t[0] && t <= limb.t[1]) {
          inRegion.push(pts[i], pts[i + 1], pts[i + 2]);
        }
      }
      if (inRegion.length) region = inRegion;
    }
  }
  const finger = limb
    ? null
    : vrm.humanoid.getNormalizedBoneNode(spec.palm.child)?.position;
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
function isOwnPart(name, side, foot = false) {
  return name.startsWith(side) &&
    (foot
      ? /(UpperLeg|LowerLeg|Foot|Toes)$/
      : /(Shoulder|UpperArm|LowerArm|Hand)$/)
      .test(name);
}

/** 1 つの鎖の、先端(手のひら)まわりの情報を用意する */
function prepareEnd(vrm, chainName, end, handPoints, part = "center") {
  const spec = IK_CHAINS[chainName];
  const limb = limbPart(chainName, part);
  let pointNode = end; // 接触点がついているボーン(手・足以外の部位のときは、その骨)
  const palmLocal = new THREE.Vector3();
  const fingerLocal = new THREE.Vector3(1, 0, 0);
  const normalLocal = (HAND_PARTS[part] ?? HAND_PARTS.center).normal.clone();
  if (spec.foot && !limb) {
    // 足: 先端は部位の接触点、向きは足裏の向き(下)と、つま先の向き
    const geo = footGeometry(vrm, spec.side);
    if (geo) {
      palmLocal.copy(footContactPoint(geo, part));
      fingerLocal.copy(geo.fwd);
    }
    normalLocal.set(0, -1, 0);
  }
  if (limb) {
    // 腕の途中(肘・前腕)で触れる: 接触点は、骨の上の点。メッシュの接触は handPoints で合わせる
    const node = vrm.humanoid.getNormalizedBoneNode(`${spec.side}${limb.node}`);
    const child = vrm.humanoid.getNormalizedBoneNode(
      `${spec.side}${limb.child}`,
    );
    if (node && child) {
      pointNode = node;
      palmLocal.copy(child.position).multiplyScalar(
        (limb.t[0] + limb.t[1]) / 2,
      );
      normalLocal.copy(limb.normal);
      normalLocal.z *= vrm.meta?.metaVersion === "0" ? -1 : 1;
      fingerLocal.copy(child.position).normalize();
    }
  } else if (spec.palm) {
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
  if (spec.collide && spec.foot) {
    // 脚の骨に沿った球(太ももの付け根は、腰の判定と重なるので、少し下から)
    const bone = (n) => vrm.humanoid.getNormalizedBoneNode(`${spec.side}${n}`);
    const [upper, lower, foot] = [
      bone("UpperLeg"),
      bone("LowerLeg"),
      bone("Foot"),
    ];
    if (upper && lower && foot) {
      const u = Math.min(
        1.5,
        Math.max(
          0.6,
          (lower.position.length() + foot.position.length()) / 0.85,
        ),
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
      add(upper, lower.position, [0.6, 0.85], 0.07);
      add(lower, foot.position, [0, 0.5, 0.85], 0.05);
      add(foot, new THREE.Vector3(), [0], 0.045);
      const geo = footGeometry(vrm, spec.side);
      if (geo) add(foot, geo.fwd.clone().multiplyScalar(0.12), [1], 0.035 * u);
    }
  } else if (spec.collide) {
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
    hasPalm: !!spec.palm || !!spec.foot,
    foot: !!spec.foot,
    samples,
    pointNode,
    skip: new Set(limb?.skip ?? []), // 触れる部位自身の点は、体の当たり判定から外す
    limbCount: spec.foot ? 5 : 4, // 置いた物を避ける点の数(先頭から。手首から先と足は、面に触れるので除く)
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
  const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
  hipBendState.get(hipsNode)?.legs.forEach((l) => (l.free = false));
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
      const key = j.hipMove ? "hips:move" : j.bone;
      if (byBone.has(key)) continue; // 体幹は、鎖どうしで共有する
      const limit = getBoneLimit(j.bone);
      if ((j.hipBend || j.hipMove) && !captureHipBend(vrm)) continue; // 脚がつながっていないモデルは、腰を使わない
      if (j.hipMove) {
        // 腰の平行移動: 基準の姿勢からのずれ(m)を未知数にする
        const st = hipBendState.get(node);
        const joint = {
          node,
          order: "XYZ",
          e: st.t.toArray(),
          trunk: true,
          hip: true,
          move: true,
          state: st,
        };
        byBone.set(key, joint);
        joints.push(joint);
        ["x", "y", "z"].forEach((axis, k) => {
          const w = j.axes[axis];
          if (!w) return;
          const [lo, hi] = HIP_MOVE_RANGE[axis];
          let low = lo * st.len;
          if (axis === "y") {
            // 立ち位置の再計算で、基準の姿勢が少しずつ低くなって、腰が床まで沈み続けないよう、腰の高さの下限を決める
            const baseY = node.getWorldPosition(_v1).y - vrm.scene.position.y -
              st.t.y;
            low = Math.max(low, Math.min(0, HIP_MIN_HEIGHT * st.len - baseY));
          }
          params.push({ joint, k, w, lo: low, hi: hi * st.len });
        });
        // 置いていない足を、前後・外側へ動かす量。足を置く(足裏・かかと・つま先)ときは使わない(置いた足が立ち位置を決める)。
        // 手や、膝・すねなどで触れるときは、届かない・体にめり込むときだけ、必要なぶん使う
        if ((!spec.foot || limbPart(goal.chain, goal.part))) {
          [0, 1].forEach((li) => {
            const sj = {
              node,
              order: "XYZ",
              e: [st.shift[li * 2], st.shift[li * 2 + 1]],
              trunk: true,
              hip: true,
              move: true,
              shift: li,
              state: st,
            };
            joints.push(sj);
            params.push({
              joint: sj,
              k: 0,
              w: SHIFT_WEIGHT,
              lo: 0,
              hi: SHIFT_OUT * st.len,
            });
            params.push({
              joint: sj,
              k: 1,
              w: SHIFT_WEIGHT,
              lo: -SHIFT_BACK * st.len,
              hi: SHIFT_FRONT * st.len,
            });
          });
        }
        continue;
      }
      const joint = {
        node,
        order: limit?.order ?? "XYZ",
        e: [0, 0, 0],
        trunk: BEND_BONES.includes(j.bone),
        hip: !!j.hipBend,
      };
      // 股関節の曲げは、可動域(骨盤の傾き ±20°)ではなく、脚との角度を使う
      joint.e = eulerWithinLimit(
        node.quaternion,
        joint.order,
        j.hipBend ? null : limit,
        flip,
      );
      byBone.set(key, joint);
      joints.push(joint);
      ["x", "y", "z"].forEach((axis, k) => {
        const w = j.axes[axis];
        if (!w) return;
        const range = j.range?.[axis] ?? limit?.[axis] ??
          [-Math.PI, Math.PI]; // 可動域はラジアン
        params.push({ joint, k, w, lo: range[0], hi: range[1] });
      });
    }
    if (!last) return null;
    if (spec.foot) {
      // 足を目標へ動かす脚は、腰の移動で足首を元の位置に留める計算から外す
      const leg = hipBendState.get(hipsNode)
        ?.legs[spec.side === "left" ? 0 : 1];
      if (leg) leg.free = true;
    }
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
    // 骨盤は脚や頭も含むので、「体幹についた目標」の判定には使わない
    trunkNodes: joints.filter((j) => j.trunk && !j.hip).map((j) => j.node),
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
    if (j.move) {
      if (j.shift !== undefined) {
        j.state.shift[j.shift * 2] = j.e[0];
        j.state.shift[j.shift * 2 + 1] = j.e[1];
      } else j.state.t.set(j.e[0], j.e[1], j.e[2]); // 腰の平行移動は、続く hips の回転のところで、まとめて反映する
      continue;
    }
    j.node.quaternion.setFromEuler(
      _eul.set(j.e[0] * ctx.flip, j.e[1], j.e[2] * ctx.flip, j.order),
    );
    if (j.hip) syncHipBend(j.node);
    j.node.updateMatrixWorld(false);
  }
  for (const node of ctx.refresh) node.updateMatrixWorld(false);
  for (const c of ctx.chains) {
    c.P.copy(c.palmLocal).applyMatrix4(c.pointNode.matrixWorld);
    c.N.copy(c.normalLocal).transformDirection(c.pointNode.matrixWorld);
    c.F.copy(c.fingerLocal).transformDirection(c.pointNode.matrixWorld);
    c.excess = 0;
    if (c.contactNormal && c.handPoints) {
      // 手のメッシュのうち、面にいちばん近い(法線の逆向きに、いちばん深い)頂点まで、先端の点をずらす。
      // そうすると、先端の点を面に合わせれば、手のひらの実際の表面が面に触れる
      const w = c.pointNode.matrixWorld.elements;
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
  c.P.copy(c.palmLocal).applyMatrix4(c.pointNode.matrixWorld);
  c.N.copy(c.normalLocal).transformDirection(c.pointNode.matrixWorld);
  c.F.copy(c.fingerLocal).transformDirection(c.pointNode.matrixWorld);
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
const COLLISION_MARGIN = 0.0005; // 体の表面から、これだけ余分に離す(m)
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
const FOOT_RELAX_ERROR = 0.001; // 足の誤差がこれ(m)より大きければ、向きより位置を優先して解き直す

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
  // 床の下へ、腕や脚が潜り込まないようにする(膝・すねを床に付けるとき、足が床を突き抜けて姿勢が定まらなくなるのを防ぐ)
  if (bodySurface?.floorY !== undefined) {
    const floorY = bodySurface.floorY;
    ctx.chains.forEach((c, ci) => {
      for (let k = 0; k < c.samples.length; k++) {
        if (c.skip?.has(k)) continue; // 触れさせる部位は、床に付けたい
        const depth = floorY - (c.samplePos[k * 3 + 1] - c.samples[k].r * 0.5);
        if (depth > 0) {
          // あとで COLLISION_MARGIN が足されるので、引いておく(床は、余白なしで押し返す)
          out.push({
            ci,
            k,
            depth: depth - COLLISION_MARGIN,
            dx: 0,
            dy: 1,
            dz: 0,
          });
        }
      }
    });
  }
  // 置いた物(球で敷き詰めた表面)の中を、腕や脚が通り抜けないようにする
  if (bodySurface?.grids?.length) {
    ctx.chains.forEach((c, ci) => {
      for (let k = 0; k < Math.min(c.limbCount ?? 0, c.samples.length); k++) {
        if (c.skip?.has(k)) continue;
        const x = c.samplePos[k * 3],
          y = c.samplePos[k * 3 + 1],
          z = c.samplePos[k * 3 + 2];
        const rr = c.samples[k].r + COLLISION_BAND;
        for (const g of bodySurface.grids) {
          const h = g.deepest(x, y, z, rr);
          if (h) {
            out.push({
              ci,
              k,
              depth: h.depth - COLLISION_BAND,
              dx: h.dx,
              dy: h.dy,
              dz: h.dz,
            });
          }
        }
      }
    });
  }
  if (!bodySurface?.length) return;
  const mats = bodySurface.map((e) =>
    e.node && e.offset
      ? new THREE.Matrix4().multiplyMatrices(e.node.matrixWorld, e.offset)
      : e.bone.matrixWorld
  );
  ctx.chains.forEach((c, ci) => {
    for (let k = 0; k < c.samples.length; k++) {
      if (c.skip?.has(k)) continue;
      _v1.set(
        c.samplePos[k * 3],
        c.samplePos[k * 3 + 1],
        c.samplePos[k * 3 + 2],
      );
      let depth = 0;
      let dx = 0, dy = 0, dz = 0;
      bodySurface.forEach(({ name, shape, other }, i) => {
        if (!other && isOwnPart(name, c.side, c.foot)) return;
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
  const hipSt = ctx.joints.find((j) => j.move)?.state ?? null; // 腰を動かせるとき、足が浮かないかも見る
  const legRows = hipSt ? hipSt.legs.length : 0;
  const overOf = () => hipSt ? hipSt.legs.reduce((m, l) => m + l.over, 0) : 0;
  // 腰を曲げる・しゃがむときに、太ももや膝が、自分の胴(spine・chest・upperChest)にめり込まないかも見る
  const trunkShapes = hipSt
    ? (bodySurface ?? []).filter((e) => !e.other && SELF_TRUNK.includes(e.name))
    : [];
  const selfRows = trunkShapes.length ? hipSt.legs.length : 0;
  const selfDepth = new Float64Array(selfRows);
  const selfOf = () => {
    if (!selfRows) return 0;
    const u = Math.min(1.5, Math.max(0.6, hipSt.len / 0.82));
    const mats = trunkShapes.map((e) =>
      e.node && e.offset
        ? new THREE.Matrix4().multiplyMatrices(e.node.matrixWorld, e.offset)
        : e.bone.matrixWorld
    );
    let sum = 0;
    for (let i = 0; i < selfRows; i++) {
      const leg = hipSt.legs[i];
      let worst = 0;
      for (const [a, b, t, r] of SELF_LEG_SAMPLES) {
        const nodeA = leg[a], nodeB = b && leg[b];
        const p = nodeA.getWorldPosition(_v2);
        if (nodeB) p.lerp(nodeB.getWorldPosition(_v3), t);
        trunkShapes.forEach(({ shape }, k) => {
          const d = shape.calculateCollision(mats[k], p, r * u, _dir);
          if (d < 0) worst = Math.max(worst, -d);
        });
      }
      selfDepth[i] = worst;
      sum += worst;
    }
    return sum;
  };
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
    return { per, maxDepth, over: overOf(), self: selfOf() };
  };
  const costOf = ({ per, maxDepth, over, self = 0 }) =>
    per.reduce((sum, p) => sum + p.posErr + p.rotErr * ROT_WEIGHT, 0) +
    maxDepth + over * LEG_REACH_WEIGHT + self * SELF_WEIGHT;

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
        ) && ev.maxDepth < 1e-3 && ev.over < 1e-3 && ev.self < 1e-3
      ) break;
      const cost = costOf(ev);
      if (cost < best.cost) best = { cost, e: snapshot() };
      stalled = cost > lastCost * 0.99 ? stalled + 1 : 0;
      if (stalled >= STALL_LIMIT) break;
      lastCost = cost;

      const hits = _hits.slice();
      const rows = baseRows + hits.length + legRows + selfRows;
      const rhs = new Array(rows).fill(0);
      const legRow = baseRows + hits.length; // 足が浮く分の行(あれば)
      const selfRow = legRow + legRows; // 太ももや膝が、自分の胴にめり込む分の行(あれば)
      for (let i = 0; i < legRows; i++) {
        rhs[legRow + i] = hipSt.legs[i].over * LEG_REACH_WEIGHT;
      }
      for (let i = 0; i < selfRows; i++) {
        rhs[selfRow + i] = selfDepth[i] * SELF_WEIGHT;
      }
      const baseOver = hipSt?.legs.map((l) => l.over);
      const baseSelf = Array.from(selfDepth);
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
        for (let i = 0; i < legRows; i++) {
          J[legRow + i][c] = (hipSt.legs[i].over - baseOver[i]) *
            LEG_REACH_WEIGHT / FD_DELTA;
        }
        if (selfRows) {
          selfOf();
          for (let i = 0; i < selfRows; i++) {
            J[selfRow + i][c] = (selfDepth[i] - baseSelf[i]) * SELF_WEIGHT /
              FD_DELTA;
          }
          baseSelf.forEach((v, i) => (selfDepth[i] = v)); // 次の未知数のために、元の値に戻す
        }
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
  const reachError = goals.some((g) => IK_CHAINS[g.chain].foot)
    ? FOOT_RELAX_ERROR * 2
    : TRUNK_REACH_ERROR;
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
    // 腰の動き: 腕や背骨で届くなら、腰は使わない。届かなければ、まず前屈だけ使い、それでも届かなければ、しゃがみも使う。
    // 各段は「前の段で届かなかったときだけ」進み、戻るときは条件を厳しくして(ヒステリシス)、境目で行ったり来たりしないようにする
    const bendParams = params.filter((p) => p.joint.hip && !p.joint.move);
    const moveParams = params.filter((p) => p.joint.move);
    if (bendParams.length || moveParams.length) {
      const hipParams = [...bendParams, ...moveParams];
      const hipW = hipParams.map((p) => p.w);
      const saved = ctx.joints.map((j) => j.e.slice());
      const bent = bendParams.some((p) => p.joint.e[p.k] > HIP_BENT_MIN);
      const squatting = moveParams.some((p) =>
        p.joint.shift === undefined && Math.abs(p.joint.e[p.k]) > HIP_MOVE_MIN
      );
      const rest = (ps) =>
        ps.forEach((p) => {
          p.w = 0;
          p.joint.e[p.k] = Math.max(p.lo, Math.min(p.hi, 0));
        });
      const reached = (limit) => ev.per.every((p) => p.posErr <= limit);
      // いまの姿勢(腰を曲げたまま)での誤差。腰を戻す条件は、これより少し悪いだけ、まで許す
      // (接触のように、元々 2 mm より大きく残る目標でも、戻せなくなって曲げっぱなしになるのを防ぐ)
      forward(ctx);
      const curErr = Math.max(...evaluate().per.map((p) => p.posErr));
      // (目標を大きく動かした直後は、今の姿勢の誤差が大きいだけなので、上限を設ける。上限がないと、腰を下げたまま戻れなくなる)
      const release = HIP_RELEASE_ERROR + Math.min(curErr, HIP_RELEASE_CAP);
      const back = () => {
        ctx.joints.forEach((j, i) => j.e.splice(0, 3, ...saved[i]));
        hipParams.forEach((p, i) => (p.w = hipW[i]));
      };
      rest(hipParams); // 1. 腰を使わない
      ({ ev, cost } = run());
      if (!reached(bent || squatting ? release : reachError)) {
        back();
        rest(moveParams); // 2. 前屈だけ使う
        ({ ev, cost } = run());
        if (!reached(squatting ? release : reachError)) {
          // 2 までの解(いちばんよかった姿勢)。しゃがんだ解が、これより良くなければ、これを採る
          const prev = { cost, e: ctx.joints.map((j) => j.e.slice()) };
          back(); // 3. しゃがみも使う
          if (goals.some((g) => IK_CHAINS[g.chain].foot)) {
            // 足は、腰を下げる量で姿勢が大きく変わり、一度の更新で行き過ぎやすい。腰の高さをいくつか変えて始め、いちばんよい解を採る
            const start = ctx.joints.map((j) => j.e.slice());
            const mp = moveParams[0];
            // 今の姿勢より良くならなければ、今の姿勢のまま(届かないときに、毎回違う姿勢へ飛んでぷるぷるするのを防ぐ)
            let bestRun = prev;
            const starts = goals.some((g) => limbPart(g.chain, g.part))
              ? LIMB_SQUAT_STARTS
              : FOOT_SQUAT_STARTS;
            for (const f of starts) {
              ctx.joints.forEach((j, i) => j.e.splice(0, 3, ...start[i]));
              mp.joint.e[mp.k] = Math.max(mp.lo, -f * mp.joint.state.len);
              const r = run();
              if (r.cost < bestRun.cost - 1e-4) {
                bestRun = {
                  cost: r.cost,
                  e: ctx.joints.map((j) => j.e.slice()),
                };
              }
              if (reached(reachError)) break;
            }
            ctx.joints.forEach((j, i) => j.e.splice(0, 3, ...bestRun.e[i]));
            forward(ctx);
            ev = evaluate();
            cost = bestRun.cost;
          } else {
            ({ ev, cost } = run());
          }
        }
      }
    } else {
      ({ ev, cost } = run());
    }
  }
  // 足は、浮いたり埋まったりが目立つので、手より厳しく位置を優先する
  const relaxError = goals.some((g) => IK_CHAINS[g.chain].foot)
    ? FOOT_RELAX_ERROR
    : TRUNK_REACH_ERROR;
  // それでも届かないときは、手のひらの向きの優先度を下げて、位置を優先する(向きが少しずれても、手が目標の近くへ行く方がよい)
  if (
    !globalThis.__noRelax && ts.some((t) => t.rows === 6) &&
    ev.per.some((p) => p.posErr > relaxError)
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
  const initialHip = hipOffset(vrm);
  const direct = solveCore(vrm, goals, bodySurface);
  const directPose = nodes.map((n) => n.quaternion.clone());
  const directHip = hipOffset(vrm);
  nodes.forEach((n, i) => n.quaternion.copy(initial[i]));
  settleHipBend(vrm, initialHip);
  vrm.scene.updateMatrixWorld(true);
  solveCore(
    vrm,
    goals.map((g) => ({ ...g, target: { position: g.target.position } })),
    bodySurface,
  );
  const staged = solveCore(vrm, goals, bodySurface);
  if (staged && direct && staged[0].totalCost >= direct[0].totalCost) {
    nodes.forEach((n, i) => n.quaternion.copy(directPose[i]));
    settleHipBend(vrm, directHip);
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
  // 腕の付け根の上腕から先にある骨はすべて腕(ひねり補助のボーンも含む)
  const root = vrm.humanoid.getRawBoneNode(
    `${side}${IK_CHAINS[chainName].foot ? "UpperLeg" : "UpperArm"}`,
  );
  if (!root) return false;
  const inArm = (b) => {
    for (let o = b; o; o = o.parent) if (o === root) return true;
    return false;
  };
  const bones = mesh.skeleton?.bones;
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  if (!bones || !si || !sw) return false;
  // 三角形の 3 頂点の、手のボーンへの重みの平均が半分を超えれば、手のメッシュとみなす
  let w = 0;
  for (const v of [face.a, face.b, face.c]) {
    for (let k = 0; k < 4; k++) {
      const wk = sw.getComponent(v, k);
      if (wk > 0 && inArm(bones[si.getComponent(v, k)])) w += wk;
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
    this._pending = {}; // chain → { part, fingers }。目標点を置く前に選んだ部位・指(次に置く目標点に使う)
    this.walk = true; // 届かないとき、体ごと歩いて近づくか
    this._guards = new WeakMap();
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
    if (e) e.refineId = (e.refineId ?? 0) + 1; // 仕上げの途中なら中止
    if (!e) {
      e = chains[chain] = {
        target: new THREE.Vector3(),
        chain,
        normal: null,
        fingerBase: null,
        roll: 0,
        manualRoll: false, // 手のひらの回転を自分で決めたか(まだなら、いちばん無理のない向きを自動で選ぶ)
        handPoints: null, // 手のメッシュの接触用の点(最初に解くときに集める)
        part: IK_CHAINS[chain].foot ? "sole" : "center", // 面に触れさせる手の部位(HAND_PARTS)、足の部位(FOOT_PARTS)
        fingers: ["Index"], // part が "fingers" のとき、触れる指(FINGER_KEYS)
        fingerPoints: null, // 指ごとの接触用の頂点
        fingerBackup: null, // 指で触れる前の、指の姿勢(部位を戻すときに戻す)
        gripFingers: [...FINGER_KEYS], // 握る指(FINGER_KEYS)。握らない指は、そのまま
        gripSpread: 0, // 親指の開き(0〜1)。0 で他の指と一緒に閉じ、1 で広げたまま
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
    if ((IK_CHAINS[chain].foot ? FOOT_PARTS : HAND_PARTS)[extra.part]) {
      e.part = extra.part;
    }
    if (Array.isArray(extra.fingers)) {
      const keys = FINGER_KEYS.filter((k) => extra.fingers.includes(k));
      if (keys.length) e.fingers = keys;
    }
    this._clearGrip(vrm, e);
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

  /** 肘・前腕・膝・すねの向き(骨の向き)の基準(ロール 0°)。今の骨の向きを面の上に落としたもの */
  _limbBase(vrm, chain, e) {
    const cur = getEndPoint(vrm, chain, e.part)?.fingerDir;
    if (cur) {
      const f = cur.clone().addScaledVector(e.normal, -cur.dot(e.normal));
      if (f.lengthSq() > 0.09) return f.normalize();
    }
    return this._canonicalBase(vrm, e.normal);
  }

  /** 指(肘・膝などは骨)の向き(基準を、法線まわりにロールの角度だけ回したもの) */
  _fingerDir(e) {
    if (!e.normal || !e.fingerBase) return null;
    return e.fingerBase.clone().applyAxisAngle(e.normal, e.roll);
  }

  /** 手のひらの回転(ロール)を変える。ラジアン。初めて回すときは、今の指の向きを0°にする */
  setRoll(vrm, chain, roll) {
    const e = this._chains(vrm)?.[chain];
    if (!e?.normal) return;
    e.fingerBase ??= limbPart(chain, e.part)
      ? this._limbBase(vrm, chain, e)
      : this._canonicalBase(vrm, e.normal);
    e.manualRoll = true; // 自分で回したら、自動の推定はもうしない
    e.roll = roll;
    if (e.grip) e.grip.dirty = true; // 手の向きが変わるので、握りの接触は調べ直す
  }

  /** 目標点を追随させ始める。手のひらの回転を自分で決めていなければ、動かしている間は向きを縛らない */
  beginFollow(vrm, chain, refine = false) {
    const e = this._chains(vrm)?.[chain];
    if (!e) return;
    e.refineId = (e.refineId ?? 0) + 1; // 仕上げの途中なら中止
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
    if (IK_CHAINS[chain].foot && !limbPart(chain, e.part)) {
      // 足: 接触の頂点や握りは使わない。向きは、今の足の向きから始める(回転のスライダーで変える)
      if (e.normal && !e.fingerBase) {
        e.fingerBase = this._footBase(vrm, chain, e);
      }
      e.refine = false;
      this._callbacks.onChange?.();
      return;
    }
    this._collectPoints(vrm, chain, e);
    this._attach(vrm, chain, e); // 体幹につく部位なら、向きを選ぶときも体幹を固定する
    if (e.grip) e.grip.dirty = true;
    const refine = e.refine;
    // 微調整のあとは、今の向きのまま届いていれば、向きは選び直さない(選び直すと、姿勢が大きく変わる)
    let keep = false;
    if (refine && e.fingerBase) {
      this._ensurePoints(vrm, chain, e);
      const r = solveChains(
        vrm,
        [this._goal(chain, e)],
        this._surfaces(vrm) ?? null,
      )?.[0];
      keep = !!r && r.posErr <= RETRY_ERROR && r.depth <= STUCK_DEPTH;
    }
    e.refine = false;
    if (!keep && e.normal && !e.manualRoll) this.autoRoll(vrm, chain);
    // 置いた姿勢はすぐ描画させて、接触の仕上げは、そのあとで少しずつ行う(1 回ごとに間をあけて、画面を止めない)
    this._refineContact(vrm, chain, e);
  }

  /**
   * 目標点を、いちばん近い体の部位につける。その部位が動いたとき(ポーズを変える、モデルを動かす)、目標点もついていく。
   * 体の表面から離れている(床や物の上など)ときは、つけない(ワールドに固定)
   */
  _attach(vrm, chain, e) {
    e.anchor = null;
    const bodySurface = this._surfaces(vrm);
    if (!bodySurface?.length) return;
    vrm.scene.updateMatrixWorld(true);
    const side = IK_CHAINS[chain].side;
    let best = null;
    let bestName = null;
    let bestDist = 0;
    for (const { name, node, offset, shape, other } of bodySurface) {
      if (
        !node || !offset || !name ||
        (!other && isOwnPart(name, side, IK_CHAINS[chain].foot))
      ) {
        continue;
      }
      if (other) node.updateWorldMatrix(true, false); // 他のモデルの今の姿勢で判定する
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

  /** 肩から、触れる部位までの届く長さ(手なら腕の長さ、肘なら上腕の長さ) */
  _armReach(pos, arm, part) {
    const upper = pos(arm[0]).distanceTo(pos(arm[1]));
    const lower = pos(arm[1]).distanceTo(pos(arm[2]));
    const r = HAND_PARTS[part]?.reach ?? [1, 1];
    return upper * r[0] + lower * r[1];
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
    if (limbPart(chain, e.part)?.noAutoRoll) return; // 肘など、面の上での回転は自分で回すまで決めない
    const bodySurface = this._surfaces(vrm) ?? null;
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
      .filter((j) => !BEND_BONES.includes(j.bone))
      .map((j) => vrm.humanoid.getNormalizedBoneNode(j.bone))
      .filter(Boolean);
    const savedPose = nodes.map((n) => n.quaternion.clone());
    savedPose.hip = hipOffset(vrm);
    const setPose = (pose) => {
      nodes.forEach((n, i) => n.quaternion.copy(pose[i]));
      settleHipBend(vrm, pose.hip);
    };
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
          const pose = nodes.map((n) => n.quaternion.clone());
          pose.hip = hipOffset(vrm);
          best = { roll, score, posErr: results[0].posErr, pose };
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
    if (IK_CHAINS[chain].foot && limbPart(chain, e.part)) {
      // 膝・すね: 手と同じく、メッシュの接触点と法線で合わせる
      return {
        chain,
        part: e.part,
        handPoints: e.handPoints,
        lockTrunk: false,
        target: this._target(e, this._fingerDir(e)),
      };
    }
    if (IK_CHAINS[chain].foot) {
      return {
        chain,
        part: e.part,
        handPoints: null,
        lockTrunk: false,
        target: this._footTarget(e, this._fingerDir(e)),
      };
    }
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
   * 足の目標。足裏を面に向け、つま先を面の上で flat へ向ける。かかとだけ・つま先だけで触れるときは、足を傾ける(足首から先だけで、つま先やかかとを浮かせる)
   */
  _footTarget(e, flat) {
    const target = { position: e.target, palmNormal: null, fingerDir: null };
    if (!e.normal) return target;
    const t = (FOOT_PARTS[e.part] ?? FOOT_PARTS.sole).tilt;
    const c = Math.cos(t), s = Math.sin(t);
    target.palmNormal = e.normal.clone().multiplyScalar(-c);
    if (!flat) return target;
    target.palmNormal.addScaledVector(flat, s);
    target.fingerDir = flat.clone().multiplyScalar(c).addScaledVector(
      e.normal,
      s,
    );
    return target;
  }

  /**
   * 足の向き(つま先の向き)の基準(ロール 0°)。床のような面では、今の足の向きを面の上に落としたもの。落とせなければ(壁など)、手と同じ基準
   */
  _footBase(vrm, chain, e) {
    const cur = getEndPoint(vrm, chain, e.part)?.fingerDir;
    if (cur && Math.abs(e.normal.y) > 0.8) {
      const f = cur.clone().addScaledVector(e.normal, -cur.dot(e.normal));
      if (f.lengthSq() > 0.09) return f.normalize();
    }
    return this._canonicalBase(vrm, e.normal);
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

  /** 握る指(FINGER_KEYS のうち 1 本以上)と、親指の開き(0〜1) */
  getGripSetup(vrm, chain) {
    const e = this._chains(vrm)?.[chain];
    return {
      fingers: e?.gripFingers ?? [...FINGER_KEYS],
      spread: e?.gripSpread ?? 0,
    };
  }

  /** 握る指を決める。握らない指は、握る前の姿勢のままにする */
  setGripFingers(vrm, chain, keys) {
    const e = this._chains(vrm)?.[chain];
    const next = FINGER_KEYS.filter((k) => keys.includes(k));
    if (!e || !next.length) return;
    e.gripFingers = next;
    if (e.grip) e.grip.dirty = true; // 新しく握る指の接触を調べる
    this._callbacks.onChange?.();
  }

  /** 親指の開き。大きいほど、親指を広げたまま(0 なら、他の指と同じだけ閉じる) */
  setGripSpread(vrm, chain, spread) {
    const e = this._chains(vrm)?.[chain];
    if (!e) return;
    e.gripSpread = Math.min(1, Math.max(0, spread));
    this._callbacks.onChange?.();
  }

  /** 握りの状態(0〜1)。0 なら握っていない */
  getGrip(vrm, chain) {
    return this._chains(vrm)?.[chain]?.grip?.amount ?? 0;
  }

  /**
   * 手のひらで触れた手の指を、触れるまで曲げていく(握る)。amount: 0(開く)〜1(触れるまで、または可動域の端まで閉じる)。
   * 指ごとに、体の表面・床・置いた物に触れたところで止まる。手のひらの位置は動かさず、指の関節だけを変える。
   */
  setGrip(vrm, chain, amount) {
    const e = this._chains(vrm)?.[chain];
    if (!e || e.part === "fingers") return;
    const a = Math.min(1, Math.max(0, amount));
    if (a === 0) {
      this._clearGrip(vrm, e);
    } else {
      e.grip ??= this._initGrip(vrm, chain);
      e.grip.amount = a;
    }
    this._callbacks.onChange?.();
  }

  /** 触れるまで、いっぱいに握る(接触は調べ直す) */
  autoGrip(vrm, chain) {
    const e = this._chains(vrm)?.[chain];
    if (!e || e.part === "fingers") return;
    e.grip ??= this._initGrip(vrm, chain);
    e.grip.amount = 1;
    e.grip.dirty = true;
    e.grip.stamp = 0; // すぐ調べ直す
    this._callbacks.onChange?.();
  }

  /**
   * 親指の先の 2 つの関節(第 2・第 1 関節)の、曲げる軸と最大の角度。
   * 親指は、指と違って y 軸まわりに曲がる(指先が手のひらを横切って小指側へ閉じる)。曲げる側の向きは、可動域の大きいほう
   * (右手は左手のミラーなので、符号が逆になる)。戻り値は [null, 第 2 関節, 第 1 関節]
   */
  _thumbFlex(vrm, side) {
    const flex = (name) => {
      if (!vrm.humanoid.getNormalizedBoneNode(`${side}${name}`)) return null;
      const [lo, hi] = getBoneLimit(`${side}${name}`)?.y ?? [0, 0];
      const dir = Math.abs(hi) >= Math.abs(lo) ? 1 : -1;
      return {
        axis: new THREE.Vector3(0, dir, 0),
        max: Math.abs(dir > 0 ? hi : lo),
      };
    };
    const prox = flex("ThumbProximal"), dist = flex("ThumbDistal");
    return prox && dist ? [null, prox, dist] : null;
  }

  /**
   * 親指を曲げる向き(x・y・z の可動域の、下端 -1 / 上端 +1 / 動かさない 0)を、実際に曲げてみて決める。
   * 親指の軸の向きはモデルによって違うので、人差し指の腹にいちばん近づく組み合わせを選ぶ。
   */
  _thumbGripDirections(vrm, side, flex) {
    const names = ["ThumbMetacarpal", "ThumbProximal", "ThumbDistal"];
    const nodes = names.map((n) =>
      vrm.humanoid.getNormalizedBoneNode(`${side}${n}`)
    );
    const target = vrm.humanoid.getNormalizedBoneNode(
      `${side}IndexIntermediate`,
    );
    if (nodes.some((n) => !n) || !target || !flex) return [-1, 1, 1];
    const limits = names.map((n) => getBoneLimit(`${side}${n}`));
    const saved = nodes.map((n) => n.quaternion.clone());
    vrm.scene.updateMatrixWorld(true);
    // 狙う点: 人差し指の中節から、手のひら側(PALM_NORMAL)へ指の太さ分だけ出した所(親指の腹が、人差し指の腹と向かい合う位置)
    const hand = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`);
    const goal = target.getWorldPosition(new THREE.Vector3());
    if (hand) {
      goal.addScaledVector(
        PALM_NORMAL.clone().transformDirection(hand.matrixWorld),
        0.012,
      );
    }
    const tip = new THREE.Vector3();
    let best = [-1, 1, 1], bestDist = Infinity;
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        for (const dz of [-1, 0, 1]) {
          if (!dx && !dy && !dz) continue;
          const d = [dx, dy, dz];
          nodes.forEach((n, i) => {
            const l = limits[i];
            const v = (range, dir) =>
              dir === 0 ? 0 : range?.[dir > 0 ? 1 : 0] ?? 0;
            // 付け根(0 番目)は x・y・z、その先の 2 つの関節は、手のひら側への曲げの軸で最大まで
            if (i === 0) {
              n.quaternion.setFromEuler(
                _eul.set(
                  v(l?.x, dx),
                  v(l?.y, dy),
                  v(l?.z, dz),
                  l?.order ?? "XYZ",
                ),
              );
            } else {
              n.quaternion.setFromAxisAngle(flex[i].axis, flex[i].max);
            }
          });
          nodes[0].updateMatrixWorld(true);
          // 親指の先(末節の関節から、一つ前の節と同じ向きに少し伸ばした点)が、手のひらに近いか
          nodes[2].getWorldPosition(tip);
          tip.addScaledVector(
            tip.clone().sub(nodes[1].getWorldPosition(_v1)),
            0.7,
          );
          const dist = tip.distanceTo(goal);
          if (dist < bestDist) {
            bestDist = dist;
            best = d;
          }
        }
      }
    }
    nodes.forEach((n, i) => n.quaternion.copy(saved[i]));
    vrm.scene.updateMatrixWorld(true);
    return best;
  }

  /**
   * 親指の「いっぱいに閉じた姿勢」を、他の指(人差し指から順に、握る指のうち最初の 1 本)の指先と向かい合う姿勢にする。
   * 親指の関節の可動域を粗い格子で試し、指先の腹が相手の指先の腹とちょうど向かい合うものから、触れていない姿勢を選ぶ。
   * (他の指が物を囲んで止まっていれば、親指もその物の側へ回る。決められなければ、曲げる向きだけを決めた姿勢のまま)
   */
  _fitThumb(vrm, chain, e, sweep) {
    const grip = e.grip;
    const side = IK_CHAINS[chain].side;
    const goalKey = ["Index", "Middle", "Ring", "Little"].find((k) =>
      e.gripFingers.includes(k)
    );
    if (!goalKey || grip.joints.Thumb.length !== 3) return;
    // 他の指を、触れたところまで閉じた姿勢にして、その指先を相手にする
    for (const k of FINGER_KEYS.slice(1)) {
      this._poseFinger(grip, k, e.gripFingers.includes(k) ? grip.stops[k] : 0);
    }
    const node = (n) => vrm.humanoid.getNormalizedBoneNode(`${side}${n}`);
    const d = node(`${goalKey}Distal`), m = node(`${goalKey}Intermediate`);
    if (!d || !m) return;
    const padOf = (a, b) => {
      const pa = a.getWorldPosition(new THREE.Vector3());
      return pa.addScaledVector(pa.clone().sub(b.getWorldPosition(_v1)), 0.7);
    };
    const goal = padOf(d, m);
    const nodes = grip.joints.Thumb.map((j) => j.node);
    const limits = FINGER_JOINTS.Thumb.map(([n]) =>
      getBoneLimit(`${side}${n}`)
    );
    const flex = grip.thumbFlex; // 握る前の姿勢で決めたもの(親指を動かしたあとの向きで決めると、ずれる)
    if (!flex) return;
    const at = (range, u) => range ? range[0] + (range[1] - range[0]) * u : 0;
    const apply = (c) => {
      nodes.forEach((n, i) => {
        const l = limits[i];
        // 付け根(0 番目)は x・y・z、その先の 2 つの関節は、手のひら側への曲げの軸(最大角の割合 c)
        if (i === 0) {
          n.quaternion.setFromEuler(
            _eul.set(
              at(l?.x, c[0]),
              at(l?.y, c[1]),
              at(l?.z, c[2]),
              l?.order ?? "XYZ",
            ),
          );
        } else {
          n.quaternion.setFromAxisAngle(flex[i].axis, flex[i].max * c[2 + i]);
        }
      });
      nodes[0].updateMatrixWorld(true);
    };
    const U3 = [0, 1 / 3, 2 / 3, 1], U5 = [0, 0.25, 0.5, 0.75, 1];
    const cands = [];
    for (const a of U3) {
      for (const b of U3) {
        for (const c of U3) {
          for (const x of U5) {
            for (const z of U5) {
              const prm = [a, b, c, x, z]; // 付け根の x・y・z、第 2 関節・第 1 関節の曲げ
              apply(prm);
              const tip = padOf(nodes[2], nodes[1]);
              cands.push([Math.abs(tip.distanceTo(goal) - THUMB_PAD_GAP), prm]);
            }
          }
        }
      }
    }
    cands.sort((p, q) => p[0] - q[0]);
    // 上位の候補ごとに、閉じていって止まった姿勢の指先の腹が、相手の指先の腹にどれだけ近いかを比べる
    // (最後の姿勢が良くても、そこへ行く途中で物にぶつかって止まるものがあるため)
    let best = null;
    for (const [, prm] of cands.slice(0, THUMB_CANDIDATES)) {
      apply(prm);
      grip.joints.Thumb.forEach((j, i) => j.full.copy(nodes[i].quaternion));
      const stop = sweep("Thumb");
      this._poseFinger(grip, "Thumb", stop);
      // 近さが同じくらいなら、指の関節をよく曲げた(自然な握りの)ほうを選ぶ
      const gap =
        Math.abs(padOf(nodes[2], nodes[1]).distanceTo(goal) - THUMB_PAD_GAP) +
        0.004 * (2 - prm[3] - prm[4]);
      if (!best || gap < best.gap) {
        best = { gap, prm };
      }
    }
    if (best) {
      apply(best.prm);
      grip.joints.Thumb.forEach((j, i) => j.full.copy(nodes[i].quaternion));
    }
    grip.joints.Thumb.forEach((j) => j.node.quaternion.copy(j.base));
    nodes[0].updateMatrixWorld(true);
  }

  /** 握る前の指の姿勢と、いっぱいに曲げた姿勢を、関節ごとに控える */
  _initGrip(vrm, chain) {
    const side = IK_CHAINS[chain].side;
    const flip = vrm.meta?.metaVersion === "0" ? -1 : 1;
    const flexEnd = (r) => {
      const [lo, hi] = r ?? [0, 0];
      return Math.abs(lo) > Math.abs(hi) ? lo : hi; // 曲げる側の端
    };
    const joints = {};
    const thumbFlex = this._thumbFlex(vrm, side);
    const thumbDir = this._thumbGripDirections(vrm, side, thumbFlex);
    for (const key of FINGER_KEYS) {
      joints[key] = FINGER_JOINTS[key].map(([name], i) => {
        const node = vrm.humanoid.getNormalizedBoneNode(`${side}${name}`);
        if (!node) return null;
        const limit = getBoneLimit(`${side}${name}`);
        const r = GRIP_RATIO[key][i];
        const end = (range, dir) =>
          (dir === 0 ? 0 : range?.[dir > 0 ? 1 : 0] ?? 0) * r;
        const full = key === "Thumb"
          // 親指の付け根(0 番目)は自由に動く。その先の 2 つの関節は、手のひら側への曲げの軸で曲げる
          ? (i === 0 || !thumbFlex
            ? new THREE.Quaternion().setFromEuler(
              _eul.set(
                end(limit?.x, thumbDir[0]),
                end(limit?.y, thumbDir[1]),
                end(limit?.z, thumbDir[2]),
                limit?.order ?? "XYZ",
              ),
            )
            : new THREE.Quaternion().setFromAxisAngle(
              thumbFlex[i].axis,
              thumbFlex[i].max,
            ))
          : new THREE.Quaternion().setFromEuler(
            _eul.set(0, 0, flexEnd(limit?.z) * r * flip, limit?.order ?? "XYZ"),
          );
        return { node, base: node.quaternion.clone(), full };
      }).filter(Boolean);
    }
    return {
      amount: 0,
      joints,
      thumbFlex,
      stops: Object.fromEntries(FINGER_KEYS.map((k) => [k, 1])),
      dirty: true,
      stamp: 0,
    };
  }

  /** 握りをやめて、握る前の指の姿勢に戻す */
  _clearGrip(vrm, e) {
    if (!e.grip) return;
    for (const list of Object.values(e.grip.joints)) {
      for (const j of list) j.node.quaternion.copy(j.base);
    }
    e.grip = null;
    vrm.scene.updateMatrixWorld(true);
  }

  _poseFinger(grip, key, t) {
    for (const j of grip.joints[key]) {
      j.node.quaternion.copy(j.base).slerp(j.full, t);
    }
    grip.joints[key][0]?.node.updateMatrixWorld(true);
  }

  /**
   * 指ごとに、閉じていって最初に触れる所(0〜1)を調べる。触れる相手は、体の表面(自分の腕は除く)・床・置いた物。
   * 手が動いたとき(離したときや手のひらを回したとき)は、調べ直す。
   */
  _computeGripStops(vrm, chain, e) {
    const grip = e.grip;
    const side = IK_CHAINS[chain].side;
    vrm.scene.updateMatrixWorld(true);
    const sets = collectFingerPoints(vrm, chain, FINGER_KEYS);
    const bodySurface = this._surfaces(vrm) ?? [];
    const mats = bodySurface.map((b) =>
      b.node && b.offset
        ? new THREE.Matrix4().multiplyMatrices(b.node.matrixWorld, b.offset)
        : b.bone.matrixWorld
    );
    const p = new THREE.Vector3();
    const run = (inside) => {
      // 指の点(key の指、骨 b の i 番目)が、何かに入っているか
      const hitAt = (node, pts, i) => {
        p.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(node.matrixWorld);
        if (p.y < -GRIP_MARGIN) return true; // 床
        for (let k = 0; k < bodySurface.length; k++) {
          if (!bodySurface[k].other && isOwnPart(bodySurface[k].name, side)) {
            continue;
          }
          if (
            bodySurface[k].shape.calculateCollision(mats[k], p, 0, _dir) <
              -GRIP_MARGIN
          ) return true;
        }
        return !!inside?.(p);
      };
      const strideOf = (pts) =>
        3 * Math.max(1, Math.floor(pts.length / 3 / GRIP_POINTS));
      // 開いた姿勢で、もう何かに入っている点。握り始めの接触(手を物に押し当てているなど)は、止める理由にしない
      const skip = {};
      for (const key of FINGER_KEYS) {
        if (!sets?.[key] || !e.gripFingers.includes(key)) continue;
        this._poseFinger(grip, key, 0);
        skip[key] = new Set();
        sets[key].forEach(({ node, pts }, b) => {
          for (let i = 0; i < pts.length; i += strideOf(pts)) {
            if (hitAt(node, pts, i)) skip[key].add(b * 1e6 + i);
          }
        });
      }
      const collides = (key) => {
        const ignore = skip[key];
        let b = 0;
        for (const { node, pts } of sets?.[key] ?? []) {
          for (let i = 0; i < pts.length; i += strideOf(pts)) {
            if (ignore?.has(b * 1e6 + i)) continue;
            if (hitAt(node, pts, i)) return true;
          }
          b++;
        }
        return false;
      };
      // 指を閉じていき、最初に触れる所(0〜1)を返す
      const sweep = (key) => {
        let lo = 0, hi = -1;
        for (let i = 1; i <= GRIP_STEPS; i++) {
          this._poseFinger(grip, key, i / GRIP_STEPS);
          if (collides(key)) {
            hi = i / GRIP_STEPS;
            break;
          }
          lo = i / GRIP_STEPS;
        }
        if (hi < 0) return 1;
        for (let i = 0; i < GRIP_BISECT; i++) {
          const mid = (lo + hi) / 2;
          this._poseFinger(grip, key, mid);
          if (collides(key)) hi = mid;
          else lo = mid;
        }
        return lo;
      };
      // 親指は、他の指が閉じた姿勢が決まってから、その指先へ向かい合わせるので、最後にする
      for (const key of [...FINGER_KEYS.slice(1), "Thumb"]) {
        if (!sets?.[key] || !e.gripFingers.includes(key)) {
          grip.stops[key] = 1;
          continue;
        }
        if (key === "Thumb") this._fitThumb(vrm, chain, e, sweep);
        grip.stops[key] = sweep(key);
      }
    };
    const withObjects = this._callbacks.withObjectTest;
    if (withObjects) withObjects(run);
    else run(null);
    grip.dirty = false;
    grip.stamp = performance.now();
  }

  /** 握りの姿勢を、指の関節に書く。vrm.update の前に呼ぶ */
  _applyGrip(vrm, chain, e) {
    const grip = e.grip;
    if (!grip) return;
    if (grip.dirty && performance.now() - grip.stamp > GRIP_INTERVAL) {
      this._computeGripStops(vrm, chain, e);
    }
    for (const key of FINGER_KEYS) {
      let t = 0;
      if (e.gripFingers.includes(key)) {
        const want = key === "Thumb"
          ? grip.amount * (1 - e.gripSpread)
          : grip.amount;
        t = Math.min(want, grip.stops[key]);
      }
      this._poseFinger(grip, key, t);
    }
  }

  /**
   * 手の骨(手のひら・甲・掌底。指は除く)の頂点のうち、点 center の近くのものの世界座標。3 つずつ並べた配列
   */
  _handBodyPoints(vrm, chain, center) {
    const spec = IK_CHAINS[chain];
    const raw = vrm.humanoid.getRawBoneNode(`${spec.side}Hand`);
    if (!raw) return [];
    const armRoot = vrm.humanoid.getRawBoneNode(`${spec.side}UpperArm`);
    const inArm = (b) => {
      for (let n = b; n; n = n.parent) if (n === armRoot) return true;
      return false;
    };
    const out = [];
    const v = new THREE.Vector3();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const si = o.geometry.attributes.skinIndex,
        sw = o.geometry.attributes.skinWeight;
      if (!si || !sw) return;
      // 手の骨が最も強い頂点は、メッシュごとに 1 回だけ探して覚える(毎回全頂点を調べると重い)
      this._handVertices ??= new WeakMap();
      let ids = this._handVertices.get(o)?.[spec.side];
      if (!ids) {
        ids = [];
        for (let i = 0; i < si.count; i++) {
          let best = 0, bw = -1;
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k);
            if (w > bw) {
              bw = w;
              best = si.getComponent(i, k);
            }
          }
          const bone = o.skeleton.bones[best];
          if (
            bone === raw ||
            (/roll/i.test(bone.name) && /hand/i.test(bone.name) &&
              inArm(bone))
          ) ids.push(i);
        }
        const per = this._handVertices.get(o) ?? {};
        per[spec.side] = ids;
        this._handVertices.set(o, per);
      }
      if (!ids.length) return;
      o.skeleton.update();
      for (const i of ids) {
        o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
        if (v.distanceToSquared(center) <= REFINE_RADIUS * REFINE_RADIUS) {
          out.push(v.x, v.y, v.z);
        }
      }
    });
    return out;
  }

  /** 手の骨の頂点と触れる面のメッシュの、面の向きに沿った隙間(正)・食い込み(負)の最小。測れなければ null */
  _contactGap(vrm, chain, e) {
    const meshes = this._callbacks.getContactMeshes?.(vrm);
    if (!meshes?.length) return null;
    vrm.humanoid.update?.();
    vrm.scene.updateMatrixWorld(true);
    const index = new ContactIndex(e.target, REFINE_RADIUS);
    index.addMeshes(
      meshes,
      (mesh, a, b, c) =>
        isArmHit(vrm, chain, { object: mesh, face: { a, b, c } }),
    );
    if (!index.size) return null;
    const pts = this._handBodyPoints(vrm, chain, e.target);
    const p = new THREE.Vector3();
    let gap = Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      p.set(pts[i], pts[i + 1], pts[i + 2]);
      gap = Math.min(gap, index.gapAlong(p, e.normal));
    }
    return Number.isFinite(gap) ? gap : null;
  }

  /**
   * 置いたあとの仕上げ。手の骨の実際のメッシュが、触れる面のメッシュにぴったり触れる(隙間も食い込みもない)ように、
   * 目標点を面の向きに沿って寄せて、解き直す。当たり判定の形(メッシュより数 mm 内側)や、解く途中の余裕で残る隙間・食い込みをなくす
   */
  _refineContact(vrm, chain, e) {
    const id = e.refineId = (e.refineId ?? 0) + 1;
    const reattach = () => {
      this._attach(vrm, chain, e);
      if (e.anchor && e.fingerBase) e.anchor.b0 = e.fingerBase.clone();
    };
    const finish = () => {
      reattach();
      this._callbacks.onChange?.();
    };
    if (!e.normal || e.part === "fingers") return finish();
    // 置き直し・ドラッグ・解除などで id が変わったら、そこで中止する
    const step = (i) => {
      if (e.refineId !== id || !e.enabled) return;
      const gap = i < REFINE_ITERATIONS
        ? this._contactGap(vrm, chain, e)
        : null;
      if (gap === null || Math.abs(gap) <= REFINE_TOLERANCE) return finish();
      e.target.addScaledVector(e.normal, -gap * 0.85);
      e.marker.position.copy(e.target);
      this._ensurePoints(vrm, chain, e);
      solveChains(
        vrm,
        [this._goal(chain, e)],
        this._surfaces(vrm) ?? null,
      );
      reattach(); // 毎回つけ直さないと、体についた目標点が古い位置へ引き戻される
      setTimeout(() => step(i + 1), 0);
    };
    setTimeout(() => step(0), 0);
  }

  /**
   * その体の当たり判定に、同じシーンにいる他のモデルの体の当たり判定を足したもの(他のモデルのものには other を付ける)。
   * 腕が、自分だけでなく、そばにいる他のモデルの体にも食い込まないようにし、他のモデルの体に置いた目標を、その体に合わせて動かすのに使う。
   */
  _surfaces(vrm) {
    const s = this._surfacesRaw(vrm);
    if (s) {
      s.floorY = this._lying(vrm)
        ? vrm.scene.userData.ikFloorY
        : vrm.scene.position.y; // 床(物の上に立つときは、その高さ。体を横たえているときは、横たえる前の高さ)
    }
    if (s) s.grids = this._frameGrids ?? null; // 置いた物の球(solveCore が、腕や脚の通り抜けを防ぐのに使う)
    return s;
  }

  _surfacesRaw(vrm) {
    const own = this._callbacks.getBodySurface?.(vrm);
    const others = (this._callbacks.getOtherVrms?.(vrm) ?? [])
      .map((v) => this._callbacks.getBodySurface?.(v))
      .filter((a) => a?.length);
    if (!others.length) return own;
    const cache = this._surfaceCache?.get(vrm);
    if (
      cache && cache.own === own && cache.others.length === others.length &&
      cache.others.every((a, i) => a === others[i])
    ) return cache.merged;
    this._otherTags ??= new WeakMap();
    const tagged = (entry) => {
      let t = this._otherTags.get(entry);
      if (!t) {
        t = { ...entry, other: true };
        this._otherTags.set(entry, t);
      }
      return t;
    };
    const merged = [...(own ?? []), ...others.flatMap((a) => a.map(tagged))];
    (this._surfaceCache ??= new Map()).set(vrm, { own, others, merged });
    return merged;
  }

  /** 面に触れさせる手の部位を変える(HAND_PARTS のキー)。接触の点を取り直して、向きを選び直す */
  setPart(vrm, chain, part) {
    if (!(IK_CHAINS[chain].foot ? FOOT_PARTS : HAND_PARTS)[part]) return;
    (this._pending[chain] ??= {}).part = part; // 目標点がまだ無くても覚えて、次に置くときに使う
    const e = this._chains(vrm)?.[chain];
    if (IK_CHAINS[chain].foot) {
      if (!e || e.part === part) return;
      const limbChange = limbPart(chain, e.part) || limbPart(chain, part);
      e.part = part;
      if (limbChange) {
        e.handPoints = null;
        this.endFollow(vrm, chain); // 膝・すねは、メッシュの接触点を取り直す
      }
      this._callbacks.onChange?.();
      return;
    }
    if (!e || !HAND_PARTS[part] || e.part === part) return;
    const was = e.part;
    if (part === "fingers") this._clearGrip(vrm, e); // 指で触れるときは、握りは使わない
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
    if (next.length) (this._pending[chain] ??= {}).fingers = next;
    if (!e || !next.length || next.join() === e.fingers.join()) return;
    e.fingers = next;
    if (e.part === "fingers") {
      this._prepareFingers(vrm, chain, e);
      this.endFollow(vrm, chain);
    }
    this._callbacks.onChange?.();
  }

  /** 目標点を置く前に選んだ部位・指(なければ空) */
  getPending(chain) {
    return this._pending[chain] ?? {};
  }

  /** 新しく置いた目標点に、置く前に選んでおいた部位・指を使う */
  applyPending(vrm, chain) {
    const p = this._pending[chain];
    const e = this._chains(vrm)?.[chain];
    if (!p || !e) return;
    if (p.fingers) e.fingers = [...p.fingers];
    if (p.part && p.part !== e.part) this.setPart(vrm, chain, p.part);
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
    const enabled = Object.entries(chains).filter(([, e]) => e.enabled);
    if (!enabled.length) return;
    // 動きが行ったり来たりして止まらない(ぷるぷる)ときは、目標が変わるまで、体を動かすのをやめる
    const guard = this._guard(vrm, enabled);
    // 何も変わっていなければ(目標も姿勢も、前回の結果のまま)、解いても同じなので、何もしない
    const sig = this._signature(vrm, enabled);
    if (guard.sigAfter === sig && guard.sigBefore === sig) return;
    guard.sigBefore = sig;
    const canMove = this.walk && !guard.frozen;
    const floorY = vrm.scene.position.y;
    this._frameGrids =
      this._callbacks.getObstacles?.(vrm)?.grids?.filter((g) =>
        g.box.max.y >= floorY + STANCE_LOW
      ) ?? null;
    const t0 = this._pose(vrm);
    let pending = this._solveAll(vrm, enabled, canMove);
    // 全身が、他のモデルの体を突き抜けていれば、押し出して、手足を解き直す
    if (canMove && this._depenetrate(vrm, enabled)) {
      pending = this._solveAll(vrm, enabled, false) || pending;
    }
    this._watchMotion(vrm, guard, t0);
    // 届いていない目標の「初期姿勢から解き直す」が、まだ残っていれば、次のフレームも続ける
    guard.sigAfter = pending ? null : this._signature(vrm, enabled);
  }

  /** 目標と、モデルの姿勢(全ボーンの回転・腰の位置・置き場所)、他のモデルの置き場所の指紋 */
  _signature(vrm, enabled) {
    const v = [];
    for (const [c, e] of enabled) {
      v.push(c, ...e.target.toArray(), e.roll ?? 0, e.part, e.normal ? 1 : 0);
    }
    const hm = vrm.humanoid;
    for (const name of Object.keys(hm.humanBones ?? {})) {
      const n = hm.getNormalizedBoneNode(name);
      if (n) v.push(...n.quaternion.toArray());
    }
    v.push(
      ...hm.getNormalizedBoneNode("hips").position.toArray(),
      ...this._pose(vrm),
    );
    for (const m of this._callbacks.getOtherPoses?.(vrm) ?? []) v.push(...m);
    return v.map((x) => (typeof x === "number" ? Math.round(x * 1e5) : x))
      .join();
  }

  /** モデルの置き場所(水平位置と向き) */
  _pose(vrm) {
    const p = vrm.scene.position, q = vrm.scene.quaternion;
    return [p.x, p.z, q.x, q.y, q.z, q.w];
  }

  _guard(vrm, enabled) {
    let g = this._guards.get(vrm);
    if (!g) {
      this._guards.set(vrm, g = { key: "", hist: [], flips: 0, frozen: false });
    }
    const key = enabled.map(([c, e]) => `${c}:${e.target.toArray().join()}`)
      .join("|");
    if (key !== g.key) {
      Object.assign(g, { key, hist: [], flips: 0, frozen: false });
    }
    return g;
  }

  /**
   * 体の置き場所が、2 回前の置き場所に戻る動きが続いたら、行ったり来たりしているので、止める
   */
  _watchMotion(vrm, g, before) {
    const now = this._pose(vrm);
    const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    if (diff(now, before) < 0.001) return; // 動いていない
    const prev2 = g.hist[g.hist.length - 2];
    g.flips = prev2 && diff(now, prev2) < 0.002
      ? g.flips + 1
      : Math.max(0, g.flips - 1);
    g.hist.push(before);
    if (g.hist.length > 4) g.hist.shift();
    if (g.flips >= 3) g.frozen = true;
  }

  /**
   * 体(胴・頭・腰・指定していない脚)が、他のモデルの体にどれだけ入り込んでいるか。腕は、手の IK が避けるので、ここでは見ない。
   * @returns {{depth: number, push: THREE.Vector3}} 最も深い入り込み(m)と、それを水平に押し出す移動量
   */
  _bodyHits(vrm, enabled, surfaces) {
    const hm = vrm.humanoid;
    const node = (n) => hm.getNormalizedBoneNode(n);
    const hips = node("hips");
    const out = { depth: 0, push: new THREE.Vector3() };
    if (!hips || !surfaces?.length) return out;
    const u = Math.min(
      1.5,
      Math.max(
        0.6,
        (hips.getWorldPosition(_v1).y - vrm.scene.position.y) / 0.9,
      ),
    );
    const placed = new Set(
      enabled.filter(([c]) => IK_CHAINS[c].foot).map(([c]) =>
        IK_CHAINS[c].side
      ),
    );
    // [骨, 次の骨(あれば、その中間), 半径]
    const parts = [
      ["hips", null, 0.13],
      ["spine", null, 0.12],
      ["chest", null, 0.13],
      ["upperChest", null, 0.12],
      ["neck", null, 0.06],
      ["head", null, 0.1],
    ];
    for (const side of ["left", "right"]) {
      if (placed.has(side)) continue; // 足を置いた脚は、その場に残す
      parts.push(
        [`${side}UpperLeg`, `${side}LowerLeg`, 0.08],
        [`${side}LowerLeg`, `${side}Foot`, 0.06],
        [`${side}Foot`, null, 0.05],
      );
    }
    const mats = surfaces.map((e) =>
      e.node && e.offset
        ? new THREE.Matrix4().multiplyMatrices(e.node.matrixWorld, e.offset)
        : e.bone.matrixWorld
    );
    for (const [a, b, r] of parts) {
      const na = node(a);
      if (!na) continue;
      const p = na.getWorldPosition(_v2);
      if (b && node(b)) p.lerp(node(b).getWorldPosition(_v3), 0.5);
      surfaces.forEach(({ shape }, i) => {
        const d = shape.calculateCollision(mats[i], p, r * u, _dir);
        if (d >= 0 || -d <= out.depth) return;
        out.depth = -d;
        // 押し出しは水平に。法線が上下に偏っているときは、入り込みを水平に換算する(行き過ぎないよう、換算は 3 倍まで)
        const h = Math.hypot(_dir.x, _dir.z);
        if (h > 1e-6) {
          out.push.set(_dir.x / h, 0, _dir.z / h).multiplyScalar(
            -d / Math.max(h, 0.33),
          );
        } else out.push.set(0, 0, 0);
      });
    }
    return out;
  }

  /** 体が他のモデルの体に入り込んでいれば、水平に押し出す。動かしたら true */
  _depenetrate(vrm, enabled) {
    const surfaces = this._surfaces(vrm)?.filter((e) => e.other);
    if (!surfaces?.length) return false;
    let moved = false;
    for (let iter = 0; iter < DEPENETRATE_ITERATIONS; iter++) {
      vrm.scene.updateMatrixWorld(true);
      const hit = this._bodyHits(vrm, enabled, surfaces);
      if (hit.depth < DEPENETRATE_MIN || hit.push.lengthSq() < 1e-10) break;
      hit.push.setLength(hit.push.length() + 0.002);
      vrm.scene.position.add(hit.push);
      moved = true;
    }
    if (moved) vrm.scene.updateMatrixWorld(true);
    return moved;
  }

  /** @returns {boolean} 届かない手が、まだ「初期姿勢から解き直す」を試していないとき true */
  _solveAll(vrm, enabled, canMove) {
    vrm.scene.updateMatrixWorld(true);
    // 足が指定されていれば、先にその場所へ足を置く。以降の腰の移動(しゃがみ)も、その足の位置を保つ
    const feet = enabled.filter(([chain]) => IK_CHAINS[chain].foot);
    if (feet.length) {
      // 膝・すねで触れる脚は、体についた目標に追従し、接触の点が要る。足を置く(足裏・かかと・つま先)のとは別に扱う
      for (const [chain, e] of feet) {
        if (!limbPart(chain, e.part)) continue;
        this._followAnchor(e);
        this._ensurePoints(vrm, chain, e);
      }
      const goals = feet.map(([chain, e]) => this._goal(chain, e));
      const placed = feet.filter(([chain, e]) => !limbPart(chain, e.part));
      // 両足を置くなら、低いほうの足の高さに、モデルを持ち上げる(物の上に立つ)
      if (canMove && placed.length >= 2) this._liftToFeet(vrm, placed);
      // 届かない足は、先に届く位置へ動く(届かないまま解くと、姿勢が定まらずにぷるぷるする)
      if (canMove && placed.length && this._moveToFoot(vrm, placed)) {
        vrm.scene.updateMatrixWorld(true);
      }
      const results = solveChains(vrm, goals, this._surfaces(vrm) ?? null);
      vrm.scene.updateMatrixWorld(true);
      if (results) this._retryLegs(vrm, feet, goals, results);
    }
    const active = enabled.filter(([chain]) => !IK_CHAINS[chain].foot);
    if (!active.length) return false;
    if (canMove && !feet.length) this._leaveObstacle(vrm, active);
    const bodySurface = this._surfaces(vrm) ?? null;
    for (const [, e] of active) this._followAnchor(e);
    const goals = active.map(([chain, e]) => {
      this._ensurePoints(vrm, chain, e);
      return this._goal(chain, e);
    });
    let results = solveChains(vrm, goals, bodySurface);
    if (!results) return false;
    // 両手(両肘など)が、肩から腕を伸ばしても届かないほど低く、今の姿勢でも届いていなければ、歩いて近づく前に、体を横たえてみる
    // (片手だけなら、しゃがむ・かがむ・歩くで届くので、それらで届かなかったときの最後の手段にする)
    if (
      canMove && !feet.length && !this._lying(vrm) &&
      this._isUnreached(active, results) && this._lowCount(vrm, active) >= 2
    ) {
      results = this._lieDown(vrm, active, goals, results) ?? results;
    }
    // 体を横たえているとき、今の姿勢で届かなくなれば、立ち姿に戻して解き直す(そのあと、必要ならまた横たえる)
    const lie = vrm.scene.userData;
    if (this._lying(vrm)) {
      // 横たえた直後は、まだ収束の途中なので、しばらく届かなくても待つ
      lie.ikLieBad = this._isUnreached(active, results)
        ? (lie.ikLieBad || 0) + 1
        : 0;
    }
    if (
      this._lying(vrm) && canMove && !feet.length && lie.ikLieBad > LIE_PATIENCE
    ) {
      this._standUp(vrm, active);
      for (const [, e] of active) this._followAnchor(e);
      results = solveChains(vrm, goals, this._surfaces(vrm) ?? null) ?? results;
    }
    // 届かない目標があれば、確実に届く立ち位置へ移動してから(1 回で)解き直す。それでも届かなければ、さらに近づく
    for (
      let attempt = 0;
      canMove && !feet.length && !this._lying(vrm) &&
      attempt < STAND_RATIOS.length;
      // 足を指定したら、その場から動かない
      attempt++
    ) {
      if (!this._moveToStance(vrm, active, results, STAND_RATIOS[attempt])) {
        break;
      }
      vrm.scene.updateMatrixWorld(true);
      for (const [, e] of active) this._followAnchor(e);
      results = solveChains(vrm, goals, bodySurface) ?? results;
    }
    // 立ったままでは(しゃがむ・かがむ・歩くでも)届かない状態が続くなら、最後の手段として体を横たえて届かせる
    if (canMove && !feet.length && !this._lying(vrm)) {
      const u = vrm.scene.userData;
      u.ikUnreached = this._isUnreached(active, results)
        ? (u.ikUnreached || 0) + 1
        : 0;
      if (u.ikUnreached >= LIE_AFTER) {
        results = this._lieDown(vrm, active, goals, results) ?? results;
      }
    }
    // 届いていても、体を突き抜けているなら、突き抜けない立ち位置を探す
    if (
      canMove && !feet.length && !this._lying(vrm) &&
      this._moveToClear(vrm, active, goals, bodySurface, results, enabled)
    ) {
      vrm.scene.updateMatrixWorld(true);
      results = solveChains(vrm, goals, bodySurface) ?? results;
    }
    active.forEach(([chain, e], i) => {
      // 局所解にはまって、ずっと届かないときは、腕を初期姿勢に戻して解き直してみる(間隔をあけて、良くなったときだけ採用)
      const bad = results[i].posErr > RETRY_ERROR ||
        results[i].depth > STUCK_DEPTH;
      e.stuck = bad ? (e.stuck ?? 0) + 1 : 0;
      e.cooldown = Math.max(0, (e.cooldown ?? 0) - 1);
      const tkey = this._targetKey(e);
      if (e.stuck >= STUCK_FRAMES && e.cooldown === 0 && e.retryKey !== tkey) {
        e.cooldown = RETRY_INTERVAL;
        e.retryKey = tkey; // 同じ目標では、1 回だけ(1 回が重く、やっても変わらないことが多いので)
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
    // 握り: 手の姿勢が決まったあとで、指を曲げる
    for (const [chain, e] of active) this._applyGrip(vrm, chain, e);
    return active.some(([, e], i) =>
      (results[i].posErr > RETRY_ERROR || results[i].depth > STUCK_DEPTH) &&
      e.retryKey !== this._targetKey(e)
    );
  }

  /**
   * 膝・すねで触れる脚が、深くしゃがんだ姿勢などの局所解にはまって、位置や向きが合わないままのとき、
   * 脚と腰を初期姿勢に戻して解き直す(同じ目標では 1 回だけ。明らかに良くなったときだけ採用)
   */
  _retryLegs(vrm, feet, goals, results) {
    const bad = feet.some(([chain, e], i) => {
      if (!limbPart(chain, e.part) || e.retryKey === this._targetKey(e)) {
        return false;
      }
      const r = results[i];
      const rot = (r.cost - r.posErr - r.depth) / ROT_WEIGHT;
      return r.posErr > RETRY_ERROR || rot > LIMB_ROT_RETRY;
    });
    if (!bad) return;
    for (const [chain, e] of feet) {
      if (limbPart(chain, e.part)) e.retryKey = this._targetKey(e);
    }
    const hm = vrm.humanoid;
    const hips = hm.getNormalizedBoneNode("hips");
    const all = Object.keys(hm.humanBones)
      .map((name) => hm.getNormalizedBoneNode(name))
      .filter(Boolean);
    const saved = all.map((n) => [n.quaternion.clone(), n.position.clone()]);
    const oldState = hipBendState.get(hips);
    // 戻すのは、腰と脚(の関節)だけ。腕などは、今の姿勢のまま
    const reset = new Set([
      hips,
      ...feet.flatMap(([chain]) =>
        IK_CHAINS[chain].joints.map((j) => hm.getNormalizedBoneNode(j.bone))
      ),
    ]);
    const surfaces = this._surfaces(vrm) ?? null;
    const sum = (rs) => rs.reduce((a, r) => a + r.cost, 0);
    const before = sum(results);
    // 目標を持たない足(支えの足)は、動かさない
    const supports = ["leftFoot", "rightFoot"]
      .filter((n) => !feet.some(([chain]) => chain === n))
      .map((n) => hm.getNormalizedBoneNode(n))
      .filter(Boolean);
    const supportAt = supports.map((n) =>
      n.getWorldPosition(new THREE.Vector3())
    );
    hm.resetNormalizedPose();
    all.forEach((n, i) => {
      if (reset.has(n)) return;
      n.quaternion.copy(saved[i][0]);
      n.position.copy(saved[i][1]);
    });
    vrm.scene.updateMatrixWorld(true);
    let next = null;
    for (let pass = 0; pass < 4; pass++) {
      next = solveChains(vrm, goals, surfaces);
    }
    const moved = supports.some((n, i) =>
      n.getWorldPosition(_hv1).distanceTo(supportAt[i]) > RETRY_SUPPORT_MOVE
    );
    if (!next || moved || sum(next) > before * 0.8) {
      all.forEach((n, i) => {
        n.quaternion.copy(saved[i][0]);
        n.position.copy(saved[i][1]);
      });
      if (oldState) hipBendState.set(hips, oldState);
    }
    vrm.scene.updateMatrixWorld(true);
  }

  _targetKey(e) {
    return [...e.target.toArray(), e.roll ?? 0].map((v) => +v.toFixed(3))
      .join();
  }

  /** 腕を初期姿勢に戻して解き直し、今より明らかに良くなったときだけ、その姿勢にする */
  _retryFromRest(vrm, chain, index, goals, bodySurface, e, currentErr) {
    const nodes = IK_CHAINS[chain].joints
      .filter((j) => !BEND_BONES.includes(j.bone))
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
    const savedHip = hipOffset(vrm);
    // 初期姿勢から、そのまま解く → 目標の手前を経由して解く、の順に試す。今より明らかに良くなったときだけ採用する
    let adopted = false;
    // 体幹についた目標は、体幹を動かすと目標ごと動いて、いつまでも届かず揺れ続けるので、体幹は動かさない
    const seeds = e.anchor?.trunk ? ["rest", "via"] : ["rest", "via", "free"];
    const started = performance.now();
    for (const seed of seeds) {
      // 1 回の解き直しで、画面が止まりすぎないよう、時間の上限を超えたら、残りの試しはやめる
      if (seed !== seeds[0] && performance.now() - started > RETRY_BUDGET_MS) {
        break;
      }
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
      settleHipBend(vrm, savedHip);
    }
    vrm.scene.updateMatrixWorld(true);
  }

  /**
   * 腰を曲げたりしゃがんだりしても手が届かない目標があれば、目標のほうを向いて、目標から(水平に)腕の長さ × ratio の
   * 位置へ、体ごと(足の位置ごと)移動する。体についた目標(自分の体の上)は、移動しても変わらないので対象外。
   * @returns {boolean} 体の位置や向きを動かしたか
   */
  /**
   * 立ち位置(足元の水平位置 x, z)に、物や他のモデルの体がないか。
   * 物は、箱(おおまかな大きさ)で、他のモデルは、腰を中心にした円柱で調べる
   */
  _stanceFree(obstacles, x, z, floor, top, radius = STANCE_RADIUS) {
    if (!obstacles) return true;
    for (const box of obstacles.boxes) {
      if (box.max.y < floor + STANCE_LOW || box.min.y > floor + top) continue;
      const dx = Math.max(box.min.x - x, 0, x - box.max.x);
      const dz = Math.max(box.min.z - z, 0, z - box.max.z);
      if (Math.hypot(dx, dz) < radius) return false;
    }
    for (const c of obstacles.cylinders) {
      if (Math.hypot(x - c.x, z - c.z) < c.r + radius) return false;
    }
    return true;
  }

  /**
   * 目標(tx, tz)から radii の距離のどこかで、障害物のない立ち位置のうち、今の位置(hx, hz)にいちばん近いものを探す。
   * すでに desired(x, z)が空いていれば、それを返す。空いたところがなければ、desired のまま(体がめり込むが、届くことを優先する)
   */
  _freeStance(vrm, desired, target, radii, here) {
    const obstacles = this._callbacks.getObstacles?.(vrm);
    if (!obstacles) return desired;
    const floor = vrm.scene.position.y;
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    const top = Math.max(0.5, (hips?.getWorldPosition(_v1).y ?? 1) - floor) * 2;
    if (this._stanceFree(obstacles, desired.x, desired.z, floor, top)) {
      return desired;
    }
    let best = null;
    let bestDist = Infinity;
    for (const r of radii) {
      for (let a = 0; a < Math.PI * 2 - 1e-6; a += STANCE_STEP) {
        const x = target.x + Math.cos(a) * r, z = target.z + Math.sin(a) * r;
        if (!this._stanceFree(obstacles, x, z, floor, top)) continue;
        const d = Math.hypot(x - here.x, z - here.z);
        if (d < bestDist) {
          bestDist = d;
          best = { x, z };
        }
      }
    }
    return best ?? desired;
  }

  /**
   * 足が届かない目標があれば、その足の付け根から、確実に届く距離まで、モデルを水平に動かす(向きは変えない)。
   * 届かないまま解き続けると、姿勢が定まらずにぷるぷるするので、先に届く位置へ動く
   */
  /** 置いた物(箱)の中に立っているとき、手の目標の近くの、物の外へ出る */
  _leaveObstacle(vrm, active) {
    const obstacles = this._callbacks.getObstacles?.(vrm);
    if (!obstacles?.boxes.length) return false;
    const hips = vrm.humanoid.getNormalizedBoneNode("hips");
    if (!hips) return false;
    const here = hips.getWorldPosition(new THREE.Vector3());
    const floor = vrm.scene.position.y;
    const top = Math.max(0.5, here.y - floor) * 2;
    if (
      this._stanceFree(
        { boxes: obstacles.boxes, cylinders: [] },
        here.x,
        here.z,
        floor,
        top,
        STANCE_INSIDE,
      )
    ) return false;
    const hand = active.find(([chain]) => chain.endsWith("Hand"));
    if (!hand) return false;
    const target = this._aim(vrm, active, hand[1]);
    const spot = this._freeStance(vrm, here, target, STANCE_LEAVE_RADII, here);
    if (!this._standAt(vrm, spot, target)) return false; // 目標のほうを向いて立つ
    vrm.scene.updateMatrixWorld(true);
    return true;
  }

  /**
   * 両足を置く場所が、床より高い(物の上など)とき、モデルをその高さまで持ち上げる(低いほうの足に合わせる。もう片方は脚で届かせる)。
   * 床に戻したときは、床まで下げる
   */
  _liftToFeet(vrm, feet) {
    const y = Math.min(...feet.map(([, e]) => e.target.y));
    const lift = y - vrm.scene.position.y;
    if (Math.abs(lift) < 1e-4) return;
    vrm.scene.position.y = y;
    vrm.scene.userData.groundLift = 0; // 接地の持ち上げ量とは別に、ここで高さを決めたので、重ねて引かれないようにする
    vrm.scene.updateMatrixWorld(true);
  }

  _moveToFoot(vrm, feet) {
    const pos = (n) => n.getWorldPosition(new THREE.Vector3());
    let move = null;
    let moveTarget = null;
    let moveRadii = null;
    let most = 0;
    for (const [chain, e] of feet) {
      const side = IK_CHAINS[chain].side;
      const leg = ["UpperLeg", "LowerLeg", "Foot"].map((n) =>
        vrm.humanoid.getNormalizedBoneNode(`${side}${n}`)
      );
      if (leg.some((n) => !n)) continue;
      const root = pos(leg[0]);
      const length = root.distanceTo(pos(leg[1])) +
        pos(leg[1]).distanceTo(pos(leg[2]));
      // 足首は、足裏より FOOT_ANKLE_RATIO だけ上にある。腰も下げられるので、脚は少し余裕を見る
      const dy = root.y - (e.target.y + length * FOOT_ANKLE_RATIO) -
        length * FOOT_SQUAT_ALLOWANCE;
      const reach = Math.sqrt(
        Math.max(0, (length * FOOT_STAND_RATIO) ** 2 - Math.max(0, dy) ** 2),
      );
      const toTarget = e.target.clone().sub(root);
      toTarget.y = 0;
      const dist = toTarget.length();
      if (dist <= reach || dist - reach <= most) continue; // 水平に動いても高さが届かないときも、動かない
      most = dist - reach;
      move = toTarget.clone().multiplyScalar((dist - reach * 0.8) / dist);
      moveTarget = e.target;
      moveRadii = [0.8, 0.6, 0.4].map((k) => reach * k);
    }
    if (!move) return false;
    // 動き先に障害物があれば、足の目標から同じ距離の、空いたところへ変える
    const here = pos(vrm.humanoid.getNormalizedBoneNode("hips"));
    const desired = here.clone().add(move);
    const spot = this._freeStance(vrm, desired, moveTarget, moveRadii, here);
    vrm.scene.position.x += spot.x - here.x;
    vrm.scene.position.z += spot.z - here.z;
    return true;
  }

  /**
   * 向き直る先。手が複数あるときは、どれか 1 つの手のほうへ向くと、もう片方の手が横に逃げてしまうので、手の目標の真ん中を向く
   */
  _aim(vrm, active, e) {
    const hands = active.filter(([chain, en]) => {
      if (!chain.endsWith("Hand")) return false;
      for (let o = en.anchor?.node; o; o = o.parent) {
        if (o === vrm.scene) return false;
      }
      return true;
    });
    if (hands.length < 2) return e.target;
    const aim = new THREE.Vector3();
    for (const [, en] of hands) aim.add(en.target);
    return aim.multiplyScalar(1 / hands.length);
  }

  _moveToStance(vrm, active, results, ratio) {
    let worst = -1;
    let worstErr = WALK_TRIGGER;
    active.forEach(([chain, e], i) => {
      if (!chain.endsWith("Hand")) return;
      // 自分の体についた目標は、移動しても一緒に動くので、対象外
      for (let o = e.anchor?.node; o; o = o.parent) if (o === vrm.scene) return;
      if (results[i].posErr > worstErr) {
        worst = i;
        worstErr = results[i].posErr;
      }
    });
    if (worst < 0) return false;
    const [chain, e] = active[worst];
    const hm = vrm.humanoid;
    const side = IK_CHAINS[chain].side;
    const hips = hm.getNormalizedBoneNode("hips");
    const left = hm.getNormalizedBoneNode("leftUpperLeg");
    const right = hm.getNormalizedBoneNode("rightUpperLeg");
    const arm = ["UpperArm", "LowerArm", "Hand"].map((n) =>
      hm.getNormalizedBoneNode(`${side}${n}`)
    );
    if (!hips || !left || !right || arm.some((n) => !n)) return false;
    const pos = (n) => n.getWorldPosition(new THREE.Vector3());
    const armLength = this._armReach(pos, arm, e.part);
    const aim = this._aim(vrm, active, e);
    const toTarget = aim.clone().sub(pos(hips));
    toTarget.y = 0;
    const dist = toTarget.length();
    const stand = armLength * ratio;
    if (dist <= stand) return false; // もう十分近い
    toTarget.multiplyScalar(1 / dist);
    // 立ち位置: 目標のほうへ stand だけ近づいた位置。そこに障害物があれば、目標から同じ(か少し近い)距離の、空いたところへ変える
    const here = pos(hips);
    const desired = here.clone().addScaledVector(toTarget, dist - stand);
    const spot = this._freeStance(
      vrm,
      desired,
      aim,
      STANCE_SHRINK.map((k) => stand * k),
      here,
    );
    return this._standAt(vrm, spot, aim);
  }

  /** 体を横たえた姿勢にしているか(横たえたあとに、モデルの向きを手で変えられていたら、横たえていないものとして扱う) */
  _lying(vrm) {
    const u = vrm.scene.userData;
    if (!u.ikPosture) return false;
    if (u.ikLieQ && u.ikLieQ.angleTo(vrm.scene.quaternion) < 1e-3) return true;
    delete u.ikPosture;
    delete u.ikFloorY;
    return false;
  }

  /** 自分の体についていない目標のうち、届いていないものがあるか */
  _isUnreached(active, results) {
    return active.some(([chain, e], i) => {
      if (!chain.endsWith("Hand") || e.anchor) return false;
      return results[i].posErr > RETRY_ERROR;
    });
  }

  /** 肩から腕を伸ばしても届かないほど低い、手の目標の数 */
  _lowCount(vrm, active) {
    const hm = vrm.humanoid;
    return active.filter(([chain, e]) => {
      if (!chain.endsWith("Hand") || e.anchor) return false;
      const side = IK_CHAINS[chain].side;
      const arm = ["UpperArm", "LowerArm", "Hand"].map((n) =>
        hm.getNormalizedBoneNode(`${side}${n}`)
      );
      if (arm.some((n) => !n)) return false;
      const pos = (n) => n.getWorldPosition(new THREE.Vector3());
      return pos(arm[0]).y - e.target.y > this._armReach(pos, arm, e.part);
    }).length;
  }

  /** 体の向きを表す回転行列(列: 左右・頭・正面)。頭は腰から頭、正面は(左脚 − 右脚)× 頭の向き */
  _bodyFrame(vrm) {
    const hm = vrm.humanoid;
    const pos = (n) =>
      hm.getNormalizedBoneNode(n).getWorldPosition(new THREE.Vector3());
    const up = pos("head").sub(pos("hips")).normalize();
    const front = pos("leftUpperLeg").sub(pos("rightUpperLeg")).cross(up);
    front.addScaledVector(up, -front.dot(up)).normalize();
    const lat = up.clone().cross(front);
    return new THREE.Matrix4().makeBasis(lat, up, front);
  }

  /** 腰・体幹・脚と、目標のある腕の関節を、初期姿勢に戻す(ほかのボーンは今のまま) */
  _resetBody(vrm, active) {
    const hm = vrm.humanoid;
    const all = Object.keys(hm.humanBones)
      .map((name) => [name, hm.getNormalizedBoneNode(name)])
      .filter(([, n]) => n);
    const reset = new Set([
      ...LIE_BONES,
      ...active.flatMap(([chain]) =>
        IK_CHAINS[chain].joints.map((j) => j.bone)
      ),
    ]);
    const saved = all.map((
      [, n],
    ) => [n.quaternion.clone(), n.position.clone()]);
    hm.resetNormalizedPose();
    all.forEach(([name, n], i) => {
      if (reset.has(name)) return;
      n.quaternion.copy(saved[i][0]);
      n.position.copy(saved[i][1]);
    });
  }

  /** 体の今の姿勢(ボーンと、モデルの位置・向き)を覚える / 戻す */
  _snapshot(vrm) {
    const hm = vrm.humanoid;
    const nodes = Object.keys(hm.humanBones)
      .map((name) => hm.getNormalizedBoneNode(name))
      .filter(Boolean);
    return {
      nodes,
      bones: nodes.map((n) => [n.quaternion.clone(), n.position.clone()]),
      q: vrm.scene.quaternion.clone(),
      p: vrm.scene.position.clone(),
    };
  }

  _restoreSnapshot(vrm, snap) {
    snap.nodes.forEach((n, i) => {
      n.quaternion.copy(snap.bones[i][0]);
      n.position.copy(snap.bones[i][1]);
    });
    vrm.scene.quaternion.copy(snap.q);
    vrm.scene.position.copy(snap.p);
    vrm.scene.updateMatrixWorld(true);
  }

  /**
   * 立ったままでは届かないとき、体を横たえて(うつ伏せ・仰向け・横向き)届かせる。
   * 頭の向き(水平 8 方向)と腹の向き(下・上・左右)の候補を、肩から目標までの距離だけで絞り込み、
   * 残った少数だけを実際に解いて、いちばん良いものを採る。良くならなければ、元の姿勢に戻す。
   * 体はいちばん低い点が床に付く高さに置く。
   * @returns {object[]|null} 横たえて解いた結果。横たえなかったら null
   */
  _lieDown(vrm, active, goals, before) {
    const u = vrm.scene.userData;
    const key = active.map(([, e]) => this._targetKey(e)).join("|");
    if (u.ikLieKey === key) return null; // 同じ目標では、1 回だけ(重いので)
    u.ikLieKey = key;
    const lowestY = this._callbacks.getLowestY;
    if (!lowestY) return null;
    const hm = vrm.humanoid;
    const pos = (n) => n.getWorldPosition(new THREE.Vector3());
    const hips = hm.getNormalizedBoneNode("hips");
    if (!hips) return null;
    // 体に付いていない手の目標だけで考える
    const hands = active
      .map(([chain, e], i) => ({ chain, e, i }))
      .filter(({ chain, e }) => chain.endsWith("Hand") && !e.anchor);
    if (!hands.length) return null;
    const upper = hands.map(({ chain }) =>
      hm.getNormalizedBoneNode(`${IK_CHAINS[chain].side}UpperArm`)
    );
    if (upper.some((n) => !n)) return null;
    const base = this._snapshot(vrm);
    const floor0 = (u.ikFloorY ?? base.p.y) - (u.groundLift || 0);
    const aim = hands.reduce((a, { e }) => a.add(e.target), new THREE.Vector3())
      .multiplyScalar(1 / hands.length);
    const toAim = aim.clone().sub(pos(hips));
    toAim.y = 0;
    if (toAim.lengthSq() < 1e-6) toAim.set(0, 0, 1);
    toAim.normalize();
    const reaches = hands.map(({ chain, e }) => {
      const arm = ["UpperArm", "LowerArm", "Hand"].map((n) =>
        hm.getNormalizedBoneNode(`${IK_CHAINS[chain].side}${n}`)
      );
      return this._armReach(pos, arm, e.part);
    });
    const meanReach = reaches.reduce((a, b) => a + b, 0) / reaches.length;
    const up = new THREE.Vector3(0, 1, 0);
    /** 候補の向きに体を置く。頭 h、腹の向き kind。戻り値は、肩から目標までの距離(腕の長さに対する割合)の並び */
    const place = (h, kind, exact = false) => {
      this._restoreSnapshot(vrm, base);
      this._resetBody(vrm, active);
      vrm.scene.updateMatrixWorld(true);
      const front = kind === "prone"
        ? new THREE.Vector3(0, -1, 0)
        : kind === "supine"
        ? new THREE.Vector3(0, 1, 0)
        : kind === "right"
        ? up.clone().cross(h) // 右を下にして寝る
        : h.clone().cross(up); // 左を下にして寝る
      const lat = h.clone().cross(front);
      const target = new THREE.Matrix4().makeBasis(lat, h, front);
      const turn = target.multiply(this._bodyFrame(vrm).transpose());
      vrm.scene.quaternion.premultiply(
        new THREE.Quaternion().setFromRotationMatrix(turn),
      );
      vrm.scene.updateMatrixWorld(true);
      // 両肩の中点を、目標の手前(水平)へ
      const mid = upper.reduce((a, n) => a.add(pos(n)), new THREE.Vector3())
        .multiplyScalar(1 / upper.length);
      vrm.scene.position.x += aim.x - toAim.x * LIE_SHOULDER_RATIO * meanReach -
        mid.x;
      vrm.scene.position.z += aim.z - toAim.z * LIE_SHOULDER_RATIO * meanReach -
        mid.z;
      vrm.scene.updateMatrixWorld(true);
      const low = exact ? lowestY(vrm) : this._boneLowestY(vrm);
      if (low !== null) vrm.scene.position.y += floor0 - low;
      vrm.scene.updateMatrixWorld(true);
      return hands.map(({ e }, k) =>
        pos(upper[k]).distanceTo(e.target) / reaches[k]
      );
    };
    // 簡単な判定: どの目標にも、肩から腕が届く
    const candidates = [];
    for (let k = 0; k < LIE_HEADINGS; k++) {
      const angle = (k * 2 * Math.PI) / LIE_HEADINGS;
      const h = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      for (const kind of Object.keys(LIE_PREFERENCE)) {
        const ratios = place(h, kind);
        if (ratios.some((r) => r > 1)) continue;
        const score = ratios.reduce(
          (a, r) => a + Math.abs(r - LIE_SHOULDER_RATIO),
          0,
        ) + LIE_PREFERENCE[kind];
        candidates.push({ h, kind, score });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const sum = (rs) => rs.reduce((a, r) => a + r.cost, 0);
    const locked = goals.map((g) => ({ ...g, lockTrunk: true }));
    let best = null;
    for (const cand of candidates.slice(0, LIE_CANDIDATES)) {
      place(cand.h, cand.kind, true);
      let results = null;
      let last = Infinity;
      for (let pass = 0; pass < LIE_PASSES; pass++) {
        results = solveChains(vrm, locked, this._surfaces(vrm) ?? null) ??
          results;
        if (results.every((r) => r.posErr < LIE_DONE_ERROR)) break;
        const now = sum(results);
        if (now > last * 0.9) break; // もう良くならない
        last = now;
      }
      if (!results) continue;
      const cost = sum(results);
      if (!best || cost < best.cost) {
        best = { ...cand, cost, snap: this._snapshot(vrm), results };
      }
    }
    if (!best || best.cost > sum(before) * 0.8) {
      this._restoreSnapshot(vrm, base);
      return null;
    }
    this._restoreSnapshot(vrm, best.snap);
    u.ikPosture = best.kind;
    u.ikUprightQ = base.q.clone();
    u.ikUprightP = base.p.clone();
    u.ikUprightLift = u.groundLift || 0;
    u.ikFloorY = floor0;
    u.ikLieBad = 0;
    u.ikLieQ = vrm.scene.quaternion.clone();
    u.groundLift = 0; // 高さは、ここで床に合わせてある
    return best.results;
  }

  /** 体のいちばん低い点の高さの目安(ボーンの位置から、太さを引いたもの)。候補を絞り込むときの、軽い見積もり */
  _boneLowestY(vrm) {
    const hm = vrm.humanoid;
    let low = Infinity;
    for (const name of Object.keys(hm.humanBones)) {
      const n = hm.getNormalizedBoneNode(name);
      if (!n) continue;
      const r = /hips|spine|chest|neck|head/.test(name) ? 0.1 : 0.04;
      low = Math.min(low, n.getWorldPosition(_v1).y - r);
    }
    return low;
  }

  /** 横たえた体を、立ち姿に戻す(向きと位置は、横たえる前のところ) */
  _standUp(vrm, active) {
    const u = vrm.scene.userData;
    if (!u.ikPosture) return;
    this._resetBody(vrm, active);
    vrm.scene.quaternion.copy(u.ikUprightQ);
    vrm.scene.position.copy(u.ikUprightP);
    u.groundLift = u.ikUprightLift;
    delete u.ikPosture;
    delete u.ikFloorY;
    vrm.scene.updateMatrixWorld(true);
  }

  /** 腰を spot(水平)へ動かし、目標(水平)のほうを向く。足元(モデルの原点)を軸に回してから動く */
  _standAt(vrm, spot, target) {
    const hm = vrm.humanoid;
    const hips = hm.getNormalizedBoneNode("hips");
    const left = hm.getNormalizedBoneNode("leftUpperLeg");
    const right = hm.getNormalizedBoneNode("rightUpperLeg");
    if (!hips || !left || !right) return false;
    const pos = (n) => n.getWorldPosition(new THREE.Vector3());
    // 体の正面(水平): 左脚の付け根 − 右脚の付け根 に、上向きを掛ける(左 × 上 = 正面)
    const front = pos(left).sub(pos(right)).cross(_v1.set(0, 1, 0));
    front.y = 0;
    if (front.lengthSq() < 1e-8) return false;
    front.normalize();
    const face = _v2.set(target.x - spot.x, 0, target.z - spot.z);
    if (face.lengthSq() < 1e-8) return false;
    face.normalize();
    const angle = Math.atan2(
      front.z * face.x - front.x * face.z,
      front.x * face.x + front.z * face.z,
    ); // 正面から目標へ(上から見て、Y 軸まわりの角度)
    vrm.scene.rotateOnWorldAxis(_v1.set(0, 1, 0), angle);
    vrm.scene.updateMatrixWorld(true);
    const moved = pos(hips); // 回してから、腰の位置を測り直して、立ち位置へ動く
    vrm.scene.position.x += spot.x - moved.x;
    vrm.scene.position.z += spot.z - moved.z;
    return true;
  }

  /**
   * 届いていても、腕が他のモデルの体(や自分の体)を突き抜けたままなら、目標のまわりの別の立ち位置を試す。
   * 近い順に試して、届いて、突き抜けない最初の位置を採る。どれも良くならなければ、元に戻す。
   * @returns {boolean} 立ち位置を変えて、解き直したか
   */
  _moveToClear(vrm, active, goals, bodySurface, results, enabled) {
    const others = bodySurface?.filter((e) => e.other);
    if (!others?.length) return false; // 他のモデルがいなければ、立ち位置を変えても、自分の体への入り込みは変わらない
    // 胴や脚が突き抜けているときも、立ち位置を変える(上体を倒して、他のモデルの上に覆いかぶさるときなど)
    const bodyDepth = () => this._bodyHits(vrm, enabled, others).depth;
    const bodyBlocked = bodyDepth() > BLOCK_DEPTH;
    let worst = -1;
    let worstDepth = BLOCK_DEPTH;
    active.forEach(([chain, e], i) => {
      if (!chain.endsWith("Hand")) return;
      for (let o = e.anchor?.node; o; o = o.parent) if (o === vrm.scene) return;
      if (results[i].depth > worstDepth) {
        worst = i;
        worstDepth = results[i].depth;
      }
    });
    if (worst < 0 && bodyBlocked) {
      worst = active.findIndex(([chain]) => chain.endsWith("Hand"));
    }
    if (worst < 0) return false;
    const [chain, e] = active[worst];
    // 同じ目標・同じ位置で、すでに探して見つからなかったなら、毎フレーム探し直さない(目標か位置が変わるまで)
    const key = e.target.toArray().map((v) => v.toFixed(3)).join();
    if (e.clearKey !== key) Object.assign(e, { clearKey: key, clearCount: 0 });
    if (e.clearCount >= CLEAR_SEARCHES) return false; // 同じ目標では、何度も探さない(1 回が重いので)
    e.clearCount++;
    const aim = this._aim(vrm, active, e);
    const hm = vrm.humanoid;
    const side = IK_CHAINS[chain].side;
    const hips = hm.getNormalizedBoneNode("hips");
    const arm = ["UpperArm", "LowerArm", "Hand"].map((n) =>
      hm.getNormalizedBoneNode(`${side}${n}`)
    );
    if (!hips || arm.some((n) => !n)) return false;
    const pos = (n) => n.getWorldPosition(new THREE.Vector3());
    const armLength = this._armReach(pos, arm, e.part);
    const obstacles = this._callbacks.getObstacles?.(vrm);
    const here = pos(hips);
    const floor = vrm.scene.position.y;
    const top = Math.max(0.5, here.y - floor) * 2;
    const spots = [];
    for (const k of STANCE_SHRINK) {
      for (let a = 0; a < Math.PI * 2 - 1e-6; a += STANCE_STEP) {
        const x = aim.x + Math.cos(a) * armLength * k;
        const z = aim.z + Math.sin(a) * armLength * k;
        if (!this._stanceFree(obstacles, x, z, floor, top)) continue;
        spots.push({ x, z, d: Math.hypot(x - here.x, z - here.z) });
      }
    }
    spots.sort((p, q) => p.d - q.d);
    // 試す前の状態(元に戻すため)
    const names = Object.keys(hm.humanBones ?? {});
    const nodes = names.map((n) => hm.getNormalizedBoneNode(n)).filter(Boolean);
    const saved = {
      q: nodes.map((n) => n.quaternion.clone()),
      hp: hips.position.clone(),
      p: vrm.scene.position.clone(),
      r: vrm.scene.quaternion.clone(),
      results,
    };
    const restore = () => {
      nodes.forEach((n, i) => n.quaternion.copy(saved.q[i]));
      hips.position.copy(saved.hp);
      vrm.scene.position.copy(saved.p);
      vrm.scene.quaternion.copy(saved.r);
      vrm.scene.updateMatrixWorld(true);
    };
    let best = null;
    for (const spot of spots.slice(0, CLEAR_TRIES)) {
      restore();
      if (!this._standAt(vrm, spot, aim)) continue;
      vrm.scene.updateMatrixWorld(true);
      for (const [, en] of active) this._followAnchor(en);
      const r = solveChains(vrm, goals, bodySurface);
      if (!r) continue;
      const err = Math.max(...r.map((x) => x.posErr));
      const depth = Math.max(...r.map((x) => x.depth), bodyDepth());
      const score = err + depth * 2;
      if (!best || score < best.score) {
        best = { score, spot };
      }
      if (err <= WALK_TRIGGER && depth < BLOCK_DEPTH) return true; // 良い位置が見つかった
    }
    // どれも良くならなければ、いちばんよかった位置(元より良ければ)か、元の位置
    restore();
    const base = Math.max(...results.map((x) => x.posErr)) +
      Math.max(...results.map((x) => x.depth), bodyDepth()) * 2;
    if (best && best.score < base - 1e-3) {
      this._standAt(vrm, best.spot, aim);
      vrm.scene.updateMatrixWorld(true);
      for (const [, en] of active) this._followAnchor(en);
      solveChains(vrm, goals, bodySurface);
      return true;
    }
    return false;
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
