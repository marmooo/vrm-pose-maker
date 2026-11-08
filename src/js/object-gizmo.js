/**
 * object-gizmo.js - 選択中のオブジェクトを、キャンバス上で回転・拡大縮小するためのギズモ
 *
 * - 物を包む球のまわりに、ワールドの X / Y / Z 軸の回転リングを出す(赤 / 緑 / 青)。
 *   リングのドラッグの量→回転角は、ボーンのギズモと同じ GizmoDrag で求める。
 * - 球の斜め右上(画面から見て)に出る白い丸をドラッグすると、物の中心からの距離に
 *   比例して拡大縮小する。
 * - 大きさは、選んだときの物の大きさ(回転しても変わらない球)に、物の拡大率を掛けて決める。
 *   物を回してもリングが伸び縮みしない。
 */
import * as THREE from "three";

const AXES = {
  x: { color: 0xff5555, vector: new THREE.Vector3(1, 0, 0) },
  y: { color: 0x55dd77, vector: new THREE.Vector3(0, 1, 0) },
  z: { color: 0x5588ff, vector: new THREE.Vector3(0, 0, 1) },
};
const RING_SCALE = 1.15; // 物を包む球の半径に対するリングの半径
const HANDLE_DISTANCE = 1.35; // リング半径を 1 としたときの拡大縮小ハンドルの距離

export class ObjectGizmo {
  /** @param {import('./scene.js').SceneManager} sceneManager */
  constructor(sceneManager) {
    this._scene = sceneManager;
    this._root = null;
    this._localCenter = new THREE.Vector3();
    this._baseRadius = 1;
    this._baseScale = 1;
    this._active = null;

    this._group = new THREE.Group();
    this._group.visible = false;
    this._rings = {};
    this._hits = [];
    const make = (geometry, material, order) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = order;
      return mesh;
    };
    for (const [key, { color }] of Object.entries(AXES)) {
      // TorusGeometry は XY 平面(法線 +Z)にあるので、軸に合わせて向ける
      const orient = (g) => {
        if (key === "x") g.rotateY(Math.PI / 2);
        else if (key === "y") g.rotateX(Math.PI / 2);
        return g;
      };
      const ring = make(
        orient(new THREE.TorusGeometry(1, 0.014, 8, 80)),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.8,
          depthTest: false,
        }),
        999,
      );
      ring.raycast = () => {};
      const hit = make(
        orient(new THREE.TorusGeometry(1, 0.07, 6, 48)),
        new THREE.MeshBasicMaterial({ visible: false }),
        0,
      );
      hit.userData.key = key;
      this._rings[key] = ring;
      this._hits.push(hit);
      this._group.add(ring, hit);
    }
    this._handle = make(
      new THREE.SphereGeometry(0.07, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
      999,
    );
    this._handle.raycast = () => {};
    this._handleHit = make(
      new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }),
      0,
    );
    this._handleHit.userData.key = "scale";
    this._hits.push(this._handleHit);
    this._group.add(this._handle, this._handleHit);
    this._scene.scene.add(this._group);
  }

  /** root(物を包むグループ)に付ける。null で外す。 */
  attach(root) {
    this._root = root;
    this._active = null;
    if (!root) {
      this._group.visible = false;
      return;
    }
    root.updateWorldMatrix(true, true);
    const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(
      new THREE.Sphere(),
    );
    this._localCenter.copy(root.worldToLocal(sphere.center.clone()));
    this._baseRadius = Math.max(sphere.radius, 0.001);
    this._baseScale = root.scale.x || 1;
    this.update();
  }

  /** 物の中心(ワールド座標)。物を回したり拡大縮小したりしても、ここは動かさない。 */
  get center() {
    this._root.updateWorldMatrix(true, false);
    return this._root.localToWorld(this._localCenter.clone());
  }

  /** リングの半径(ワールド座標の長さ) */
  get radius() {
    return this._baseRadius * (this._root.scale.x / this._baseScale) *
      RING_SCALE;
  }

  /** 毎フレーム呼ぶ。物の動き・拡大縮小とカメラの向きに合わせる。 */
  update() {
    if (!this._root) return;
    this._group.visible = true;
    this._group.position.copy(this.center);
    this._group.scale.setScalar(this.radius);
    // 拡大縮小ハンドルは、カメラから見て右上に置く(どの向きから見ても見える)
    const q = this._scene.camera.quaternion;
    const dir = new THREE.Vector3(1, 1, 0).normalize().applyQuaternion(q);
    this._handle.position.copy(dir).multiplyScalar(HANDLE_DISTANCE);
    this._handleHit.position.copy(this._handle.position);
  }

  /** 撮影・書き出しに映り込まないよう、次のフレームまで隠す。 */
  hide() {
    this._group.visible = false;
  }

  setActive(key) {
    this._active = key;
    for (const [k, ring] of Object.entries(this._rings)) {
      ring.material.opacity = k === key ? 1 : 0.8;
    }
    this._handle.material.opacity = key === "scale" ? 1 : 0.9;
  }

  /**
   * レイが当たるギズモの部品を返す。
   * @returns {{kind:'rotate', key:string, axis:THREE.Vector3, origin:THREE.Vector3, radius:number}
   *   | {kind:'scale', origin:THREE.Vector3, radius:number, scale:number} | null}
   */
  hitTest(raycaster) {
    if (!this._root || !this._group.visible) return null;
    this._group.updateWorldMatrix(true, true);
    const hit = raycaster.intersectObjects(this._hits, false)[0];
    if (!hit) return null;
    const key = hit.object.userData.key;
    const origin = this.center;
    if (key === "scale") {
      return {
        kind: "scale",
        origin,
        radius: this.radius,
        scale: this._root.scale.x,
      };
    }
    return {
      kind: "rotate",
      key,
      axis: AXES[key].vector.clone(),
      origin,
      radius: this.radius,
    };
  }
}
