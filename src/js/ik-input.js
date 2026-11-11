/**
 * ik-input.js - IK の目標点をキャンバス上で指定・ドラッグする入力
 *
 *   - 「場所を指定」中: 画面を押すと、当たった場所(オブジェクト・モデルの表面、床)に目標点を置き、
 *     押したまま動かすと、そのあいだ目標点が追随する(手が付いてくる)。離したところで確定する。
 *     何にも当たらなければ、今の手足の位置を通る、画面に平行な面の上に置く。
 *   - 目標点の球(マーカー)をドラッグ: 同じように、表面の上を追随する。表面から外れたら、画面に平行な面の上を動く。
 *   - 動かしている腕自身の表面は、当たりとして数えない(手が自分の腕に吸い付かないように)。
 *
 * ボーン操作(bone-control.js)より先に判定するため、キャプチャ段階で受け、
 * 自分が使う入力だけ他へ伝えない。OrbitControls は、ボーン操作と同じく controls.enabled で止める。
 */
import * as THREE from "three";
import { armSegments, IK_CHAINS, SURFACE_OFFSET } from "./ik.js";

export class IkInput {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} sceneManager Scene(camera, controls)
   * @param {import("./ik.js").IkManager} ik
   * @param {{getVrm:()=>object, pickPoint:(ray:THREE.Raycaster, reject:(p:THREE.Vector3)=>boolean)=>({point:THREE.Vector3,normal:THREE.Vector3}|null),
   *          onPlacingChange?:(chain:string|null)=>void}} callbacks
   */
  constructor(canvas, sceneManager, ik, callbacks) {
    this._canvas = canvas;
    this._scene = sceneManager;
    this._ik = ik;
    this._cb = callbacks;
    this._placing = null; // 目標点を置く最中の部位
    this._drag = null; // { chain, plane, offset }
    this._pending = null; // 追随の更新待ち(画面の更新ごとに1回だけ処理する)
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    canvas.addEventListener("mousedown", (e) => this._onDown(e, e), true);
    window.addEventListener("mousemove", (e) => this._onMove(e));
    window.addEventListener("mouseup", (e) => this._onUp(e));
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) this._onDown(e, e.touches[0]);
    }, { capture: true, passive: false });
    window.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1) this._onMove(e.touches[0]);
    }, { passive: false });
    window.addEventListener("touchend", (e) => this._onUp(e.changedTouches[0]));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._placing) this.cancelPlacing();
    });
  }

  get placing() {
    return this._placing;
  }

  beginPlacing(chain) {
    if (!IK_CHAINS[chain]) return;
    this._placing = chain;
    this._canvas.style.cursor = "crosshair";
    this._cb.onPlacingChange?.(chain);
  }

  cancelPlacing() {
    if (!this._placing) return;
    this._placing = null;
    this._canvas.style.cursor = "";
    this._cb.onPlacingChange?.(null);
  }

  _setRay(p) {
    const rect = this._canvas.getBoundingClientRect();
    this._ndc.set(
      ((p.clientX - rect.left) / rect.width) * 2 - 1,
      ((p.clientY - rect.top) / rect.height) * -2 + 1,
    );
    this._raycaster.setFromCamera(this._ndc, this._scene.camera);
    return this._raycaster;
  }

  /** 画面に平行で、point を通る面 */
  _cameraPlane(point) {
    const n = this._scene.camera.getWorldDirection(new THREE.Vector3());
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
  }

  _swallow(e) {
    e.preventDefault?.();
    e.stopImmediatePropagation?.();
  }

  _onDown(e, p) {
    if (e.button !== undefined && e.button !== 0) return;
    const vrm = this._cb.getVrm();
    if (!vrm) return;
    if (this._placing) {
      // 押した所に置いて、離すまで追随させる。ボーン選択やモデル移動には渡さない
      // (カメラ回転は OrbitControls が別の入力で受けるので、controls.enabled で止める)
      const chain = this._placing;
      const placed = this._placementPoint(vrm, chain, p);
      this._ik.setTarget(vrm, chain, placed.point, placed.normal);
      this._beginDrag(chain, null);
      this._swallow(e);
      return;
    }
    const ray = this._setRay(p);
    const markers = this._ik.activeMarkers();
    const hit = ray.intersectObjects(markers.map((m) => m.marker), false)[0];
    if (!hit) return;
    const chain = markers.find((m) => m.marker === hit.object).chain;
    const plane = this._cameraPlane(hit.object.position);
    const at = ray.ray.intersectPlane(plane, new THREE.Vector3());
    this._beginDrag(
      chain,
      at ? hit.object.position.clone().sub(at) : new THREE.Vector3(),
    );
    this._swallow(e);
  }

  _beginDrag(chain, offset) {
    const vrm = this._cb.getVrm();
    const target = this._ik.getTarget(vrm, chain);
    this._drag = {
      chain,
      offset: offset ?? new THREE.Vector3(),
      // 表面から外れたとき用の、画面に平行な面(今の目標点を通る)
      plane: this._cameraPlane(target.position),
    };
    this._ik.beginFollow(vrm, chain);
    this._scene.controls.enabled = false;
  }

  _onMove(p) {
    if (!this._drag) return;
    const first = !this._pending;
    this._pending = { clientX: p.clientX, clientY: p.clientY };
    if (first) requestAnimationFrame(() => this._follow()); // 重い判定なので、画面の更新ごとに1回だけ
  }

  /** 押している位置へ、目標点を追随させる */
  _follow() {
    const p = this._pending;
    this._pending = null;
    const vrm = this._cb.getVrm();
    if (!p || !this._drag || !vrm) return;
    const { chain } = this._drag;
    const picked = this._pickAt(vrm, chain, p);
    if (picked) {
      this._ik.moveTarget(
        vrm,
        chain,
        picked.point.clone().addScaledVector(picked.normal, SURFACE_OFFSET),
        picked.normal,
      );
      this._drag.plane = this._cameraPlane(picked.point); // 表面から外れたときの面は、最後の表面の奥行き
      this._drag.offset.set(0, 0, 0);
    } else {
      const at = this._setRay(p).ray.intersectPlane(
        this._drag.plane,
        new THREE.Vector3(),
      );
      if (at) this._ik.moveTarget(vrm, chain, at.add(this._drag.offset));
    }
  }

  _onUp() {
    if (!this._drag) return;
    if (this._pending) this._follow(); // 離す直前の位置まで反映する
    const { chain } = this._drag;
    this._drag = null;
    this._scene.controls.enabled = true;
    const vrm = this._cb.getVrm();
    if (vrm) this._ik.endFollow(vrm, chain); // 手の点を取り直し、手のひらの回転を選ぶ
    if (this._placing) this.cancelPlacing(); // 置き終わり(場所の指定を抜ける)
    this._ik.setActiveVrm(this._cb.getVrm()); // UI などへ変更を知らせる
  }

  /** ray が当たる表面(動かしている腕自身は除く)と床のうち、いちばん手前。{ point, normal } か null */
  _pickAt(vrm, chain, p) {
    const ray = this._setRay(p);
    const segments = armSegments(vrm, chain);
    const reject = (pt) =>
      segments.some(([a, b, r]) =>
        new THREE.Line3(a, b).closestPointToPoint(pt, true, _tmp).distanceTo(
          pt,
        ) < r
      );
    let best = this._cb.pickPoint(ray, reject);
    const ground = ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Vector3(),
    );
    const bestDist = best ? best.point.distanceTo(ray.ray.origin) : Infinity;
    if (ground && ground.distanceTo(ray.ray.origin) < bestDist) {
      best = { point: ground, normal: new THREE.Vector3(0, 1, 0) };
    }
    return best;
  }

  /** 押した場所から、目標点を決める。表面に当たらなければ、今の手足の先を通る、画面に平行な面の上(向きなし) */
  _placementPoint(vrm, chain, p) {
    const best = this._pickAt(vrm, chain, p);
    if (best) {
      return {
        point: best.point.clone().addScaledVector(best.normal, SURFACE_OFFSET),
        normal: best.normal,
      };
    }
    const ray = this._setRay(p);
    const end = vrm.humanoid.getNormalizedBoneNode(IK_CHAINS[chain].end);
    const endPos = end.getWorldPosition(new THREE.Vector3());
    return {
      point: ray.ray.intersectPlane(
        this._cameraPlane(endPos),
        new THREE.Vector3(),
      ) ?? endPos,
      normal: null,
    };
  }
}

const _tmp = new THREE.Vector3();
