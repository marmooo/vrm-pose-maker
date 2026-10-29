/**
 * ui.js - ボーンリスト描画・スライダー制御
 */
import * as THREE from "three";
import { getMirrorBoneName, getParentBoneName } from "./bone-hierarchy.js";

import { tr } from "./i18n.js";
// フラットなボーンリスト（表示順・グループ・日本語ラベル）
const BONE_LIST = [
  // 胴体
  { group: tr("ui.001"), name: "hips", label: tr("ui.002") },
  { group: tr("ui.001"), name: "spine", label: tr("ui.003") },
  { group: tr("ui.001"), name: "chest", label: tr("ui.004") },
  { group: tr("ui.001"), name: "upperChest", label: tr("ui.005") },
  // 頭
  { group: tr("ui.006"), name: "neck", label: tr("ui.007") },
  { group: tr("ui.006"), name: "head", label: tr("ui.006") },
  { group: tr("ui.006"), name: "jaw", label: tr("ui.008") },
  { group: tr("ui.006"), name: "leftEye", label: tr("ui.009") },
  { group: tr("ui.006"), name: "rightEye", label: tr("ui.010") },
  // 左腕
  { group: tr("ui.011"), name: "leftShoulder", label: tr("ui.012") },
  { group: tr("ui.011"), name: "leftUpperArm", label: tr("ui.013") },
  { group: tr("ui.011"), name: "leftLowerArm", label: tr("ui.014") },
  { group: tr("ui.011"), name: "leftHand", label: tr("ui.015") },
  // 右腕
  { group: tr("ui.032"), name: "rightShoulder", label: tr("ui.033") },
  { group: tr("ui.032"), name: "rightUpperArm", label: tr("ui.034") },
  { group: tr("ui.032"), name: "rightLowerArm", label: tr("ui.035") },
  { group: tr("ui.032"), name: "rightHand", label: tr("ui.036") },
  // 左脚
  { group: tr("ui.053"), name: "leftUpperLeg", label: tr("ui.054") },
  { group: tr("ui.053"), name: "leftLowerLeg", label: tr("ui.055") },
  { group: tr("ui.053"), name: "leftFoot", label: tr("ui.056") },
  { group: tr("ui.053"), name: "leftToes", label: tr("ui.057") },
  // 右脚
  { group: tr("ui.058"), name: "rightUpperLeg", label: tr("ui.059") },
  { group: tr("ui.058"), name: "rightLowerLeg", label: tr("ui.060") },
  { group: tr("ui.058"), name: "rightFoot", label: tr("ui.061") },
  { group: tr("ui.058"), name: "rightToes", label: tr("ui.062") },
  // 左手指
  { group: tr("ui.016"), name: "leftThumbMetacarpal", label: tr("ui.017") },
  { group: tr("ui.016"), name: "leftThumbProximal", label: tr("ui.018") },
  { group: tr("ui.016"), name: "leftThumbDistal", label: tr("ui.019") },
  { group: tr("ui.016"), name: "leftIndexProximal", label: tr("ui.020") },
  { group: tr("ui.016"), name: "leftIndexIntermediate", label: tr("ui.021") },
  { group: tr("ui.016"), name: "leftIndexDistal", label: tr("ui.022") },
  { group: tr("ui.016"), name: "leftMiddleProximal", label: tr("ui.023") },
  { group: tr("ui.016"), name: "leftMiddleIntermediate", label: tr("ui.024") },
  { group: tr("ui.016"), name: "leftMiddleDistal", label: tr("ui.025") },
  { group: tr("ui.016"), name: "leftRingProximal", label: tr("ui.026") },
  { group: tr("ui.016"), name: "leftRingIntermediate", label: tr("ui.027") },
  { group: tr("ui.016"), name: "leftRingDistal", label: tr("ui.028") },
  { group: tr("ui.016"), name: "leftLittleProximal", label: tr("ui.029") },
  { group: tr("ui.016"), name: "leftLittleIntermediate", label: tr("ui.030") },
  { group: tr("ui.016"), name: "leftLittleDistal", label: tr("ui.031") },
  // 右手指
  { group: tr("ui.037"), name: "rightThumbMetacarpal", label: tr("ui.038") },
  { group: tr("ui.037"), name: "rightThumbProximal", label: tr("ui.039") },
  { group: tr("ui.037"), name: "rightThumbDistal", label: tr("ui.040") },
  { group: tr("ui.037"), name: "rightIndexProximal", label: tr("ui.041") },
  { group: tr("ui.037"), name: "rightIndexIntermediate", label: tr("ui.042") },
  { group: tr("ui.037"), name: "rightIndexDistal", label: tr("ui.043") },
  { group: tr("ui.037"), name: "rightMiddleProximal", label: tr("ui.044") },
  { group: tr("ui.037"), name: "rightMiddleIntermediate", label: tr("ui.045") },
  { group: tr("ui.037"), name: "rightMiddleDistal", label: tr("ui.046") },
  { group: tr("ui.037"), name: "rightRingProximal", label: tr("ui.047") },
  { group: tr("ui.037"), name: "rightRingIntermediate", label: tr("ui.048") },
  { group: tr("ui.037"), name: "rightRingDistal", label: tr("ui.049") },
  { group: tr("ui.037"), name: "rightLittleProximal", label: tr("ui.050") },
  { group: tr("ui.037"), name: "rightLittleIntermediate", label: tr("ui.051") },
  { group: tr("ui.037"), name: "rightLittleDistal", label: tr("ui.052") },
];

