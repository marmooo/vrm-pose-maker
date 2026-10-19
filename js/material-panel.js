/**
 * material-panel.js - マテリアル編集パネル。
 *
 * アクティブなモデルの全メッシュからマテリアルを集めて選択式にし、
 * MToonMaterial (@pixiv/three-vrm) ならその全パラメータを、
 * 通常のPBRマテリアル(MeshStandardMaterial)ならその主要パラメータを、
 * PBR+ (MeshPhysicalMaterial、KHR_materials_*拡張が付いている場合のみ実際に
 * 生成される)ならクリアコート・透過・シーン・イリデセンスなどの追加パラメータも
 * あわせてスライダー・カラーピッカーで編集できるようにする。
 *
 * MToonのアウトラインは実体としては「元のメッシュのマテリアルを複製した、
 * 別インスタンスのマテリアル」として描画されている(three-vrmが読込時に自動生成する)。
 * そのため、アウトラインに関わる値だけをコピーしても足りず、この複製先が
 * 見た目として常に元のマテリアルと一致するよう、変更のたびに全パラメータを
 * コピーし直している。読込時にアウトラインが無効だったマテリアルで、あとから
 * アウトラインを有効にした場合は、three-vrm本体と同じ手順でその場において
 * アウトライン用のメッシュ複製を生成する。
 *
 * 【発光色などが編集してもすぐ元に戻ってしまう問題について】
 * VRMの表情(Expression)には、表情ごとに「このマテリアルのこの色をこの色に変える」
 * という紐付け(MaterialColorBind。例: 頬を赤くする、目を光らせる、等)を持てる。
 * three-vrmはこれを毎フレーム「紐付けを一度ぜんぶ元の色(VRM読込時点の色)に戻す→
 * 現在の表情のウェイトぶんだけ混ぜる」という手順で実現している。そのため、表情が
 * emissive(発光色)などにこの紐付けを持つモデルでは、このパネルで色を変えても
 * 次のフレームで毎回「読込時点の色」に戻されてしまい、何も変わっていないように
 * 見える(ウェイト0の表情は「読込時点の色のまま」が正解の挙動のため)。
 * これを防ぐため、色を変更した際は該当する紐付けの「戻り先」自体をその場で
 * 今設定した色に書き換える(rebaseExpressionColorBind)。three-vrmにはそのための
 * 公開APIが無いため、内部の_binds/_stateに直接手を入れている。
 */
import * as THREE from "three";
import { VRMExpressionMaterialColorBind } from "@pixiv/three-vrm";
import {
  createCheckbox,
  createColorInput,
  createSection,
  createSelect,
  createSlider,
} from "./controls.js";

import { tr } from "./i18n.js";
/**
 * 表情のMaterialColorBindが指定マテリアル・プロパティに対して持っている
 * 「戻り先の色」を、今まさに設定した色に書き換える。
 * これをしないと、次のvrm.update(delta)で表情システムが色を元(VRM読込時点)に
 * 戻してしまい、このパネルでの変更がすぐ打ち消されてしまう。
 * @param {import('@pixiv/three-vrm').VRM|null} vrm
 * @param {THREE.Material} material
 * @param {string} propertyName material上のプロパティ名 (例: 'emissive', 'color')
 */
function rebaseExpressionColorBinds(vrm, material, propertyName) {
  let count = 0;
  const expressions = vrm?.expressionManager?.expressions;
  if (!expressions) return count;
  for (const expression of expressions) {
    const binds = expression._binds;
    if (!Array.isArray(binds)) continue;
    for (const bind of binds) {
      if (!(bind instanceof VRMExpressionMaterialColorBind)) continue;
      if (bind.material !== material) continue;
      const state = bind._state?.color;
      if (!state || state.propertyName !== propertyName) continue;
      const current = material[propertyName];
      if (!current || !current.isColor) continue;
      state.initialValue.copy(current);
      state.deltaValue.setRGB(
        bind.targetValue.r - current.r,
        bind.targetValue.g - current.g,
        bind.targetValue.b - current.b,
      );
      count++;
    }
  }
  return count;
}

