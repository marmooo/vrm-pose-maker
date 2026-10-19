/**
 * bone-sphere.js - ボーン操作UI（球 / ギズモ）の表示と操作
 *
 * 可動域制限は行わない。UIはボーン操作のためのものとして機能するのみ。
 *
 * 操作方式（manipMode）:
 *   'sphere' : 半透明の球をドラッグして自由な方向へ向ける（デフォルト）。
 *   'gizmo'  : X(赤)/Y(緑)/Z(青) の回転リング。掴んだ軸だけを回転させる。
 *   位置移動（右ドラッグ/2本指）と、起点クリックでの操作対象トグルは
 *   どちらのモードでも共通して使える。
 *
 * モード（見た目の種別。'sphere'方式の球サイズ決定に使う）:
 *   'limb'  : 四肢系。子ボーンまでの距離を半径にした水色球。
 *   'torso' : 胴体系。身長比率の大きめの球。
 *   'eye'   : 目。頭前方にオフセットした球。X/Y軸のみ回転。
 *
 * 操作対象トグル（targetMode）:
 *   'self'   : 選択中のボーン自身を回転/移動する（デフォルト）。
 *              例: 「すね」選択時 → すねの先（足首側）が動く。
 *   'parent' : 選択中のボーン（ピボット）のワールド変換を完全に固定したまま、
 *              親ボーンの向きだけを変える（回転のみ。位置移動は簡易的に
 *              親ボーンをそのまま動かす）。
 *              例: 「すね」選択時に回転操作 → すねの位置・向きは固定されたまま
 *                  （足首・つま先も地面に設置したまま動かない）、
 *                  親の「太もも」から上（腰・体幹など）がすねを蝶番にして動く。
 *   起点マーカー（中心の点）をクリックするとトグルされる。
 *   球面/リングのドラッグ（回転/移動操作）とは別の当たり判定なので競合しない。
 */
import * as THREE from "three";
import {
  CHILD_MAP,
  findAnyChildBoneName,
  getParentBoneName,
} from "./bone-hierarchy.js";

const BONE_MODE = {
  hips: "torso",
  spine: "torso",
  chest: "torso",
  upperChest: "torso",
  neck: "torso",
  head: "torso",
  jaw: "torso",
  leftEye: "eye",
  rightEye: "eye",
};

const DEFAULT_RADIUS = 0.12;

// 目の可動域クランプ（現実的な範囲に収める。左右上下 ±この角度まで）
const EYE_MAX_ANGLE_DEG = 35;

const COLOR_SELF = 0x44aaff; // 通常（自分自身を操作）
const COLOR_EYE = 0x88ccff;
const COLOR_PARENT = 0xffaa33; // 親ボーン操作モード
const DOT_COLOR_SELF = 0xffff00;
const DOT_COLOR_PARENT = 0xff8800;

const GIZMO_AXES = [
  {
    key: "x",
    color: 0xff5050,
    apply: (m) => {
      m.rotation.y = Math.PI / 2;
    },
    local: new THREE.Vector3(1, 0, 0),
  },
  {
    key: "y",
    color: 0x50ff50,
    apply: (m) => {
      m.rotation.x = Math.PI / 2;
    },
    local: new THREE.Vector3(0, 1, 0),
  },
  {
    key: "z",
    color: 0x5090ff,
    apply: () => {},
    local: new THREE.Vector3(0, 0, 1),
  },
];

export class BoneSphere {
  constructor(sceneManager, onBoneChange) {
    this._scene = sceneManager;
    this._onBoneChange = onBoneChange;
    this._vrm = null;
    this._boneName = null;
    this._boneNode = null;
    this._radius = DEFAULT_RADIUS;
    this._mode = "limb";
    // 'sphere' | 'gizmo' - 操作方式。ボーンを選び直しても保持される
    // （ユーザーの好みとして扱う）。
    this._manipMode = "sphere";
    // ドラッグ中かどうか。待機中は球を薄いワイヤーフレームだけにして
    // モデルや他の関節が見やすいように（親ボーン選択の邪魔をしないように）する。
    this._dragging = false;
    // 'self' | 'parent' - 起点クリックでトグルする操作対象
    this._targetMode = "self";
    // ドラッグ中の連続性の基準方向（resetDragReference/_pickContinuousHitPoint参照）
    this._dragReferenceDir = null;
    // ギズモでドラッグ中の軸（'x'|'y'|'z'|null）
    this._gizmoAxis = null;
    this._activeGizmoAxis = null;

    this._group = new THREE.Group();
    sceneManager.scene.add(this._group);

    this._sphereMesh = null;
    this._wireMesh = null;
    this._hitSphereMesh = null; // 当たり判定専用（不可視・両モード共通）
    this._dotMesh = null;
    this._dotHitMesh = null; // 起点クリック判定専用（見た目より広め・不可視）
    this._ringMeshes = null;
    this._ringHitMeshes = null;

    this._raycaster = new THREE.Raycaster();
    this._modelHeight = 1.6;
  }

