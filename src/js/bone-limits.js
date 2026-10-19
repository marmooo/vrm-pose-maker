/**
 * bone-limits.js - ボーンごとの可動域定義（ローカルオイラー角 XYZ順、単位:ラジアン）
 *
 * 出典: VRoidBones (MIT License) https://github.com/cmd410/VRoidBones/blob/master/constraints.py
 * および Second Life Wiki BVH Joint Rotation Limits
 *
 * ═══════════════════════════════════════════════════════════════
 * 軸マッピング: Blender LOCAL → VRM 正規化ボーン
 *
 * Blenderのボーンは Y軸が骨の伸びる方向。
 * VRM正規化ボーンは -Y軸が子方向（骨の伸びる方向）。
 *
 * VRoidBones は Blender LOCAL空間で制限を定義しているので、
 * VRM正規化ボーンへの変換は:
 *   Blender X → VRM X  (同じ)
 *   Blender Y → VRM -Y (逆)  ← ほぼ使われない（骨軸方向のロール）
 *   Blender Z → VRM Z  (VRoidはZupではなくYupで作成されているため同じ)
 *
 * すね・前腕はIK制限（ik_config）として定義されており:
 *   LowerLeg: X軸のみ -150〜0度（Blender X = VRM X）
 *   LowerArm_L: Z軸のみ -150〜0度（Blender Z = VRM Z）
 *   LowerArm_R: Z軸のみ 0〜+150度
 *
 * ただしBlenderとVRMでは初期ポーズ時のボーン向きが異なる場合があるため、
 * 実際の挙動を見ながら調整が必要。
 * ═══════════════════════════════════════════════════════════════
 *
 * { x:[min,max], y:[min,max], z:[min,max] } 単位: ラジアン
 * null = 制限なし (±π)
 */

const D = (deg) => deg * Math.PI / 180;