const DEBUG_MODE_OPTIONS = [
  { value: "none", label: tr("mat.001") },
  { value: "normal", label: tr("mat.002") },
  { value: "litShadeRate", label: tr("mat.003") },
  { value: "uv", label: "UV" },
];

const OUTLINE_WIDTH_MODE_OPTIONS = [
  { value: "none", label: tr("mat.001") },
  { value: "worldCoordinates", label: tr("mat.004") },
  { value: "screenCoordinates", label: tr("mat.005") },
];

// 変更のたびにアウトライン複製側へコピーする、MToonの見た目に関わるプロパティ一覧
const MTOON_COLOR_PROPS = [
  "color",
  "shadeColorFactor",
  "parametricRimColorFactor",
  "matcapFactor",
  "emissive",
  "outlineColorFactor",
];
const MTOON_NUMBER_PROPS = [
  "opacity",
  "alphaTest",
  "shadingShiftFactor",
  "shadingToonyFactor",
  "giEqualizationFactor",
  "parametricRimFresnelPowerFactor",
  "parametricRimLiftFactor",
  "rimLightingMixFactor",
  "emissiveIntensity",
  "outlineWidthFactor",
  "outlineLightingMixFactor",
  "uvAnimationScrollXSpeedFactor",
  "uvAnimationScrollYSpeedFactor",
  "uvAnimationRotationSpeedFactor",
];
const MTOON_OTHER_PROPS = [
  "outlineWidthMode",
  "ignoreVertexColor",
  "v0CompatShade",
  "debugMode",
  "transparent",
];
// ↑ 'side' はここに含めない: アウトライン複製は常に THREE.BackSide で描画する必要があり、
//   サーフェス側の side (通常 FrontSide) をコピーしてしまうと輪郭が正しく描画されなくなる。

function copyMToonAppearance(src, dst) {
  for (const p of MTOON_COLOR_PROPS) {
    if (src[p] && dst[p]?.copy) dst[p].copy(src[p]);
  }
  for (const p of MTOON_NUMBER_PROPS) {
    if (typeof src[p] === "number") dst[p] = src[p];
  }
  for (const p of MTOON_OTHER_PROPS) if (p in src) dst[p] = src[p];
  // 値の更新だけなら軽量な uniformsNeedUpdate で十分。needsUpdate(シェーダー再コンパイル)は
  // outlineWidthMode/debugMode などの各setterが本当に必要な時だけ内部で呼んでくれる。
  // ここで毎回 needsUpdate=true にすると、頻繁な変更のたびに無駄な再コンパイルが走り、
  // 描画が乱れる/消えるなどの不具合の原因になる。
  dst.uniformsNeedUpdate = true;
}

function shouldGenerateOutline(m) {
  return typeof m.outlineWidthMode === "string" &&
    m.outlineWidthMode !== "none" &&
    typeof m.outlineWidthFactor === "number" && m.outlineWidthFactor > 0;
}

/** three-vrm本体の _generateOutline と同じ手順で、その場でアウトライン用の複製を作る。 */
function createOutlineForMesh(mesh, surfaceMaterial) {
  mesh.material = [surfaceMaterial];
  const outlineMaterial = surfaceMaterial.clone();
  outlineMaterial.name = (surfaceMaterial.name || "material") + " (Outline)";
  outlineMaterial.isOutline = true;
  outlineMaterial.side = THREE.BackSide;
  mesh.material.push(outlineMaterial);
  const geometry = mesh.geometry;
  const primitiveVertices = geometry.index
    ? geometry.index.count
    : geometry.attributes.position.count / 3;
  geometry.addGroup(0, primitiveVertices, 0);
  geometry.addGroup(0, primitiveVertices, 1);
}

/** サーフェス側マテリアルの変更を、対応するアウトライン複製へ反映する(なければ必要に応じて生成する)。 */
function syncOutlineForMaterial(vrm, surfaceMaterial) {
  if (!surfaceMaterial.isMToonMaterial || !vrm) return;
  vrm.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    if (Array.isArray(obj.material)) {
      if (!obj.material.includes(surfaceMaterial)) return;
      const outline = obj.material.find((m) => m.isOutline);
      if (outline) copyMToonAppearance(surfaceMaterial, outline);
    } else if (
      obj.material === surfaceMaterial && shouldGenerateOutline(surfaceMaterial)
    ) {
      createOutlineForMesh(obj, surfaceMaterial);
    }
  });
}

