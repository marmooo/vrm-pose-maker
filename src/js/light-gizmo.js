/**
 * light-gizmo.js - ライト位置をビューポート上で直接ドラッグして設定するための
 * 可視ハンドル(球)とドラッグ操作。
 *
 * これまで「平行光源の位置を数値スライダーで設定するのが分かりづらい」
 * という問題への対応として追加。ボーン操作の球(bone-sphere.js/bone-control.js)
 * と同じ「3D空間に出したハンドルをドラッグする」という考え方を踏襲しているが、
 * ライトは可動域制限やボーン階層を持たないぶん、はるかにシンプルな実装になっている。
 *
 * 操作方法:
 *   ライトパネルの「ビューでライト位置を編集」をONにすると、各ライト(環境光・
 *   半球ライトを除く)の位置に色付きの球ハンドルが表示される。
 *   - 左ドラッグ         : カメラの画面に平行な面内でライトを移動
 *   - Shift+左ドラッグ   : カメラの前後方向(奥行き)にライトを移動
 *   - クリック(ドラッグ無し): そのライトを選択（ライトパネル側のカードが
 *                            ハイライトされ、スクロールして表示される）
 *   平行光源・スポットライトは「どちらを向いているか」が重要なので、
 *   ハンドルから注視点(光源のtarget。このアプリでは常に原点)まで線を引いて、
 *   光の向きが一目でわかるようにしている。
 *   さらに、ポイントライト/スポットライトは「減衰距離(距離=0なら無限)」
 *   「照射角度」という"範囲"を決めるパラメーターを既に持っているが、数値
 *   だけだとその範囲が実際どれくらい広いのか掴みにくいため、スポットライトは
 *   円錐(角度×距離)、ポイントライトは球(距離)のワイヤーフレームを重ねて
 *   表示し、範囲も視覚的に把握できるようにしている。この範囲の先端には
 *   小さな白いハンドルも置いてあり、それ自体をドラッグすると減衰距離を
 *   直接変更できる(外に引っ張れば広がり、内側に押し込めば狭まる)。
 *
 * このモードがON中は、ボーン操作(bone-control.js)と操作が競合しないよう
 * BoneController 側を無効化する(app.js で配線)。
 */
import * as THREE from "three";

const DRAG_THRESHOLD = 4; // px. これ未満の移動は「クリック」(選択)として扱う

export class LightGizmo {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./scene.js').SceneManager} sceneManager
   * @param {{ onDragEnd?: () => void, onSelect?: (id: string|null) => void }} [callbacks]
   */
  constructor(canvas, sceneManager, { onDragEnd, onSelect } = {}) {
    this._canvas = canvas;
    this._scene = sceneManager;
    this._onDragEnd = onDragEnd ?? (() => {});
    this._onSelect = onSelect ?? (() => {});

    this._enabled = false;
    this._group = new THREE.Group();
    this._group.visible = false;
    sceneManager.scene.add(this._group);

    // id -> { mesh, line, light, type }
    this._handles = new Map();
    this._selectedId = null;

    this._raycaster = new THREE.Raycaster();

    // ドラッグ状態
    this._dragMode = null; // null | 'pending' | 'plane' | 'depth'
    this._downPos = null;
    this._lastX = 0;
    this._lastY = 0;
    this._dragLight = null;

    this._bindEvents();
  }

  // =========================================================
  // 表示ON/OFF
  // =========================================================

  setEnabled(enabled) {
    this._enabled = !!enabled;
    this._group.visible = this._enabled;
    if (!this._enabled) {
      this._endDrag();
      this._setSelected(null);
    }
  }

  isEnabled() {
    return this._enabled;
  }

  getSelectedId() {
    return this._selectedId;
  }

  // =========================================================
  // ハンドルの同期（ライトの追加・削除のたびに呼ぶ）
  // =========================================================

