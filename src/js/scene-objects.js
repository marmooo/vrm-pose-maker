/**
 * scene-objects.js - VRM 以外の 3D オブジェクト(小物・背景セットなど。GLB / FBX)をシーンに置く
 *
 * - 読み込んだ物は「足元の中心が原点」のグループで包む。位置の移動・拡大縮小・Y 軸回転は
 *   このグループに対して行うので、回転は物の中心の真下を軸にし、拡大縮小は床から行われる。
 * - 単位が違うファイルは、読み込み時に扱いやすい大きさ(最大辺が 0.05〜10)に揃える。
 *   FBX は cm 単位が多いので、大きければまず 0.01 倍し、そのうえで 10 の累乗倍で範囲に収める。細かい調整はパネルの「拡大率」で行う。
 * - 物自身が持つアニメーションがあれば、最初の1本を繰り返し再生する。
 * - プロジェクト保存のため、元のファイルを保持する。
 */
import * as THREE from "three";
import { ContactIndex } from "./contact-index.js";
import { createGLTFLoader } from "./gltf-loader.js";
import { ObjectGizmo } from "./object-gizmo.js";
import { ObjectSpheres } from "./object-spheres.js";
import { Exporter } from "./exporter.js";
import { tr } from "./i18n.js";

// 読み込み時に揃える大きさ(最大辺, m)の範囲
const MIN_SIZE = 0.05;
const MAX_SIZE = 10;
const HIGHLIGHT_COLOR = 0x4dabf7;
// 拡大率の範囲(パネルのスライダーと同じ)
const SCALE_MIN = 0.1;
const SCALE_MAX = 5;
const ICON_SPRITE = "/vrm-pose-maker/icons/bootstrap-icons.svg";

export class SceneObjects {
  /**
   * @param {import('./scene.js').SceneManager} sceneManager
   * @param {object} options
   * @param {HTMLElement} options.controlsEl 選択中の物の操作(拡大率・回転)を描く要素
   * @param {() => void} [options.onChange] 物の追加・削除・選択が変わったときに呼ぶ
   */
  constructor(sceneManager, { controlsEl, onChange }) {
    this._scene = sceneManager;
    this._controlsEl = controlsEl;
    this._onChange = onChange ?? null;
    this._gizmo = new ObjectGizmo(sceneManager); // キャンバス上の回転・拡大縮小
    this.spheres = new ObjectSpheres(); // 物の表面を敷き詰めた球(IK の当たり判定と、接地の計測に使う)
    this._items = [];
    this._modelRoot = null; // 物を選んでいないとき、ギズモを出すモデルの root
    this._selectedId = null;
    this._helper = null;
    this._counter = 0;
    this._renderControls();
  }

  /** 置いてある物の一覧(追加した順)。{ id, name } */
  get items() {
    return this._items.map(({ id, name, thumbnail }) => ({
      id,
      name,
      thumbnail,
    }));
  }

  /** 置いてある物の root(撮影のとき他の物を隠すのに使う)。 */
  roots() {
    return this._items.map((item) => item.root);
  }

  /** id の物の root(なければ undefined)。 */
  rootOf(id) {
    return this._items.find((item) => item.id === id)?.root;
  }

  get count() {
    return this._items.length;
  }

  get selectedId() {
    return this._selectedId;
  }

  // =========================================================
  // 読み込み・削除
  // =========================================================