  setVrm(vrm) {
    this._vrm = vrm;
    this._modelHeight = this._calcModelHeight(vrm);
    this.hide();
  }

  show(boneName) {
    if (!this._vrm) return;
    const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    this._boneName = boneName;
    this._boneNode = node;
    this._mode = BONE_MODE[boneName] ?? "limb";
    // ボーンを選び直したら操作対象は毎回「自分自身」に戻す
    // （manipMode＝球かギズモかは、ユーザーの好みとして保持したまま変えない）
    this._targetMode = "self";
    this._dragReferenceDir = null;
    this._gizmoAxis = null;
    this._activeGizmoAxis = null;

    if (this._mode === "torso") {
      this._radius = this._modelHeight * 0.30;
    } else if (this._mode === "eye") {
      // 目は「注視点ターゲット」として、目自体より一回り大きく、
      // 少し離れた場所に表示する（クリック精度を確保するため）。
      this._radius = this._modelHeight * 0.12;
    } else {
      this._radius = this._calcLimbRadius(boneName);
    }

    this._buildMeshes();
    this._updatePosition();
  }

  hide() {
    this._group.clear();
    this._sphereMesh = null;
    this._wireMesh = null;
    this._hitSphereMesh = null;
    this._dotMesh = null;
    this._dotHitMesh = null;
    this._ringMeshes = null;
    this._ringHitMeshes = null;
    this._boneName = null;
    this._boneNode = null;
    this._dragging = false;
    this._dragReferenceDir = null;
    this._targetMode = "self";
    this._gizmoAxis = null;
    this._activeGizmoAxis = null;
  }

  update() {
    if (!this._boneNode) return;
    this._updatePosition();
  }

  /**
   * 操作方式を 'sphere' ⇄ 'gizmo' で切り替える。
   * ボーンを選び直しても保持される、ユーザーのグローバルな好み設定。
   */
  setManipulationMode(mode) {
    if (mode !== "sphere" && mode !== "gizmo") return;
    if (this._manipMode === mode) return;
    this._manipMode = mode;
    if (this._boneNode) {
      this._buildMeshes();
      this._updatePosition();
    }
  }

  getManipulationMode() {
    return this._manipMode;
  }

  /**
   * ドラッグ中（回転/移動の操作中）かどうかを設定する。
   * 待機中は球を薄いワイヤーフレームだけにして視界を遮らないようにし、
   * 実際に操作している間だけ塗りつぶして分かりやすくする。
   */
  setDragging(active) {
    this._dragging = active;
    this._applyVisualState();
  }

  isSphereHit(pointer, camera) {
    if (!this._hitSphereMesh) return false;
    this._raycaster.setFromCamera(pointer, camera);
    return this._raycaster.intersectObject(this._hitSphereMesh, false).length >
      0;
  }

  /**
   * ギズモの回転リングのうち、どれをクリックしたか（'x'|'y'|'z'）を判定する。
   * 'gizmo' モードでない場合は常に null。
   */
  hitTestGizmoRing(pointer, camera) {
    if (this._manipMode !== "gizmo" || !this._ringHitMeshes) return null;
    this._raycaster.setFromCamera(pointer, camera);
    for (const spec of GIZMO_AXES) {
      const mesh = this._ringHitMeshes[spec.key];
      if (mesh && this._raycaster.intersectObject(mesh, false).length > 0) {
        return spec.key;
      }
    }
    return null;
  }

  /** ギズモドラッグ開始。ドラッグ中の軸を強調表示する。 */
  beginGizmoRotate(axisKey) {
    this._gizmoAxis = axisKey;
    this._activeGizmoAxis = axisKey;
    this._applyVisualState();
  }

  /** ギズモドラッグ終了。強調表示を解除する。 */
  endGizmoRotate() {
    this._gizmoAxis = null;
    this._activeGizmoAxis = null;
    this._applyVisualState();
  }