  /** @param {{id:string, type:string, light:THREE.Light}[]} lights */
  sync(lights) {
    const liveIds = new Set();
    for (const entry of lights) {
      const { id, type, light } = entry;
      if (type === "ambient" || type === "hemisphere") continue; // 位置を持たない
      liveIds.add(id);
      // 向き(位置→注視点)の線は、位置だけでなく向きも意味を持つ
      // 平行光源・スポットライトに表示する。ポイントライトは全方向に
      // 光るので向きの概念がなく、表示しない。
      const needsLine = type === "directional" || type === "spot";
      // 範囲(減衰距離・照射角度)のワイヤーフレーム表示。
      // スポットライトは円錐、ポイントライトは球。
      const needsRange = type === "point" || type === "spot";

      let h = this._handles.get(id);
      if (!h) {
        const mesh = this._buildHandleMesh(light);
        this._group.add(mesh);
        const line = needsLine ? this._buildLine() : null;
        if (line) this._group.add(line);
        const rangeHelper = needsRange
          ? (type === "spot" ? this._buildCone() : this._buildSphereWire())
          : null;
        if (rangeHelper) this._group.add(rangeHelper);
        // 範囲(距離)をドラッグで直接変えられる小さいハンドル。ポイントライトは
        // 方向の概念がない(= needsLine が false)ぶん、この半径線が唯一の
        // 「線」になる。スポットライトは既にある向きの線の先端を兼ねる。
        let rangeHandle = null;
        let radiusLine = null;
        if (needsRange) {
          rangeHandle = this._buildRangeHandleMesh();
          this._group.add(rangeHandle);
          if (type === "point") {
            radiusLine = this._buildLine(0x66ccff);
            this._group.add(radiusLine);
          }
        }
        h = {
          mesh,
          line,
          rangeHelper,
          rangeHandle,
          radiusLine,
          light,
          type,
          id,
        };
        this._handles.set(id, h);
      } else {
        h.light = light;
        h.type = type;
        h.mesh.material.color.set(light.color.getHex());
      }
    }
    // 消えたライトのハンドルを片付ける
    for (const [id, h] of [...this._handles]) {
      if (!liveIds.has(id)) {
        this._group.remove(h.mesh);
        if (h.line) this._group.remove(h.line);
        if (h.rangeHelper) this._group.remove(h.rangeHelper);
        if (h.rangeHandle) this._group.remove(h.rangeHandle);
        if (h.radiusLine) this._group.remove(h.radiusLine);
        this._handles.delete(id);
      }
    }
    if (this._selectedId && !liveIds.has(this._selectedId)) {
      this._setSelected(null);
    }
  }

