/**
 * gizmo-drag.js - 回転ギズモ(リング)のドラッグを、回転軸まわりの回転角に直す
 *
 * ボーンのギズモ(bone-control.js)とオブジェクトのギズモ(object-gizmo.js)で共通に使う。
 * 掴んだリング(回転軸 axis まわりの、中心 origin・半径 radius の円)の上での動きを、
 * その軸まわりの回転角(右ねじの向きが正)に直す。
 *
 * 'plane'  : リングがある程度こちらを向いているとき。カメラからポインタへの光線が
 *            リングを含む平面と交わる点の、中心まわりの角度の変化をそのまま回転角にする
 *            (一般的なギズモと同じ。マウスがリングの上を一周すれば、ちょうど一回転する)。
 * 'tangent': リングをほぼ真横から見ているとき。平面との交点が不安定になるので、
 *            掴んだ点でのリングの接線方向への画面上の移動量から回転角を求める。
 * どちらも回転軸の向きは変わらないので、カメラの向きによる符号の反転は要らない。
 */
import * as THREE from "three";

// 回転軸とカメラ方向の内積(の絶対値)がこれ以上なら plane。小さいほどリングを真横から見ている。
const PLANE_MIN_FACING = 0.3;

export class GizmoDrag {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLCanvasElement} canvas
   * @param {THREE.Vector3} axis 回転軸(ワールド座標・単位ベクトル)
   * @param {THREE.Vector3} origin リングの中心(ワールド座標)
   * @param {number} radius リングの半径
   * @param {number} clientX ドラッグ開始位置
   * @param {number} clientY
   */
  constructor(camera, canvas, axis, origin, radius, clientX, clientY) {
    this._camera = camera;
    this._canvas = canvas;
    this._a = axis.clone().normalize();
    this._origin = origin.clone();
    this._radius = radius;
    const helper = Math.abs(this._a.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    this._u = new THREE.Vector3().crossVectors(helper, this._a).normalize();
    // u → v が a まわりの正の向き
    this._v = new THREE.Vector3().crossVectors(this._a, this._u);
    this._mode = "tangent";
    this._angle = 0; // plane: 直前の角度 / tangent: 掴んでいるリング上の位置
    this._x = clientX;
    this._y = clientY;

    const toView = new THREE.Vector3()
      .subVectors(camera.position, this._origin).normalize();
    if (Math.abs(this._a.dot(toView)) >= PLANE_MIN_FACING) {
      const hit = this._planePoint(clientX, clientY);
      if (hit) {
        this._mode = "plane";
        this._angle = this._planeAngle(hit);
      }
    }
    if (this._mode === "tangent") {
      // ポインタに一番近いリング上の点を、掴んだ位置とする
      let best = Infinity;
      for (let i = 0; i < 72; i++) {
        const th = (i / 72) * Math.PI * 2;
        const p = this._screenPoint(this._ringPoint(th));
        const d = Math.hypot(p.x - clientX, p.y - clientY);
        if (d < best) {
          best = d;
          this._angle = th;
        }
      }
    }
  }

  /** 前回の呼び出しから増えた分の回転角(ラジアン)を返す。 */
  delta(clientX, clientY) {
    let delta = 0;
    if (this._mode === "plane") {
      const hit = this._planePoint(clientX, clientY);
      if (hit) {
        const angle = this._planeAngle(hit);
        delta = angle - this._angle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        this._angle = angle;
      }
    } else {
      // 掴んだ点での接線(画面上)と、1ラジアンあたりの画面上の移動量
      const p0 = this._screenPoint(this._ringPoint(this._angle));
      const eps = 0.01;
      const p1 = this._screenPoint(this._ringPoint(this._angle + eps));
      const tx = (p1.x - p0.x) / eps;
      const ty = (p1.y - p0.y) / eps;
      const len2 = tx * tx + ty * ty;
      if (len2 > 1e-6) {
        delta = ((clientX - this._x) * tx + (clientY - this._y) * ty) / len2;
        this._angle += delta;
      }
    }
    this._x = clientX;
    this._y = clientY;
    return delta;
  }

  _ringPoint(theta) {
    return this._origin.clone()
      .addScaledVector(this._u, Math.cos(theta) * this._radius)
      .addScaledVector(this._v, Math.sin(theta) * this._radius);
  }

  /** ワールド座標の点 → 画面(クライアント)座標 */
  _screenPoint(world) {
    const ndc = world.clone().project(this._camera);
    const rect = this._canvas.getBoundingClientRect();
    return {
      x: (ndc.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-ndc.y * 0.5 + 0.5) * rect.height + rect.top,
    };
  }

  /** ポインタの光線と、リングを含む平面との交点(平行などで交わらなければ null) */
  _planePoint(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this._camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this._a,
      this._origin,
    );
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  _planeAngle(point) {
    const w = point.clone().sub(this._origin);
    return Math.atan2(w.dot(this._v), w.dot(this._u));
  }
}