  /**
   * ギズモでドラッグ中の軸まわりに、指定した角度（ラジアン）だけ回転を加える。
   * 'parent' モード（操作対象トグルが親）の場合は、選択中ボーン（ピボット）の
   * ワールド変換を固定したまま親ボーンを回すピボット固定処理を行う。
   */
  applyGizmoRotationDelta(deltaAngle) {
    if (!this._gizmoAxis || !this._boneNode) return;
    const spec = GIZMO_AXES.find((s) => s.key === this._gizmoAxis);
    if (!spec) return;

    if (this._targetMode === "parent" && this._boneNode.parent) {
      const pivot = this._boneNode;
      const eff = pivot.parent;

      const effParentWorldQ = new THREE.Quaternion();
      if (eff.parent) eff.parent.getWorldQuaternion(effParentWorldQ);
      const worldAxis = spec.local.clone().applyQuaternion(effParentWorldQ)
        .normalize();

      const effWorldQuatCurrent = new THREE.Quaternion();
      eff.getWorldQuaternion(effWorldQuatCurrent);
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(
        worldAxis,
        deltaAngle,
      );
      const effWorldQuatNew = deltaQuat.multiply(effWorldQuatCurrent)
        .normalize();

      this._applyPivotPreservingEffWorldQuat(pivot, eff, effWorldQuatNew);
    } else {
      const node = this._boneNode;
      const parentWorldQ = new THREE.Quaternion();
      if (node.parent) node.parent.getWorldQuaternion(parentWorldQ);
      const worldAxis = spec.local.clone().applyQuaternion(parentWorldQ)
        .normalize();

      const currentWorldQuat = new THREE.Quaternion();
      node.getWorldQuaternion(currentWorldQuat);
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(
        worldAxis,
        deltaAngle,
      );
      const newWorldQuat = deltaQuat.multiply(currentWorldQuat).normalize();

      const newLocalQuat = parentWorldQ.clone().invert().multiply(newWorldQuat);
      node.quaternion.copy(newLocalQuat).normalize();
      this._onBoneChange(this._boneName, node.quaternion);
    }
  }

  /**
   * 中心の起点マーカー（黄色い点）をクリックしたかどうか。
   * 見た目より少し広い専用メッシュで判定するのでタップしやすい。
   * 球面のドラッグ判定（isSphereHit / handleClick）とは独立している。
   */
  isDotHit(pointer, camera) {
    if (!this._dotHitMesh) return false;
    this._raycaster.setFromCamera(pointer, camera);
    return this._raycaster.intersectObject(this._dotHitMesh, false).length > 0;
  }

  /**
   * 現在のボーンに、トグル可能な親ボーンが存在するか
   * （ヒューマンボーンの根本＝hips には親がないので不可）
   */
  hasToggleableParent() {
    if (!this._vrm || !this._boneName) return false;
    const parentName = getParentBoneName(this._boneName);
    if (!parentName) return false;
    return !!this._vrm.humanoid.getNormalizedBoneNode(parentName);
  }

  /**
   * 操作対象を 'self' ⇄ 'parent' でトグルする。
   * 親ボーンが存在しない場合は何もせず false を返す。
   */
  toggleTargetMode() {
    if (!this.hasToggleableParent()) return false;
    this._targetMode = this._targetMode === "self" ? "parent" : "self";
    this._applyVisualState();
    return true;
  }

  getTargetMode() {
    return this._targetMode;
  }

  /**
   * 指定した軸（'x'|'y'|'z'）の、現在のワールド空間での方向ベクトルを返す。
   * 'parent' モードの場合は eff（親ボーン）基準、'self' の場合は選択中
   * ボーン自身基準で計算する（applyGizmoRotationDelta と同じ基準）。
   */
  getGizmoWorldAxis(axisKey) {
    const spec = GIZMO_AXES.find((s) => s.key === axisKey);
    if (!spec || !this._boneNode) return new THREE.Vector3(1, 0, 0);

    const refNode = (this._targetMode === "parent" && this._boneNode.parent)
      ? this._boneNode.parent
      : this._boneNode;

    const parentWorldQ = new THREE.Quaternion();
    if (refNode.parent) refNode.parent.getWorldQuaternion(parentWorldQ);
    return spec.local.clone().applyQuaternion(parentWorldQ).normalize();
  }

  /** 現在実際に動かす対象のボーン名（'self'なら選択中ボーン、'parent'ならその親） */
  getEffectiveBoneName() {
    if (this._targetMode === "parent") {
      return getParentBoneName(this._boneName) ?? this._boneName;
    }
    return this._boneName;
  }

  /**
   * ドラッグ中の「連続性」の基準方向。新しくドラッグを始めた最初の一回は
   * 必ず null にリセットし、手前側（見たまま）を採用する。
   * ドラッグを継続している間だけ、直前に選んだ方向を基準に、より近い方
   * （手前 or 奥）を選ぶことで、そのままドラッグし続けると球の裏側にも
   * 自然に回り込めるようにする。
   */
  resetDragReference() {
    this._dragReferenceDir = null;
  }