  /** 毎フレーム呼ぶ: ハンドル位置・向き・見た目を更新する。 */
  update() {
    if (!this._enabled) return;
    const camera = this._scene.camera;
    for (const h of this._handles.values()) {
      h.mesh.position.copy(h.light.position);

      // 画面上でだいたい同じ大きさに見えるよう、カメラ距離に応じてスケールする
      const dist = Math.max(camera.position.distanceTo(h.mesh.position), 0.01);
      const scale = dist * 0.045;
      h.mesh.scale.setScalar(scale);

      const isSelected = h.id === this._selectedId;
      h.mesh.material.opacity = isSelected ? 1.0 : 0.8;

      const targetPos = h.light.target?.position ?? new THREE.Vector3(0, 0, 0);

      if (h.line) {
        const posAttr = h.line.geometry.attributes.position;
        posAttr.setXYZ(
          0,
          h.light.position.x,
          h.light.position.y,
          h.light.position.z,
        );
        posAttr.setXYZ(1, targetPos.x, targetPos.y, targetPos.z);
        posAttr.needsUpdate = true;
        h.line.geometry.computeBoundingSphere();
        h.line.material.opacity = isSelected ? 0.8 : 0.35;
      }

      if (h.rangeHelper || h.rangeHandle) {
        if (h.type === "spot") {
          const dir = new THREE.Vector3().subVectors(
            targetPos,
            h.light.position,
          );
          const len = dir.length();
          dir.normalize();
          if (len < 1e-4) dir.set(0, -1, 0); // 位置と注視点が重なった場合のフォールバック
          // 距離=0(無限)の場合は、現在ターゲットまでの距離を目安の長さに使う
          const effLength = h.light.distance > 0
            ? h.light.distance
            : Math.max(len, 0.5);
          const radius = effLength * Math.tan(h.light.angle ?? Math.PI / 6);
          h.rangeHelper.position.copy(h.light.position);
          h.rangeHelper.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 0, -1),
            dir,
          );
          h.rangeHelper.scale.set(radius, radius, effLength);
          h.rangeHelper.visible = true;
          h.rangeHelper.material.opacity = isSelected ? 0.6 : 0.25;

          // 範囲ハンドル: 向きの線の先端(=円錐の頂点から最も遠い点)に置く。
          // ここをドラッグすると減衰距離(円錐の長さ)を直接変えられる。
          if (h.rangeHandle) {
            const handlePos = h.light.position.clone().addScaledVector(
              dir,
              effLength,
            );
            h.rangeHandle.position.copy(handlePos);
            const hdist = Math.max(camera.position.distanceTo(handlePos), 0.01);
            h.rangeHandle.scale.setScalar(hdist * 0.025);
            h.rangeHandle.material.opacity = isSelected ? 1.0 : 0.7;
          }
        } else if (h.type === "point") {
          // distance=0(無限)は球として表現しようがないので非表示にする。
          // ただしハンドル自体は、無限状態から有限の範囲をドラッグで
          // 新しく設定できるよう、目安の長さ(3)で常に出しておく。
          const hasFiniteRange = h.light.distance > 0;
          h.rangeHelper.visible = hasFiniteRange;
          if (hasFiniteRange) {
            h.rangeHelper.position.copy(h.light.position);
            h.rangeHelper.scale.setScalar(h.light.distance);
            h.rangeHelper.material.opacity = isSelected ? 0.5 : 0.2;
          }

          // 範囲ハンドル: カメラの右方向に、距離ぶん離した位置に置く
          // (どの角度から見てもだいたい掴みやすい位置に来るようにするため)。
          // カメラは操作中は動かない(OrbitControls無効化中)ので、ドラッグ中も
          // 毎フレーム再計算して問題ない。
          const effLength = hasFiniteRange ? h.light.distance : 3;
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(
            camera.quaternion,
          );
          const handlePos = h.light.position.clone().addScaledVector(
            camRight,
            effLength,
          );

          if (h.rangeHandle) {
            h.rangeHandle.position.copy(handlePos);
            const hdist = Math.max(camera.position.distanceTo(handlePos), 0.01);
            h.rangeHandle.scale.setScalar(hdist * 0.025);
            h.rangeHandle.material.opacity = isSelected ? 1.0 : 0.7;
          }
          if (h.radiusLine) {
            const posAttr = h.radiusLine.geometry.attributes.position;
            posAttr.setXYZ(
              0,
              h.light.position.x,
              h.light.position.y,
              h.light.position.z,
            );
            posAttr.setXYZ(1, handlePos.x, handlePos.y, handlePos.z);
            posAttr.needsUpdate = true;
            h.radiusLine.geometry.computeBoundingSphere();
            h.radiusLine.material.opacity = isSelected ? 0.7 : 0.3;
          }
        }
      }
    }
  }

  // =========================================================
  // Private: メッシュ構築
  // =========================================================

  _buildHandleMesh(light) {
    // 半径1の単位球にしておき、update()でカメラ距離に応じてスケールする
    const geo = new THREE.SphereGeometry(1, 20, 20);
    const mat = new THREE.MeshBasicMaterial({
      color: light.color.getHex(),
      transparent: true,
      opacity: 0.8,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 997;
    return mesh;
  }

  _buildLine(color = 0xffffff) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 996;
    return line;
  }

  /**
   * 範囲(減衰距離)をドラッグで直接変更するための小さいハンドル。
   * メインのハンドル球より一回り小さく、見た目で区別できるよう白系の色にする。
   */
  _buildRangeHandleMesh() {
    const geo = new THREE.SphereGeometry(1, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 997;
    return mesh;
  }

  /**
   * スポットライトの照射範囲(角度×距離)を示す円錐ワイヤーフレーム。
   * 原点(0,0,0)を頂点として -Z 方向に伸びる「単位円錐」(z=-1での半径が1)
   * として一度だけ作っておき、毎フレーム update() で position/quaternion/scale
   * を設定することで実際の位置・向き・角度・距離に合わせる
   * (ジオメトリ自体は再生成しない。ボーンギズモの回転リングと同じ考え方)。
   */
  _buildCone() {
    const segments = 24;
    const points = [];
    const base = [];
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      base.push(new THREE.Vector3(Math.cos(theta), Math.sin(theta), -1));
    }
    // 頂点(光源位置) → 底面の各点への放射状の線(等間隔に間引いて描画しすぎない)
    const spokeCount = 8;
    for (let i = 0; i < spokeCount; i++) {
      const idx = Math.floor((i / spokeCount) * segments);
      points.push(new THREE.Vector3(0, 0, 0), base[idx]);
    }
    // 底面の円
    for (let i = 0; i < segments; i++) {
      points.push(base[i], base[(i + 1) % segments]);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.25,
      depthTest: false,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.renderOrder = 995;
    return mesh;
  }

  /**
   * ポイントライトの減衰距離(範囲)を示す球ワイヤーフレーム。
   * 半径1の単位球として作り、毎フレーム scale を distance に合わせる。
   */
  _buildSphereWire() {
    const geo = new THREE.WireframeGeometry(
      new THREE.SphereGeometry(1, 16, 10),
    );
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.2,
      depthTest: false,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.renderOrder = 995;
    return mesh;
  }

  // =========================================================
  // Private: 選択状態
  // =========================================================

  _setSelected(id) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    this._onSelect(id);
  }

  // =========================================================
  // ポインタ操作
  // =========================================================

  _bindEvents() {
    const c = this._canvas;
    c.addEventListener("mousedown", (e) => this._onDown(e));
    window.addEventListener("mousemove", (e) => this._onMove(e));
    window.addEventListener("mouseup", (e) => this._onUp(e));

    c.addEventListener("touchstart", (e) => this._onTouchStart(e), {
      passive: false,
    });
    c.addEventListener("touchmove", (e) => this._onTouchMove(e), {
      passive: false,
    });
    c.addEventListener("touchend", (e) => this._onTouchEnd(e), {
      passive: false,
    });
    c.addEventListener("touchcancel", (e) => this._onTouchEnd(e), {
      passive: false,
    });
  }

  _getPointerNDC(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      ((clientY - rect.top) / rect.height) * -2 + 1,
    );
  }

  /**
   * ポインタ位置に当たっているハンドルを探す。位置ハンドル(mesh)と
   * 範囲ハンドル(rangeHandle)の両方を対象に、一番手前のものを返す。
   * @returns {{ h: object, kind: 'position'|'range' }|null}
   */
  _hitTest(ndc) {
    this._raycaster.setFromCamera(ndc, this._scene.camera);
    let closest = null;
    let closestKind = null;
    let closestDist = Infinity;
    for (const h of this._handles.values()) {
      const hits = this._raycaster.intersectObject(h.mesh, false);
      if (hits.length && hits[0].distance < closestDist) {
        closestDist = hits[0].distance;
        closest = h;
        closestKind = "position";
      }
      if (h.rangeHandle) {
        const rangeHits = this._raycaster.intersectObject(h.rangeHandle, false);
        if (rangeHits.length && rangeHits[0].distance < closestDist) {
          closestDist = rangeHits[0].distance;
          closest = h;
          closestKind = "range";
        }
      }
    }
    return closest ? { h: closest, kind: closestKind } : null;
  }

  _onDown(e) {
    if (!this._enabled || e.button !== 0) return;
    const ndc = this._getPointerNDC(e.clientX, e.clientY);
    const hit = this._hitTest(ndc);
    if (!hit) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    this._dragMode = "pending";
    this._dragKind = hit.kind;
    this._dragDepth = e.shiftKey;
    this._downPos = { x: e.clientX, y: e.clientY };
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this._dragLight = hit.h;
    this._scene.controls.enabled = false;
  }

  _onMove(e) {
    if (!this._enabled || !this._dragMode) return;

    if (this._dragMode === "pending") {
      const dx = e.clientX - this._downPos.x;
      const dy = e.clientY - this._downPos.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this._dragMode = this._dragKind === "range"
          ? "range"
          : (this._dragDepth ? "depth" : "plane");
        this._canvas.classList.add("dragging-bone");
      } else {
        return;
      }
    }

    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    if (this._dragMode === "range") {
      this._applyRangeDrag(dx, dy);
    } else {
      this._applyDrag(dx, dy);
    }
    this._lastX = e.clientX;
    this._lastY = e.clientY;
  }

  _onUp(e) {
    if (e.button !== 0) return;
    if (this._dragMode === "pending") {
      // ドラッグせずに離した＝クリック → 選択のみ
      this._setSelected(this._dragLight?.id ?? null);
    } else if (this._dragMode) {
      this._endDrag();
      this._onDragEnd();
    }
    this._dragMode = null;
    this._dragKind = null;
    this._downPos = null;
    this._dragLight = null;
    this._scene.controls.enabled = true;
    this._canvas.classList.remove("dragging-bone");
  }

  _onTouchStart(e) {
    if (!this._enabled || e.touches.length !== 1) return;
    const t = e.touches[0];
    const ndc = this._getPointerNDC(t.clientX, t.clientY);
    const hit = this._hitTest(ndc);
    if (!hit) return;

    e.preventDefault();
    this._dragMode = "pending";
    this._dragKind = hit.kind;
    this._dragDepth = false; // タッチでは奥行き操作は提供しない（2本指はカメラ操作に割当済みのため）
    this._downPos = { x: t.clientX, y: t.clientY };
    this._lastX = t.clientX;
    this._lastY = t.clientY;
    this._dragLight = hit.h;
    this._scene.controls.enabled = false;
  }

  _onTouchMove(e) {
    if (!this._enabled || !this._dragMode || e.touches.length !== 1) return;
    const t = e.touches[0];

    if (this._dragMode === "pending") {
      const dx = t.clientX - this._downPos.x;
      const dy = t.clientY - this._downPos.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this._dragMode = this._dragKind === "range" ? "range" : "plane";
        this._canvas.classList.add("dragging-bone");
      } else {
        e.preventDefault();
        return;
      }
    }

    e.preventDefault();
    const dx = t.clientX - this._lastX;
    const dy = t.clientY - this._lastY;
    if (this._dragMode === "range") {
      this._applyRangeDrag(dx, dy);
    } else {
      this._applyDrag(dx, dy);
    }
    this._lastX = t.clientX;
    this._lastY = t.clientY;
  }

  _onTouchEnd(e) {
    if (!this._dragMode) return;
    if (this._dragMode === "pending") {
      this._setSelected(this._dragLight?.id ?? null);
    } else {
      this._endDrag();
      this._onDragEnd();
    }
    this._dragMode = null;
    this._dragKind = null;
    this._downPos = null;
    this._dragLight = null;
    this._scene.controls.enabled = true;
    this._canvas.classList.remove("dragging-bone");
  }

  _endDrag() {
    if (this._dragMode && this._dragMode !== "pending") {
      this._canvas.classList.remove("dragging-bone");
    }
    this._scene.controls.enabled = true;
    this._dragMode = null;
    this._dragKind = null;
    this._downPos = null;
    this._dragLight = null;
  }

  /**
   * ドラッグ中のマウス/指の移動量(px)を、選択中ライトの実際の移動に変換する。
   * 'plane': カメラの画面に平行な面内で移動（ボーンの平行移動と同じ考え方）。
   * 'depth' : カメラの前後方向（奥行き）に移動。縦方向のドラッグ量だけを使う。
   */
  _applyDrag(dx, dy) {
    if (!this._dragLight) return;
    const light = this._dragLight.light;
    const camera = this._scene.camera;
    const rect = this._canvas.getBoundingClientRect();
    const distance = Math.max(camera.position.distanceTo(light.position), 0.1);

    if (this._dragMode === "depth") {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const sensitivity = distance * 0.01;
      // 下方向へドラッグ＝カメラに近づく、上方向へドラッグ＝遠ざかる
      light.position.addScaledVector(forward, -dy * sensitivity);
      this._setSelected(this._dragLight.id);
      return;
    }

    const unitsPerPixel = 2 *
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance /
      rect.height;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    light.position.addScaledVector(right, dx * unitsPerPixel);
    light.position.addScaledVector(up, -dy * unitsPerPixel);
    this._setSelected(this._dragLight.id);
  }

  /**
   * 範囲ハンドル(rangeHandle)のドラッグを、減衰距離(light.distance)の
   * 変化量に変換する。ハンドルは常に「ライト位置から一定方向に
   * distance 分だけ離れた点」に置かれているので(update()参照)、
   * マウス移動量をその方向(基準方向)への射影(内積)に変換するだけで、
   * 「外に引っ張れば範囲が広がり、内に押し込めば狭まる」という
   * 自然な1次元のドラッグ操作になる。
   */
  _applyRangeDrag(dx, dy) {
    if (!this._dragLight) return;
    const h = this._dragLight;
    const light = h.light;
    const camera = this._scene.camera;
    const rect = this._canvas.getBoundingClientRect();
    const distance = Math.max(camera.position.distanceTo(light.position), 0.1);

    const unitsPerPixel = 2 *
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance /
      rect.height;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const deltaWorld = new THREE.Vector3()
      .addScaledVector(right, dx * unitsPerPixel)
      .addScaledVector(up, -dy * unitsPerPixel);

    // ハンドルが置かれている基準方向(update()と同じ計算)
    let refDir;
    let currentDistance;
    if (h.type === "spot") {
      const targetPos = light.target?.position ?? new THREE.Vector3(0, 0, 0);
      refDir = new THREE.Vector3().subVectors(targetPos, light.position);
      const len = refDir.length();
      refDir.normalize();
      if (len < 1e-4) refDir.set(0, -1, 0);
      currentDistance = light.distance > 0
        ? light.distance
        : Math.max(len, 0.5);
    } else {
      refDir = right.clone();
      currentDistance = light.distance > 0 ? light.distance : 3;
    }

    const deltaScalar = deltaWorld.dot(refDir);
    light.distance = THREE.MathUtils.clamp(
      currentDistance + deltaScalar,
      0,
      30,
    );
    this._setSelected(h.id);
  }
}