/** VRMの全メッシュから、重複を除いた(アウトライン複製を除く)マテリアル一覧を集める。 */
function collectMaterials(vrm) {
  const seen = new Set();
  const list = [];
  let index = 0;
  vrm.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const materials = Array.isArray(obj.material)
      ? obj.material
      : [obj.material];
    for (const material of materials) {
      if (!material || material.isOutline || seen.has(material.uuid)) continue;
      seen.add(material.uuid);
      list.push({
        key: material.name ? material.name : `material-${index}`,
        material,
      });
      index++;
    }
  });
  return list;
}

const ALL_MATERIALS_KEY = "__all__";

/**
 * 編集項目の定義。kind ごとに createXxx を呼び分けて描画する。
 * get/set/exists を省略した場合は key を使ったデフォルトの読み書きになる
 * (color種別なら THREE.Color の get/set、それ以外は素の代入)。
 */
function fieldExists(field, m) {
  return field.exists ? field.exists(m) : field.key in m;
}
function fieldGet(field, m) {
  if (field.get) return field.get(m);
  return field.kind === "color"
    ? "#" + m[field.key].getHexString()
    : m[field.key];
}
function fieldSet(field, m, value) {
  if (field.set) {
    field.set(m, value);
    return;
  }
  if (field.kind === "color") m[field.key].set(value);
  else m[field.key] = value;
}