  /**
   * クリック位置とカメラから伸ばしたレイは、球面と2点（手前側・奥側）で
   * 交差することがある。
   * - ドラッグを新しく始めた最初の一回: 見たまま（手前側 = hits[0]）を採用。
   * - ドラッグ継続中: 直前に選んだ方向に近い方（＝自然に連続する方）を選ぶ。
   *   これにより、そのまま同じ向きにドラッグし続けるだけで球の裏側
   *   （カメラの死角）まで回り込めるようになる。
   */
  _pickContinuousHitPoint(hits, originWorld) {
    let best;
    if (hits.length <= 1 || !this._dragReferenceDir) {
      // 初回クリック、または交点が1つだけ → 見たまま（手前側）
      best = hits[0];
    } else {
      let bestDot = -Infinity;
      for (const h of hits) {
        const dir = h.point.clone().sub(originWorld).normalize();
        const dot = dir.dot(this._dragReferenceDir);
        if (dot > bestDot) {
          bestDot = dot;
          best = h;
        }
      }
    }

    this._dragReferenceDir = best.point.clone().sub(originWorld).normalize();
    return best.point;
  }

  handleClick(pointer, camera) {
    if (this._manipMode !== "sphere" || !this._sphereMesh || !this._boneNode) {
      return false;
    }
    this._raycaster.setFromCamera(pointer, camera);
    const hits = this._raycaster.intersectObject(this._sphereMesh, false);
    if (hits.length === 0) return false;

    const originWorld = new THREE.Vector3();
    this._boneNode.getWorldPosition(originWorld);
    const targetPoint = this._pickContinuousHitPoint(hits, originWorld);

    // 目ボーン専用のX/Y制限つき視線処理は「自分自身」を動かす場合のみ。
    // 親（=頭）を動かす場合は通常の回転処理を使う。
    if (this._mode === "eye" && this._targetMode === "self") {
      this._aimEyeAt(targetPoint);
    } else {
      this._aimBoneAt(targetPoint);
    }
    return true;
  }

  /**
   * 位置移動。'parent' モードの場合は親ボーンをそのまま平行移動する
   * （回転のようなピボット固定＝足元を動かさない処理は行わない簡易版）。
   */
  handleTranslate(dx, dy, camera) {
    const node = this._getEffectiveNode();
    if (!node) return;
    const sensitivity = 0.004;
    const camRight = new THREE.Vector3();
    const camUp = new THREE.Vector3();
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    const delta = new THREE.Vector3()
      .addScaledVector(camRight, dx * sensitivity)
      .addScaledVector(camUp, -dy * sensitivity);

    const worldPos = new THREE.Vector3();
    node.getWorldPosition(worldPos);
    worldPos.add(delta);

    if (node.parent) {
      const inv = new THREE.Matrix4().copy(node.parent.matrixWorld).invert();
      worldPos.applyMatrix4(inv);
    }
    node.position.copy(worldPos);
    this._onBoneChange(this.getEffectiveBoneName(), node.quaternion);
  }

  // =========================================================
  // Private: メッシュ構築
  // =========================================================

  _buildMeshes() {
    this._group.clear();
    const r = this._radius;

    // 当たり判定専用の不可視球（右クリックでの位置移動・親切替判定に、
    // 球/ギズモどちらのモードでも共通で使う）
    const hitGeo = new THREE.SphereGeometry(r, 16, 16);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    this._hitSphereMesh = new THREE.Mesh(hitGeo, hitMat);
    this._group.add(this._hitSphereMesh);

    this._sphereMesh = null;
    this._wireMesh = null;
    this._ringMeshes = null;
    this._ringHitMeshes = null;

    if (this._manipMode === "gizmo") {
      this._buildGizmoRings();
    } else {
      // 球本体（単色・半透明）。待機中はほぼ透明にしておき、
      // ドラッグ中だけ濃く見せる（_applyVisualState で切り替える）。
      const geo = new THREE.SphereGeometry(r, 32, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: COLOR_SELF,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this._sphereMesh = new THREE.Mesh(geo, mat);
      this._group.add(this._sphereMesh);

      // ワイヤーフレーム（輪郭のみ・常時薄く表示 → モデルが透けて見える）
      const wireGeo = new THREE.SphereGeometry(r * 1.001, 16, 16);
      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x66bbdd,
        transparent: true,
        opacity: 0.18,
        wireframe: true,
      });
      this._wireMesh = new THREE.Mesh(wireGeo, wireMat);
      this._group.add(this._wireMesh);
    }