// ボーン名 → 日本語ラベルの逆引き（親ボーン表示用）
export const BONE_LABELS = Object.fromEntries(
  BONE_LIST.map((b) => [b.name, b.label]),
);

// 表情（Expression）名 → 日本語ラベル。未知の名前はそのまま表示する。
export const EXPRESSION_LABELS = {
  happy: tr("ui.063"),
  angry: tr("ui.064"),
  sad: tr("ui.065"),
  relaxed: tr("ui.066"),
  surprised: tr("ui.067"),
  aa: tr("ui.068"),
  ih: tr("ui.069"),
  ou: tr("ui.070"),
  ee: tr("ui.071"),
  oh: tr("ui.072"),
  blink: tr("ui.073"),
  blinkLeft: tr("ui.074"),
  blinkRight: tr("ui.075"),
  lookUp: tr("ui.076"),
  lookDown: tr("ui.077"),
  lookLeft: tr("ui.078"),
  lookRight: tr("ui.079"),
};

// 大文字小文字違い（アバター側のカスタム表情名など）でも一致するように、
// 小文字化したキーの逆引きテーブルを作っておく
const EXPRESSION_LABELS_LOWER = Object.fromEntries(
  Object.entries(EXPRESSION_LABELS).map(([k, v]) => [k.toLowerCase(), v]),
);

/** 表情名から日本語ラベルを引く（大文字小文字を無視して一致させる） */
function getExpressionLabel(name) {
  return EXPRESSION_LABELS_LOWER[name.toLowerCase()] ?? name;
}

export class UIManager {
  /**
   * @param {Object} callbacks
   * @param {(boneName: string) => void} callbacks.onBoneSelect
   * @param {(boneName: string, axis: string, deg: number) => void} callbacks.onSliderChange
   * @param {(boneName: string) => void} callbacks.onBoneReset
   * @param {(boneName: string, axis: string) => void} callbacks.onAxisReset
   * @param {(boneName: string) => void} callbacks.onMirrorPart
   * @param {(name: string, weight: number) => void} callbacks.onExpressionChange
   * @param {(boneNames: string[], options?: {explicit?: boolean}) => void} callbacks.onBonesRandom 部位まとめてランダム
   * @param {(boneNames: string[]) => void} callbacks.onBonesReset 部位まとめてリセット
   */
  constructor(callbacks) {
    this._callbacks = callbacks;
    this._vrm = null;
    this._selectedBone = null;
    this._availableBones = new Set();

    this._boneListContainer = document.getElementById("bone-list-container");
    this._boneControls = document.getElementById("bone-controls");
    this._boneHint = document.getElementById("bone-hint");
    this._expressionControls = document.getElementById("expression-controls");

    // 見出し(Bones)の「全体ランダム / 全体リセット」ボタン。VRM にあるボーン全部が対象
    document.getElementById("bone-all-random")?.addEventListener(
      "click",
      () => this._callbacks.onBonesRandom([...this._availableBones]),
    );
    document.getElementById("bone-all-reset")?.addEventListener(
      "click",
      () => this._callbacks.onBonesReset([...this._availableBones]),
    );
  }

