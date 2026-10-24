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
import { createGLTFLoader } from "./gltf-loader.js";
import { Exporter } from "./exporter.js";
import { tr } from "./i18n.js";

// 読み込み時に揃える大きさ(最大辺, m)の範囲
const MIN_SIZE = 0.05;
const MAX_SIZE = 10;
const HIGHLIGHT_COLOR = 0x4dabf7;
const ICON_SPRITE = "/vrm-pose-maker/icons/bootstrap-icons.svg";

export class SceneObjects {
  /**
   * @param {import('./scene.js').SceneManager} sceneManager
   * @param {object} options
   * @param {HTMLElement} options.listEl 一覧を描く要素
   * @param {HTMLElement} options.controlsEl 選択中の物の操作(拡大率・回転)を描く要素
   */
  constructor(sceneManager, { listEl, controlsEl }) {
    this._scene = sceneManager;
    this._listEl = listEl;
    this._controlsEl = controlsEl;
    this._items = [];
    this._selectedId = null;
    this._helper = null;
    this._counter = 0;
    this._render();
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
    if (!this._helper) return;
    this._helper.update();
    this._helper.visible = true;
  }

  /** 撮影・書き出しに選択枠が映り込まないよう、次のフレームまで隠す。 */
  hideHelper() {
    if (this._helper) this._helper.visible = false;
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
    if (!this._listEl) return;
    this._listEl.replaceChildren();
    if (!this._items.length) {
      const empty = document.createElement("div");
      empty.className = "text-secondary small";
      empty.textContent = tr("obj.001");
      this._listEl.append(empty);
    }
    for (const item of this._items) {
      const row = document.createElement("div");
      row.className = "d-flex align-items-center gap-1 mb-1";

      const select = document.createElement("button");
      select.type = "button";
      select.className = "btn btn-sm flex-grow-1 text-start text-truncate " +
        (item.id === this._selectedId
          ? "btn-primary"
          : "btn-outline-secondary");
      select.textContent = item.name;
      select.title = item.name;
      select.addEventListener("click", () => this.select(item.id));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-sm btn-outline-danger";
      remove.title = tr("obj.004", item.name);
      remove.innerHTML =
        `<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="${ICON_SPRITE}#x"/></svg>`;
      remove.addEventListener("click", () => this.remove(item.id));

      row.append(select, remove);
      this._listEl.append(row);
    }
    this._renderControls();
  }

  _renderControls() {
    if (!this._controlsEl) return;
    this._controlsEl.replaceChildren();
    const item = this._items.find((i) => i.id === this._selectedId);
    if (!item) return;

    const slider = (label, min, max, step, value, format, onInput) => {
      const wrap = document.createElement("div");
      wrap.className = "mb-2";
      const head = document.createElement("div");
      head.className = "d-flex justify-content-between small text-secondary";
      const name = document.createElement("span");
      name.textContent = label;
      const output = document.createElement("span");
      output.textContent = format(value);
      head.append(name, output);
      const input = document.createElement("input");
      input.type = "range";
      input.className = "form-range";
      Object.assign(input, { min, max, step, value });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        output.textContent = format(v);
        onInput(v);
      });
      wrap.append(head, input);
      this._controlsEl.append(wrap);
    };

    slider(
      tr("obj.002"),
      0.1,
      5,
      0.05,
      item.root.scale.x,
      (v) => `×${v.toFixed(2)}`,
      (v) => item.root.scale.setScalar(v),
    );
    slider(
      tr("obj.003"),
      -180,
      180,
      1,
      Math.round(THREE.MathUtils.radToDeg(item.root.rotation.y)),
      (v) => `${Math.round(v)}°`,
      (v) => (item.root.rotation.y = THREE.MathUtils.degToRad(v)),
    );
  }
}
