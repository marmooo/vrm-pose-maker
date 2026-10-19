/**
 * bone-hierarchy.js - VRM ヒューマンボーンの親子関係（共通定義）
 *
 * bone-control.js（球の右クリックでの親切り替え）と
 * ui.js（パネルの「親ボーンへ」ボタン）の両方から参照する。
 */

// 子 → 親 マッピング
export const PARENT_MAP = {
  spine: "hips",
  chest: "spine",
  upperChest: "chest",
  neck: "upperChest",
  head: "neck",
  jaw: "head",
  leftEye: "head",
  rightEye: "head",
  leftShoulder: "upperChest",
  leftUpperArm: "leftShoulder",
  leftLowerArm: "leftUpperArm",
  leftHand: "leftLowerArm",
  leftThumbMetacarpal: "leftHand",
  leftThumbProximal: "leftThumbMetacarpal",
  leftThumbDistal: "leftThumbProximal",
  leftIndexProximal: "leftHand",
  leftIndexIntermediate: "leftIndexProximal",
  leftIndexDistal: "leftIndexIntermediate",
  leftMiddleProximal: "leftHand",
  leftMiddleIntermediate: "leftMiddleProximal",
  leftMiddleDistal: "leftMiddleIntermediate",
  leftRingProximal: "leftHand",
  leftRingIntermediate: "leftRingProximal",
  leftRingDistal: "leftRingIntermediate",
  leftLittleProximal: "leftHand",
  leftLittleIntermediate: "leftLittleProximal",
  leftLittleDistal: "leftLittleIntermediate",
  rightShoulder: "upperChest",
  rightUpperArm: "rightShoulder",
  rightLowerArm: "rightUpperArm",
  rightHand: "rightLowerArm",
  rightThumbMetacarpal: "rightHand",
  rightThumbProximal: "rightThumbMetacarpal",
  rightThumbDistal: "rightThumbProximal",
  rightIndexProximal: "rightHand",
  rightIndexIntermediate: "rightIndexProximal",
  rightIndexDistal: "rightIndexIntermediate",
  rightMiddleProximal: "rightHand",
  rightMiddleIntermediate: "rightMiddleProximal",
  rightMiddleDistal: "rightMiddleIntermediate",
  rightRingProximal: "rightHand",
  rightRingIntermediate: "rightRingProximal",
  rightRingDistal: "rightRingIntermediate",
  rightLittleProximal: "rightHand",
  rightLittleIntermediate: "rightLittleProximal",
  rightLittleDistal: "rightLittleIntermediate",
  leftUpperLeg: "hips",
  leftLowerLeg: "leftUpperLeg",
  leftFoot: "leftLowerLeg",
  leftToes: "leftFoot",
  rightUpperLeg: "hips",
  rightLowerLeg: "rightUpperLeg",
  rightFoot: "rightLowerLeg",
  rightToes: "rightFoot",
};

/**
 * @param {string} boneName
 * @returns {string|null} 親のヒューマンボーン名（hips 等ルートの場合は null）
 */
export function getParentBoneName(boneName) {
  return PARENT_MAP[boneName] ?? null;
}

/**
 * boneName の「唯一の子」を PARENT_MAP から逆引きする。
 * CHILD_MAP でカバーしていない末端の細かいボーン（指など）向けの
 * フォールバック。指の各関節は子が1つだけなので曖昧さがない。
 *
 * head（子候補: jaw / leftEye / rightEye）のように子が複数ある場合は、
 * どれか1つを恣意的に選ぶとレスト方向の基準が意図しないものになって
 * しまう（例: head の場合、あご方向を基準にすると上下が直感と逆転する）
 * ため、複数ある場合は null を返す。呼び出し側で別のフォールバック
 * （自分自身のオフセット方向など）を使うことを想定している。
 */
export function findAnyChildBoneName(boneName) {
  const matches = Object.entries(PARENT_MAP)
    .filter(([, parent]) => parent === boneName)
    .map(([child]) => child);
  return matches.length === 1 ? matches[0] : null;
}

// 親 → 子 マッピング（体幹・四肢の主要ボーンのみ。指は対象外）
// クリック選択時の「骨の線分」判定や、球の半径計算に使う。
export const CHILD_MAP = {
  hips: "spine",
  spine: "chest",
  chest: "upperChest",
  upperChest: "neck",
  neck: "head",
  leftShoulder: "leftUpperArm",
  leftUpperArm: "leftLowerArm",
  leftLowerArm: "leftHand",
  rightShoulder: "rightUpperArm",
  rightUpperArm: "rightLowerArm",
  rightLowerArm: "rightHand",
  leftUpperLeg: "leftLowerLeg",
  leftLowerLeg: "leftFoot",
  leftFoot: "leftToes",
  rightUpperLeg: "rightLowerLeg",
  rightLowerLeg: "rightFoot",
  rightFoot: "rightToes",
};

/**
 * クリックによるボーン選択の対象となる主要ボーン一覧（指などの細かいボーンは除く）
 */
export const SELECTABLE_BONE_NAMES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];

/**
 * VRMヒューマノイドの全ボーン名（指を含む）。PARENT_MAP のキー（=ルートの
 * hips 以外の全ボーン）に、ルートの 'hips' を加えたもの。
 * ポーズの保存・リセット・書き出しなど「すべてのボーンを対象にしたい」
 * 処理で使う共通の一覧（ここだけ直せば漏れなく反映される）。
 */
export const ALL_BONE_NAMES = ["hips", ...Object.keys(PARENT_MAP)];

/**
 * "left"/"right" で始まるボーン名の、反対側のボーン名を返す。
 * 左右の対がないボーン（hips, spine, chest, neck, head など体幹）は null。
 */
export function getMirrorBoneName(boneName) {
  if (boneName.startsWith("left")) return "right" + boneName.slice(4);
  if (boneName.startsWith("right")) return "left" + boneName.slice(5);
  return null;
}

/**
 * boneName 自身と、その子孫すべてのボーン名を返す（PARENT_MAP を辿って判定）。
 * 例: 'leftUpperArm' → [leftUpperArm, leftLowerArm, leftHand, 指...]
 */
export function getDescendantBoneNames(boneName) {
  const result = [boneName];
  for (const name of ALL_BONE_NAMES) {
    if (name === boneName) continue;
    let cur = name;
    let depth = 0;
    while (cur && depth < 30) {
      const parent = getParentBoneName(cur);
      if (parent === boneName) {
        result.push(name);
        break;
      }
      cur = parent;
      depth++;
    }
  }
  return result;
}