export const BONE_LIMITS = {
  // ===== 胴体 =====
  // VRoidBones: Spine ±30°, Chest ±15°, UpperChest ±10°
  hips: {
    x: [D(-40), D(40)],
    y: [D(-30), D(30)],
    z: [D(-30), D(30)],
  },
  spine: {
    x: [D(-30), D(30)],
    y: [D(-30), D(30)],
    z: [D(-30), D(30)],
  },
  chest: {
    x: [D(-15), D(15)],
    y: [D(-15), D(15)],
    z: [D(-15), D(15)],
  },
  upperChest: {
    x: [D(-10), D(10)],
    y: [D(-10), D(10)],
    z: [D(-10), D(10)],
  },

  // ===== 頭・首 =====
  // VRoidBones: Neck/Head ±30°
  neck: {
    x: [D(-30), D(30)],
    y: [D(-30), D(30)],
    z: [D(-30), D(30)],
  },
  head: {
    x: [D(-30), D(30)],
    y: [D(-30), D(30)],
    z: [D(-30), D(30)],
  },
  jaw: {
    x: [D(-30), D(0)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  // 目は eye モードで独自処理
  leftEye: { x: [D(-180), D(180)], y: [D(-180), D(180)], z: [D(-180), D(180)] },
  rightEye: {
    x: [D(-180), D(180)],
    y: [D(-180), D(180)],
    z: [D(-180), D(180)],
  },

  // ===== 左肩 =====
  // VRoidBones: Shoulder_L x:±20°, y:-5〜+20°, z:±20°
  leftShoulder: {
    x: [D(-20), D(20)],
    y: [D(-5), D(20)],
    z: [D(-20), D(20)],
  },

  // ===== 左上腕 =====
  // VRoidBones: UpperArm_L x:-120〜+25°, y:±50°, z:-130〜+90°
  leftUpperArm: {
    x: [D(-120), D(25)],
    y: [D(-50), D(50)],
    z: [D(-130), D(90)],
  },

  // ===== 左前腕 =====
  // VRoidBones IK: Z軸のみ -150〜0° (肘は一方向のみ)
  leftLowerArm: {
    x: [D(0), D(0)],
    y: [D(0), D(0)],
    z: [D(-150), D(0)],
  },

  // ===== 左手首 =====
  leftHand: {
    x: [D(-45), D(45)],
    y: [D(-20), D(30)],
    z: [D(-80), D(80)],
  },

  // ===== 右肩 =====
  // VRoidBones: Shoulder_R x:±20°, y:-20〜+5°, z:±20°
  rightShoulder: {
    x: [D(-20), D(20)],
    y: [D(-20), D(5)],
    z: [D(-20), D(20)],
  },

  // ===== 右上腕 =====
  // VRoidBones: UpperArm_R x:-120〜+25°, y:±50°, z:-90〜+130°
  rightUpperArm: {
    x: [D(-120), D(25)],
    y: [D(-50), D(50)],
    z: [D(-90), D(130)],
  },

  // ===== 右前腕 =====
  // VRoidBones IK: Z軸のみ 0〜+150° (左と逆方向)
  rightLowerArm: {
    x: [D(0), D(0)],
    y: [D(0), D(0)],
    z: [D(0), D(150)],
  },

  // ===== 右手首 =====
  rightHand: {
    x: [D(-45), D(45)],
    y: [D(-30), D(20)],
    z: [D(-80), D(80)],
  },

  // ===== 左手指 =====
  // VRoidBones fingers: x:-90〜+8°, y:0, z:±20°
  leftThumbMetacarpal: {
    x: [D(-57), D(20)],
    y: [D(0), D(0)],
    z: [D(-20), D(30)],
  },
  leftThumbProximal: {
    x: [D(-57), D(20)],
    y: [D(0), D(0)],
    z: [D(-20), D(30)],
  },
  leftThumbDistal: { x: [D(-57), D(20)], y: [D(0), D(0)], z: [D(-20), D(30)] },
  leftIndexProximal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(-20), D(20)] },
  leftIndexIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  leftIndexDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  leftMiddleProximal: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(-20), D(20)],
  },
  leftMiddleIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  leftMiddleDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  leftRingProximal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(-20), D(20)] },
  leftRingIntermediate: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  leftRingDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  leftLittleProximal: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(-20), D(20)],
  },
  leftLittleIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  leftLittleDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },

  // ===== 右手指 =====（左右対称、Z軸は符号反転）
  rightThumbMetacarpal: {
    x: [D(-57), D(20)],
    y: [D(0), D(0)],
    z: [D(-30), D(20)],
  },
  rightThumbProximal: {
    x: [D(-57), D(20)],
    y: [D(0), D(0)],
    z: [D(-30), D(20)],
  },
  rightThumbDistal: { x: [D(-57), D(20)], y: [D(0), D(0)], z: [D(-30), D(20)] },
  rightIndexProximal: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(-20), D(20)],
  },
  rightIndexIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  rightIndexDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  rightMiddleProximal: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(-20), D(20)],
  },
  rightMiddleIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  rightMiddleDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  rightRingProximal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(-20), D(20)] },
  rightRingIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  rightRingDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },
  rightLittleProximal: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(-20), D(20)],
  },
  rightLittleIntermediate: {
    x: [D(-90), D(8)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
  rightLittleDistal: { x: [D(-90), D(8)], y: [D(0), D(0)], z: [D(0), D(0)] },

  // ===== 左太もも =====
  // VRoidBones: UpperLeg x:-40〜+110°, y:±25°, z:-45〜+80°
  leftUpperLeg: {
    x: [D(-40), D(110)],
    y: [D(-25), D(25)],
    z: [D(-45), D(80)],
  },

  // ===== 左すね =====
  // VRoidBones IK: X軸のみ -150〜0° (膝は後ろ方向のみ)
  leftLowerLeg: {
    x: [D(-150), D(0)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },

  // ===== 左足首 =====
  // VRoidBones: Foot x:-48〜+37°, y:±3°, z:±15°
  leftFoot: {
    x: [D(-48), D(37)],
    y: [D(-3), D(3)],
    z: [D(-15), D(15)],
  },
  leftToes: {
    x: [D(-30), D(30)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },

  // ===== 右太もも =====（左右対称）
  rightUpperLeg: {
    x: [D(-40), D(110)],
    y: [D(-25), D(25)],
    z: [D(-80), D(45)],
  },

  // ===== 右すね =====
  rightLowerLeg: {
    x: [D(-150), D(0)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },

  // ===== 右足首 =====
  rightFoot: {
    x: [D(-48), D(37)],
    y: [D(-3), D(3)],
    z: [D(-15), D(15)],
  },
  rightToes: {
    x: [D(-30), D(30)],
    y: [D(0), D(0)],
    z: [D(0), D(0)],
  },
};

/**
 * 指定ボーンの可動域を取得
 * @param {string} boneName
 * @returns {{ x:[min,max], y:[min,max], z:[min,max] }} 単位: ラジアン
 */
export function getBoneLimit(boneName) {
  return BONE_LIMITS[boneName] ?? {
    x: [D(-180), D(180)],
    y: [D(-180), D(180)],
    z: [D(-180), D(180)],
  };
}