  /**
   * VRM 読込後にボーンリストを描画する
   */
  buildBoneList(vrm) {
    this._vrm = vrm;
    this._availableBones.clear();

    // VRM に実際に存在するボーンを収集
    for (const { name } of BONE_LIST) {
      if (vrm.humanoid.getNormalizedBoneNode(name)) {
        this._availableBones.add(name);
      }
    }

    this._boneListContainer.innerHTML = "";

    // グループごとにまとめる(VRM に存在するボーンだけ)
    const groups = [];
    for (const { group, name, label } of BONE_LIST) {
      if (!this._availableBones.has(name)) continue;
      if (groups.at(-1)?.group !== group) groups.push({ group, items: [] });
      groups.at(-1).items.push({ name, label });
    }

    const createRow = (name, label) => {
      const row = document.createElement("div");
      row.className = "bone-item small";
      row.dataset.bone = name;
      row.textContent = label;
      row.addEventListener("click", () => {
        this.selectBone(name);
        this._callbacks.onBoneSelect(name);
      });
      return row;
    };
    const ICON = (id) =>
      `<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="/vrm-pose-maker/icons/bootstrap-icons.svg#${id}"/></svg>`;
    // 部位まとめて操作するボタン組(ランダム / リセット)
    const createTools = (names, label, randomOptions) => {
      const tools = document.createElement("span");
      tools.className = "bone-tools";
      const add = (icon, title, callback, options) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bone-tool-btn";
        btn.innerHTML = ICON(icon);
        btn.title = title;
        btn.setAttribute("aria-label", title);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          callback(names, options);
        });
        tools.appendChild(btn);
      };
      add(
        "shuffle",
        tr("ui.096", label),
        this._callbacks.onBonesRandom,
        randomOptions,
      );
      add(
        "arrow-counterclockwise",
        tr("ui.097", label),
        this._callbacks.onBonesReset,
      );
      return tools;
    };
    const createHeader = (text, names) => {
      const header = document.createElement("div");
      header.className = "bone-group-header small";
      const label = document.createElement("span");
      label.className = "bone-header-label";
      label.textContent = text;
      header.appendChild(label);
      if (names?.length) header.appendChild(createTools(names, text));
      return header;
    };
    // 指ごとの見出し(各指の最初の関節の前に差し込む)
    const FINGER_LABELS = {
      Thumb: tr("ui.091"),
      Index: tr("ui.092"),
      Middle: tr("ui.093"),
      Ring: tr("ui.094"),
      Little: tr("ui.095"),
    };
    const fingerKeyOf = (name) =>
      name.match(/^((?:left|right)(?:Thumb|Index|Middle|Ring|Little))/)?.[1] ??
        null;
    // その指の関節のうち、リストの先頭に来るものか(見出しと関節ボタンを出す位置)
    const isFirstJointOfFinger = (name, items) =>
      fingerKeyOf(name) !== null &&
      items.find((i) => fingerKeyOf(i.name) === fingerKeyOf(name))?.name ===
        name;
    // 関節の番号(付け根側から 1, 2, 3)。親指は 中手骨→基節→末節、他の指は 基節→中節→末節
    const JOINT_NUMBER = { Metacarpal: 1, Intermediate: 2, Distal: 3 };
    const jointNumberOf = (name) => {
      const joint = name.match(/(Metacarpal|Proximal|Intermediate|Distal)$/)[1];
      if (joint === "Proximal") return /Thumb/.test(name) ? 2 : 1;
      return JOINT_NUMBER[joint];
    };
    // 指ごとの関節ボタン(1 2 3 を横に等分して並べる)
    const createFingerJoints = (name, items) => {
      const key = fingerKeyOf(name);
      const fingerLabel = FINGER_LABELS[key.replace(/^(left|right)/, "")];
      const row = document.createElement("div");
      row.className = "bone-finger-joints";
      const byNumber = new Map(
        items.filter((i) => fingerKeyOf(i.name) === key).map((
          i,
        ) => [jointNumberOf(i.name), i]),
      );
      for (const n of [1, 2, 3]) {
        const item = byNumber.get(n);
        if (!item) {
          row.appendChild(document.createElement("div"));
          continue;
        }
        const chip = createRow(item.name, String(n));
        chip.classList.add("bone-joint");
        chip.title = tr("ui.099", fingerLabel, n);
        row.appendChild(chip);
      }
      return row;
    };
    // 目の見出し(頭グループ内。目は頭グループ全体のランダムでは動かさず、ここからだけ動かす)
    const createEyeHeader = (items) => {
      const header = document.createElement("div");
      header.className = "bone-finger-header small";
      const label = document.createElement("span");
      label.className = "bone-header-label";
      label.textContent = tr("ui.098");
      header.appendChild(label);
      const names = items.map((i) => i.name).filter((n) => /Eye$/.test(n));
      header.appendChild(
        createTools(names, label.textContent, { explicit: true }),
      );
      return header;
    };
    const createFingerHeader = (name, items) => {
      const key = fingerKeyOf(name);
      const header = document.createElement("div");
      header.className = "bone-finger-header small";
      const label = document.createElement("span");
      label.className = "bone-header-label";
      label.textContent = FINGER_LABELS[key.replace(/^(left|right)/, "")];
      header.appendChild(label);
      const names = items.map((i) => i.name).filter((n) =>
        fingerKeyOf(n) === key
      );
      header.appendChild(createTools(names, label.textContent));
      return header;
    };
    const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
    const SIDE = /^(Left |Right |左|右)/;
    // 左右ペアの列では見出しに左右が出るので、各ボーン名の先頭の「左」「右」(Left / Right)は省く
    const stripSide = (label) => capitalize(label.replace(SIDE, ""));

    // 左のグループごとに、同じ部位(leftHand と rightHand など)を持つ右のグループを探して組にする
    const partsOf = (items, side) =>
      new Set(items.map((item) => item.name.replace(side, "")));
    const pairOf = new Map(); // 左グループの番号 → 右グループの番号
    const consumed = new Set(); // 左と組にして並べた、右グループの番号
    groups.forEach((g, i) => {
      if (!g.items[0].name.startsWith("left")) return;
      const leftParts = partsOf(g.items, /^left/);
      let best = -1;
      let bestCount = 0;
      for (let j = i + 1; j < groups.length; j++) {
        if (consumed.has(j) || !groups[j].items[0].name.startsWith("right")) {
          continue;
        }
        const count = [...partsOf(groups[j].items, /^right/)].filter((p) =>
          leftParts.has(p)
        ).length;
        if (count > bestCount) {
          [best, bestCount] = [j, count];
        }
      }
      if (best >= 0) {
        pairOf.set(i, best);
        consumed.add(best);
      }
    });

    for (let i = 0; i < groups.length; i++) {
      if (consumed.has(i)) continue; // 左と組にして、すでに並べた
      const { group, items } = groups[i];
      if (pairOf.has(i)) {
        const next = groups[pairOf.get(i)];
        // 左を左の列・右を右の列に並べる(同じ部位が同じ行に並ぶ)
        const grid = document.createElement("div");
        grid.className = "bone-pair";
        grid.append(
          createHeader(group, items.map((i) => i.name)),
          createHeader(next.group, next.items.map((i) => i.name)),
        );
        const rightByPart = new Map(
          next.items.map((item) => [item.name.replace(/^right/, ""), item]),
        );
        const used = new Set();
        const empty = () => document.createElement("div");
        for (const item of items) {
          const part = item.name.replace(/^left/, "");
          const right = rightByPart.get(part);
          used.add(part);
          if (fingerKeyOf(item.name)) {
            // 指は「見出し(ランダム/リセット)」と「関節 1 2 3」の2行にまとめる。
            // 左右の同じ指を同じ行に並べる
            if (isFirstJointOfFinger(item.name, items)) {
              grid.append(
                createFingerHeader(item.name, items),
                right ? createFingerHeader(right.name, next.items) : empty(),
                createFingerJoints(item.name, items),
                right ? createFingerJoints(right.name, next.items) : empty(),
              );
            }
            continue;
          }
          grid.append(
            createRow(item.name, stripSide(item.label)),
            right ? createRow(right.name, stripSide(right.label)) : empty(),
          );
        }
        for (const [part, item] of rightByPart) {
          if (used.has(part)) continue;
          if (fingerKeyOf(item.name)) {
            if (isFirstJointOfFinger(item.name, next.items)) {
              grid.append(
                empty(),
                createFingerHeader(item.name, next.items),
                empty(),
                createFingerJoints(item.name, next.items),
              );
            }
            continue;
          }
          grid.append(empty(), createRow(item.name, stripSide(item.label)));
        }
        this._boneListContainer.appendChild(grid);
        continue;
      }
      this._boneListContainer.appendChild(
        createHeader(group, items.map((i) => i.name)),
      );
      const groupEl = document.createElement("div");
      groupEl.className = "bone-group";
      let eyePair = null; // 左右の目は2列に並べる
      for (const { name, label } of items) {
        if (fingerKeyOf(name)) {
          if (isFirstJointOfFinger(name, items)) {
            groupEl.appendChild(createFingerHeader(name, items));
            groupEl.appendChild(createFingerJoints(name, items));
          }
          continue;
        }
        if (/^(left|right)Eye$/.test(name)) {
          if (!eyePair) {
            groupEl.appendChild(createEyeHeader(items));
            eyePair = document.createElement("div");
            eyePair.className = "bone-eye-pair";
            groupEl.appendChild(eyePair);
          }
          // 左目を左の列、右目を右の列に(片方しかない場合は空きを入れる)
          if (name === "rightEye" && !eyePair.children.length) {
            eyePair.appendChild(document.createElement("div"));
          }
          eyePair.appendChild(createRow(name, label));
          continue;
        }
        groupEl.appendChild(createRow(name, label));
      }
      this._boneListContainer.appendChild(groupEl);
    }
  }

  /**
   * ボーンを選択状態にする（リスト側）
   * @param {string} boneName
   */
  selectBone(boneName) {
    this._selectedBone = boneName;

    // リストのハイライトを更新
    this._boneListContainer.querySelectorAll(".bone-item").forEach((el) => {
      el.classList.toggle("selected", el.dataset.bone === boneName);
    });

    // 選択ボーンをスクロールして表示
    const selected = this._boneListContainer.querySelector(
      `.bone-item[data-bone="${boneName}"]`,
    );
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }

    // ヒントバッジ更新
    this._boneHint.textContent = boneName;
    this._boneHint.classList.remove("d-none");

    // 右パネルのスライダーを構築
    this._buildSliders(boneName);
  }

  clearBoneSelection() {
    this._selectedBone = null;
    this._boneListContainer.querySelectorAll(".bone-item").forEach((el) => {
      el.classList.remove("selected");
    });
    this._boneHint.classList.add("d-none");
    this._boneControls.innerHTML = tr("ui.080");
  }

  /**
   * 右パネルにスライダーを構築
   */
  _buildSliders(boneName) {
    if (!this._vrm) return;

    const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    const euler = new THREE.Euler().setFromQuaternion(node.quaternion, "XYZ");
    const toDeg = (r) => Math.round(THREE.MathUtils.radToDeg(r));

    this._boneControls.innerHTML = "";

    // ボーン名ヘッダ + リセットボタン
    const header = document.createElement("div");
    header.className = "mb-1 d-flex align-items-center justify-content-between";

    const nameLabel = document.createElement("span");
    nameLabel.className = "small fw-bold text-body-emphasis";
    nameLabel.textContent = boneName;

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-sm btn-outline-secondary";
    resetBtn.innerHTML = tr("ui.081");
    resetBtn.title = tr("ui.082");
    resetBtn.addEventListener("click", () => {
      this._callbacks.onBoneReset(boneName);
    });

    header.appendChild(nameLabel);
    header.appendChild(resetBtn);
    this._boneControls.appendChild(header);

    // 左右対称ミラーボタン（このボーン＋子孫を反対側へコピー）
    const mirrorTarget = getMirrorBoneName(boneName);
    if (mirrorTarget) {
      const mirrorLabel = BONE_LABELS[mirrorTarget] ?? mirrorTarget;
      const mirrorRow = document.createElement("div");
      mirrorRow.className = "mb-2";
      const mirrorBtn = document.createElement("button");
      mirrorBtn.className = "btn btn-sm btn-outline-warning w-100";
      mirrorBtn.innerHTML = tr("ui.083", mirrorLabel);
      mirrorBtn.title = tr("ui.084");
      mirrorBtn.addEventListener("click", () => {
        this._callbacks.onMirrorPart(boneName);
      });
      mirrorRow.appendChild(mirrorBtn);
      this._boneControls.appendChild(mirrorRow);
    }

    // 親ボーンへ切り替えるボタン（3D上で球をクリックしなくても切り替えられる）
    const parentName = getParentBoneName(boneName);
    const parentRow = document.createElement("div");
    parentRow.className = "mb-2";

    if (parentName) {
      const parentLabel = BONE_LABELS[parentName] ?? parentName;
      const parentBtn = document.createElement("button");
      parentBtn.className = "btn btn-sm btn-outline-info w-100";
      parentBtn.innerHTML = tr("ui.085", parentLabel);
      parentBtn.title = tr("ui.086");
      parentBtn.addEventListener("click", () => {
        this._callbacks.onBoneSelect(parentName);
      });
      parentRow.appendChild(parentBtn);
    } else {
      const rootNote = document.createElement("div");
      rootNote.className = "text-secondary small";
      rootNote.innerHTML = tr("ui.087");
      parentRow.appendChild(rootNote);
    }
    this._boneControls.appendChild(parentRow);

    // X, Y, Z スライダー
    for (const axis of ["x", "y", "z"]) {
      const deg = toDeg(euler[axis]);
      const group = this._createSliderGroup(boneName, axis, deg);
      this._boneControls.appendChild(group);
    }
  }

  _createSliderGroup(boneName, axis, initialDeg) {
    const wrapper = document.createElement("div");
    wrapper.className = "axis-slider-group";

    const labelRow = document.createElement("div");
    labelRow.className = "d-flex align-items-center gap-2 mb-1";

    const axisLabel = document.createElement("span");
    axisLabel.className = "axis-label";
    axisLabel.textContent = axis.toUpperCase();

    const numInput = document.createElement("input");
    numInput.type = "number";
    numInput.className =
      "form-control form-control-sm text-end axis-value-input ms-auto";
    numInput.min = -180;
    numInput.max = 180;
    numInput.step = 1;
    numInput.value = initialDeg;
    numInput.dataset.bone = boneName;
    numInput.dataset.axis = axis;

    const axisResetBtn = document.createElement("button");
    axisResetBtn.type = "button";
    axisResetBtn.className = "btn btn-sm btn-outline-secondary axis-reset-btn";
    axisResetBtn.innerHTML =
      '<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="/vrm-pose-maker/icons/bootstrap-icons.svg#arrow-counterclockwise"/></svg>';
    axisResetBtn.title = tr("ui.088", axis.toUpperCase());
    axisResetBtn.addEventListener("click", () => {
      this._callbacks.onAxisReset(boneName, axis);
    });

    labelRow.appendChild(axisLabel);
    labelRow.appendChild(numInput);
    labelRow.appendChild(axisResetBtn);
    wrapper.appendChild(labelRow);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "form-range";
    slider.min = -180;
    slider.max = 180;
    slider.step = 1;
    slider.value = initialDeg;
    slider.dataset.bone = boneName;
    slider.dataset.axis = axis;

    wrapper.appendChild(slider);

    // スライダー → 数値・ボーン更新
    slider.addEventListener("input", () => {
      numInput.value = slider.value;
      this._callbacks.onSliderChange(boneName, axis, parseFloat(slider.value));
    });

    // 数値入力 → スライダー・ボーン更新
    numInput.addEventListener("change", () => {
      let v = parseFloat(numInput.value);
      v = Math.max(-180, Math.min(180, v));
      numInput.value = v;
      slider.value = v;
      this._callbacks.onSliderChange(boneName, axis, v);
    });

    return wrapper;
  }

  /**
   * ドラッグ操作後にスライダーを現在値に同期する
   * @param {string} boneName
   * @param {THREE.Quaternion} quaternion
   */
  syncSlidersFromBone(boneName, quaternion) {
    if (this._selectedBone !== boneName) return;

    const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
    const toDeg = (r) => Math.round(THREE.MathUtils.radToDeg(r));

    for (const axis of ["x", "y", "z"]) {
      const deg = toDeg(euler[axis]);
      const slider = this._boneControls.querySelector(
        `input[type="range"][data-bone="${boneName}"][data-axis="${axis}"]`,
      );
      const numInput = this._boneControls.querySelector(
        `input[type="number"][data-bone="${boneName}"][data-axis="${axis}"]`,
      );
      if (slider) slider.value = deg;
      if (numInput) numInput.value = deg;
    }
  }

  /**
   * VRM 読込後に表情（Expression）スライダーを描画する。
   * @param {string[]} expressionNames
   */
  buildExpressionControls(expressionNames, customNames = []) {
    this._expressionControls.innerHTML = "";

    if (!expressionNames || expressionNames.length === 0) {
      this._expressionControls.innerHTML = tr("ui.089");
      return;
    }

    // 標準の表情を先に、モデル独自(カスタム)の表情を後に並べ、間に区切り線を引く
    const custom = new Set(customNames);
    const standard = expressionNames.filter((name) => !custom.has(name));
    const extra = expressionNames.filter((name) => custom.has(name));
    const ordered = [...standard, ...extra];

    for (const name of ordered) {
      if (extra.length && standard.length && name === extra[0]) {
        const divider = document.createElement("hr");
        divider.className = "my-3";
        this._expressionControls.appendChild(divider);
      }
      const label = getExpressionLabel(name);

      const wrapper = document.createElement("div");
      wrapper.className = "mb-3";

      const labelRow = document.createElement("div");
      labelRow.className = "d-flex align-items-center gap-2 mb-1";

      const nameLabel = document.createElement("span");
      nameLabel.className = "small";
      nameLabel.textContent = label;

      const numInput = document.createElement("input");
      numInput.type = "number";
      numInput.className =
        "form-control form-control-sm text-end ms-auto expression-value-input";
      numInput.min = 0;
      numInput.max = 100;
      numInput.step = 1;
      numInput.value = 0;
      numInput.dataset.expression = name;

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "btn btn-sm btn-outline-secondary";
      resetBtn.innerHTML =
        '<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="/vrm-pose-maker/icons/bootstrap-icons.svg#arrow-counterclockwise"/></svg>';
      resetBtn.title = tr("ui.090");

      labelRow.appendChild(nameLabel);
      labelRow.appendChild(numInput);
      labelRow.appendChild(resetBtn);
      wrapper.appendChild(labelRow);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "form-range";
      slider.min = 0;
      slider.max = 100;
      slider.step = 1;
      slider.value = 0;
      slider.dataset.expression = name;
      wrapper.appendChild(slider);

      const onChange = (val) => {
        const v = Math.max(0, Math.min(100, val));
        slider.value = v;
        numInput.value = v;
        this._callbacks.onExpressionChange(name, v / 100);
      };
      slider.addEventListener(
        "input",
        () => onChange(parseFloat(slider.value)),
      );
      numInput.addEventListener(
        "change",
        () => onChange(parseFloat(numInput.value) || 0),
      );
      resetBtn.addEventListener("click", () => onChange(0));

      this._expressionControls.appendChild(wrapper);
    }
  }

  /** 表情スライダー(と数値入力)を指定した値(0〜1)にそろえる。表情自体の変更は呼び出し側で行う */
  setExpressionSliderValue(name, weight) {
    const percent = Math.round(Math.max(0, Math.min(1, weight)) * 100);
    this._expressionControls.querySelectorAll("input[data-expression]").forEach(
      (el) => {
        if (el.dataset.expression === name) el.value = percent;
      },
    );
  }

  /** すべての表情スライダーを 0 に戻す（表情自体のリセットは呼び出し側で行う） */
  resetExpressionSliders() {
    this._expressionControls.querySelectorAll("input[data-expression]").forEach(
      (el) => {
        el.value = 0;
      },
    );
  }

  reset() {
    this._vrm = null;
    this._selectedBone = null;
    this._availableBones.clear();
    this._boneListContainer.innerHTML = tr("app.041");
    this._boneControls.innerHTML = tr("ui.080");
    this._expressionControls.innerHTML = tr("app.041");
    this._boneHint.classList.add("d-none");
  }
}