const BASE_FIELDS = [
  { key: "color", label: tr("mat.006"), kind: "color" },
  // opacity/alphaTest/transparent は「一括編集の対象から外す」(bulkUnsafe)。
  // VRMは頬の赤み・まつげ・顔の影テクスチャなど、パーツごとに意図的に異なる
  // 不透明度/透過設定を持っていることが多く、「すべてのマテリアル」で
  // 一括変更すると、それらの値が他の(本来不透明な)パーツにまで
  // 上書きされてモデル全体が透明になってしまう。個別のマテリアルを
  // 選んだ時だけ編集できるようにする。
  {
    key: "opacity",
    label: tr("mat.007"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    bulkUnsafe: true,
    hint: tr("mat.008"),
  },
  {
    key: "alphaTest",
    label: tr("mat.009"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    bulkUnsafe: true,
    hint: tr("mat.010"),
  },
  {
    key: "transparent",
    label: tr("mat.011"),
    kind: "checkbox",
    bulkUnsafe: true,
    hint: tr("mat.012"),
  },
  {
    key: "doubleSided",
    label: tr("mat.013"),
    kind: "checkbox",
    exists: () => true,
    hint: tr("mat.014"),
    get: (m) => m.side === THREE.DoubleSide,
    set: (m, v) => {
      m.side = v ? THREE.DoubleSide : THREE.FrontSide;
    },
  },
];
const WIREFRAME_FIELD = {
  key: "wireframe",
  label: tr("mat.015"),
  kind: "checkbox",
  exists: (m) => "wireframe" in m,
};
const PBR_FIELDS = [
  {
    key: "metalness",
    label: tr("mat.016"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.metalness === "number",
  },
  {
    key: "roughness",
    label: tr("mat.017"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.roughness === "number",
  },
];
// PBR+ (MeshPhysicalMaterial) 固有の項目。VRMにKHR_materials_*系拡張が
// ついている場合にだけ実際に生成されるマテリアルで、対応する項目が無い
// マテリアルではそれぞれ自動的にスキップされる。
const PBR_PLUS_FIELDS = [
  {
    key: "clearcoat",
    label: tr("mat.018"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.clearcoat === "number",
  },
  {
    key: "clearcoatRoughness",
    label: tr("mat.019"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.clearcoatRoughness === "number",
  },
  {
    key: "ior",
    label: tr("mat.020"),
    kind: "number",
    min: 1,
    max: 2.333,
    step: 0.01,
    exists: (m) => typeof m.ior === "number",
  },
  {
    key: "transmission",
    label: tr("mat.021"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.transmission === "number",
    bulkUnsafe: true,
  },
  {
    key: "thickness",
    label: tr("mat.022"),
    kind: "number",
    min: 0,
    max: 5,
    step: 0.01,
    exists: (m) => typeof m.thickness === "number",
  },
  {
    key: "attenuationDistance",
    label: tr("mat.023"),
    kind: "number",
    min: 0.01,
    max: 20,
    step: 0.01,
    exists: (m) => typeof m.attenuationDistance === "number",
    get: (
      m,
    ) => (Number.isFinite(m.attenuationDistance)
      ? Math.min(m.attenuationDistance, 20)
      : 20),
    set: (m, v) => {
      m.attenuationDistance = v >= 20 ? Infinity : v;
    },
  },
  {
    key: "attenuationColor",
    label: tr("mat.024"),
    kind: "color",
    exists: (m) => !!m.attenuationColor,
  },
  {
    key: "sheen",
    label: tr("mat.025"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.sheen === "number",
  },
  {
    key: "sheenRoughness",
    label: tr("mat.026"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.sheenRoughness === "number",
  },
  {
    key: "sheenColor",
    label: tr("mat.027"),
    kind: "color",
    exists: (m) => !!m.sheenColor,
  },
  {
    key: "specularIntensity",
    label: tr("mat.028"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.specularIntensity === "number",
  },
  {
    key: "specularColor",
    label: tr("mat.029"),
    kind: "color",
    exists: (m) => !!m.specularColor,
  },
  {
    key: "iridescence",
    label: tr("mat.030"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.iridescence === "number",
  },
  {
    key: "iridescenceIOR",
    label: tr("mat.031"),
    kind: "number",
    min: 1,
    max: 2.333,
    step: 0.01,
    exists: (m) => typeof m.iridescenceIOR === "number",
  },
  {
    key: "anisotropy",
    label: tr("mat.032"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.anisotropy === "number",
  },
  {
    key: "anisotropyRotation",
    label: tr("mat.033"),
    kind: "number",
    min: 0,
    max: Math.PI * 2,
    step: 0.01,
    exists: (m) => typeof m.anisotropyRotation === "number",
  },
  {
    key: "dispersion",
    label: tr("mat.034"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    exists: (m) => typeof m.dispersion === "number",
  },
];
const EMISSIVE_FIELDS = [
  // 発光強度は発光色に掛け算されるだけなので、どちらかが0(または黒)だと
  // 見た目は変わらない。両方を一緒に調整する必要がある。
  {
    key: "emissive",
    label: tr("mat.035"),
    kind: "color",
    exists: (m) => !!m.emissive,
    hint: tr("mat.036"),
  },
  {
    key: "emissiveIntensity",
    label: tr("mat.037"),
    kind: "number",
    min: 0,
    max: 5,
    step: 0.05,
    exists: (m) => typeof m.emissiveIntensity === "number",
    hint: tr("mat.038"),
  },
  {
    // VRoidなど多くのVRMは、実際には発光させる気のないパーツにまで、ほぼ真っ黒な
    // 「発光マップ」テクスチャを全メッシュへデフォルトで割り当てている。シェーダー上は
    // 発光色 × 発光マップ のテクセル値 になるため、マップがほぼ黒だと発光色・発光強度を
    // どう変えても結果はほぼ0(=見た目の変化なし)になる。これはモデル側の仕様であり
    // バグではないが、このアプリで発光色を試したい場合はマップ自体を無視できる必要が
    // ある。トグルで一時的にテクスチャを外し、元のテクスチャ参照はuserDataに保存して、
    // オフに戻せば復元できるようにする。
    key: "ignoreEmissiveMap",
    label: tr("mat.039"),
    kind: "checkbox",
    exists: (m) => !!m.emissive,
    hint: tr("mat.040"),
    get: (m) => !!m.userData.__emissiveMapHidden,
    set: (m, v) => {
      if (v) {
        if (!m.userData.__emissiveMapHidden) {
          m.userData.__originalEmissiveMap = m.emissiveMap;
          m.emissiveMap = null;
          m.userData.__emissiveMapHidden = true;
          // テクスチャの有無はシェーダーのdefine(USE_EMISSIVEMAP)を切り替えるため、
          // ここだけは軽量なuniformsNeedUpdateでは足りず、本当に再コンパイルが必要。
          m.needsUpdate = true;
        }
      } else if (m.userData.__emissiveMapHidden) {
        m.emissiveMap = m.userData.__originalEmissiveMap ?? null;
        m.userData.__emissiveMapHidden = false;
        m.needsUpdate = true;
      }
      // 診断用ログ: このトグル自体が実際に押されたか、効いたかをここで確認できる。
      console.info("[material-panel] ignoreEmissiveMap toggled", {
        material: m.name || "(no name)",
        ignoreEmissiveMap: v,
        emissiveMapNow: m.emissiveMap,
        hadOriginalMap: !!m.userData.__originalEmissiveMap,
      });
    },
  },
];
const MTOON_SHADE_FIELDS = [
  {
    key: "shadeColorFactor",
    label: tr("mat.041"),
    kind: "color",
    hint: tr("mat.042"),
  },
  {
    key: "shadingShiftFactor",
    label: tr("mat.043"),
    kind: "number",
    min: -1,
    max: 1,
    step: 0.01,
    hint: tr("mat.044"),
  },
  {
    key: "shadingToonyFactor",
    label: tr("mat.045"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    hint: tr("mat.046"),
  },
  // giEqualizationFactor (GI均一化) は仕様上は存在するが、このthree-vrmのバージョンの
  // シェーダー実装では参照されておらず、値を変えても見た目に反映されない。
  // 動かない項目を表示し続けると混乱するため、ここでは意図的に外してある。
];
const MTOON_RIM_FIELDS = [
  {
    key: "parametricRimColorFactor",
    label: tr("mat.047"),
    kind: "color",
    hint: tr("mat.048"),
  },
  {
    key: "parametricRimFresnelPowerFactor",
    label: tr("mat.049"),
    kind: "number",
    min: 0,
    max: 100,
    step: 0.5,
    hint: tr("mat.050"),
  },
  {
    key: "parametricRimLiftFactor",
    label: tr("mat.051"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    hint: tr("mat.052"),
  },
  // rimLightingMixFactor (リムライトとライティングのミックス) も同様に、このthree-vrmの
  // バージョンのシェーダーでは参照されておらず無効なため外してある。
];
const MTOON_MATCAP_FIELDS = [
  {
    key: "matcapFactor",
    label: tr("mat.053"),
    kind: "color",
    exists: (m) => !!m.matcapTexture,
    hint: tr("mat.054"),
  },
];
const MTOON_OUTLINE_FIELDS = [
  {
    key: "outlineWidthMode",
    label: tr("mat.055"),
    kind: "select",
    options: OUTLINE_WIDTH_MODE_OPTIONS,
  },
  {
    key: "outlineWidthFactor",
    label: tr("mat.056"),
    kind: "number",
    min: 0,
    max: 0.01,
    step: 0.0005,
    decimals: 4,
    hint: tr("mat.057"),
  },
  { key: "outlineColorFactor", label: tr("mat.058"), kind: "color" },
  {
    key: "outlineLightingMixFactor",
    label: tr("mat.059"),
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    hint: tr("mat.060"),
  },
];
// テクスチャの貼り付け位置(UV)そのものを時間経過で動かす機能。例えば「エフェクト的な
// 流れる模様」「炎や魔法陣のような、同じテクスチャをループでスクロール/回転させて
// 動きを出す」表現に使う。多くのVRMの肌・服・髪のテクスチャは模様が流れても
// 違和感のない絵柄ではない(むしろ継ぎ目が不自然に動いて見える)ため、このアプリで
// 読み込む普通のモデルではほぼ効果が感じられない、使いどころの限られた項目。
//
// 注意: 速度(SpeedFactor)は「動かし続ける速さ」でしかなく、実際に今どれだけ
// ズレているかは uvAnimationScrollXOffset 等の別の値(時間経過で勝手に増え続ける)
// が保持している。そのため速度を0に戻しても、ズレてしまった位置そのものは
// 戻らない。位置を戻したい場合は、下のオフセット項目自体をリセットする必要がある。
const MTOON_UVANIM_FIELDS = [
  {
    key: "uvAnimationScrollXSpeedFactor",
    label: tr("mat.061"),
    kind: "number",
    min: -2,
    max: 2,
    step: 0.05,
    hint: tr("mat.062"),
  },
  {
    key: "uvAnimationScrollYSpeedFactor",
    label: tr("mat.063"),
    kind: "number",
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    key: "uvAnimationRotationSpeedFactor",
    label: tr("mat.064"),
    kind: "number",
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    key: "uvAnimationScrollXOffset",
    label: tr("mat.065"),
    kind: "number",
    min: -5,
    max: 5,
    step: 0.05,
    exists: (m) => typeof m.uvAnimationScrollXOffset === "number",
    hint: tr("mat.066"),
  },
  {
    key: "uvAnimationScrollYOffset",
    label: tr("mat.067"),
    kind: "number",
    min: -5,
    max: 5,
    step: 0.05,
    exists: (m) => typeof m.uvAnimationScrollYOffset === "number",
  },
  {
    key: "uvAnimationRotationPhase",
    label: tr("mat.068"),
    kind: "number",
    min: -12.56,
    max: 12.56,
    step: 0.05,
    exists: (m) => typeof m.uvAnimationRotationPhase === "number",
    hint: tr("mat.069"),
  },
];
const MTOON_ADVANCED_FIELDS = [
  { key: "ignoreVertexColor", label: tr("mat.070"), kind: "checkbox" },
  { key: "v0CompatShade", label: tr("mat.071"), kind: "checkbox" },
  {
    key: "debugMode",
    label: tr("mat.072"),
    kind: "select",
    options: DEBUG_MODE_OPTIONS,
  },
];

// 全フィールドをフラットにした一覧。マテリアルごとの「初期値」スナップショットを
// 取るのに使う(存在するものだけ記録する)。
const ALL_FIELDS = [
  ...BASE_FIELDS,
  WIREFRAME_FIELD,
  ...PBR_FIELDS,
  ...PBR_PLUS_FIELDS,
  ...EMISSIVE_FIELDS,
  ...MTOON_SHADE_FIELDS,
  ...MTOON_RIM_FIELDS,
  ...MTOON_MATCAP_FIELDS,
  ...MTOON_OUTLINE_FIELDS,
  ...MTOON_UVANIM_FIELDS,
  ...MTOON_ADVANCED_FIELDS,
];

export class MaterialPanel {
  /**
   * @param {HTMLSelectElement} selectEl
   * @param {HTMLElement} container
   * @param {{ onChange?: () => void }} [callbacks]
   */
  constructor(selectEl, container, { onChange } = {}) {
    this._select = selectEl;
    this._container = container;
    this._onChange = onChange ?? (() => {});
    this._vrm = null;
    this._materials = [];
    // マテリアルごとの「初めて見た時の値」。リセットボタンの戻し先に使う。
    this._originals = new WeakMap();
    this._select.addEventListener("change", () => this._renderSelected());
  }

  /** アクティブなモデルが切り替わったときに呼ぶ。 */
  setVrm(vrm) {
    this._vrm = vrm;
    this._materials = vrm ? collectMaterials(vrm) : [];
    this._select.innerHTML = "";

    if (!this._materials.length) {
      this._select.disabled = true;
      this._container.innerHTML = tr("mat.073");
      return;
    }

    for (const { material } of this._materials) this._ensureOriginal(material);

    this._select.disabled = false;
    const allOpt = document.createElement("option");
    allOpt.value = ALL_MATERIALS_KEY;
    allOpt.textContent = tr("mat.074");
    this._select.appendChild(allOpt);
    for (const { key, material } of this._materials) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = material.name || key;
      this._select.appendChild(opt);
    }
    // 個々のマテリアルを1つずつ確認するのは大変なため、まず全体にまとめて
    // 効果を確認できるよう「すべてのマテリアル」を初期選択にしておく。
    this._select.value = ALL_MATERIALS_KEY;
    this._renderSelected();
  }

  /** 初めて見るマテリアルなら、今の値を「初期値」として記録しておく。 */
  _ensureOriginal(material) {
    let snapshot = this._originals.get(material);
    if (snapshot) return snapshot;
    snapshot = {};
    for (const field of ALL_FIELDS) {
      if (fieldExists(field, material)) {
        snapshot[field.key] = fieldGet(field, material);
      }
    }
    this._originals.set(material, snapshot);
    return snapshot;
  }

  _renderSelected() {
    this._container.innerHTML = "";
    const isAll = this._select.value === ALL_MATERIALS_KEY;
    const targets = isAll
      ? this._materials.map((m) => m.material)
      : [this._materials.find((m) => m.key === this._select.value)?.material]
        .filter(Boolean);

    if (!targets.length) {
      this._container.innerHTML = tr("mat.075");
      return;
    }

    if (isAll) {
      const note = document.createElement("div");
      note.className = "small text-secondary mb-2";
      note.textContent = tr("mat.076", targets.length);
      this._container.appendChild(note);
    }

    this._container.appendChild(this._buildFieldsPanel(targets, isAll));
  }

  /**
   * 対象マテリアル群(1個、または「すべて」の場合は全部)に対する編集UIを組み立てる。
   * 各フィールドは、対象のうち実際にそのプロパティを持つマテリアルだけに適用され、
   * 誰も持っていないフィールドは描画されない。
   * @param {boolean} isAll 「すべてのマテリアル」を選んでいるか。true の場合、
   *   bulkUnsafe (パーツごとに値が違って当然な項目) は表示しない。
   */
  _buildFieldsPanel(materials, isAll) {
    const root = document.createDocumentFragment();
    const anyMToon = materials.some((m) => m.isMToonMaterial);

    const sections = [
      [tr("mat.077"), [...BASE_FIELDS, WIREFRAME_FIELD]],
      [tr("mat.078"), PBR_FIELDS],
      [tr("mat.079"), PBR_PLUS_FIELDS],
      [tr("mat.080"), EMISSIVE_FIELDS],
    ];
    if (anyMToon) {
      sections.push(
        [tr("mat.081"), MTOON_SHADE_FIELDS],
        [tr("mat.082"), MTOON_RIM_FIELDS],
        [tr("mat.083"), MTOON_MATCAP_FIELDS],
        [tr("mat.084"), MTOON_OUTLINE_FIELDS],
        [tr("mat.085"), MTOON_UVANIM_FIELDS],
        [tr("mat.086"), MTOON_ADVANCED_FIELDS],
      );
    }

    // 同じ「すべて選択」描画の中で、フィールド同士が互いの表示を更新し合うための
    // (フィールドキー → コントロール)対応表。例: 発光色を黒以外にした時、
    // 発光強度が0だと見た目に出ないので強度側のスライダー表示も一緒に動かす。
    const controlsByKey = new Map();

    for (const [title, fields] of sections) {
      const section = createSection(title);
      for (const field of fields) {
        if (isAll && field.bulkUnsafe) continue;
        this._renderField(field, materials, section.content, controlsByKey);
      }
      if (section.content.children.length) root.appendChild(section.element);
    }
    return root;
  }

  /** フィールド1つ分のコントロールを作り、対応する全マテリアルへ反映されるようにする。 */
  _renderField(field, materials, container, controlsByKey) {
    const targets = materials.filter((m) => fieldExists(field, m));
    if (!targets.length) return;

    const first = targets[0];
    const currentValue = fieldGet(field, first);
    const resetValue = this._ensureOriginal(first)[field.key];

    const onChange = (value) => {
      const rebaseCounts = new Map();
      for (const m of targets) {
        fieldSet(field, m, value);
        // 色を変えた場合、表情(Expression)がこのプロパティに対する
        // MaterialColorBindを持っていると、次のvrm.update(delta)で
        // 「読込時点の色」に戻されてしまう。戻り先そのものを今の色に
        // 書き換えて、変更がすぐ打ち消されないようにする。
        if (field.kind === "color") {
          rebaseCounts.set(
            m,
            rebaseExpressionColorBinds(this._vrm, m, field.key),
          );
        }
        // 値だけの更新なら軽量な uniformsNeedUpdate で十分。needsUpdate(シェーダー再
        // コンパイル)を毎回呼ぶと、ドラッグ中に大量の再コンパイルが走ってしまい、
        // 描画が崩れる/透明になるなどの不具合の原因になる。再コンパイルが本当に
        // 必要な項目(outlineWidthMode/debugModeなど)は、各setterが内部で
        // needsUpdate=trueを呼ぶのでここでは何もしなくてよい。
        if (m.isMToonMaterial) m.uniformsNeedUpdate = true;
        syncOutlineForMaterial(this._vrm, m);
      }

      // 発光色を黒以外に変えたのに発光強度が0のままだと、何をどう変えても
      // 画面上は何も起きない(黒 × 0 = 0 も、色 × 0 = 0 も同じ)。
      // ここで強度を自動で1まで引き上げ、見た目にも反映する。
      if (field.key === "emissive") {
        let bumped = false;
        for (const m of targets) {
          if (m.emissive.getHex() !== 0 && m.emissiveIntensity === 0) {
            m.emissiveIntensity = 1;
            bumped = true;
          }
          // 診断用ログ: どうしても発光が見えない場合、ブラウザの開発者コンソール
          // (F12 → Console) に出るこの内容を見れば、強度/マップ/表情紐付けの
          // どれが原因かここで判別できる。rebasedExpressionBinds が1以上なら、
          // この色は表情システムの紐付けを持っていた(=今回の書き換え対象だった)ことを意味する。
          console.debug("[material-panel] emissive changed", {
            material: m.name || "(no name)",
            emissive: "#" + m.emissive.getHexString(),
            emissiveIntensity: m.emissiveIntensity,
            hasEmissiveMap: !!m.emissiveMap,
            isMToonMaterial: !!m.isMToonMaterial,
            rebasedExpressionBinds: rebaseCounts.get(m) ?? 0,
          });
        }
        if (bumped) controlsByKey?.get("emissiveIntensity")?.setValue(1);
      }

      this._onChange();
    };

    const opts = {
      label: field.label,
      hint: field.hint,
      value: currentValue,
      resetValue,
      onChange,
    };
    let control;
    switch (field.kind) {
      case "color":
        control = createColorInput(opts);
        break;
      case "select":
        control = createSelect({ ...opts, options: field.options });
        break;
      case "checkbox":
        control = createCheckbox({ ...opts, checked: currentValue });
        break;
      default:
        control = createSlider({
          ...opts,
          min: field.min,
          max: field.max,
          step: field.step,
        });
        break;
    }
    container.appendChild(control.element);
    controlsByKey?.set(field.key, control);
  }
}

/**
 * プロジェクト保存用に、モデルの全マテリアルの現在値をプレーンなオブジェクトとして取り出す。
 * @param {import('@pixiv/three-vrm').VRM} vrm
 */
export function getMaterialsSnapshot(vrm) {
  const snapshot = {};
  for (const { key, material: m } of collectMaterials(vrm)) {
    const data = { type: m.isMToonMaterial ? "mtoon" : "standard" };
    for (const field of ALL_FIELDS) {
      if (fieldExists(field, m)) data[field.key] = fieldGet(field, m);
    }
    snapshot[key] = data;
  }
  return snapshot;
}

/**
 * getMaterialsSnapshot() で取り出した値をモデルへ適用する(プロジェクト読込用)。
 * @param {import('@pixiv/three-vrm').VRM} vrm
 * @param {object} snapshot
 */
export function applyMaterialsSnapshot(vrm, snapshot) {
  if (!snapshot) return;
  for (const { key, material: m } of collectMaterials(vrm)) {
    const data = snapshot[key];
    if (!data) continue;
    for (const field of ALL_FIELDS) {
      if (data[field.key] !== undefined && fieldExists(field, m)) {
        fieldSet(field, m, data[field.key]);
        if (field.kind === "color") {
          rebaseExpressionColorBinds(vrm, m, field.key);
        }
      }
    }
    if (m.isMToonMaterial) {
      m.uniformsNeedUpdate = true;
      syncOutlineForMaterial(vrm, m);
    }
  }
}
