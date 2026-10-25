/**
 * scene.js - Three.js シーン管理・カメラ・レンダリング・OrbitControls
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { tr } from "./i18n.js";
// テーマごとの既定の背景色と、床グリッドの色(中心線, 格子線)
// 描画解像度の倍率の上限(これを超える高DPI画面でも、見た目の差は小さく負荷だけが増えるため)
const MAX_PIXEL_RATIO = 2;
// スクリーンショットの一辺の上限(px)。GPU/ブラウザの描画バッファ上限に引っかからないようにする
const MAX_SCREENSHOT_SIDE = 8192;
// 半身・全身の撮影(captureFramed)の画角(縦方向, 度)。望遠寄りにして遠近の歪みを抑える
const FRAME_FOV = 20;
// 撮影構図の余白(被写体の高さに対する倍率)。1.1 なら上下に5%ずつ余白が出る
const FRAME_MARGIN = 1.1;

// 通常の視点の近クリップ面。注視点に近づいたときは、距離に応じてこれより小さくする(_updateNearPlane)
const CAMERA_NEAR = 0.1;
const CAMERA_NEAR_MIN = 0.005;
// 揺れ物の重力の既定値(足す分)。0 ならモデル元の設定のまま。設定パネルから変えられる。
const DEFAULT_GRAVITY = 0.5;
// 風の揺らぎの既定値。風を吹かせたときに、風が動いているのが見た目で分かるようにするため 0 にはしない。
const DEFAULT_GUST = 0.5;
// 布を押し出す相手(体のカプセル)の線分。[根元のボーン, 先端のボーン]。先端が無いボーンは、手のように前腕の向きに延ばす。
const BODY_SEGMENTS = [
  ["hips", "pelvis"], // 骨盤(お尻): 左右の股関節を結ぶ線分
  ["leftUpperLeg", "leftLowerLeg"],
  ["leftLowerLeg", "leftFoot"],
  ["rightUpperLeg", "rightLowerLeg"],
  ["rightLowerLeg", "rightFoot"],
  ["leftLowerArm", "leftHand"],
  ["rightLowerArm", "rightHand"],
  ["leftHand", null],
  ["rightHand", null],
];
const CLOTH_PUSH_MAX = 9; // シェーダーで扱うカプセルの数(BODY_SEGMENTS 以上)
// スカートのボーンへの重みが、この値を超えた頂点から押し出しを始める(シェーダーの smoothstep の始点と同じ)
const SKIRT_PUSH_START = 0.1;
// 体の半径を測るとき、ボーンへの影響が強い(重みがこれ以上の)頂点だけを使う
const MIN_SKIN_WEIGHT = 0.6;

const THEME_BACKGROUND = { dark: "#1a1a2e", light: "#e9edf3" };
const THEME_GRID = { dark: [0x333333, 0x222222], light: [0x9aa3af, 0xc3cad3] };

export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.currentVrm = null;
    this.vrms = [];
    this._animationId = null;
    // THREE.Clock は非推奨。Timer は、タブを隠していた間の時間を delta に含めない(connect)
    this._timer = new THREE.Timer();
    this._timer.connect(document);
    this._animationMixers = new Set();
    // 揺れ物(髪・服)の物理。gravity は各ジョイントの重力に足す強さ(setPhysics を参照)
    this._physics = {
      enabled: true,
      gravity: DEFAULT_GRAVITY,
      wind: { x: 0, y: 0, z: 0 }, // 風が吹いていく向き(ワールド座標)と強さ。x:右 y:上 z:正面(手前)
      gust: DEFAULT_GUST, // 風の強弱の揺らぎ(0〜1)。0 なら一定の風
      collision: 0, // 補う当たり判定の大きさ(体の太さに対する倍率)。0 なら補わない
    };
    this._clothPush = new WeakMap(); // vrm → { specs, uniforms, meshes }。体のカプセルの測定結果と、押し出しを仕込んだメッシュ
    this._springManagers = new WeakMap(); // 物理を無効にしている間も、元の manager を保持する
    this._windForce = new THREE.Vector3();
    this._jointForce = new THREE.Vector3();

    this._init();
  }

  _init() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true, // 透過PNGのスクリーンショット用(通常は不透明の背景色を描くので見た目は変わらない)
      powerPreference: "high-performance",
      // preserveDrawingBuffer は無効のまま。スクリーンショットは getScreenshot() が撮る直前に描画するので不要で、
      // 有効にすると毎フレーム描画バッファの退避が入って遅くなる。
    });
    // 高DPIの画面(タブレット等は2〜3倍)で描画ピクセル数が跳ね上がらないよう上限を設ける
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.setClearColor(0x1a1a2e, 1);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x1a1a2e, 10, 30);

    // Camera
    this.camera = new THREE.PerspectiveCamera(30, 1, CAMERA_NEAR, 100);
    this.camera.position.set(0, 1.4, 4);
    this.camera.lookAt(0, 1.0, 0);

    // Lights
    // 一般的なVRMビューア相当のシンプルな2灯構成(環境光+メインの平行光源)を
    // デフォルトにしている。以前は補助光(リムライト)も含めて3灯だったが、
    // 大抵のVRMツールはそこまで使わない・ライト編集機能自体がないことも多い
    // ため、最小限の構成にして、必要な分だけライトパネルから足してもらう。
    this.lights = []; // { id, type, light } のリスト。ライト編集UIから操作する。
    this.addLight("ambient", { color: 0xffffff, intensity: 0.7 });
    this.addLight("directional", {
      color: 0xffffff,
      intensity: 1.2,
      position: [1, 3, 2],
    });

    // Grid
    const grid = new THREE.GridHelper(10, 20, 0x333333, 0x222222);
    this.scene.add(grid);
    this._grid = grid;
    this._bgColor = 0x1a1a2e;
    this._bgTexture = null;
    this._bgVideoUrl = null;
    this._theme = "dark";
    this._bgUserSet = false; // ユーザーが背景色を自分で選んだら true(その間はテーマを切り替えても色を変えない)

    // OrbitControls - 左ドラッグでカメラ回転、ホイールでズーム
    // （球内操作時は controls.enabled = false で一時無効化）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.0, 0);
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.enableRotate = true;
    // ホイール/ピンチのズームは、カーソル位置ではなく画面中央(注視点)に向けて行う。
    // 近づきすぎて体の内側に入らないよう、近クリップ面は _updateNearPlane で距離に応じて詰める。
    this.controls.zoomToCursor = false;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.update();

    // Resize
    this._onResize();
    window.addEventListener("resize", () => this._onResize());

    // Animation loop
    this._animate();
  }

  _onResize() {
    const wrapper = this.canvas.parentElement;
    if (!wrapper) return;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    this._animationId = requestAnimationFrame(() => this._animate());
    this._timer.update();
    const delta = this._timer.getDelta();

    // 編集中でないモデルのアニメーションも止めずに再生し続けるため、
    // 登録されている全モデルのミキサーを毎フレーム更新する。
    // 揺れ物(髪・服)の計算は今のポーズを元に行うので、必ずミキサーの更新より後に vrm.update を呼ぶ。
    for (const mixer of this._animationMixers) mixer.update(delta);
    this._updateWind(this._timer.getElapsed());
    for (const vrm of this.vrms) vrm.update(delta);
    this._updateSelectionPulses(delta);
    this.sceneObjects?.update(delta);

    // BoneSphere が登録されていれば毎フレーム更新
    if (this.boneSphere) {
      this.boneSphere.update();
    }

    // ライト位置編集用ハンドル(light-gizmo.js)も毎フレーム更新
    if (this.lightGizmo) {
      this.lightGizmo.update();
    }

    this.controls.update();
    this._updateNearPlane();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 編集対象のアバターが切り替わったことを知らせるエフェクト。
   * アバターの足元から、地面に沿って広がりながら消える光の輪を2つ出す(約1秒)。
   * 光の輪は深度テストをしないので、グリッドや他のアバターに隠れない。
   * @param {import('@pixiv/three-vrm').VRM} vrm
   */
  pulseSelection(vrm) {
    if (!vrm) return;
    const box = new THREE.Box3().setFromObject(vrm.scene);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(Math.max(size.x, size.z) * 0.5, 0.35);

    this._selectionPulses ??= [];
    for (let i = 0; i < 2; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x4dabf7,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1, 64),
        material,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(center.x, box.min.y + 0.01, center.z);
      mesh.renderOrder = 999;
      mesh.raycast = () => {}; // クリック判定には関与しない
      this.scene.add(mesh);
      this._selectionPulses.push({
        mesh,
        radius,
        age: -i * 0.18, // 2つめの輪は少し遅らせる
      });
    }
  }

  _updateSelectionPulses(delta) {
    if (!this._selectionPulses?.length) return;
    const duration = 1.0;
    this._selectionPulses = this._selectionPulses.filter((pulse) => {
      pulse.age += delta;
      const t = pulse.age / duration;
      if (t >= 1) {
        this._disposePulse(pulse);
        return false;
      }
      if (t < 0) return true; // まだ出ていない
      const eased = 1 - (1 - t) * (1 - t); // 最初に勢いよく広がる
      pulse.mesh.scale.setScalar(pulse.radius * (0.5 + eased * 1.4));
      pulse.mesh.material.opacity = 0.9 * (1 - t);
      return true;
    });
  }

  _disposePulse(pulse) {
    this.scene.remove(pulse.mesh);
    pulse.mesh.geometry.dispose();
    pulse.mesh.material.dispose();
  }

  /** 撮影・書き出しに映り込まないよう、出ている選択エフェクトを消す。 */
  _clearSelectionPulses() {
    for (const pulse of this._selectionPulses ?? []) this._disposePulse(pulse);
    this._selectionPulses = [];
  }

  /**
   * 注視点までの距離に応じて近クリップ面を変える。近クリップ面より近い面は描かれないので、
   * 固定のままだと顔などに寄ったとき、肌や服の表面が欠けて内側が見えてしまう。
   * 通常の距離(約2m以上)では CAMERA_NEAR のままにして、深度の精度は変えない。
   */
  _updateNearPlane() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = THREE.MathUtils.clamp(
      distance * 0.05,
      CAMERA_NEAR_MIN,
      CAMERA_NEAR,
    );
    if (Math.abs(near - this.camera.near) < 1e-6) return;
    this.camera.near = near;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 指定した VRM の顔だけをズームしたサムネイル画像(データURL)を撮影する。
   * モデル一覧のアイコンに使う。メイン画面用のレンダラー/カメラとは別に、
   * 専用のオフスクリーンレンダラーで撮影するため、通常の3D表示には一切影響しない。
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {number} size - 出力する正方形画像の一辺(px)
   * @returns {string|null} data URL (image/png)。頭のボーンが見つからない場合は null。
   */
  captureFaceThumbnail(vrm, size = 128) {
    this._clearSelectionPulses();
    this.sceneObjects?.hideHelper();
    if (!vrm) return null;
    const headNode = vrm.humanoid?.getNormalizedBoneNode("head");
    if (!headNode) return null;

    // 撮影用のカメラ・描画先は初回だけ作って使い回す。
    // 別の WebGLRenderer を作ると、モデルのテクスチャ転送とシェーダーのコンパイル(MToon は重い)を
    // もう一度やり直し、GPUメモリも二重に使うので、メインのレンダラーでオフスクリーンに描画する。
    if (!this._thumbCamera) {
      this._thumbCamera = new THREE.PerspectiveCamera(30, 1, 0.05, 10);
    }
    if (!this._thumbTarget || this._thumbTarget.width !== size) {
      this._thumbTarget?.dispose();
      this._thumbTarget = new THREE.WebGLRenderTarget(size, size, {
        samples: 4,
        type: THREE.UnsignedByteType,
      });
    }

    // 顔のワールド座標を最新化してから取得
    vrm.scene.updateWorldMatrix(true, false);
    headNode.updateWorldMatrix(true, false);
    const headPos = headNode.getWorldPosition(new THREE.Vector3());

    // モデル全体の高さから頭のおおよそのサイズを推定し、そのサイズに応じてカメラ距離・
    // 注視点を決める。固定の距離だと、モデルの身長やスケールが違うと寄りすぎたり
    // (=目や鼻しか映らない)引きすぎたりしてしまうため。
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const totalHeight = Math.max(box.max.y - box.min.y, 0.01);
    const headSize = totalHeight / 7.5; // 一般的な頭身比率(約7.5頭身)から頭の大きさを概算

    // headボーンは顎〜首の付け根あたりにあることが多いため、そのままだと
    // 口元中心のフレーミングになりがち。少し上を向いた点を注視点にして、
    // 額や頭頂部まで含めて顔全体が入るようにする。
    const lookTarget = new THREE.Vector3(
      headPos.x,
      headPos.y + headSize * 0.3,
      headPos.z,
    );
    const distance = headSize * 3.2;
    // このアプリのVRMは読込時に +Z 方向を向くよう統一されている(vrm-loader.js参照)ため、
    // 顔の少し+Z側にカメラを置く。
    this._thumbCamera.position.set(
      lookTarget.x,
      lookTarget.y,
      headPos.z + distance,
    );
    this._thumbCamera.lookAt(lookTarget);
    this._thumbCamera.updateProjectionMatrix();

    // 他のモデルとグリッドが写り込まないよう一時的に隠す
    const others = this.vrms.filter((v) => v !== vrm);
    const prevVisible = others.map((v) => v.scene.visible);
    others.forEach((v) => {
      v.scene.visible = false;
    });
    const prevGridVisible = this._grid?.visible;
    if (this._grid) this._grid.visible = false;
    const prevBackground = this.scene.background;
    this.scene.background = null;

    const renderer = this.renderer;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this._thumbTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.render(this.scene, this._thumbCamera);
    const pixels = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(
      this._thumbTarget,
      0,
      0,
      size,
      size,
      pixels,
    );
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    const dataUrl = SceneManager._pixelsToDataUrl(pixels, size);

    others.forEach((v, i) => {
      v.scene.visible = prevVisible[i];
    });
    if (this._grid) this._grid.visible = prevGridVisible;
    this.scene.background = prevBackground;

    return dataUrl;
  }

  /**
   * 指定した VRM を正面から、決まった構図で撮影した透過 PNG(データURL)を返す。
   * 現在のポーズ・表情のまま撮る。モデル選択画面のサムネイル用(半身=一覧、全身=プレビュー)。
   * captureFaceThumbnail と同様、メインのレンダラーでオフスクリーンに描画するので、
   * 画面の表示(カメラ・サイズ)は変わらない。
   *
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {"portrait"|"fullBody"} mode
   *   portrait: 頭頂〜腰あたりまで(半身)。fullBody: 全身が収まる構図。
   * @param {number} width - 出力画像の幅(px)
   * @param {number} height - 出力画像の高さ(px)
   * @returns {string|null} data URL (image/png)。撮影できない(形状が空など)場合は null。
   */
  captureFramed(vrm, mode, width = 600, height = 800) {
    this._clearSelectionPulses();
    this.sceneObjects?.hideHelper();
    if (!vrm) return null;

    // 現在のポーズでの最新の形状から範囲を求める。precise=true にしないと、スキンメッシュは
    // 初期姿勢(Tポーズ等)のままの範囲になり、しゃがみなどのポーズで構図がずれる。
    vrm.scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(vrm.scene, true);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(FRAME_FOV / 2));
    const aspect = width / height;
    const top = box.max.y;
    let bottom;
    let targetX = center.x;
    let targetZ = center.z;
    let minWidth = 0;
    if (mode === "portrait") {
      const hipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
      const headNode = vrm.humanoid?.getNormalizedBoneNode("head");
      const hipsY = hipsNode
        ? hipsNode.getWorldPosition(new THREE.Vector3()).y
        : top - size.y * 0.55;
      bottom = hipsY; // 腰(hips ボーン)の高さまで。これより下げると脚の付け根が写る
      if (headNode) {
        // 左右・奥行きは顔の位置に合わせる(腕を広げたポーズでも顔が中央に来る)
        const headPos = headNode.getWorldPosition(new THREE.Vector3());
        targetX = headPos.x;
        targetZ = headPos.z;
      }
    } else {
      bottom = box.min.y;
      minWidth = size.x * 1.06; // 腕を広げたポーズでも左右が切れないようにする
    }

    // 縦に収める距離と、(全身のとき)横に収める距離の大きいほうを採用する
    const frameHeight = Math.max(top - bottom, size.y * 0.3) * FRAME_MARGIN;
    let distance = Math.max(
      frameHeight / 2 / tanHalfFov,
      minWidth / 2 / (tanHalfFov * aspect),
    );
    distance += size.z * 0.5; // 注視点は奥行きの中央なので、手前側が大きく写る分だけ引く

    // モデルが向いている方向(ワールド空間, 水平面内)に回り込む。VRM0 は読込時に
    // 180度回して +Z 向きに揃えているため、向きの基準がローカルでは -Z になる。
    const localFront = new THREE.Vector3(
      0,
      0,
      vrm.meta?.metaVersion === "0" ? -1 : 1,
    );
    const front = localFront.applyQuaternion(
      vrm.scene.getWorldQuaternion(new THREE.Quaternion()),
    );
    front.y = 0;
    if (front.lengthSq() < 1e-6) front.set(0, 0, 1);
    front.normalize();

    const target = new THREE.Vector3(targetX, (top + bottom) / 2, targetZ);
    if (!this._frameCamera) this._frameCamera = new THREE.PerspectiveCamera();
    const camera = this._frameCamera;
    camera.fov = FRAME_FOV;
    camera.aspect = aspect;
    camera.near = 0.05;
    camera.far = distance + size.length() + 10;
    camera.up.set(0, 1, 0);
    camera.position.copy(target).addScaledVector(front, distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix();

    if (
      !this._frameTarget ||
      this._frameTarget.width !== width ||
      this._frameTarget.height !== height
    ) {
      this._frameTarget?.dispose();
      this._frameTarget = new THREE.WebGLRenderTarget(width, height, {
        samples: 4,
        type: THREE.UnsignedByteType,
      });
    }

    // 他のモデル・床グリッド・操作用の補助表示・背景・フォグは写さない(透過PNGにする)
    const others = this.vrms.filter((v) => v !== vrm);
    const overlays = [this.boneSphere?._group, this.lightGizmo?._group].filter(
      Boolean,
    );
    const hidden = [...others.map((v) => v.scene), ...overlays];
    const prevVisible = hidden.map((o) => o.visible);
    hidden.forEach((o) => {
      o.visible = false;
    });
    const prevGridVisible = this._grid?.visible;
    if (this._grid) this._grid.visible = false;
    const prevBackground = this.scene.background;
    const prevFog = this.scene.fog;
    this.scene.background = null;
    this.scene.fog = null;

    const renderer = this.renderer;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(this._frameTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.render(this.scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(
        this._frameTarget,
        0,
        0,
        width,
        height,
        pixels,
      );
      return SceneManager._pixelsToDataUrl(pixels, width, height);
    } finally {
      renderer.setRenderTarget(null);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      hidden.forEach((o, i) => {
        o.visible = prevVisible[i];
      });
      if (this._grid) this._grid.visible = prevGridVisible;
      this.scene.background = prevBackground;
      this.scene.fog = prevFog;
    }
  }

  /**
   * オフスクリーン描画の結果(リニア色・上下反転・RGBA)を、sRGB の PNG(data URL)に変換する。
   * 描画先がレンダーターゲットのときは three.js が sRGB へ変換しないので、ここで変換する。
   * @param {Uint8Array} pixels
   * @param {number} width
   * @param {number} [height] - 省略すると正方形(width x width)
   */
  static _pixelsToDataUrl(pixels, width, height = width) {
    if (!SceneManager._linearToSrgbLut) {
      const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const c = i / 255;
        lut[i] = Math.round(
          (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) *
            255,
        );
      }
      SceneManager._linearToSrgbLut = lut;
    }
    const lut = SceneManager._linearToSrgbLut;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * row; // 下から上へ並んでいるので上下を反転して詰める
      const dst = y * row;
      for (let x = 0; x < row; x += 4) {
        image.data[dst + x] = lut[pixels[src + x]];
        image.data[dst + x + 1] = lut[pixels[src + x + 1]];
        image.data[dst + x + 2] = lut[pixels[src + x + 2]];
        image.data[dst + x + 3] = pixels[src + x + 3];
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  /**
   * VRM をシーンにセットする
   * @param {import('@pixiv/three-vrm').VRM} vrm
   */
  setVrm(vrm) {
    this.setVrms([vrm]);
    this.focusVrm(vrm);
  }

  /**
   * アニメーションミキサーを更新対象に登録する。
   * モデルを切り替えても再生が止まらないよう、編集中かどうかに関わらず
   * 登録された全てのミキサーを毎フレーム更新する。
   */
  registerAnimationMixer(mixer) {
    if (mixer) this._animationMixers.add(mixer);
  }

  /** アニメーションミキサーを更新対象から外す（モデル削除・アニメーション差し替え時）。 */
  unregisterAnimationMixer(mixer) {
    if (mixer) this._animationMixers.delete(mixer);
  }

  /** 複数の VRM をシーンに表示する（編集対象の選択とは独立）。 */
  setVrms(vrms) {
    for (const oldVrm of this.vrms) this.scene.remove(oldVrm.scene);
    this.vrms = [...vrms];
    for (const vrm of this.vrms) this.scene.add(vrm.scene);
    if (this.currentVrm && !this.vrms.includes(this.currentVrm)) {
      this.currentVrm = null;
    }
    for (const vrm of this.vrms) this._applyPhysics(vrm);
  }

  // =========================================================
  // 揺れ物(髪・服)の物理
  // =========================================================

  /** 揺れ物の物理の設定(コピー)。{ enabled, gravity, wind: {x,y,z}, gust, collision } */
  getPhysics() {
    return { ...this._physics, wind: { ...this._physics.wind } };
  }

  /**
   * 揺れ物(VRM の SpringBone)の物理を設定する。
   * @param {{ enabled?: boolean, gravity?: number }} options
   *   gravity: 各ジョイントに元から設定されている重力に足す強さ。VRoid などのモデルは
   *   全ジョイントの重力が 0 で、体が傾いたり脚を上げたりしても髪や服が下へたれず、
   *   剛性で元の形に戻ろうとするだけになる。これを足すと、重力で自然にたれ下がる。
   *   wind: 風が吹いていく向きと強さ(ワールド座標の x:右 y:上 z:正面側。1 で重力 1 と同じ強さの力)。
   *   gust: 風の強弱の揺らぎ(0〜1)。0 なら一定の風、大きいほど弱まったり強まったりを繰り返す。
   *   collision: 揺れ物がめり込まないよう、体(胴・脚・腕・手)に補う当たり判定の大きさ(体の太さに対する倍率、0〜)。
   *   0 なら補わない(読み込みが遅くならないよう、既定は 0)。
   */
  setPhysics({ enabled, gravity, wind, gust, collision } = {}) {
    if (enabled !== undefined) this._physics.enabled = !!enabled;
    if (gravity !== undefined) this._physics.gravity = Math.max(0, gravity);
    if (wind) Object.assign(this._physics.wind, wind);
    if (gust !== undefined) this._physics.gust = Math.min(1, Math.max(0, gust));
    if (collision !== undefined) {
      this._physics.collision = Math.max(0, collision);
    }
    for (const vrm of this.vrms) this._applyPhysics(vrm);
  }

  /**
   * 布の頂点を、体(脚・腕)の外へ押し出す。「スカートの中には必ず脚がある」ので、脚の内側に入った布の頂点は必ず間違いで、
   * 外へ出してよい。揺れ物の判定(ボーンの点だけ)では、ボーンとボーンの間の布が脚を横切ってしまうが、
   * これは描画される頂点そのものを動かすので、その間の布にも効く。
   * 対象は、スカートのボーンに強くウェイトされた頂点だけ(肌に密着したタイツや靴は動かさない)。
   * 半径は、肌の頂点から測った太さの scale 倍。scale が 0 なら何もしない(既定。読み込みを遅くしないため、初めて上げたときに仕込む)。
   */
  _applyClothPush(vrm) {
    const scale = this._physics.collision;
    let entry = this._clothPush.get(vrm);
    if (!entry && scale <= 0) return;
    if (!entry) {
      entry = this._prepareClothPush(vrm);
      this._clothPush.set(vrm, entry);
    }
    entry.scale = scale;
    if (scale <= 0) entry.uniforms.clothCount.value = 0;
  }

  /** メッシュの頂点ごとに、スカートのボーンへの重みの合計(0〜1)を返す。 */
  _skirtWeights(mesh, skirtBones) {
    const { skinIndex, skinWeight } = mesh.geometry.attributes;
    const weights = new Float32Array(skinIndex.count);
    for (let i = 0; i < weights.length; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) {
        if (skirtBones.has(mesh.skeleton.bones[skinIndex.getComponent(i, k)])) {
          w += skinWeight.getComponent(i, k);
        }
      }
      weights[i] = Math.min(1, w);
    }
    return weights;
  }

  /** そのジョイントのボーンから親をたどって、最初に出会うヒューマノイドのボーンが腰か太ももなら、スカート(など腰から下がる物)。 */
  _isSkirtJoint(vrm, joint, humanoidBones) {
    const roots = ["hips", "leftUpperLeg", "rightUpperLeg"].map((n) =>
      vrm.humanoid.getRawBoneNode(n)
    );
    for (let node = joint.bone.parent; node; node = node.parent) {
      if (humanoidBones.has(node)) return roots.includes(node);
    }
    return false;
  }

  _prepareClothPush(vrm) {
    const uniforms = {
      clothCount: { value: 0 },
      clothA: {
        value: Array.from(
          { length: CLOTH_PUSH_MAX },
          () => new THREE.Vector4(),
        ),
      },
      clothB: {
        value: Array.from(
          { length: CLOTH_PUSH_MAX },
          () => new THREE.Vector3(),
        ),
      },
    };
    const entry = { specs: [], uniforms, scale: 0 };

    // スカートのボーン(ジョイントの根元と先端)の集合
    const manager = this._springManagers.get(vrm) ?? vrm.springBoneManager;
    const humanoidBones = new Set(
      Object.values(vrm.humanoid.rawHumanBones ?? {}).map((b) => b.node),
    );
    const skirtBones = new Set();
    for (const joint of manager?.joints ?? []) {
      if (!this._isSkirtJoint(vrm, joint, humanoidBones)) continue;
      skirtBones.add(joint.bone);
      if (joint.child) skirtBones.add(joint.child);
    }

    const done = new Set();
    const meshes = [];
    // 初期姿勢(立った状態)で、体の太さと、スカートの頂点が体からどれだけ離れているかを測る
    this._withRestPose(vrm, manager, () => {
      entry.specs = this._measureBodyCapsules(vrm);
      vrm.scene.traverse((mesh) => {
        if (!mesh.isSkinnedMesh) return;
        const { skinIndex } = mesh.geometry.attributes;
        if (!skinIndex || done.has(mesh.geometry)) return;
        const loose = this._skirtWeights(mesh, skirtBones);
        const any = loose.some((w) => w > 0.2);
        if (!any) return;
        done.add(mesh.geometry);
        meshes.push({ mesh, loose });
        this._limitRadiusByRestCloth(entry.specs, mesh, loose);
      });
    });

    for (const { mesh, loose } of meshes) {
      mesh.geometry.setAttribute(
        "clothLoose",
        new THREE.BufferAttribute(loose, 1),
      );
      const rest = mesh.userData.clothRest;
      const count = loose.length;
      const slot = (size, offset) => {
        const array = new Float32Array(count * size);
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < size; k++) {
            array[i * size + k] = rest[i * CLOTH_PUSH_MAX + offset + k];
          }
        }
        return new THREE.BufferAttribute(array, size);
      };
      mesh.geometry.setAttribute("clothRest0", slot(4, 0));
      mesh.geometry.setAttribute("clothRest1", slot(4, 4));
      mesh.geometry.setAttribute("clothRest2", slot(1, 8));
      for (const material of [].concat(mesh.material)) {
        this._patchClothPush(material, uniforms);
      }
      const original = mesh.onBeforeRender;
      mesh.onBeforeRender = (...args) => {
        original.apply(mesh, args);
        this._uploadClothPush(entry);
      };
    }
    return entry;
  }

  /** 一時的に初期姿勢(Tポーズ)にして fn を実行し、終わったら元のポーズに戻す。 */
  _withRestPose(vrm, manager, fn) {
    const saved = [];
    const save = (o) => {
      if (
        o.isBone || o.parent === vrm.humanoid.normalizedHumanBonesRoot ||
        o.isObject3D
      ) {
        saved.push([
          o,
          o.position.clone(),
          o.quaternion.clone(),
          o.scale.clone(),
        ]);
      }
    };
    // 実際のボーンと、ポーズの編集で動かしている正規化ボーンの両方を覚えておく
    vrm.scene.traverse((o) => o.isBone && save(o));
    vrm.humanoid.normalizedHumanBonesRoot.traverse(save);
    const refresh = () => {
      vrm.scene.updateMatrixWorld(true);
      vrm.scene.traverse((o) => o.isSkinnedMesh && o.skeleton.update());
    };
    vrm.humanoid.resetNormalizedPose();
    vrm.humanoid.update();
    manager?.reset();
    refresh();
    try {
      fn();
    } finally {
      for (const [o, position, quaternion, scale] of saved) {
        o.position.copy(position);
        o.quaternion.copy(quaternion);
        o.scale.copy(scale);
      }
      vrm.humanoid.update();
      refresh();
      manager?.reset(); // 揺れ物の内部の状態も、今のポーズで初期化し直す
    }
  }

  /**
   * 初期姿勢では、スカートは体の外にある。だから各カプセルの半径は、スカートの頂点までの最短距離を超えてはいけない
   * (超えると、立っているだけでスカートが押し広げられてしまう)。
   */
  _limitRadiusByRestCloth(specs, mesh, loose) {
    const p = new THREE.Vector3();
    const head = new THREE.Vector3();
    const ab = new THREE.Vector3();
    // 頂点ごと・カプセルごとの、初期姿勢での体までの距離(押し出しの半径の上限)。スカートの頂点だけ測る。
    // シェーダーの属性に合わせて、1 頂点につき 9 個を vec4 + vec4 + float に詰める。
    const rest = new Float32Array(loose.length * CLOTH_PUSH_MAX).fill(1e3);
    specs.forEach((spec, n) => {
      spec.bone.localToWorld(head.copy(spec.head));
      spec.bone.localToWorld(ab.copy(spec.tail)).sub(head);
      const lengthSq = Math.max(ab.lengthSq(), 1e-8);
      for (let i = 0; i < loose.length; i++) {
        if (loose[i] < SKIRT_PUSH_START) continue; // シェーダーが押し出し始める重みと同じ値で測る
        mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).sub(head);
        const t = Math.min(1, Math.max(0, p.dot(ab) / lengthSq));
        rest[i * CLOTH_PUSH_MAX + n] = p.sub(ab.clone().multiplyScalar(t))
          .length();
      }
    });
    mesh.userData.clothRest = rest;
  }

  /** MToon の頂点処理に、体のカプセルから頂点を押し出す処理を差し込む。 */
  _patchClothPush(material, uniforms) {
    if (!material.isShaderMaterial || material.userData.clothPush) return;
    material.userData.clothPush = true;
    const base = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      base.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main()",
          `attribute float clothLoose;
attribute vec4 clothRest0;
attribute vec4 clothRest1;
attribute float clothRest2;
uniform int clothCount;
uniform vec4 clothA[${CLOTH_PUSH_MAX}];
uniform vec3 clothB[${CLOTH_PUSH_MAX}];
float clothRestV[${CLOTH_PUSH_MAX}];
vec3 clothPush(vec3 w, float loose) {
  for (int i = 0; i < ${CLOTH_PUSH_MAX}; i++) {
    if (i >= clothCount) break;
    vec3 a = clothA[i].xyz;
    vec3 ab = clothB[i] - a;
    float t = clamp(dot(w - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
    vec3 d = w - (a + ab * t);
    float dist = length(d);
    // この頂点が初期姿勢で体から離れていた距離を、半径の上限にする(立っているだけで布が膨らまないように)
    float radius = min(clothA[i].w, clothRestV[i] * 0.95);
    if (dist < radius && dist > 1e-5) w += d / dist * (radius - dist) * loose;
  }
  return w;
}
void main()`,
        )
        .replace(
          "#include <skinning_vertex>",
          `#include <skinning_vertex>
  if (clothCount > 0 && clothLoose > ${SKIRT_PUSH_START.toFixed(2)}) {
    vec3 clothWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    float clothAmount = smoothstep(${
            SKIRT_PUSH_START.toFixed(2)
          }, 0.6, clothLoose);
    clothRestV[0] = clothRest0.x; clothRestV[1] = clothRest0.y; clothRestV[2] = clothRest0.z; clothRestV[3] = clothRest0.w;
    clothRestV[4] = clothRest1.x; clothRestV[5] = clothRest1.y; clothRestV[6] = clothRest1.z; clothRestV[7] = clothRest1.w;
    clothRestV[8] = clothRest2;
    vec3 clothMoved = clothPush(clothPush(clothWorld, clothAmount), clothAmount);
    transformed += inverse(mat3(modelMatrix)) * (clothMoved - clothWorld);
  }`,
        );
    };
    const key = material.customProgramCacheKey;
    material.customProgramCacheKey = () => `${key.call(material)}|clothPush`;
    material.needsUpdate = true;
  }

  /** 描画の直前に、体のカプセルの今の位置(ワールド座標)をシェーダーへ渡す。 */
  _uploadClothPush(entry) {
    const { uniforms, specs, scale } = entry;
    if (scale <= 0) {
      uniforms.clothCount.value = 0;
      return;
    }
    const a = uniforms.clothA.value;
    const b = uniforms.clothB.value;
    const worldScale = new THREE.Vector3();
    const head = new THREE.Vector3(); // Vector4 に localToWorld を使うと w が掛かって壊れるので、Vector3 で計算してから入れる
    specs.forEach((spec, i) => {
      spec.bone.localToWorld(head.copy(spec.head));
      spec.bone.getWorldScale(worldScale);
      a[i].set(head.x, head.y, head.z, spec.radius * worldScale.x * scale);
      spec.bone.localToWorld(b[i].copy(spec.tail));
    });
    uniforms.clothCount.value = specs.length;
  }

  /** 部位ごとのカプセル({ bone, tail(ボーン座標), radius })を、今のポーズの肌の形から測る。 */
  _measureBodyCapsules(vrm) {
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    const node = (name) => vrm.humanoid.getRawBoneNode(name);
    const head = new THREE.Vector3();
    const tail = new THREE.Vector3();
    const v = new THREE.Vector3();

    // 肌のメッシュ(名前に body を含むもの。無ければ全メッシュ)の頂点を、いちばん強く影響するボーンごとに分ける
    const skinned = [];
    vrm.scene.traverse((obj) => {
      if (obj.isSkinnedMesh) skinned.push(obj);
    });
    const bodies = skinned.filter((m) => /body|skin|肌|体/i.test(m.name));
    const points = new Map(); // ボーン → ワールド座標の頂点(平坦な配列)
    for (const mesh of bodies.length ? bodies : skinned) {
      const { skinIndex, skinWeight } = mesh.geometry.attributes;
      if (!skinIndex) continue;
      for (let i = 0; i < skinIndex.count; i++) {
        for (let k = 0; k < 4; k++) {
          if (skinWeight.getComponent(i, k) < MIN_SKIN_WEIGHT) continue;
          const bone = mesh.skeleton.bones[skinIndex.getComponent(i, k)];
          mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
          let list = points.get(bone);
          if (!list) points.set(bone, list = []);
          list.push(v.x, v.y, v.z);
        }
      }
    }

    const specs = [];
    for (const [rootName, tipName] of BODY_SEGMENTS) {
      const root = node(rootName);
      if (!root) continue;
      const pelvis = tipName === "pelvis";
      const tip = tipName && !pelvis ? node(tipName) : null;
      if (pelvis) {
        const left = node("leftUpperLeg");
        const right = node("rightUpperLeg");
        if (!left || !right) continue;
        left.getWorldPosition(head);
        right.getWorldPosition(tail);
      } else {
        root.getWorldPosition(head);
      }
      if (pelvis) {
        // 骨盤は、左右の股関節を結ぶ線分
      } else if (tip) tip.getWorldPosition(tail);
      else {
        // 先端が無い(手): 前腕の向きに、手のひらの長さ(前腕の約1/3)ぶん延ばす
        const forearm = node(rootName.replace("Hand", "LowerArm"));
        if (!forearm) continue;
        forearm.getWorldPosition(tail);
        tail.sub(head).multiplyScalar(-0.35).add(head);
      }
      const length = head.distanceTo(tail);
      if (length < 1e-4) continue;

      // 線分への距離の 90% 点を半径にする(押し出された布が肌の下に隠れないよう、やや外側まで)
      const list = points.get(root);
      const axis = tail.clone().sub(head).divideScalar(length);
      const distances = [];
      for (let i = 0; list && i < list.length; i += 3) {
        v.set(list[i], list[i + 1], list[i + 2]).sub(head);
        const t = Math.min(length, Math.max(0, v.dot(axis)));
        distances.push(v.sub(axis.clone().multiplyScalar(t)).length());
      }
      distances.sort((x, y) => x - y);
      const radius = distances.length >= 8
        ? distances[Math.floor(distances.length * 0.9)]
        : length * 0.2; // 測れなかった部位は、長さの比率で代用する

      const worldScale = root.getWorldScale(new THREE.Vector3());
      specs.push({
        bone: root,
        head: root.worldToLocal(head.clone()),
        tail: root.worldToLocal(tail.clone()),
        radius: radius / worldScale.x,
        pelvis,
      });
    }
    return specs;
  }

  /** 風の強弱の倍率(gust が 0 なら常に 1)。2つの周期の違う波を重ねて、不規則に見せる。 */
  _gustFactor(seconds) {
    const { gust } = this._physics;
    if (!gust || seconds === null) return 1;
    return 1 +
      gust *
        (0.6 * Math.sin(seconds * 1.7) + 0.4 * Math.sin(seconds * 3.1 + 1.3));
  }

  /**
   * 各ジョイントにかかる外力を、モデル元の重力 + 追加の重力 + 風 の合計にする。
   * three-vrm は外力を「gravityDir × gravityPower」で受け取るので、合計のベクトルを向きと大きさに分けて渡す。
   * @param {number|null} seconds 経過時間(風の揺らぎ用)。null なら揺らぎ無し(落ち着かせる計算用)
   */
  _updateForces(manager, seconds) {
    const { gravity, wind } = this._physics;
    const k = this._gustFactor(seconds);
    this._windForce.set(wind.x * k, wind.y * k, wind.z * k);
    for (const joint of manager.joints) {
      joint.userData ??= {};
      if (!joint.userData.baseForce) {
        joint.userData.baseForce = joint.settings.gravityDir
          .clone()
          .multiplyScalar(joint.settings.gravityPower);
      }
      const force = this._jointForce
        .copy(joint.userData.baseForce)
        .add(this._windForce);
      force.y -= gravity;
      const power = force.length();
      joint.settings.gravityPower = power;
      if (power > 1e-6) {
        joint.settings.gravityDir.copy(force).divideScalar(power);
      }
    }
  }

  /** 毎フレーム呼ぶ。風に揺らぎがあるときだけ、外力を更新し直す。 */
  _updateWind(seconds) {
    const { enabled, gust, wind } = this._physics;
    if (!enabled || !gust || !(wind.x || wind.y || wind.z)) return;
    for (const vrm of this.vrms) {
      const manager = vrm.springBoneManager;
      if (manager) this._updateForces(manager, seconds);
    }
  }

  _applyPhysics(vrm) {
    let manager = this._springManagers.get(vrm);
    if (!manager) {
      manager = vrm.springBoneManager;
      if (!manager) return; // 揺れ物を持たないモデル
      this._springManagers.set(vrm, manager);
    }
    this._updateForces(manager, null);
    this._applyClothPush(vrm);
    if (this._physics.enabled) {
      if (!vrm.springBoneManager) {
        vrm.springBoneManager = manager; // 無効にしていた物理を戻す
        manager.reset();
      }
    } else if (vrm.springBoneManager) {
      manager.reset(); // 揺れていた髪・服を元の形に戻してから、計算を止める
      vrm.springBoneManager = null;
    }
  }

  /**
   * 揺れ物を、今のポーズで重力に任せて落ち着いた状態にする。
   * ポーズを大きく変えた直後は、髪や服がしばらく揺れ続けるので、すぐ撮影したいときに使う。
   */
  settlePhysics(seconds = 4) {
    const steps = Math.round(seconds * 60);
    for (const vrm of this.vrms) {
      const manager = vrm.springBoneManager;
      if (!manager) continue;
      vrm.humanoid.update(); // 正規化ボーンの今のポーズを実際のボーンへ反映する
      vrm.scene.updateMatrixWorld(true);
      manager.reset();
      this._updateForces(manager, null); // 揺らぎの無い、平均的な風で落ち着かせる
      for (let i = 0; i < steps; i++) manager.update(1 / 60);
    }
  }

  /** 編集対象の VRM にカメラを合わせる(moveCamera: false なら編集対象だけを切り替え、視点は動かさない)。 */
  focusVrm(vrm, { moveCamera = true } = {}) {
    if (!vrm) return;
    this.currentVrm = vrm;
    if (!moveCamera) return;

    // カメラをモデルに合わせる
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const height = size.y;

    const distance = Math.max(height * 2.2, 1);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y, center.z + distance);
    this.controls.update();
  }

  /**
   * 背景色を設定する（背景画像が設定されている場合はクリアされる）
   * @param {string} hexColor - '#rrggbb' 形式
   */
  setBackgroundColor(hexColor, { auto = false } = {}) {
    // テーマ既定色と同じ色を選んだ場合は「自分で選んだ」扱いにしない(テーマに追従させる)
    this._bgUserSet = !auto && !SceneManager.isThemeDefaultBackground(hexColor);
    this._bgColor = hexColor;
    this.scene.background = null;
    this._disposeBackgroundTexture();
    this.renderer.setClearColor(hexColor, 1);
    if (this.scene.fog) this.scene.fog.color.set(hexColor);
  }

  /**
   * 背景色を現在のテーマの既定色に戻す(以後はテーマの切り替えにも追従する)。
   * 背景画像が設定されている場合はクリアされる(setBackgroundColor と同じ)。
   * @returns {string} 戻した背景色('#rrggbb')
   */
  resetBackgroundColor() {
    this.setBackgroundColor(THEME_BACKGROUND[this._theme], { auto: true });
    return "#" + new THREE.Color(this._bgColor).getHexString();
  }

  /**
   * ライト/ダークのテーマに合わせた既定の背景色・床グリッドの色にする。
   * 背景色をユーザーが自分で選んでいる場合は、その色を保ったままグリッドの色だけ合わせる。
   * @returns {string} 現在の背景色('#rrggbb')
   */
  setTheme(theme) {
    this._theme = theme === "light" ? "light" : "dark";
    if (!this._bgUserSet) {
      this.setBackgroundColor(THEME_BACKGROUND[this._theme], { auto: true });
    }
    // GridHelper は色を頂点に持っているので、作り直して差し替える
    const visible = this._grid ? this._grid.visible : true;
    if (this._grid) {
      this.scene.remove(this._grid);
      this._grid.geometry.dispose();
      this._grid.material.dispose();
    }
    const [center, line] = THEME_GRID[this._theme];
    this._grid = new THREE.GridHelper(10, 20, center, line);
    this._grid.visible = visible;
    this.scene.add(this._grid);
    return "#" + new THREE.Color(this._bgColor).getHexString();
  }

  /** hex がどちらかのテーマの既定背景色と同じか */
  static isThemeDefaultBackground(hexColor) {
    const hex = new THREE.Color(hexColor).getHexString();
    return Object.values(THEME_BACKGROUND).some((c) =>
      new THREE.Color(c).getHexString() === hex
    );
  }

  /**
   * 背景画像を設定する（スクリーンショットにもそのまま写り込む）
   * @param {string} dataUrl - 画像の data URL
   */
  setBackgroundImage(dataUrl) {
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      this._disposeBackgroundTexture();
      this._bgTexture = texture;
      this.scene.background = texture;
    });
  }

  /**
   * 背景に動画を設定する(ループ・消音で自動再生。スクリーンショットには表示中のフレームが写る)
   * @param {Blob} blob - 動画ファイル
   * @returns {Promise<void>} 再生可能になったら解決、読み込めなければ reject
   */
  setBackgroundVideo(blob) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    return new Promise((resolve, reject) => {
      video.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        reject(new Error("video load error"));
      }, { once: true });
      video.addEventListener("loadeddata", () => {
        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        this._disposeBackgroundTexture();
        this._bgTexture = texture;
        this._bgVideoUrl = url;
        this.scene.background = texture;
        video.play().catch(
          () => {/* 自動再生が拒否されても、最初のフレームは表示される */},
        );
        resolve();
      }, { once: true });
    });
  }

  /** 背景テクスチャ(画像/動画)を破棄する。動画は停止して Blob URL も解放する。 */
  _disposeBackgroundTexture() {
    const texture = this._bgTexture;
    if (!texture) return;
    const video = texture.isVideoTexture ? texture.image : null;
    texture.dispose();
    this._bgTexture = null;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (this._bgVideoUrl) {
      URL.revokeObjectURL(this._bgVideoUrl);
      this._bgVideoUrl = null;
    }
  }

  /** 背景画像を消して単色背景に戻す */
  clearBackgroundImage() {
    this.scene.background = null;
    this._disposeBackgroundTexture();
    this.renderer.setClearColor(this._bgColor, 1);
  }

  /** 床グリッドの表示/非表示 */
  setGridVisible(visible) {
    if (this._grid) this._grid.visible = visible;
  }

  // =========================================================
  // ライト管理
  // シーンのライトは「型が固定の3灯」ではなく、種類・数とも自由に
  // 編集できるリストとして管理する。ライト編集パネル(light-panel.js)は
  // このAPIだけを通してライトを読み書きする。
  // =========================================================

  /**
   * ライトを1つ追加する。
   * @param {'ambient'|'directional'|'point'|'spot'|'hemisphere'} type
   * @param {object} [options]
   * @returns {{ id: string, type: string, light: THREE.Light }}
   */
  addLight(type, options = {}) {
    const color = options.color ?? 0xffffff;
    const intensity = options.intensity ?? 1;
    let light;
    switch (type) {
      case "ambient":
        light = new THREE.AmbientLight(color, intensity);
        break;
      case "hemisphere":
        light = new THREE.HemisphereLight(
          color,
          options.groundColor ?? 0x444444,
          intensity,
        );
        break;
      case "directional":
        light = new THREE.DirectionalLight(color, intensity);
        break;
      case "point":
        light = new THREE.PointLight(
          color,
          intensity,
          options.distance ?? 0,
          options.decay ?? 2,
        );
        break;
      case "spot":
        light = new THREE.SpotLight(
          color,
          intensity,
          options.distance ?? 0,
          options.angle ?? Math.PI / 6,
          options.penumbra ?? 0.2,
          options.decay ?? 2,
        );
        break;
      default:
        throw new Error(tr("scene.001", type));
    }
    if (light.position && type !== "ambient" && type !== "hemisphere") {
      const p = options.position ?? [1, 2, 2];
      light.position.set(p[0], p[1], p[2]);
    }
    if ("castShadow" in light) light.castShadow = !!options.castShadow;
    this._configureShadow(light);

    const id = options.id ??
      ("light-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
    const entry = { id, type, light };
    // リセットボタン用に、生成直後の値を「初期値」として保存しておく
    entry.original = this._snapshotLight(entry);
    this.lights.push(entry);
    this.scene.add(light);
    return entry;
  }

  /**
   * シャドウマップの精度を、このアプリのスケール(VRMキャラクター=身長1.6m前後)
   * に合わせて設定する。
   *
   * three.jsの各ライトのshadow.cameraは、デフォルトでは near=0.5, far=500
   * (平行光源はさらに left/right/top/bottom=±5)という、巨大な屋外シーンを
   * 想定した値になっている。キャラクター1体程度の小さなシーンでこれを
   * そのまま使うと、深度バッファの精度が広い範囲に無駄に分散してしまい、
   * わずかな自己遮蔽（服が肌に重なる・髪が顔にかかる、など）でもシャドウ
   * アクネ(縞模様のノイズ)が全身に出てしまう。特に「影を落とす」をONに
   * した瞬間にキャラクターがほぼ真っ黒になり、この画面の暗い背景色
   * (#1a1a2e)に紛れて「消えた」ように見えてしまう、という不具合の主因。
   * near/farをモデルのスケールに合わせて絞り、さらに bias/normalBias で
   * 自己遮蔽の誤判定を抑えることで解消する。
   */
  _configureShadow(light) {
    const shadow = light.shadow;
    if (!shadow) return; // ambient/hemisphereは影を持たない

    shadow.mapSize.set(1024, 1024);
    // 負のbiasは「shadow acne(自己遮蔽ノイズ)」、正に振りすぎると
    // 今度は「peter panning(影が本体から浮く)」が出るため、
    // キャラクタースケールでの経験的なバランス値にしている。
    shadow.bias = -0.0004;
    shadow.normalBias = 0.02;

    const cam = shadow.camera;
    cam.near = 0.1;
    cam.far = 15; // キャラクター+背景グリッド程度が収まれば十分
    if (cam.isOrthographicCamera) {
      // 平行光源用。モデルを囲むのに十分な範囲に絞る
      cam.left = -3;
      cam.right = 3;
      cam.top = 3;
      cam.bottom = -3;
    }
    cam.updateProjectionMatrix();
  }

  /**
   * ライトをシーンから外すだけでなく、GPU側のリソースも解放する。
   * PointLight/SpotLight/DirectionalLightは、影を落とす設定を一度でもONに
   * すると、影描画用のWebGLRenderTarget(フレームバッファ+深度テクスチャ)を
   * light.shadow.mapとして自分で保持する。scene.remove()はシーングラフから
   * 外すだけでこれを解放しないため、呼ばずにいると「ライトを足して消す」を
   * 繰り返すたびにGPUリソースが解放されずに残り続け、負荷が上がっていく
   * 原因になる。light.dispose()(各ライトのクラスがshadow.dispose()を
   * 呼ぶようオーバーライドしている)を呼んで、確実に解放する。
   */
  _disposeLight(light) {
    light.dispose?.();
  }

  /** ライトを1つ削除する。 */
  removeLight(id) {
    const index = this.lights.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [entry] = this.lights.splice(index, 1);
    this.scene.remove(entry.light);
    this._disposeLight(entry.light);
  }

  /** 現在のライトをすべて削除する(プロジェクト読込時のやり直し用)。 */
  clearLights() {
    for (const entry of this.lights) {
      this.scene.remove(entry.light);
      this._disposeLight(entry.light);
    }
    this.lights = [];
  }

  /** id からライトのエントリ({id, type, light, original})を取得する。 */
  getLight(id) {
    return this.lights.find((entry) => entry.id === id) ?? null;
  }

  _snapshotLight({ id, type, light }) {
    return {
      id,
      type,
      color: "#" + light.color.getHexString(),
      intensity: light.intensity,
      position: light.position ? light.position.toArray() : undefined,
      groundColor: light.groundColor
        ? "#" + light.groundColor.getHexString()
        : undefined,
      distance: light.distance,
      decay: light.decay,
      angle: light.angle,
      penumbra: light.penumbra,
      castShadow: light.castShadow ?? false,
    };
  }

  /** 保存用に、現在のライト一覧をプレーンなデータの配列として取り出す。 */
  getLightsData() {
    return this.lights.map((entry) => this._snapshotLight(entry));
  }

  /** getLightsData() の形式のデータから、既存のライトをすべて置き換えて復元する。 */
  loadLightsData(list) {
    this.clearLights();
    // 旧バージョン(THREE.jsのクラス名をそのまま保存していた形式)との互換用マッピング
    const legacyTypeMap = {
      AmbientLight: "ambient",
      DirectionalLight: "directional",
      PointLight: "point",
      SpotLight: "spot",
      HemisphereLight: "hemisphere",
    };
    for (const raw of list ?? []) {
      const data = { ...raw };
      if (legacyTypeMap[data.type]) data.type = legacyTypeMap[data.type];
      if (typeof data.color === "string" && !data.color.startsWith("#")) {
        data.color = "#" + data.color;
      }
      if (
        typeof data.groundColor === "string" &&
        !data.groundColor.startsWith("#")
      ) data.groundColor = "#" + data.groundColor;
      try {
        this.addLight(data.type, data);
      } catch { /* 未対応の種類は無視して読み飛ばす */ }
    }
  }

  /**
   * 現在のフレームをスクリーンショット用に取得
   * @param {{ scale?: number, transparent?: boolean }} [options]
   *   scale: 画面上の描画サイズ(ピクセル)に対する倍率。大きすぎる場合は上限に収まるよう下げる。
   *   transparent: true なら背景・床グリッド・フォグを描かず、背景を透過にする。
   * @returns {string} data URL (PNG)
   */
  getScreenshot({ scale = 1, transparent = false } = {}) {
    this._clearSelectionPulses();
    this.sceneObjects?.hideHelper();
    const r = this.renderer;
    const canvas = r.domElement;
    const baseW = canvas.width, baseH = canvas.height;
    const maxSide = Math.min(
      r.capabilities.maxTextureSize || 4096,
      MAX_SCREENSHOT_SIDE,
    );
    const s = Math.max(0.25, Math.min(scale, maxSide / baseW, maxSide / baseH));
    const w = Math.max(1, Math.floor(baseW * s)),
      h = Math.max(1, Math.floor(baseH * s));

    // 操作用の補助表示(ボーンの球・ライトのハンドル)は写さない
    const overlays = [this.boneSphere?._group, this.lightGizmo?._group].filter(
      Boolean,
    );
    const overlayVisible = overlays.map((o) => o.visible);
    overlays.forEach((o) => {
      o.visible = false;
    });

    const prev = {
      background: this.scene.background,
      fog: this.scene.fog,
      grid: this._grid?.visible,
      alpha: r.getClearAlpha(),
      ratio: r.getPixelRatio(),
    };
    if (transparent) {
      this.scene.background = null;
      this.scene.fog = null;
      if (this._grid) this._grid.visible = false;
      r.setClearAlpha(0);
    }
    try {
      r.setPixelRatio(1);
      r.setSize(w, h, false); // 描画バッファだけ大きくする(CSSの表示サイズは変えない)
      r.render(this.scene, this.camera);
      return canvas.toDataURL("image/png");
    } finally {
      overlays.forEach((o, i) => {
        o.visible = overlayVisible[i];
      });
      this.scene.background = prev.background;
      this.scene.fog = prev.fog;
      if (this._grid) this._grid.visible = prev.grid;
      r.setClearAlpha(prev.alpha);
      r.setPixelRatio(prev.ratio);
      this._onResize();
      r.render(this.scene, this.camera);
    }
  }

  dispose() {
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
    }
    for (const entry of this.lights) this._disposeLight(entry.light);
    this.renderer.dispose();
    this._thumbTarget?.dispose();
    this._frameTarget?.dispose();
    this._timer.disconnect();
  }
}