  /**
   * GLB / FBX ファイルをオブジェクトとして追加する。
   * @param {File} file
   * @param {{ place?: boolean }} [options] place: false なら自動配置しない(プロジェクト復元用)
   */
  async addFromFile(file, { place = true } = {}) {
    const { model, animations, centimeters } = await this._parse(file);
    const root = new THREE.Group();
    // 向き(Y)を一番外側にして、X・Z の傾きはその向きに対して掛ける
    root.rotation.order = "YXZ";
    this._normalize(model, root, centimeters);
    root.add(model);
    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (obj.isSkinnedMesh) obj.frustumCulled = false;
    });

    const item = {
      id: `object-${Date.now()}-${this._counter++}`,
      name: file.name,
      file,
      root,
      model,
      mixer: null,
    };
    if (animations.length) {
      item.mixer = new THREE.AnimationMixer(model);
      item.mixer.clipAction(animations[0]).play();
      this._scene.registerAnimationMixer(item.mixer);
    }
    this._scene.scene.add(root);
    this._items.push(item);
    if (place) this._place(item);
    // 右パネルの選択アイコン用に、物全体の絵を撮っておく(読み込んだ直後の姿)
    item.thumbnail = this._scene.captureObjectThumbnail(root);
    this.select(item.id);
    return item;
  }

  async _parse(file) {
    const ext = /\.([^./\\]+)$/.exec(file.name)?.[1].toLowerCase();
    const buffer = await file.arrayBuffer();
    if (ext === "fbx") {
      // FBXLoader は重いので、初めて必要になったときに読み込む
      const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
      const model = new FBXLoader().parse(buffer, "");
      // FBX は cm 単位で作られていることが多い(FBXLoader は単位を変換しない)
      return { model, animations: model.animations ?? [], centimeters: true };
    }
    // GLB / glTF(Draco 圧縮にも対応)。アニメーション用の読み込みと違い、メッシュも読む
    const gltf = await new Promise((resolve, reject) =>
      createGLTFLoader().parse(buffer, "", resolve, reject)
    );
    return { model: gltf.scene, animations: gltf.animations ?? [] };
  }

  /**
   * 大きさを扱いやすい範囲に揃え、足元の中心が root の原点に来るように model をずらす。
   * (root の拡大縮小・回転が、足元を基準に働くようにするため)
   */
  _normalize(model, root, centimeters = false) {
    model.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) throw new Error(tr("obj.007"));
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    let factor = centimeters && longest > MAX_SIZE ? 0.01 : 1;
    while (longest * factor > MAX_SIZE) factor /= 10;
    while (longest * factor < MIN_SIZE) factor *= 10;
    model.scale.multiplyScalar(factor);
    root.add(model); // 行列を確定させるため、いったん root に入れて測り直す
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
  }

  /** 選択中のアバターの右隣(他の物があればさらにその右)の床に置く。何も無ければ原点。 */
  _place(item) {
    const occupied = new THREE.Box3();
    if (this._scene.currentVrm) {
      occupied.expandByObject(this._scene.currentVrm.scene);
    }
    for (const other of this._items) {
      if (other !== item) occupied.expandByObject(other.root);
    }
    if (occupied.isEmpty()) return;
    const size = new THREE.Box3().setFromObject(item.root).getSize(
      new THREE.Vector3(),
    );
    const gap = Math.max(size.x * 0.1, 0.25);
    item.root.position.set(occupied.max.x + gap + size.x / 2, 0, 0);
  }

  remove(id) {
    const index = this._items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this._items.splice(index, 1);
    if (this._selectedId === id) this.select(null);
    if (item.mixer) {
      item.mixer.stopAllAction();
      item.mixer.uncacheRoot(item.model);
      this._scene.unregisterAnimationMixer(item.mixer);
    }
    this._scene.scene.remove(item.root);
    item.root.traverse((obj) => {
      obj.geometry?.dispose?.();
      for (const m of [].concat(obj.material ?? [])) {
        for (const value of Object.values(m)) {
          value?.isTexture && value.dispose();
        }
        m.dispose?.();
      }
    });
    this._render();
  }

  clear() {
    for (const item of [...this._items]) this.remove(item.id);
  }

  // =========================================================
  // 選択・操作
  // =========================================================

  select(id) {
    const item = this._items.find((i) => i.id === id) ?? null;
    this._selectedId = item?.id ?? null;
    if (this._helper) {
      this._scene.scene.remove(this._helper);
      this._helper.geometry.dispose();
      this._helper.material.dispose();
      this._helper = null;
    }
    this._gizmo.attach(item?.root ?? this._modelRoot);
    if (item) {
      this._helper = new THREE.BoxHelper(item.root, HIGHLIGHT_COLOR);
      this._helper.material.depthTest = false;
      this._helper.renderOrder = 998;
      this._helper.raycast = () => {};
      this._scene.scene.add(this._helper);
    }
    this._render();
  }

  /** レイが当たる一番手前の物を { id, distance } で返す(当たらなければ null)。 */
  pick(raycaster) {
    let best = null;
    for (const item of this._items) {
      const hit = raycaster.intersectObject(item.root, true)[0];
      if (hit && (!best || hit.distance < best.distance)) {
        best = { id: item.id, distance: hit.distance };
      }
    }
    return best;
  }

  /**
   * 置いてある物の内側にあるかを調べる関数 inside(点) を作り、fn に渡して呼ぶ(握るときの、指と物の接触の判定に使う)。
   * 閉じたメッシュを前提に、点から上へ伸ばしたレイが面と交わる回数の偶奇で決める(裏面も数える)。
   */
  withInsideTest(fn) {
    // 物ごとに、三角形を格子に入れた索引を、初めて使うときに作る(レイ 1 本ごとに全三角形を調べると、細かい物で何十秒もかかる)
    const items = this._items.map((item) => {
      const box = new THREE.Box3().setFromObject(item.root);
      return { root: item.root, box, index: null };
    });
    const indexOf = (item) => {
      if (item.index) return item.index;
      const meshes = [];
      item.root.updateMatrixWorld(true);
      item.root.traverse((o) => o.isMesh && meshes.push(o));
      const sphere = item.box.getBoundingSphere(new THREE.Sphere());
      item.index = new ContactIndex(sphere.center, sphere.radius + 0.01);
      item.index.addMeshes(meshes);
      return item.index;
    };
    const inside = (p) => {
      for (const item of items) {
        if (!item.box.containsPoint(p)) continue;
        // 点から上へ伸ばしたレイが面と交わる回数の偶奇(閉じたメッシュを前提に、裏面も数える)
        if (indexOf(item).countUp(p, item.box.max.y) % 2 === 1) return true;
      }
      return false;
    };
    return fn(items.length ? inside : null);
  }

  /** レイが当たる一番手前の物の表面の点と向き({ point, normal })。当たらなければ null。reject(点) が true の当たりは除く。 */
  pickPoint(raycaster, reject = null) {
    let best = null;
    for (const item of this._items) {
      const hit = raycaster.intersectObject(item.root, true).find((h) =>
        !reject?.(h.point, h)
      );
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    if (!best) return null;
    const normal = best.face
      ? best.face.normal.clone().transformDirection(best.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate(); // 手前を向ける
    return { point: best.point.clone(), normal };
  }

  /** 画面外に出た物を探せるよう、注視点とカメラをその物の中心へ動かす(見る向きと距離は変えない)。 */
  focus(id) {
    const item = this._items.find((i) => i.id === id);
    if (!item) return;
    const center = new THREE.Box3().setFromObject(item.root).getCenter(
      new THREE.Vector3(),
    );
    const delta = center.sub(this._scene.controls.target);
    this._scene.controls.target.add(delta);
    this._scene.camera.position.add(delta);
    this._scene.controls.update();
  }

  /** 画面の平面に沿って(カメラの右・上方向へ)ピクセル単位で動かす。 */
  translate(id, dx, dy) {
    const item = this._items.find((i) => i.id === id);
    if (!item) return;
    const camera = this._scene.camera;
    const canvas = this._scene.canvas;
    const distance = camera.position.distanceTo(this._scene.controls.target);
    const unitsPerPixel = 2 *
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance /
      canvas.getBoundingClientRect().height;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    item.root.position.addScaledVector(right, dx * unitsPerPixel);
    item.root.position.addScaledVector(up, -dy * unitsPerPixel);
  }

  /** 毎フレーム呼ばれる。選択枠を物の動きに追従させる。 */
  update() {
    this._keepAboveGround();
    this._gizmo.update();
    if (!this._helper) return;
    this._helper.update();
    this._helper.visible = true;
  }

  /**
   * 「地面より上に保つ」がオンのとき、物が床(y=0)にめり込まないようにする(めり込む分だけ持ち上げる)。
   * モデルと同じく片側だけの制約で、浮いている分には何もしない。
   */
  _keepAboveGround() {
    if (!this._scene.getGroundContact()) return;
    for (const item of this._items) {
      const lowest = this.spheres.get(item.root).lowestY;
      if (lowest < -1e-5) {
        item.root.position.y -= lowest;
        item.root.updateMatrixWorld(true);
      }
    }
  }

  /** 撮影・書き出しに選択枠が映り込まないよう、次のフレームまで隠す。 */
  hideHelper() {
    if (this._helper) this._helper.visible = false;
    this._gizmo.hide();
  }

  // =========================================================
  // キャンバス上のギズモ(回転・拡大縮小)
  // =========================================================

  /** レイが当たるギズモの部品(rotate / scale)。当たらなければ null。当たったらその部品を強調する。 */
  hitGizmo(raycaster) {
    const hit = this._gizmo.hitTest(raycaster);
    this._gizmo.setActive(hit ? (hit.key ?? "scale") : null);
    return hit;
  }

  /** ワールドの軸 axis まわりに、物の中心を動かさずに angle(ラジアン)回す。 */
  rotateAboutCenter(axis, angle) {
    const root = this._gizmoRoot();
    if (!root) return;
    const center = this._gizmo.center;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    root.quaternion.premultiply(q);
    root.position.sub(center).applyQuaternion(q).add(center);
  }

  /** 物の中心を動かさずに、拡大率を scale にする(スライダーと同じ範囲に収める)。 */
  setScaleAboutCenter(scale) {
    const root = this._gizmoRoot();
    if (!root) return;
    const next = THREE.MathUtils.clamp(scale, SCALE_MIN, SCALE_MAX);
    const center = this._gizmo.center;
    const factor = next / root.scale.x;
    root.scale.setScalar(next);
    root.position.sub(center).multiplyScalar(factor).add(center);
  }

  /** ギズモが付いている(物を選んでいるか、モデルにギズモを出しているか) */
  get hasGizmoTarget() {
    return this._selectedId !== null || this._modelRoot !== null;
  }

  /**
   * 物を選んでいないとき、モデル(VRM)の root にギズモを出す。null で外す。
   * 物を選んでいる間は、その物のギズモが優先される。
   */
  setModelGizmo(root) {
    this._modelRoot = root;
    if (this._selectedId === null) this._gizmo.attach(root);
  }

  /** ギズモで動かす対象。選んだ物、なければモデル。 */
  _gizmoRoot() {
    return this._items.find((i) => i.id === this._selectedId)?.root ??
      this._modelRoot;
  }

  /** ギズモの操作が終わったとき。強調を戻し、パネルのスライダーを今の値に合わせる。 */
  endGizmo() {
    this._gizmo.setActive(null);
    this._render(); // パネルのスライダーを今の値に(モデルのときは、app 側が描き直す)
  }

  // =========================================================
  // プロジェクト保存・復元
  // =========================================================

  async serialize() {
    return await Promise.all(this._items.map(async (item) => ({
      name: item.name,
      data: await Exporter._fileToDataUrl(item.file),
      transform: {
        position: item.root.position.toArray(),
        quaternion: item.root.quaternion.toArray(),
        scale: item.root.scale.toArray(),
      },
    })));
  }

  async restore(list) {
    this.clear();
    for (const entry of list ?? []) {
      const file = new File(
        [Exporter.dataUrlToArrayBuffer(entry.data)],
        entry.name,
      );
      const item = await this.addFromFile(file, { place: false });
      item.root.position.fromArray(entry.transform.position);
      item.root.quaternion.fromArray(entry.transform.quaternion);
      item.root.scale.fromArray(entry.transform.scale);
    }
    this.select(null);
  }

  // =========================================================
  // パネル
  // =========================================================

  _render() {
    this._renderControls();
    this._onChange?.();
  }

  _renderControls() {
    if (!this._controlsEl) return;
    this._controlsEl.replaceChildren();
    const item = this._items.find((i) => i.id === this._selectedId);
    if (!item) return;
    renderTransformControls(this._controlsEl, item.root);
  }
}

/**
 * 拡大率と回転(X / Y / Z)のスライダーを el に描く。物(オブジェクト)にもモデル(VRM)にも使う。
 * @param {HTMLElement} el
 * @param {THREE.Object3D} root 動かす対象(足元が原点のグループ。VRM なら vrm.scene)
 */
export function renderTransformControls(el, root) {
  el.replaceChildren();
  const slider = (
    label,
    min,
    max,
    step,
    value,
    resetValue,
    format,
    onInput,
  ) => {
    const wrap = document.createElement("div");
    wrap.className = "mb-2";
    const head = document.createElement("div");
    head.className =
      "d-flex justify-content-between align-items-center small text-secondary";
    const name = document.createElement("span");
    name.textContent = label;
    const output = document.createElement("span");
    output.className = "ms-auto me-1";
    output.textContent = format(value);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn btn-sm btn-outline-secondary py-0 px-1";
    reset.title = tr("obj.008");
    reset.innerHTML =
      `<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="${ICON_SPRITE}#arrow-counterclockwise"/></svg>`;
    head.append(name, output, reset);
    const input = document.createElement("input");
    input.type = "range";
    input.className = "form-range";
    Object.assign(input, { min, max, step, value });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      output.textContent = format(v);
      onInput(v);
    });
    reset.addEventListener("click", () => {
      input.value = String(resetValue);
      output.textContent = format(resetValue);
      onInput(resetValue);
    });
    wrap.append(head, input);
    el.append(wrap);
  };
  const deg = (v) => `${Math.round(v)}°`;
  const rad = THREE.MathUtils.degToRad;
  const toDeg = (r) => Math.round(THREE.MathUtils.radToDeg(r));
  slider(
    tr("obj.002"),
    SCALE_MIN,
    SCALE_MAX,
    0.05,
    root.scale.x,
    1,
    (v) => `×${v.toFixed(2)}`,
    (v) => root.scale.setScalar(v),
  );
  slider(
    tr("obj.003"),
    -180,
    180,
    1,
    toDeg(root.rotation.y),
    0,
    deg,
    (v) => root.rotation.y = rad(v),
  );
  slider(
    tr("obj.009"),
    -90,
    90,
    1,
    toDeg(root.rotation.x),
    0,
    deg,
    (v) => root.rotation.x = rad(v),
  );
  slider(
    tr("obj.010"),
    -180,
    180,
    1,
    toDeg(root.rotation.z),
    0,
    deg,
    (v) => root.rotation.z = rad(v),
  );
}