    // 中心マーカー（操作対象トグル用。モード共通・見た目）
    const dotGeo = new THREE.SphereGeometry(r * 0.07, 12, 12);
    const dotMat = new THREE.MeshBasicMaterial({
      color: DOT_COLOR_SELF,
      depthTest: false,
    });
    this._dotMesh = new THREE.Mesh(dotGeo, dotMat);
    this._dotMesh.renderOrder = 999;
    this._group.add(this._dotMesh);

    // 中心マーカーのクリック判定（見た目より広め・不可視。タップしやすくする）
    const dotHitGeo = new THREE.SphereGeometry(
      Math.max(r * 0.22, 0.025),
      12,
      12,
    );
    const dotHitMat = new THREE.MeshBasicMaterial({ visible: false });
    this._dotHitMesh = new THREE.Mesh(dotHitGeo, dotHitMat);
    this._group.add(this._dotHitMesh);

    this._applyVisualState();
  }

  /**
   * ギズモ（回転リング）を構築する。X=赤 / Y=緑 / Z=青。
   * リングは常時前面に描画し（depthTest無効）、モデルに隠れず掴みやすくする。
   * 見た目より太い当たり判定用トーラスを別途重ねてタップしやすくする。
   */
  _buildGizmoRings() {
    const r = this._radius;
    const tube = Math.max(r * 0.05, 0.006);
    const hitTube = Math.max(r * 0.16, 0.02);

    this._ringMeshes = {};
    this._ringHitMeshes = {};

    for (const spec of GIZMO_AXES) {
      const geo = new THREE.TorusGeometry(r, tube, 8, 48);
      const mat = new THREE.MeshBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 998;
      spec.apply(mesh);
      this._group.add(mesh);
      this._ringMeshes[spec.key] = mesh;

      const hitGeo = new THREE.TorusGeometry(r, hitTube, 6, 24);
      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hitMesh = new THREE.Mesh(hitGeo, hitMat);
      spec.apply(hitMesh);
      this._group.add(hitMesh);
      this._ringHitMeshes[spec.key] = hitMesh;
    }
  }

  /**
   * ドラッグ中かどうか・操作対象モード・(ギズモなら)アクティブな軸に応じて
   * 見た目を切り替える。
   */
  _applyVisualState() {
    const isParentMode = this._targetMode === "parent";

    if (this._dotMesh) {
      this._dotMesh.material.color.set(
        isParentMode ? DOT_COLOR_PARENT : DOT_COLOR_SELF,
      );
    }

    if (this._manipMode === "gizmo") {
      if (!this._ringMeshes) return;
      for (const spec of GIZMO_AXES) {
        const mesh = this._ringMeshes[spec.key];
        if (!mesh) continue;
        const isActive = this._activeGizmoAxis === spec.key;
        mesh.material.opacity = isActive ? 1.0 : 0.75;
        mesh.scale.setScalar(isActive ? 1.06 : 1.0);
      }
      return;
    }

    if (!this._sphereMesh || !this._wireMesh) return;
    const fillOpacity = this._mode === "torso" ? 0.20 : 0.30;
    const baseColor = this._mode === "eye" ? COLOR_EYE : COLOR_SELF;

    this._sphereMesh.material.color.set(
      isParentMode ? COLOR_PARENT : baseColor,
    );

    if (this._dragging) {
      this._sphereMesh.material.opacity = fillOpacity;
      this._wireMesh.material.opacity = 0.35;
    } else {
      // 待機中はほぼ透明のワイヤーフレームのみにして、
      // モデルの見え方や他ボーンの選択を邪魔しないようにする。
      this._sphereMesh.material.opacity = 0.03;
      this._wireMesh.material.opacity = 0.18;
    }
  }

  // =========================================================
  // Private: 位置更新
  // =========================================================

  _updatePosition() {
    const wp = new THREE.Vector3();
    this._boneNode.getWorldPosition(wp);

    if (this._mode === "eye") {
      // 目の少し前方、「注視点ターゲット」としてちょうど良い距離にオフセット。
      // 目自体の可動域は±35度程度にクランプしているので（_aimEyeAt参照）、
      // 球のどこをクリックしても現実的な範囲に収まる。
      const headNode = this._vrm?.humanoid?.getNormalizedBoneNode("head");
      const refNode = headNode ?? this._boneNode.parent ?? this._boneNode;
      const refWorldQ = new THREE.Quaternion();
      refNode.getWorldQuaternion(refWorldQ);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(refWorldQ);
      this._group.position.copy(wp).addScaledVector(
        forward,
        this._modelHeight * 0.35,
      );
    } else {
      this._group.position.copy(wp);
    }
  }

  // =========================================================
  // Private: 半径計算
  // =========================================================

  /**
   * 肩・指など、骨自体がとても短い部位は「子ボーンまでの距離×1.3」が
   * 小さくなりすぎて編集しにくい。身長比の下限サイズを部位ごとに設ける。
   */
  _calcLimbRadius(boneName) {
    if (!this._vrm) return DEFAULT_RADIUS;
    const h = this._modelHeight;

    // 指: 骨が非常に短く、CHILD_MAP にも入っていないため、
    // 距離計算ではなく身長比の固定サイズを使う
    if (/Thumb|Index|Middle|Ring|Little/.test(boneName)) {
      return h * 0.045;
    }

    // 肩: 骨自体が短く「距離×1.3」だと小さくなりがちなので下限を大きめに
    const minRadius = boneName.includes("Shoulder")
      ? h * 0.10
      : Math.max(h * 0.07, DEFAULT_RADIUS);

    const childName = CHILD_MAP[boneName];
    if (!childName) return minRadius;
    const childNode = this._vrm.humanoid.getNormalizedBoneNode(childName);
    if (!childNode) return minRadius;

    const p = new THREE.Vector3();
    const c = new THREE.Vector3();
    this._boneNode.getWorldPosition(p);
    childNode.getWorldPosition(c);
    return Math.max(p.distanceTo(c) * 1.3, minRadius);
  }

  _calcModelHeight(vrm) {
    try {
      const box = new THREE.Box3().setFromObject(vrm.scene);
      const h = box.getSize(new THREE.Vector3()).y;
      if (h > 0.1 && h < 10) return h;
    } catch (_) {}
    return 1.6;
  }

  /**
   * 指定ボーンの「レストポーズ（初期姿勢）での子ボーンへの方向」を、
   * ローカル座標で求める。
   *
   * 重要: VRMの正規化ボーンは全身が (0,-1,0) を向いているとは限らない。
   * 例えば腕はTポーズで横方向を向いており、指も下向きではない。
   * 子ボーンのレスト位置（node.position。posingでは回転しか変えない
   * ので常にレスト値のまま）がそのままレスト方向を表すので、それを使う。
   *
   * まず体幹・四肢用の CHILD_MAP を見て、無ければ指などの細かいボーン用に
   * PARENT_MAP から実際の子を逆引きする（findAnyChildBoneName）。
   * 指先の関節（例:指3＝末端）のように子ボーンが存在しない場合は、
   * 代わりに「自分自身が親から伸びている方向」を使う。まっすぐ伸びた
   * 指ではこれが直前の関節とほぼ同じ方向になるため、妥当な近似になる。
   * それも取得できない場合のみ (0,-1,0) にフォールバックする。
   */
  _getRestChildDir(boneName) {
    const childName = CHILD_MAP[boneName] ?? findAnyChildBoneName(boneName);
    if (childName) {
      const childNode = this._vrm?.humanoid?.getNormalizedBoneNode(childName);
      if (childNode && childNode.position.lengthSq() > 1e-10) {
        return childNode.position.clone().normalize();
      }
    }

    // 子ボーンがない末端（指先など）: 自分自身の親からのオフセット方向を代用
    const selfNode = this._vrm?.humanoid?.getNormalizedBoneNode(boneName);
    if (selfNode && selfNode.position.lengthSq() > 1e-10) {
      return selfNode.position.clone().normalize();
    }

    return new THREE.Vector3(0, -1, 0);
  }

  // =========================================================
  // Private: 操作対象ノードの取得
  // =========================================================

  /**
   * 実際に回転/移動を適用する Object3D。
   * targetMode が 'parent' なら親ボーンのノード（取得できない場合は自分自身）。
   */
  _getEffectiveNode() {
    if (this._targetMode === "parent") {
      const parentName = getParentBoneName(this._boneName);
      if (parentName) {
        const parentNode = this._vrm?.humanoid?.getNormalizedBoneNode(
          parentName,
        );
        if (parentNode) return parentNode;
      }
    }
    return this._boneNode;
  }

  // =========================================================
  // Private: ボーン方向適用
  // =========================================================

  /**
   * 球面クリック点に操作対象ボーンを向ける（制限なし）
   *
   * 'self'   : 選択中のボーン自身を、その場（原点固定）で目標方向へ向ける。
   * 'parent' : 選択中のボーン（ピボット）のワールド変換を完全に固定したまま、
   *            親ボーンの向きだけを目標方向へ変える（_aimParentPreservingPivot）。
   */
  _aimBoneAt(targetWorld) {
    if (this._targetMode === "parent") {
      this._aimParentPreservingPivot(targetWorld);
      return;
    }

    const node = this._boneNode;
    if (!node) return;

    const originWorld = new THREE.Vector3();
    node.getWorldPosition(originWorld);

    const targetDirWorld = new THREE.Vector3()
      .subVectors(targetWorld, originWorld).normalize();

    // レスト方向（例: 腕は横方向、脚・背骨は下方向）が、現在のワールド回転
    // のもとで実際にどちらを向いているかを求める
    const restDir = this._getRestChildDir(this._boneName);
    const currentWorldQuat = new THREE.Quaternion();
    node.getWorldQuaternion(currentWorldQuat);
    const currentDirWorld = restDir.clone().applyQuaternion(currentWorldQuat)
      .normalize();

    // 固定の基準（レスト方向）から毎回計算し直すと、ドラッグの軌跡によって
    // 不要な「ひねり」が発生してしまう（ピボット固定モードで直したのと同じ
    // 問題）。そこで「現在の向き」から「目標方向」への最小差分回転として
    // 適用することで、ねじれを抑える。
    const deltaRot = new THREE.Quaternion().setFromUnitVectors(
      currentDirWorld,
      targetDirWorld,
    );
    const newWorldQuat = deltaRot.multiply(currentWorldQuat).normalize();

    // 親のワールド回転の逆でローカル空間へ
    const parentWorldQ = new THREE.Quaternion();
    if (node.parent) {
      node.parent.getWorldQuaternion(parentWorldQ);
    }
    const newLocalQuat = parentWorldQ.clone().invert().multiply(newWorldQuat);

    node.quaternion.copy(newLocalQuat).normalize();
    this._onBoneChange(this._boneName, node.quaternion);
  }

  /**
   * 'parent' モード: 選択中のボーン＝ピボット（例: すね）のワールド上の
   * 位置と向きを完全に固定したまま、その親ボーン（例: 太もも）の向きだけを
   * ドラッグ方向に合わせて変える。
   *
   * ピボットより先（子孫。例: 足首・つま先）はピボットのワールド変換が
   * 不変であることから連動して一切動かない（＝地面に設置したまま）。
   * 代わりに、ピボットの親の、そのまた親（例: 腰）を平行移動させることで、
   * ピボットの位置のズレを打ち消す。ピボット自身のローカル回転も、
   * ワールド向きが変わらないよう補正する。
   *
   * イメージ: すねを固定した「蝶番」として、そこから上の体全体
   * （太もも・腰・体幹など）が振り子のように動く。
   */
  _aimParentPreservingPivot(targetWorld) {
    const pivot = this._boneNode; // 例: すね（ワールド変換を固定する起点）
    const eff = pivot?.parent; // 例: 太もも（実際に向きを変えるボーン）
    if (!pivot || !eff) return;

    // 1. ピボット位置から見たドラッグ方向
    const P0 = new THREE.Vector3();
    pivot.getWorldPosition(P0);
    const D = new THREE.Vector3().subVectors(targetWorld, P0).normalize();

    // 2. eff（親）から見た「ピボットへ向かうレスト方向」。
    //    ピボットのレスト位置（pivot.position）がそのままこの方向を表す
    //    （VRM正規化ボーンは全身が下向きとは限らない＝腕は横向きなど）。
    const restEffToPivot = pivot.position.clone().normalize();

    // 3. 現在の eff のワールド回転から、現在の「eff→ピボット」方向を求める
    const effWorldQuatCurrent = new THREE.Quaternion();
    eff.getWorldQuaternion(effWorldQuatCurrent);
    const currentDirFromEff = restEffToPivot.clone()
      .applyQuaternion(effWorldQuatCurrent).normalize();

    // 4. 望ましい新しい「eff→ピボット」方向は D の逆向き
    //    （D はピボットから見た外向きのドラッグ方向。ピボットを固定して
    //    eff側を動かす場合、eff→ピボット方向はその逆になる）
    const desiredDirFromEff = D.clone().negate();

    // 5. 直前の向きから新しい向きへの最小差分回転を適用する
    //    （固定の基準軸から毎回計算し直すと、ドラッグの軌跡によって
    //    不要な「ひねり」が発生してしまうため、差分回転として累積させる）
    const deltaRot = new THREE.Quaternion().setFromUnitVectors(
      currentDirFromEff,
      desiredDirFromEff,
    );
    const effWorldQuatNew = deltaRot.multiply(effWorldQuatCurrent).normalize();

    this._applyPivotPreservingEffWorldQuat(pivot, eff, effWorldQuatNew);
  }

  /**
   * 'parent' モード共通処理: pivot（選択中ボーン）のワールド変換を固定した
   * まま、eff（親ボーン）を指定のワールド回転(effWorldQuatNew)にする。
   * ドラッグ由来（アイム方式）でもギズモ由来（軸角度方式）でも、
   * 「新しい eff のワールド回転が決まった後」の処理は共通なのでここに集約する。
   */
  _applyPivotPreservingEffWorldQuat(pivot, eff, effWorldQuatNew) {
    const P0 = new THREE.Vector3();
    const Q0 = new THREE.Quaternion();
    pivot.getWorldPosition(P0);
    pivot.getWorldQuaternion(Q0);

    // eff のローカル回転を、その親のワールド回転から逆算
    const effParent = eff.parent;
    const effParentWorldQ = new THREE.Quaternion();
    if (effParent) effParent.getWorldQuaternion(effParentWorldQ);
    const effLocalQuatNew = effParentWorldQ.clone().invert().multiply(
      effWorldQuatNew,
    );
    eff.quaternion.copy(effLocalQuatNew).normalize();

    // eff の現在のワールド位置（回転のみ変更したので位置はまだ不変）
    const effWorldPos = new THREE.Vector3();
    eff.getWorldPosition(effWorldPos);

    // 新しい向きのもとでピボットが来る位置を計算
    const newPivotPos = effWorldPos.clone()
      .add(pivot.position.clone().applyQuaternion(effWorldQuatNew));

    // ズレを算出し、eff の親（さらに根本側）を平行移動して打ち消す
    const deltaP = new THREE.Vector3().subVectors(P0, newPivotPos);
    if (effParent) {
      const grandParentWorldQ = new THREE.Quaternion();
      if (effParent.parent) {
        effParent.parent.getWorldQuaternion(grandParentWorldQ);
      }
      const localDelta = deltaP.clone().applyQuaternion(
        grandParentWorldQ.clone().invert(),
      );
      effParent.position.add(localDelta);
    } else {
      // eff がこれ以上根本を持たない場合は eff 自身を平行移動
      eff.position.add(deltaP);
    }

    // ピボットのローカル回転を補正し、ワールド向きを元通り(Q0)に保つ
    const pivotLocalQuatNew = effWorldQuatNew.clone().invert().multiply(Q0);
    pivot.quaternion.copy(pivotLocalQuatNew).normalize();

    this._onBoneChange(this.getEffectiveBoneName(), eff.quaternion);
  }

  /**
   * 目モード: X/Y 軸のみで視線方向を設定（Z軸ロール除去）
   * ※ 'self' モードでのみ呼ばれる（'parent' モードでは _aimBoneAt を使う）
   *
   * クリックした点の方向を見るように目を向ける。目の可動域は現実には
   * 数十度程度しかないので、左右上下 ±EYE_MAX_ANGLE にクランプすることで、
   * 球のどこをクリックしても不自然な向きにならないようにしている。
   */
  _aimEyeAt(targetWorld) {
    if (!this._boneNode) return;

    const eyeWorld = new THREE.Vector3();
    this._boneNode.getWorldPosition(eyeWorld);

    const lookDirWorld = new THREE.Vector3()
      .subVectors(targetWorld, eyeWorld).normalize();

    const parentWorldQ = new THREE.Quaternion();
    if (this._boneNode.parent) {
      this._boneNode.parent.getWorldQuaternion(parentWorldQ);
    }
    const lookDirLocal = lookDirWorld.clone()
      .applyQuaternion(parentWorldQ.clone().invert());

    // VRM 目ボーン: 前方 -Z、上 +Y
    let yaw = Math.atan2(-lookDirLocal.x, -lookDirLocal.z);
    let pitch = Math.atan2(
      lookDirLocal.y,
      Math.sqrt(lookDirLocal.x ** 2 + lookDirLocal.z ** 2),
    );

    const maxAngle = THREE.MathUtils.degToRad(EYE_MAX_ANGLE_DEG);
    yaw = THREE.MathUtils.clamp(yaw, -maxAngle, maxAngle);
    pitch = THREE.MathUtils.clamp(pitch, -maxAngle, maxAngle);

    const qYaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    // 修正: 以前は符号が反転しており、上を見せようとすると下を向いてしまっていた
    const qPitch = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      pitch,
    );
    const localRot = new THREE.Quaternion().multiplyQuaternions(qYaw, qPitch);

    this._boneNode.quaternion.copy(localRot);
    this._boneNode.quaternion.normalize();
    this._onBoneChange(this._boneName, this._boneNode.quaternion);
  }
}
