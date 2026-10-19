/**
 * app.js - エントリーポイント・各モジュールの初期化と統合
 */
import * as THREE from "three";
import { SceneManager } from "./scene.js";
import { VrmLoader } from "./vrm-loader.js";
import { BONE_LABELS, UIManager } from "./ui.js";
import { BoneController } from "./bone-control.js";
import { BoneSphere } from "./bone-sphere.js";
import { Exporter } from "./exporter.js";
import {
  ALL_BONE_NAMES,
  CHILD_MAP,
  findAnyChildBoneName,
  getDescendantBoneNames,
  getMirrorBoneName,
  PARENT_MAP,
} from "./bone-hierarchy.js";
import { LightPanel } from "./light-panel.js";
import { LightGizmo } from "./light-gizmo.js";
import {
  applyMaterialsSnapshot,
  getMaterialsSnapshot,
  MaterialPanel,
} from "./material-panel.js";

import { tr } from "./i18n.js";
// 背景に使える画像/動画の拡張子(MIMEタイプが取れない場合の判定用)
const BACKGROUND_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|m4v|ogv)$/i;
// ランダムポーズ再生機能が読み込む一覧ファイルのURL。
// list.txt に書かれた相対パス(サブディレクトリ配下を含む)の *.fbx / *.glb / *.vrma を
// ランダムに再生し続ける。各行はこのファイルからの相対パス。
// list.txt は `deno run --allow-read --allow-write scripts/generate-animation-list.ts` で生成する。
// デプロイ先によって animations/ の場所が変わる場合は、各HTMLの data-animation-list を書き換える。
// ランダム再生リストの場所は言語ごとのHTML(<body data-animation-list>)で指定する(ページの置き場所に依存するため)
const ANIMATION_LIST_URL = document.body.dataset.animationList ||
  "../animations/list.txt";
// FBX の埋め込みテクスチャの代わりに読ませる 1x1 の透明画像
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// 読み込める拡張子(ポーズ読込・ランダムポーズ再生で共通)
const POSE_FILE_EXTENSIONS = ["glb", "fbx", "vrma"];
// ランダム再生中に読み込みに失敗したファイルを飛ばして次を試す回数の上限(連続失敗でこれを超えたら停止する)
const RANDOM_ANIMATION_MAX_CONSECUTIVE_FAILURES = 5;
// 1本再生し終えてから次のランダムな1本へ切り替えるまでの、ポーズを
// 滑らかに繋ぐトランジションの時間(秒)。0にすると即座に切り替わる(トランジション無し)。
const RANDOM_ANIMATION_TRANSITION_S = 0.5;

// ファイルを更新しても、ブラウザのタブを再読み込みしない限り古いJSのまま動いてしまう
// (ビルド無しのESモジュール構成のため、キャッシュされやすい)。更新を反映したのに
// 直らないという時、本当に新しいコードが読み込まれているかをここで確認できるようにする。
console.info("[vrm-pose-app] build: 2026-10-18-perf-v1");

class App {
  constructor() {
    this._vrm = null;
    this._vrmFilename = "";
    this._models = [];
    this._activeModelId = null;

    // DOM 要素
    this._canvas = document.getElementById("three-canvas");
    this._btnLoadVrm = document.getElementById("btn-load-vrm");
    this._inputVrm = document.getElementById("input-vrm");
    this._loadingOverlay = document.getElementById("loading-overlay");

    this._btnSaveVrma = document.getElementById("btn-save-vrma");
    this._btnSaveProject = document.getElementById("btn-save-project");
    this._btnLoadProject = document.getElementById("btn-load-project");
    this._inputProject = document.getElementById("input-project");
    this._btnLoadPose = document.getElementById("btn-load-pose");
    this._btnToggleAnimation = document.getElementById("btn-toggle-animation");
    this._btnRandomAnimation = document.getElementById("btn-random-animation");
    this._selectRandomAnimation = document.getElementById(
      "select-random-animation",
    );
    this._inputPose = document.getElementById("input-pose");
    this._modelList = document.getElementById("model-list");
    this._activeModelName = document.getElementById("active-model-name");
    this._vrmFile = null;
    this._btnScreenshot = document.getElementById("btn-screenshot");
    this._btnResetPose = document.getElementById("btn-reset-pose");
    this._btnCopyPose = document.getElementById("btn-copy-pose");
    this._btnPastePose = document.getElementById("btn-paste-pose");
    this._lightControls = document.getElementById("light-controls");
    this._materialSelect = document.getElementById("material-select");
    this._materialControls = document.getElementById("material-controls");

    // 初期ボーン quaternion / position（リセット用）
    this._initialQuaternions = new Map();
    this._initialPositions = new Map();

    // モジュール初期化
    this._scene = new SceneManager(this._canvas);
    this._loader = new VrmLoader();

    this._ui = new UIManager({
      onBoneSelect: (boneName) => this._onBoneSelectFromList(boneName),
      onSliderChange: (boneName, axis, deg) =>
        this._onSliderChange(boneName, axis, deg),
      onBoneReset: (boneName) => this._onBoneReset(boneName),
      onAxisReset: (boneName, axis) => this._onAxisReset(boneName, axis),
      onMirrorPart: () => this._mirrorSelectedPart(),
      onExpressionChange: (name, weight) =>
        this._onExpressionChange(name, weight),
    });

    this._boneCtrl = new BoneController(this._canvas, this._scene, {
      onBoneSelect: (boneName) => this._onBoneSelectFromCanvas(boneName),
      onBoneChange: (boneName, quaternion) =>
        this._onBoneChange(boneName, quaternion),
      // 右クリック（球内・移動なし）/ 長押しで親ボーンに切り替わった時。
      // 選択リスト・スライダー・操作球を新しい（親）ボーンに同期する。
      // これにより「切り替えた親ボーンより根本側（下側）は固定したまま、
      // それより先（上側）だけを動かす」という操作が可能になる。
      onParentBoneSelect: (boneName) => this._onBoneSelectFromList(boneName),
      // 中心の起点クリックで操作対象トグル（自分 ⇄ 親ボーン）が
      // 切り替わった時。トースト通知でどちらを操作中か知らせる。
      onTargetModeToggle: (mode, effectiveBoneName) =>
        this._onTargetModeToggle(mode, effectiveBoneName),
      // 球にもモデルにも当たらない場所をクリック/タップした時 → 選択解除
      onDeselect: () => this._onDeselect(),
    });

    // 可動域球
    this._boneSphere = new BoneSphere(this._scene, (boneName, quaternion) => {
      this._onBoneChange(boneName, quaternion);
    });
    this._scene.boneSphere = this._boneSphere;
    this._boneCtrl.setBoneSphere(this._boneSphere);

    // ライト位置のビューポート上での可視化・ドラッグ編集
    this._lightGizmo = new LightGizmo(this._canvas, this._scene, {
      // ドラッグでライト位置が変わったら、数値スライダー側の表示も合わせて更新する
      onDragEnd: () => this._lightPanel.build(),
      onSelect: (id) => this._lightPanel.highlightLight(id),
    });
    this._scene.lightGizmo = this._lightGizmo;

    // ライト編集パネル(シーン共通。モデルには依存しない)
    this._lightPanel = new LightPanel(this._lightControls, this._scene, {
      onChange: () => {}, // ライトは毎フレーム描画されるので、変更を都度通知する必要はない
      lightGizmo: this._lightGizmo,
      // ビューでのライト位置編集モードのON/OFFに合わせて、ボーン操作と
      // 競合しないようボーンコントローラーを無効化/再有効化する。
      onToggleEditMode: (enabled) => {
        this._boneCtrl.setEnabled(!enabled);
        if (enabled) {
          this._boneCtrl.clearSelection();
          this._boneSphere.hide();
        }
      },
    });
    this._lightPanel.build();

    // マテリアル編集パネル(アクティブなモデルに依存する)
    this._materialPanel = new MaterialPanel(
      this._materialSelect,
      this._materialControls,
      {
        onChange: () => {}, // マテリアルも同様、変更は次の描画フレームに自動反映される
      },
    );

    this._bindEvents();
  }

  // =========================================================
  // VRM 読込
  // =========================================================

  _bindEvents() {
    // 右パネルのタブ切替（ボーン / 表情 / 背景）
    const tabDefs = [
      { radio: "tab-model", panel: "panel-tab-model" },
      { radio: "tab-bone", panel: "panel-tab-bone" },
      { radio: "tab-expression", panel: "panel-tab-expression" },
      { radio: "tab-material", panel: "panel-tab-material" },
      { radio: "tab-scene", panel: "panel-tab-scene" },
    ];
    for (const { radio, panel } of tabDefs) {
      document.getElementById(radio)?.addEventListener("change", () => {
        for (const { panel: p } of tabDefs) {
          const el = document.getElementById(p);
          if (el) {
            el.classList.toggle("d-none", p !== panel);
            el.classList.toggle("d-flex", p === panel);
          }
        }
      });
    }

    // ライト/ダークの切り替え(ヘッダーのボタン)に合わせて、背景色の既定値を切り替える
    this._applyThemeToScene();
    new MutationObserver(() => this._applyThemeToScene())
      .observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bs-theme"],
      });

    // 背景色
    document.getElementById("bg-color")?.addEventListener("input", (e) => {
      this._scene.setBackgroundColor(e.target.value);
    });

    // 背景画像
    document.getElementById("bg-image")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) this._setBackgroundFromFile(file);
    });
    document.getElementById("btn-clear-bg-image")?.addEventListener(
      "click",
      () => {
        this._scene.clearBackgroundImage();
        const colorInput = document.getElementById("bg-image");
        if (colorInput) colorInput.value = "";
      },
    );

    // 床グリッド表示切替
    document.getElementById("toggle-grid")?.addEventListener("change", (e) => {
      this._scene.setGridVisible(e.target.checked);
    });

    // 表情リセット
    document.getElementById("btn-reset-expressions")?.addEventListener(
      "click",
      () => {
        this._resetExpressions();
      },
    );

    // 操作方式トグル（球 / ギズモ）
    const manipSphereRadio = document.getElementById("manip-mode-sphere");
    const manipGizmoRadio = document.getElementById("manip-mode-gizmo");
    manipSphereRadio?.addEventListener("change", () => {
      if (manipSphereRadio.checked) {
        this._boneSphere.setManipulationMode("sphere");
      }
    });
    manipGizmoRadio?.addEventListener("change", () => {
      if (manipGizmoRadio.checked) {
        this._boneSphere.setManipulationMode("gizmo");
      }
    });

    // VRM 読込
    this._btnLoadVrm.addEventListener("click", () => this._inputVrm.click());
    document.getElementById("btn-model-add")?.addEventListener(
      "click",
      () => this._inputVrm.click(),
    );
    this._inputVrm.addEventListener("change", async (e) => {
      const files = [...e.target.files];
      for (const file of files) await this._loadVrm(file);
      e.target.value = ""; // 同じファイルを再選択できるようにリセット
    });

    // ポーズ読込(GLB / FBX / VRMA を拡張子で判別)と自己完結プロジェクトの保存・読込
    this._btnToggleAnimation.addEventListener(
      "click",
      () => this._toggleAnimation(),
    );
    this._btnRandomAnimation.addEventListener(
      "click",
      () => this._toggleRandomAnimation(),
    );

    this._btnLoadPose.addEventListener("click", () => this._inputPose.click());
    this._inputPose.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (file && this._vrm) await this._loadPoseFile(file);
      e.target.value = "";
    });

    this._btnSaveVrma.addEventListener("click", () => {
      if (!this._vrm) return;
      const name = this._vrmFilename.replace(/\.vrm$/i, "") || "pose";
      Exporter.saveVrma(
        this._vrm,
        `${name}_pose.vrma`,
        this._getExpressionNames(this._vrm),
      );
      this._showToast(tr("app.001"), "success");
    });
    this._btnCopyPose.addEventListener("click", async () => {
      if (!this._vrm) return;
      try {
        await Exporter.copyVrmaToClipboard(
          this._vrm,
          this._getExpressionNames(this._vrm),
        );
        this._showToast(tr("app.002"), "success");
      } catch (err) {
        this._showToast(err.message || tr("app.003"), "danger");
      }
    });
    this._btnPastePose.addEventListener("click", async () => {
      if (!this._vrm) return;
      try {
        const loadedPose = await Exporter.pasteVrmaFromClipboard();
        this._applyPose(loadedPose.pose, loadedPose.expressions);
      } catch (err) {
        this._showToast(err.message || tr("app.004"), "danger");
      }
    });
    this._btnSaveProject.addEventListener("click", async () => {
      if (!this._vrm || !this._vrmFile) return;
      const name = this._vrmFilename.replace(/\.vrm$/i, "") || "project";
      const scene = {
        background: {
          color: this._scene._bgColor,
          image:
            (this._scene._bgTexture && !this._scene._bgTexture.isVideoTexture)
              ? (this._scene._bgTexture.image?.src ?? null)
              : null,
        },
        gridVisible: this._scene._grid.visible,
        camera: {
          position: this._scene.camera.position.toArray(),
          quaternion: this._scene.camera.quaternion.toArray(),
          target: this._scene.controls.target.toArray(),
          fov: this._scene.camera.fov,
        },
        lights: this._scene.getLightsData(),
      };
      const project = await Exporter.createProject(
        this._models,
        scene,
        (vrm) => this._getExpressionNames(vrm),
        (vrm) => getMaterialsSnapshot(vrm),
      );
      Exporter._download(
        new Blob([JSON.stringify(project, null, 2)], {
          type: "application/json",
        }),
        `${name}.vrmposer.json`,
      );
      this._showToast(tr("app.005"), "success");
    });
    this._btnLoadProject.addEventListener(
      "click",
      () => this._inputProject.click(),
    );
    this._inputProject.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await this._loadProjectFile(file);
      e.target.value = "";
    });
    this._setupDropAndPaste();

    // ランダム再生の対象一覧(select)。選び直すと、そのポーズに切り替える。
    this._selectRandomAnimation.addEventListener(
      "change",
      () => this._onAnimationSelectChanged(),
    );
    this._ensureAnimationList().catch((err) => {
      console.info("[vrm-pose-app] " + (err?.message ?? err));
      this._showAnimationSelectMessage(tr("app.006", ANIMATION_LIST_URL));
    });

    // VRM エクスポート機能は削除済み(ポーズ確認用アプリのため不要)

    // スクリーンショット
    this._btnScreenshot.addEventListener("click", () => {
      if (!this._scene) return;
      const name = this._vrmFilename.replace(/\.vrm$/i, "") || "screenshot";
      const scale =
        Number(document.getElementById("screenshot-scale")?.value) || 1;
      const transparent = !!document.getElementById("screenshot-transparent")
        ?.checked;
      Exporter.saveScreenshot(
        this._scene,
        `${name}${scale > 1 ? `@${scale}x` : ""}${
          transparent ? "-transparent" : ""
        }.png`,
        { scale, transparent },
      );
      this._showToast(tr("app.007"), "success");
    });

    // ポーズリセット
    this._btnResetPose.addEventListener("click", () => {
      if (!this._vrm) return;
      this._resetPose();
    });

    // カメラビューボタン
    document.getElementById("btn-view-front").addEventListener(
      "click",
      () => this._setCameraView("front"),
    );
    document.getElementById("btn-view-back").addEventListener(
      "click",
      () => this._setCameraView("back"),
    );
    document.getElementById("btn-view-right").addEventListener(
      "click",
      () => this._setCameraView("right"),
    );
    document.getElementById("btn-view-left").addEventListener(
      "click",
      () => this._setCameraView("left"),
    );
    document.getElementById("btn-view-top").addEventListener(
      "click",
      () => this._setCameraView("top"),
    );

    // キーボードショートカット
    window.addEventListener("keydown", (e) => this._onKeyDown(e));
  }

  /** プロジェクトファイル(.vrmposer.json)を読み込む。 */
  async _loadProjectFile(file) {
    try {
      const project = JSON.parse(await file.text());
      if (project.format !== "vrm-pose-project" || !project.models?.[0]?.data) {
        throw new Error(tr("app.008"));
      }
      this._models = [];
      this._scene.setVrms([]);
      for (const model of project.models) {
        const vrm = await this._loader.loadFromFile(
          new File([Exporter.dataUrlToArrayBuffer(model.data)], model.name, {
            type: "model/gltf-binary",
          }),
        );
        this._applyLoadedProject(vrm, model, project.scene);
      }
      this._scene.setVrms(this._models.map((item) => item.vrm));
      if (project.scene?.lights) {
        this._scene.loadLightsData(project.scene.lights);
      }
      this._lightPanel.build();
      if (project.scene?.camera) {
        this._scene.camera.position.fromArray(project.scene.camera.position);
        this._scene.camera.quaternion.fromArray(
          project.scene.camera.quaternion,
        );
        this._scene.controls.target.fromArray(project.scene.camera.target);
        this._scene.camera.fov = project.scene.camera.fov;
        this._scene.camera.updateProjectionMatrix();
        this._scene.controls.update();
      }
      this._activateModel(this._models[0].id);
      this._showToast(tr("app.009"), "success");
    } catch (err) {
      this._showToast(err.message || tr("app.010"), "danger");
    }
  }

  async _loadVrm(file) {
    this._showLoading(true);
    try {
      const vrm = await this._loader.loadFromFile(file);
      this._placeNewModel(vrm);
      const model = {
        id: "model-" + Date.now() + "-" + this._models.length,
        name: file.name,
        file,
        vrm,
        ...this._captureInitialPose(vrm),
      };
      this._models.push(model);
      this._scene.setVrms(this._models.map((item) => item.vrm));
      model.thumbnail = this._scene.captureFaceThumbnail(vrm);
      this._activateModel(model.id);
      this._showToast(tr("app.011", file.name), "success");
    } catch (err) {
      console.error(err);
      this._showToast(tr("app.012", err.message), "danger");
    } finally {
      this._showLoading(false);
    }
  }

  // =========================================================
  // ドラッグ&ドロップ / ファイルの貼り付け(Ctrl+V)
  // =========================================================

  /** 現在のテーマ(data-bs-theme)を3Dシーンに反映し、背景色の入力欄も合わせる。 */
  _applyThemeToScene() {
    const theme =
      document.documentElement.getAttribute("data-bs-theme") === "light"
        ? "light"
        : "dark";
    const color = this._scene.setTheme(theme);
    const input = document.getElementById("bg-color");
    if (input) input.value = color;
  }

  _setupDropAndPaste() {
    const overlay = document.getElementById("drop-overlay");
    const hasFiles = (e) =>
      [...(e.dataTransfer?.types ?? [])].includes("Files");
    let depth = 0; // 子要素をまたぐたびに dragenter/dragleave が飛ぶので、出入りの回数で数える
    const hide = () => {
      depth = 0;
      overlay?.classList.add("d-none");
    };
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay?.classList.remove("d-none");
    });
    window.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) hide();
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      this._handleIncomingFiles([...e.dataTransfer.files]);
    });

    // ファイルマネージャでコピーしたファイル、または VRMA(JSON) のテキストを Ctrl+V で貼り付ける
    document.addEventListener("paste", (e) => {
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      ) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        this._handleIncomingFiles(files);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.includes("VRMC_vrm_animation") && this._vrm) {
        e.preventDefault();
        Exporter.readVrmaPose(new Blob([text], { type: "model/gltf+json" }))
          .then((loaded) => this._applyPose(loaded.pose, loaded.expressions))
          .catch((err) =>
            this._showToast(err.message || tr("app.004"), "danger")
          );
      }
    });
  }

  /**
   * ドロップ/貼り付けされたファイルを拡張子で振り分ける。
   *  - .vrm : モデルとして追加(複数可)
   *  - .glb / .fbx / .vrma : ポーズ読込(先頭の1つを、現在のモデルに適用)
   *  - .json : プロジェクト(先頭の1つ)
   */
  async _handleIncomingFiles(files) {
    const byExt = (...exts) =>
      files.filter((f) => exts.includes(this._getExtension(f.name)));
    const vrmFiles = byExt("vrm");
    const poseFiles = byExt(...POSE_FILE_EXTENSIONS);
    const projectFiles = byExt("json");
    const backgroundFiles = files.filter((f) => this._isBackgroundMedia(f));
    if (
      !vrmFiles.length && !poseFiles.length && !projectFiles.length &&
      !backgroundFiles.length
    ) {
      this._showToast(tr("app.013"), "danger");
      return;
    }
    if (projectFiles.length) {
      await this._loadProjectFile(projectFiles[0]);
      return;
    }
    for (const file of vrmFiles) await this._loadVrm(file);
    if (backgroundFiles.length) {
      await this._setBackgroundFromFile(backgroundFiles[0]); // 貼り付け/ドロップした画像・動画は背景にする
    }
    if (poseFiles.length) {
      if (!this._vrm) {
        this._showToast(tr("app.014"), "warning");
        return;
      }
      if (poseFiles.length > 1) {
        this._showToast(tr("app.015", poseFiles[0].name), "secondary");
      }
      await this._loadPoseFile(poseFiles[0]);
    }
  }

  /** 背景に使える画像/動画ファイルか(MIMEタイプ優先、無ければ拡張子で判定) */
  _isBackgroundMedia(file) {
    if (/^(image|video)\//.test(file.type)) return true;
    return BACKGROUND_EXTENSIONS.test(file.name);
  }

  /** 画像/動画ファイルを背景に設定する。動画はループ・消音で再生する。 */
  async _setBackgroundFromFile(file) {
    try {
      const isVideo = file.type.startsWith("video/") ||
        /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
      if (isVideo) {
        await this._scene.setBackgroundVideo(file);
      } else {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        this._scene.setBackgroundImage(dataUrl);
      }
      const input = document.getElementById("bg-image");
      if (input) input.value = "";
    } catch (err) {
      this._showToast(tr("app.bgFailed"), "danger");
    }
  }

  /** 追加したモデルを、既に表示中のモデルと重ならない右側へ配置する。 */
  _placeNewModel(vrm) {
    if (!this._models.length) return;
    const newBox = new THREE.Box3().setFromObject(vrm.scene);
    const occupied = new THREE.Box3();
    for (const model of this._models) occupied.expandByObject(model.vrm.scene);
    const width = newBox.getSize(new THREE.Vector3()).x;
    const gap = Math.max(width * 0.1, 0.25);
    vrm.scene.position.x += occupied.max.x - newBox.min.x + gap;
  }

  _captureInitialPose(vrm) {
    const initialQuaternions = new Map(), initialPositions = new Map();
    for (const boneName of ALL_BONE_NAMES) {
      const node = vrm.humanoid.getNormalizedBoneNode(boneName);
      if (node) {
        initialQuaternions.set(boneName, node.quaternion.clone());
        initialPositions.set(boneName, node.position.clone());
      }
    }
    return {
      initialQuaternions,
      initialPositions,
      restHipsHeight: this._measureHipsHeight(vrm),
    };
  }

  /** Hipsのワールド高さ(地面からの高さの目安)を測る。アニメーションの身長差補正の基準にする。 */
  _measureHipsHeight(vrm) {
    const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
    if (!hipsNode) return null;
    vrm.scene.updateWorldMatrix(true, false);
    hipsNode.updateWorldMatrix(true, false);
    const hipsWorldY = hipsNode.getWorldPosition(new THREE.Vector3()).y;
    const rootWorldY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
    return Math.abs(hipsWorldY - rootWorldY);
  }

  _activateModel(id) {
    const model = this._models.find((item) => item.id === id);
    if (!model) return;
    this._activeModelId = id;
    this._vrm = model.vrm;
    this._vrmFile = model.file;
    this._vrmFilename = model.name;
    this._initialQuaternions = model.initialQuaternions;
    this._initialPositions = model.initialPositions;
    this._scene.focusVrm(model.vrm);
    this._updateAnimationButton(model);
    this._boneCtrl.setVrm(model.vrm);
    this._boneSphere.setVrm(model.vrm);
    this._boneSphere.hide();
    this._ui.buildBoneList(model.vrm);
    this._ui.buildExpressionControls(this._getExpressionNames(model.vrm));
    this._materialPanel.setVrm(model.vrm);
    this._renderModelList();
    this._setButtonsEnabled(true);
    this._updateAnimationButton(model);
    this._updateRandomAnimationButton(model);
    this._syncAnimationSelect(model);
  }

  _renderModelList() {
    this._modelList.innerHTML = "";
    if (!this._models.length) {
      this._modelList.innerHTML = tr("app.016");
      return;
    }
    this._models.forEach((model, index) => {
      const chip = document.createElement("div");
      chip.className = "model-chip" +
        (model.id === this._activeModelId ? " active" : "");
      chip.title = model.name;

      const face = document.createElement("button");
      face.type = "button";
      face.className = "model-chip-face";
      face.setAttribute("aria-label", tr("app.017", model.name));
      if (model.thumbnail) {
        face.classList.add("has-thumbnail");
        face.style.backgroundImage = `url(${model.thumbnail})`;
      } else {
        face.innerHTML = '<i class="bi bi-person-circle"></i>';
      }
      face.addEventListener("click", () => this._activateModel(model.id));

      const number = document.createElement("span");
      number.className = "model-chip-number";
      number.textContent = String(index + 1);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "model-chip-remove";
      remove.title = tr("app.018", model.name);
      remove.innerHTML = '<i class="bi bi-x"></i>';
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        this._removeModel(model.id);
      });

      chip.append(face, number, remove);
      this._modelList.appendChild(chip);
    });
    const active = this._models.find((item) => item.id === this._activeModelId);
    this._activeModelName.textContent = active ? active.name : tr("app.019");
  }

  /**
   * ボーン名(Mixamo / VRoid(J_Bip_*) / Blender(.L/.R) / Unity(LeftUpperArm) / Bip001 など)から
   * VRMのヒューマノイドボーン名を推定する。分からなければ null。
   */
  _guessVrmBoneName(rawBoneName) {
    const exact = this._getVrmBoneNameFromFbxBoneName(rawBoneName);
    if (exact) return exact;
    // camelCase と記号で単語に分け、プレフィックス類を除く
    const tokens = rawBoneName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
    const ignore = new Set([
      "mixamorig",
      "jbip",
      "bip001",
      "bip01",
      "armature",
      "bone",
      "cc",
      "base",
      "c",
      "def",
      "org",
      "mch",
      "j",
      "bip",
    ]);
    let side = null;
    const rest = [];
    for (const t of tokens) {
      if (t === "l" || t === "left") {
        side = "left";
        continue;
      }
      if (t === "r" || t === "right") {
        side = "right";
        continue;
      }
      if (ignore.has(t)) continue;
      // "UpperArmL" / "HandR" のような末尾の L/R にも対応
      const m = /^(.*?)(l|r)$/.exec(t);
      if (
        m && m[1] &&
        /(arm|hand|leg|foot|shoulder|clavicle|thigh|calf|toe|toes|toebase|[0-9])$/
          .test(m[1])
      ) {
        side = m[2] === "l" ? "left" : "right";
        rest.push(m[1]);
        continue;
      }
      rest.push(t);
    }
    let key = rest.join("");
    // Unreal Engine 系の連番(spine_01 / spine_02 / spine_03 / neck_01)。
    // ※ Mixamo の Spine1(=chest) とは違い、0 埋めの 2 桁なら「1本目 = spine」から数える。
    const ue = /^(spine|neck)0([1-9])$/.exec(key);
    if (ue) {
      key = ue[1] === "neck"
        ? (ue[2] === "1" ? "neck" : "")
        : ["", "spine", "chest", "upperchest"][Number(ue[2])] ?? "";
    }
    const center = {
      hips: "hips",
      hip: "hips",
      pelvis: "hips",
      spine: "spine",
      spine1: "chest",
      chest: "chest",
      spine2: "upperChest",
      upperchest: "upperChest",
      neck: "neck",
      neck1: "neck",
      head: "head",
    };
    if (center[key]) return center[key];
    if (!side) return null;
    const limb = {
      shoulder: "Shoulder",
      clavicle: "Shoulder",
      collar: "Shoulder",
      arm: "UpperArm",
      upperarm: "UpperArm",
      forearm: "LowerArm",
      lowerarm: "LowerArm",
      hand: "Hand",
      upleg: "UpperLeg",
      upperleg: "UpperLeg",
      thigh: "UpperLeg",
      leg: "LowerLeg",
      lowerleg: "LowerLeg",
      calf: "LowerLeg",
      shin: "LowerLeg",
      foot: "Foot",
      toe: "Toes",
      toes: "Toes",
      toebase: "Toes",
      ball: "Toes",
    };
    if (limb[key]) return side + limb[key];
    const finger = /^(?:hand)?(thumb|index|middle|ring|pinky|little)0?([1-4])$/
      .exec(key);
    if (finger) {
      const n = Number(finger[2]);
      const base = finger[1] === "pinky"
        ? "Little"
        : finger[1][0].toUpperCase() + finger[1].slice(1);
      const joint = finger[1] === "thumb"
        ? ["Metacarpal", "Proximal", "Distal"][n - 1]
        : ["Proximal", "Intermediate", "Distal"][n - 1];
      return joint ? side + base + joint : null;
    }
    return null;
  }

  _getVrmBoneNameFromFbxBoneName(rawBoneName) {
    const name = rawBoneName.toLowerCase().replace(/[^a-z0-9]/g, "").replace(
      /^mixamorig/,
      "",
    );
    const map = {
      hips: "hips",
      spine: "spine",
      spine1: "chest",
      spine2: "upperChest",
      neck: "neck",
      head: "head",
      leftshoulder: "leftShoulder",
      leftarm: "leftUpperArm",
      leftforearm: "leftLowerArm",
      lefthand: "leftHand",
      rightshoulder: "rightShoulder",
      rightarm: "rightUpperArm",
      rightforearm: "rightLowerArm",
      righthand: "rightHand",
      leftupleg: "leftUpperLeg",
      leftleg: "leftLowerLeg",
      leftfoot: "leftFoot",
      lefttoebase: "leftToes",
      rightupleg: "rightUpperLeg",
      rightleg: "rightLowerLeg",
      rightfoot: "rightFoot",
      righttoebase: "rightToes",
      leftthumb1: "leftThumbMetacarpal",
      leftthumb2: "leftThumbProximal",
      leftthumb3: "leftThumbDistal",
      rightthumb1: "rightThumbMetacarpal",
      rightthumb2: "rightThumbProximal",
      rightthumb3: "rightThumbDistal",
      leftindex1: "leftIndexProximal",
      leftindex2: "leftIndexIntermediate",
      leftindex3: "leftIndexDistal",
      rightindex1: "rightIndexProximal",
      rightindex2: "rightIndexIntermediate",
      rightindex3: "rightIndexDistal",
      leftmiddle1: "leftMiddleProximal",
      leftmiddle2: "leftMiddleIntermediate",
      leftmiddle3: "leftMiddleDistal",
      rightmiddle1: "rightMiddleProximal",
      rightmiddle2: "rightMiddleIntermediate",
      rightmiddle3: "rightMiddleDistal",
      leftring1: "leftRingProximal",
      leftring2: "leftRingIntermediate",
      leftring3: "leftRingDistal",
      rightring1: "rightRingProximal",
      rightring2: "rightRingIntermediate",
      rightring3: "rightRingDistal",
      leftpinky1: "leftLittleProximal",
      leftpinky2: "leftLittleIntermediate",
      leftpinky3: "leftLittleDistal",
      rightpinky1: "rightLittleProximal",
      rightpinky2: "rightLittleIntermediate",
      rightpinky3: "rightLittleDistal",
    };
    return map[name] ?? null;
  }

  /** ファイル名から小文字の拡張子(ドット無し)を返す。無ければ空文字。 */
  _getExtension(name) {
    const m = /\.([^./\\]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  /**
   * 「ポーズ読込」: GLB / FBX / VRMA を拡張子で判別して、現在アクティブなモデルに適用する。
   *  - .fbx : Mixamo 等のアニメーションとして再生(良いフレームで一時停止してポーズを取る)
   *  - .vrma / .glb : 1ポーズだけの静止データ(「ポーズ保存」で出力したもの等)なら、
   *    そのままポーズとして適用する。複数フレームのアニメーションなら FBX と同様に再生する。
   * @param {File} file
   * @returns {Promise<boolean>} 成功したら true
   */
  async _loadPoseFile(file) {
    const targetModel = this._models.find((item) =>
      item.id === this._activeModelId
    );
    if (!targetModel) return false;
    const ext = this._getExtension(file.name);
    if (!POSE_FILE_EXTENSIONS.includes(ext)) {
      this._showToast(tr("app.020"), "danger");
      return false;
    }
    if (targetModel.randomAnimationActive) {
      this._stopRandomAnimationForModel(targetModel);
    }
    try {
      const source = await this._parseAnimationSource(file);
      if (
        source.vrmaExtension && Exporter.isStaticAnimation(source.animations[0])
      ) {
        // 静止ポーズ: アニメーションは止めて、ボーンを直接編集できる状態でポーズを適用する
        this._clearAnimation(targetModel);
        const loadedPose = await Exporter.poseFromGltf(source.gltf);
        this._applyPose(loadedPose.pose, loadedPose.expressions);
        return true;
      }
      const clip = await this._buildClipFromSource(
        source,
        targetModel.vrm,
        targetModel.restHipsHeight,
        file.name,
      );
      if (Exporter.isStaticAnimation(source.animations[0])) {
        // 1ポーズだけの静止データ(ポーズ集のGLB等): 再生せず、編集できるポーズとして適用する
        this._clearAnimation(targetModel);
        this._applyPose(this._poseFromClip(clip, targetModel.vrm));
        return true;
      }
      this._applyAnimationClip(targetModel, clip);
      return true;
    } catch (err) {
      console.error(err);
      this._showToast(err.message || tr("app.021"), "danger");
      return false;
    }
  }

  /** クリップのうち、回転が対応づいたボーンの数。 */
  _countRotationTracks(clip) {
    return clip.tracks.filter((t) => t.name.endsWith(".quaternion")).length;
  }

  /** リターゲット済みクリップの最初のフレームを { ボーン名: { rotation, position } } のポーズにする。 */
  _poseFromClip(clip, vrm) {
    const uuidToBone = new Map();
    for (const boneName of ALL_BONE_NAMES) {
      const node = vrm.humanoid.getNormalizedBoneNode(boneName);
      if (node) uuidToBone.set(node.uuid, boneName);
    }
    const pose = {};
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf(".");
      const boneName = uuidToBone.get(track.name.slice(0, dot));
      if (!boneName) continue;
      const entry = (pose[boneName] ??= {});
      if (track.name.endsWith(".quaternion")) {
        entry.rotation = Array.from(track.values.slice(0, 4));
      } else if (track.name.endsWith(".position")) {
        entry.position = Array.from(track.values.slice(0, 3));
      }
    }
    return pose;
  }

  /**
   * ミキサーを止めて登録解除し、内部に溜めたキャッシュ(アクション・バインディング)も解放する。
   * ランダム再生は1本ごとに新しいミキサーを作るため、ここで解放しておかないとGCまで残り続ける。
   */
  _disposeMixer(mixer, root) {
    if (!mixer) return;
    mixer.stopAllAction();
    if (root) mixer.uncacheRoot(root);
    this._scene.unregisterAnimationMixer(mixer);
  }

  /** モデルに設定されているアニメーション(ミキサー)を停止・解除する。 */
  _clearAnimation(model) {
    if (model.animationMixer) {
      this._disposeMixer(model.animationMixer, model.vrm.scene);
    }
    model.animationMixer = null;
    model.animationAction = null;
    if (model.id === this._activeModelId) this._updateAnimationButton(model);
  }

  /**
   * GLB / FBX / VRMA ファイルを拡張子で判別して解析し、共通の形で返す。
   * @returns {Promise<{ root: THREE.Object3D, animations: THREE.AnimationClip[], gltf?: object, vrmaExtension?: object }>}
   */
  async _parseAnimationSource(file) {
    const ext = this._getExtension(file.name);
    if (ext === "fbx") {
      const fbx = await this._parseFbx(await file.arrayBuffer());
      return { root: fbx, animations: fbx.animations };
    }
    if (ext === "glb" || ext === "vrma") {
      const gltf = await Exporter.parseGltf(file);
      return {
        root: gltf.scene,
        animations: gltf.animations,
        gltf,
        vrmaExtension: Exporter.getVrmaExtension(gltf),
        humanBoneByNodeName: await this._readHumanoidNodeNames(gltf),
      };
    }
    throw new Error(tr("app.022", file.name));
  }

  /**
   * FBX を解析する。埋め込みテクスチャがあると FBXLoader は blob: URL を作って解放しないため、
   * 大量に読み込むランダム再生ではメモリが増え続ける。このアプリは動きしか使わないので、
   * 作られた blob URL はその場で破棄し、テクスチャの読み込みは極小の画像に差し替える。
   */
  async _parseFbx(buffer) {
    // FBX は使う人が限られる割に FBXLoader(+fflate, NURBS)が重いので、初めて必要になった時に読み込む
    const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
    const created = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = (obj) => {
      const url = original.call(URL, obj);
      created.push(url);
      return url;
    };
    try {
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((
        url,
      ) => (url.startsWith("blob:") ? TRANSPARENT_PIXEL : url));
      return new FBXLoader(manager).parse(buffer, "");
    } finally {
      URL.createObjectURL = original;
      for (const url of created) URL.revokeObjectURL(url);
    }
  }

  /** GLB が VRM(1.0 / 0.x)のヒューマノイド定義を持っていれば、ノード名 → ボーン名の対応を返す。 */
  async _readHumanoidNodeNames(gltf) {
    const ext = gltf.parser.json.extensions || {};
    let entries = [];
    if (ext.VRMC_vrm?.humanoid?.humanBones) {
      entries = Object.entries(ext.VRMC_vrm.humanoid.humanBones).map((
        [bone, v],
      ) => [bone, v.node]);
    } else if (Array.isArray(ext.VRM?.humanoid?.humanBones)) {
      entries = ext.VRM.humanoid.humanBones.map((v) => [v.bone, v.node]);
    }
    if (!entries.length) return null;
    const map = new Map();
    for (const [bone, index] of entries) {
      const node = await gltf.parser.getDependency("node", index);
      if (node) map.set(node.name || node.uuid, bone);
    }
    return map;
  }

  /**
   * ファイル(GLB / FBX / VRMA)を解析し、指定VRM向けにリターゲットした THREE.AnimationClip を返す。
   * ミキサーの生成・登録などモデルの状態変更は一切行わない(純粋にクリップを作るだけ)。
   * @param {File} file
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {number|null} restHipsHeight - モデルの基準となるHipsの高さ(モデル読込時に
   *   一度だけ測定した固定値)。身長差補正の基準に使う。
   * @returns {Promise<THREE.AnimationClip>}
   */
  async _buildClipFromFile(file, vrm, restHipsHeight) {
    const source = await this._parseAnimationSource(file);
    return this._buildClipFromSource(source, vrm, restHipsHeight, file.name);
  }

  async _buildClipFromSource(source, vrm, restHipsHeight, fileName) {
    if (!source.animations[0]) throw new Error(tr("app.023", fileName));
    if (!source.root && !source.vrmaExtension) {
      throw new Error(tr("app.024", fileName));
    }
    return source.vrmaExtension
      ? await this._buildClipFromVrma(source, vrm, restHipsHeight, fileName)
      : this._retargetMixamoClip(source, vrm, restHipsHeight, fileName);
  }

  /** キーフレームトラックの値を素直な配列で返す(glTFのCUBICSPLINEは [入力接線, 値, 出力接線] なので値だけ取り出す)。 */
  _plainTrackValues(track, stride) {
    if (track.values.length === track.times.length * stride * 3) {
      const out = new Float32Array(track.times.length * stride);
      for (let i = 0; i < track.times.length; i++) {
        for (let k = 0; k < stride; k++) {
          out[i * stride + k] = track.values[(i * 3 + 1) * stride + k];
        }
      }
      return out;
    }
    return track.values.slice();
  }

  /**
   * VRMA(VRMC_vrm_animation)を指定VRM向けの AnimationClip にする。
   * VRMAのヒューマノイドボーンは正規化ボーン空間の回転なので、ボーン名で対応づけてそのまま使える。
   */
  async _buildClipFromVrma(source, vrm, restHipsHeight, fileName) {
    const { gltf, vrmaExtension } = source;
    const sourceClip = source.animations[0];
    const isVrm0 = vrm.meta?.metaVersion === "0";
    const humanBones = vrmaExtension.humanoid?.humanBones;
    if (!humanBones) throw new Error(tr("app.025", fileName));

    // トラック名のノード名 → VRMボーン名
    const nodeNameToBone = new Map();
    let sourceHipsHeight = 0;
    for (const [boneName, value] of Object.entries(humanBones)) {
      const node = await gltf.parser.getDependency("node", value.node);
      nodeNameToBone.set(node.name || node.uuid, boneName);
      if (boneName === "hips") {
        node.updateWorldMatrix(true, false); // シーンを持たないVRMA(このアプリの保存形式など)でも動くよう、ノード単位で更新する
        sourceHipsHeight = Math.abs(
          node.getWorldPosition(new THREE.Vector3()).y,
        );
      }
    }
    // 体格差の補正。VRMA側にスケルトンのレスト姿勢が無い(=Hipsの高さが取れない)場合は等倍。
    const hipsPositionScale = sourceHipsHeight > 1e-4 && restHipsHeight
      ? restHipsHeight / sourceHipsHeight
      : 1;

    const tracks = [];
    for (const sourceTrack of sourceClip.tracks) {
      const dotIndex = sourceTrack.name.lastIndexOf(".");
      if (dotIndex < 0) continue;
      const boneName = nodeNameToBone.get(sourceTrack.name.slice(0, dotIndex));
      const propertyName = sourceTrack.name.slice(dotIndex + 1);
      if (!boneName) continue; // 表情トラックなど
      const vrmNode = vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!vrmNode) continue;
      const interpolation =
        sourceTrack.getInterpolation() === THREE.InterpolateDiscrete
          ? THREE.InterpolateDiscrete
          : undefined;

      if (propertyName === "quaternion") {
        const values = this._plainTrackValues(sourceTrack, 4);
        if (isVrm0) {
          for (let i = 0; i < values.length; i += 4) {
            values[i] *= -1;
            values[i + 2] *= -1;
          }
        }
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${vrmNode.uuid}.quaternion`,
            sourceTrack.times,
            values,
            interpolation,
          ),
        );
      } else if (boneName === "hips" && propertyName === "position") {
        const values = this._plainTrackValues(sourceTrack, 3).map((v, i) => {
          const scaled = v * hipsPositionScale;
          return isVrm0 && i % 3 !== 1 ? -scaled : scaled; // VRM0は前後(X/Z)の向きが逆
        });
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${vrmNode.uuid}.position`,
            sourceTrack.times,
            values,
            interpolation,
          ),
        );
      }
    }
    if (!tracks.length) throw new Error(tr("app.026", fileName));
    return new THREE.AnimationClip(
      sourceClip.name || fileName,
      sourceClip.duration,
      tracks,
    );
  }

  /**
   * Mixamo 系ではない GLB 向けに、「ソース(GLB)のレスト姿勢」と「VRMの正規化ボーンのレスト姿勢(Tポーズ)」の
   * 向きの差を求める。
   *  - Y : キャラクターの左右が +X になるよう、Y軸まわりに揃える回転(向きの違い対策)
   *  - A : ボーンごとの補正回転。「VRMのレスト時のボーン方向」を「ソースのレスト時のボーン方向(Yで揃えた後)」へ
   *        向ける最短回転。Aポーズ(腕が斜め下)のソースを、Tポーズの VRM に載せるために必要。
   *        子ボーンが無い・見つからないボーンは、親の補正をそのまま引き継ぐ。
   */
  _computeRestAlignment(root, vrm, boneToSrcNode) {
    root.updateMatrixWorld(true);
    const isVrm0 = vrm.meta?.metaVersion === "0";
    const wp = (n) => n.getWorldPosition(new THREE.Vector3());

    const Y = new THREE.Quaternion();
    const left = boneToSrcNode.get("leftUpperLeg") ??
      boneToSrcNode.get("leftUpperArm");
    const right = boneToSrcNode.get("rightUpperLeg") ??
      boneToSrcNode.get("rightUpperArm");
    if (left && right) {
      const d = wp(left).sub(wp(right));
      if (Math.hypot(d.x, d.z) > 1e-4) {
        Y.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(d.z, d.x));
      }
    }

    const vrmNode = (b) => vrm.humanoid.getNormalizedBoneNode(b);
    const childOf = (b) => {
      let c = CHILD_MAP[b] ??
        (/Hand$/.test(b)
          ? b.replace(/Hand$/, "MiddleProximal")
          : findAnyChildBoneName(b));
      // 省略されたボーン(upperChest 等)は飛ばして次の子へ
      while (c && !vrmNode(c)) c = CHILD_MAP[c] ?? findAnyChildBoneName(c);
      return c ?? null;
    };

    const A = new Map();
    const resolve = (b) => {
      if (A.has(b)) return A.get(b);
      let q = null;
      const c = childOf(b);
      const bNode = vrmNode(b), cNode = c && vrmNode(c);
      const sB = boneToSrcNode.get(b), sC = c && boneToSrcNode.get(c);
      if (bNode && cNode && sB && sC) {
        // VRM側のレスト方向(親子が直結していなくても親を辿って位置を足し合わせる)
        const dv = new THREE.Vector3();
        let n = cNode;
        while (n && n !== bNode) {
          dv.add(n.position);
          n = n.parent;
        }
        if (n === bNode) {
          if (isVrm0) {
            dv.x *= -1;
            dv.z *= -1;
          }
          const ds = wp(sC).sub(wp(sB)).applyQuaternion(Y);
          if (dv.lengthSq() > 1e-12 && ds.lengthSq() > 1e-12) {
            q = new THREE.Quaternion().setFromUnitVectors(
              dv.normalize(),
              ds.normalize(),
            );
          }
        }
      }
      if (!q) {
        const parent = PARENT_MAP[b];
        q = parent ? resolve(parent).clone() : new THREE.Quaternion();
      }
      A.set(b, q);
      return q;
    };
    for (const b of ALL_BONE_NAMES) resolve(b);

    const nodeToBone = new Map();
    for (const [b, node] of boneToSrcNode) nodeToBone.set(node, b);
    return { Y, Yinv: Y.clone().invert(), A, nodeToBone };
  }

  /**
   * Mixamo 系のボーン名を持つスケルトンアニメーション(FBX、または VRMA ではない GLB)を、
   * 指定VRM向けにリターゲットした THREE.AnimationClip にする。
   */
  _retargetMixamoClip(source, vrm, restHipsHeight, fileName) {
    const root = source.root;
    const sourceClip = source.animations[0];
    const fbx = root; // 以下の処理は FBX / GLB で共通(root 配下のノード名でボーンを引く)

    // レストポーズ(Tポーズ)時点でのワールド回転を取得するため、行列を確定させておく。
    fbx.updateMatrixWorld(true);

    const restRotationInverse = new THREE.Quaternion();
    const parentRestWorldRotation = new THREE.Quaternion();
    const quatWork = new THREE.Quaternion();
    const isVrm0 = vrm.meta?.metaVersion === "0";

    // Mixamoとモデルの身長差を補正するため、Hipsの高さの比率を求める。
    // ※ここは必ずモデル読込時に測定した固定値(restHipsHeight)を基準にすること。
    //   もし「現在のHipsの高さ」をその場で測って基準にすると、アニメーションを
    //   再生するたびに基準がわずかにズレていき、それが次のアニメーションのHips位置に
    //   反映されて…と誤差が積み重なって、徐々に地面へ沈んでいくバグになる。
    let hipsPositionScale = 1;
    const fbxHipsNode = ["mixamorigHips", "Hips"].map((n) =>
      fbx.getObjectByName(n)
    ).find(Boolean);
    if (fbxHipsNode && restHipsHeight) {
      const motionHipsHeight = fbxHipsNode.position.y;
      if (motionHipsHeight) {
        hipsPositionScale = restHipsHeight / motionHipsHeight;
      }
    }

    // GLB(Unreal / Blender 等)は、Aポーズ・Z-up・向きの違いなど、Mixamo(Tポーズ)とは
    // レスト姿勢が違うことが多い。ボーンごとの「レスト時の向き」の差を補正する。
    // FBX(Mixamo)は従来どおりの変換のまま。
    const isGlb = !!source.gltf;
    const resolveBone = (raw) =>
      source.humanBoneByNodeName?.get(raw) ?? this._guessVrmBoneName(raw);
    let align = null;
    if (isGlb) {
      const boneToSrcNode = new Map();
      for (const t of sourceClip.tracks) {
        const d = t.name.lastIndexOf(".");
        if (d < 0 || t.name.slice(d + 1) !== "quaternion") continue;
        const raw = t.name.slice(0, d).split(/[|/:]/).pop();
        const bone = resolveBone(raw);
        const node = bone && fbx.getObjectByName(raw);
        if (node && vrm.humanoid.getNormalizedBoneNode(bone)) {
          boneToSrcNode.set(bone, node);
        }
      }
      align = this._computeRestAlignment(fbx, vrm, boneToSrcNode);
      // GLB は Z-up の親ノード(root)の下にあることが多く、ローカルの y は高さではない。ワールドで高さを測る。
      const h = boneToSrcNode.get("hips");
      if (h && restHipsHeight) {
        const hipsY = h.getWorldPosition(new THREE.Vector3()).y -
          fbx.getWorldPosition(new THREE.Vector3()).y;
        hipsPositionScale = hipsY > 1e-4 ? restHipsHeight / hipsY : 1;
      }
    }

    const tracks = [];
    const unmatched = new Set();
    for (const sourceTrack of sourceClip.tracks) {
      const dotIndex = sourceTrack.name.lastIndexOf(".");
      if (dotIndex < 0) continue;
      const rawBoneName = sourceTrack.name.slice(0, dotIndex).split(/[|/:]/)
        .pop();
      const propertyName = sourceTrack.name.slice(dotIndex + 1);
      const vrmBoneName = resolveBone(rawBoneName);
      if (!vrmBoneName) {
        unmatched.add(rawBoneName);
        continue;
      }
      const vrmNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
      if (!vrmNode) continue;

      if (
        propertyName === "quaternion" &&
        sourceTrack instanceof THREE.QuaternionKeyframeTrack
      ) {
        const fbxBoneNode = fbx.getObjectByName(rawBoneName);
        if (!fbxBoneNode || !fbxBoneNode.parent) continue;

        // レスト時の「そのボーン自身のワールド回転の逆」と「その"FBX側"の親のワールド回転」を使い、
        // Mixamo側の回転を一旦ワールド基準の差分に変換してからVRMの正規化ボーン空間に変換する。
        // ※ここは必ずFBX側の親を使う(VRM側の親ではない)。VRMの正規化ボーンは
        //   「どのモデルでも同じ標準的なレスト姿勢になる」よう作られているため、
        //   Mixamo側だけの情報で変換できる。VRM側の親を使うと、正規化ボーンの
        //   行列が更新されていない場合や個体差でズレてねじれの原因になる。
        fbxBoneNode.getWorldQuaternion(restRotationInverse).invert();
        fbxBoneNode.parent.getWorldQuaternion(parentRestWorldRotation);

        const values = this._plainTrackValues(sourceTrack, 4);
        // GLB: 局所回転 = A_親^-1 · Y · 親レスト · q · 自分レスト^-1 · Y^-1 · A_自分(A はレスト向きの補正、Y は向きの補正)
        const pre = new THREE.Quaternion().copy(parentRestWorldRotation);
        const post = new THREE.Quaternion().copy(restRotationInverse);
        if (align) {
          const aSelf = align.A.get(vrmBoneName) ?? new THREE.Quaternion();
          let aParent = new THREE.Quaternion();
          for (let n = fbxBoneNode.parent; n; n = n.parent) {
            const b = align.nodeToBone.get(n);
            if (b) {
              aParent = align.A.get(b) ?? aParent;
              break;
            }
          }
          pre.premultiply(align.Y).premultiply(aParent.clone().invert());
          post.multiply(align.Yinv).multiply(aSelf);
        }
        for (let i = 0; i < values.length; i += 4) {
          quatWork.fromArray(values, i);
          quatWork.premultiply(pre).multiply(post);
          if (isVrm0) {
            quatWork.x *= -1;
            quatWork.z *= -1;
          }
          quatWork.toArray(values, i);
        }
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${vrmNode.uuid}.quaternion`,
            sourceTrack.times,
            values,
          ),
        );
      } else if (
        vrmBoneName === "hips" && propertyName === "position" &&
        sourceTrack instanceof THREE.VectorKeyframeTrack
      ) {
        let values = this._plainTrackValues(sourceTrack, 3);
        if (align) {
          // 親(root 等)の姿勢を含めたワールド位置に直し、向きを揃えてから身長比でスケールする
          const hipsNode = fbx.getObjectByName(rawBoneName);
          const parentMatrix = hipsNode?.parent?.matrixWorld;
          const origin = fbx.getWorldPosition(new THREE.Vector3());
          const v3 = new THREE.Vector3();
          values = values.slice();
          for (let i = 0; i < values.length; i += 3) {
            v3.fromArray(values, i);
            if (parentMatrix) v3.applyMatrix4(parentMatrix);
            v3.sub(origin).applyQuaternion(align.Y).toArray(values, i);
          }
        }
        values = values.map((v, i) => {
          const scaled = v * hipsPositionScale;
          return isVrm0 && i % 3 !== 1 ? -scaled : scaled; // VRM0は前後(X/Z)の向きが逆
        });
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${vrmNode.uuid}.position`,
            sourceTrack.times,
            values,
          ),
        );
      }
    }

    // 指先・つま先の末端(*_leaf, *_end)や root などは VRM に対応する骨が無いので正常。それ以外だけ、同じ内容は1回だけ知らせる。
    const unexpected = [...unmatched].filter((n) =>
      !/(^|[_.\s-])(leaf|end|nub|tip|root|armature|scene)([_.\s-]|$)|_0[4-9]_/i
        .test(n)
    );
    if (unexpected.length) {
      const signature = unexpected.join("|");
      this._reportedUnmatched ??= new Set();
      if (!this._reportedUnmatched.has(signature)) {
        this._reportedUnmatched.add(signature);
        console.info(tr("app.027", unexpected.join(", ")));
      }
    }
    const rotationTrackCount =
      tracks.filter((t) => t.name.endsWith(".quaternion")).length;
    // 頭だけ動く等、ごく一部しか対応づけられなかった場合は、気付けるようにエラーにする
    if (rotationTrackCount < 5) {
      const sample = [...unmatched].slice(0, 6).join(", ");
      throw new Error(
        sample ? tr("app.028", fileName, sample) : tr("app.029", fileName),
      );
    }
    return new THREE.AnimationClip(
      sourceClip.name || fileName,
      sourceClip.duration,
      tracks,
    );
  }

  /**
   * 組み立て済みの THREE.AnimationClip をモデルに適用し、再生を開始する。
   * 既存のミキサーがあれば止めて登録解除してから、新しいミキサーに差し替える。
   * @returns {{ mixer: THREE.AnimationMixer, action: THREE.AnimationAction }}
   */
  _applyAnimationClip(targetModel, clip) {
    if (targetModel.animationMixer) {
      this._disposeMixer(targetModel.animationMixer, targetModel.vrm.scene);
    }
    const mixer = new THREE.AnimationMixer(targetModel.vrm.scene);
    const action = mixer.clipAction(clip);
    action.play();
    targetModel.animationMixer = mixer;
    targetModel.animationAction = action;
    this._scene.registerAnimationMixer(mixer);
    if (targetModel.id === this._activeModelId) {
      this._updateAnimationButton(targetModel);
    }
    return { mixer, action };
  }

  _toggleAnimation() {
    const model = this._models.find((item) => item.id === this._activeModelId);
    if (!model?.animationAction) return;
    model.animationAction.paused = !model.animationAction.paused;
    this._updateAnimationButton(model);
  }

  _updateAnimationButton(model) {
    const action = model?.animationAction;
    this._btnToggleAnimation.disabled = !action;
    if (!action) {
      this._btnToggleAnimation.innerHTML = tr("app.030");
      return;
    }
    this._btnToggleAnimation.innerHTML = action.paused
      ? tr("app.031")
      : tr("app.030");
  }

  // =========================================================
  // ランダムポーズ再生
  // ../animations/list.txt に列挙された *.fbx / *.glb / *.vrma(サブディレクトリ配下を含む)から毎回ランダムに選び、
  // 1本再生し終えたら自動的に次のランダムな1本へ進み続ける。
  // =========================================================

  _toggleRandomAnimation() {
    const model = this._models.find((item) => item.id === this._activeModelId);
    if (!model) return;
    if (model.randomAnimationActive) this._stopRandomAnimationForModel(model);
    else this._startRandomAnimationForModel(model);
  }

  async _startRandomAnimationForModel(model) {
    model.randomAnimationActive = true;
    this._updateRandomAnimationButton(model);
    try {
      await this._ensureAnimationList();
    } catch (err) {
      console.error(err);
      model.randomAnimationActive = false;
      this._updateRandomAnimationButton(model);
      this._showToast(err.message || tr("app.032"), "danger");
      return;
    }
    this._playNextRandomAnimation(model);
  }

  _stopRandomAnimationForModel(model) {
    if (!model || !model.randomAnimationActive) return;
    model.randomAnimationActive = false;
    this._updateRandomAnimationButton(model);
  }

  /** 一覧(list.txt)を1回だけ取得してキャッシュし、select に反映する。失敗した場合は次回また取得し直す。 */
  _ensureAnimationList() {
    if (this._animationFileNames) {
      return Promise.resolve(this._animationFileNames);
    }
    this._animationListPromise ??= this._fetchAnimationFileNames()
      .then((names) => {
        this._animationFileNames = names;
        this._populateAnimationSelect();
        return names;
      })
      .finally(() => {
        this._animationListPromise = null;
      });
    return this._animationListPromise;
  }

  _populateAnimationSelect() {
    const select = this._selectRandomAnimation;
    select.replaceChildren(new Option(tr("app.033"), ""));
    for (const name of this._animationFileNames) {
      const option = new Option(name, name);
      option.title = name;
      select.add(option);
    }
    this._updateAnimationSelectState();
    this._syncAnimationSelect(
      this._models.find((m) => m.id === this._activeModelId),
    );
  }

  _showAnimationSelectMessage(text) {
    this._selectRandomAnimation.replaceChildren(new Option(text, ""));
    this._updateAnimationSelectState();
  }

  _updateAnimationSelectState() {
    this._selectRandomAnimation.disabled =
      !(this._modelButtonsEnabled && this._animationFileNames?.length);
  }

  /** select の表示を、そのモデルで最後に再生したポーズに合わせる(アクティブなモデルのときだけ)。 */
  _syncAnimationSelect(model) {
    if (
      !model || model.id !== this._activeModelId || !this._animationFileNames
    ) return;
    this._selectRandomAnimation.value = model.lastRandomAnimationName ?? "";
  }

  /**
   * select を手動で変えたとき。ランダム再生中なら、そのポーズに切り替えてランダム再生を続ける。
   * 停止中なら「ポーズ読込」と同じ扱いで、そのポーズを読み込む。
   */
  async _onAnimationSelectChanged() {
    const name = this._selectRandomAnimation.value;
    const model = this._models.find((item) => item.id === this._activeModelId);
    if (!name || !model) return;
    if (model.randomAnimationActive) {
      this._playNextRandomAnimation(model, 0, name);
      return;
    }
    model.lastRandomAnimationName = name;
    try {
      const res = await fetch(this._resolveAnimationUrl(name));
      if (!res.ok) throw new Error(tr("app.034", name));
      await this._loadPoseFile(
        new File([await res.blob()], name.split("/").pop()),
      );
    } catch (err) {
      console.error(name + ": " + (err?.message ?? err));
      this._showToast(err.message || tr("app.021"), "danger");
    }
  }

  /** list.txt を取得し、対応拡張子のファイルだけを相対パスの配列にして返す(空行・コメント行は無視)。 */
  async _fetchAnimationFileNames() {
    const res = await fetch(ANIMATION_LIST_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(tr("app.035", ANIMATION_LIST_URL));
    const names = (await res.text()).split(/\r?\n/)
      .map((s) => s.trim().replace(/\\/g, "/"))
      .filter((s) =>
        s && !s.startsWith("#") &&
        POSE_FILE_EXTENSIONS.includes(this._getExtension(s))
      );
    if (!names.length) throw new Error(tr("app.036"));
    return names;
  }

  /** list.txt 中の相対パス(サブディレクトリ可)を、取得用のURLにする。 */
  _resolveAnimationUrl(relativePath) {
    const encoded = relativePath.split("/").map((seg) =>
      encodeURIComponent(seg)
    ).join("/");
    return new URL(encoded, new URL(ANIMATION_LIST_URL, window.location.href))
      .href;
  }

  /**
   * ランダムに1本選んで読み込み、前のポーズから滑らかに繋いでから再生を開始する。
   * 読み込めないファイル(ボーンが対応しない GLB など)があっても止まらず、別のファイルを選び直す。
   */
  async _playNextRandomAnimation(model, failures = 0, forcedName = null) {
    if (!model.randomAnimationActive) return;
    // 新しく再生を始めるたびに番号を進める。手動切替などで途中から別の再生が始まったとき、
    // 古い方(読込中・トランジション中・再生終了待ち)が後から割り込まないようにするため。
    const token = model.randomPlayToken = (model.randomPlayToken ?? 0) + 1;
    model.transitionCancel?.();
    const names = this._animationFileNames;
    // 直前に再生したものと同じファイルが続かないようにする(候補が2つ以上ある場合)
    let name = forcedName;
    if (!name) {
      do {
        name = names[Math.floor(Math.random() * names.length)];
      } while (names.length > 1 && name === model.lastRandomAnimationName);
    }
    try {
      const res = await fetch(this._resolveAnimationUrl(name));
      if (!res.ok) throw new Error(tr("app.034", name));
      const blob = await res.blob();
      const file = new File([blob], name.split("/").pop());

      const clip = await this._buildClipFromFile(
        file,
        model.vrm,
        model.restHipsHeight,
      );
      if (!model.randomAnimationActive || model.randomPlayToken !== token) {
        return;
      }
      model.lastRandomAnimationName = name;
      this._syncAnimationSelect(model); // いま動かしているポーズを select で選択状態にする

      // 万一のズレが蓄積しないよう、次のアニメーションに移る前に一度姿勢をリセットしておく。
      // (トランジションで滑らかに繋ぐので、見た目が急に変わることはない)
      this._resetModelPose(model, { silent: true });

      await this._transitionToClip(model, clip);
      if (!model.randomAnimationActive || model.randomPlayToken !== token) {
        return;
      }

      const { mixer, action } = this._applyAnimationClip(model, clip);
      // 1本再生し終えたら止まって次に進めるよう、このアクションだけループさせない
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      const onFinished = (event) => {
        if (event.action !== action) return;
        mixer.removeEventListener("finished", onFinished);
        if (!model.randomAnimationActive || model.randomPlayToken !== token) {
          return;
        }
        this._playNextRandomAnimation(model);
      };
      mixer.addEventListener("finished", onFinished);
    } catch (err) {
      console.error(name + ": " + (err?.message ?? err));
      if (!model.randomAnimationActive || model.randomPlayToken !== token) {
        return;
      }
      if (forcedName) this._showToast(tr("app.037", name), "warning");
      if (failures + 1 < RANDOM_ANIMATION_MAX_CONSECUTIVE_FAILURES) {
        this._playNextRandomAnimation(model, failures + 1); // このファイルは飛ばして別のものを試す
        return;
      }
      this._showToast(err.message || tr("app.038"), "danger");
      this._stopRandomAnimationForModel(model);
    }
  }

  /**
   * 現在のポーズ(直前のアニメーションが終わった姿勢、または現在ポーズしている姿勢)から、
   * 次に再生するクリップの最初のフレームの姿勢まで、RANDOM_ANIMATION_TRANSITION_S 秒かけて
   * ボーンの回転・位置を直接補間して滑らかに繋ぐ。三.jsの AnimationMixer 同士のクロスフェード
   * は同じミキサー上のアクション同士でないと使えない(このアプリは読み込むたびに新しい
   * ミキサーを作る作りのため)ので、代わりに正規化ボーンの値を毎フレーム自前で
   * slerp/lerp して繋いでいる。
   * @returns {Promise<void>}
   */
  _transitionToClip(model, clip) {
    return new Promise((resolve) => {
      const vrm = model.vrm;
      const fromByUuid = new Map();
      for (const boneName of ALL_BONE_NAMES) {
        const node = vrm.humanoid.getNormalizedBoneNode(boneName);
        if (!node) continue;
        fromByUuid.set(node.uuid, {
          node,
          quat: node.quaternion.clone(),
          pos: node.position.clone(),
        });
      }

      // 次のクリップの最初のフレーム(t=0)の値を、対象ノードごとに集める
      const toByUuid = new Map();
      for (const track of clip.tracks) {
        const dot = track.name.lastIndexOf(".");
        const uuid = track.name.slice(0, dot);
        const propertyName = track.name.slice(dot + 1);
        const from = fromByUuid.get(uuid);
        if (!from) continue;
        let entry = toByUuid.get(uuid);
        if (!entry) {
          entry = {};
          toByUuid.set(uuid, entry);
        }
        if (propertyName === "quaternion") {
          entry.quat = new THREE.Quaternion().fromArray(track.values, 0);
        } else if (propertyName === "position") {
          entry.pos = new THREE.Vector3().fromArray(track.values, 0);
        }
      }

      // 直前のミキサーは、姿勢を保持したまま(=fromの値を取り終えた後に)止めてしまってよい。
      // ここから先はトランジションの間、ボーンの値を直接書き換えて制御する。
      if (model.animationMixer) {
        this._disposeMixer(model.animationMixer, model.vrm.scene);
        model.animationMixer = null;
        model.animationAction = null;
      }

      const duration = Math.max(RANDOM_ANIMATION_TRANSITION_S, 0);
      let elapsed = 0;
      const finish = () => {
        this._scene.unregisterAnimationMixer(tween);
        model.transitionCancel = null;
        resolve();
      };
      model.transitionCancel = finish; // 途中で別のポーズに切り替えられたら、ここで打ち切る
      const tween = {
        update: (delta) => {
          elapsed += delta;
          const t = duration > 0 ? Math.min(elapsed / duration, 1) : 1;
          const eased = t * t * (3 - 2 * t); // smoothstep: 急発進・急停止を避ける
          for (const [uuid, to] of toByUuid) {
            const from = fromByUuid.get(uuid);
            if (!from) continue;
            if (to.quat) {
              from.node.quaternion.copy(from.quat).slerp(to.quat, eased);
            }
            if (to.pos) from.node.position.copy(from.pos).lerp(to.pos, eased);
          }
          if (t >= 1) finish();
        },
      };
      this._scene.registerAnimationMixer(tween);
      if (duration <= 0) tween.update(0); // トランジション無しの場合は即座に確定させる
    });
  }

  /** ランダム再生ボタンの見た目を、渡されたモデル(通常は現在アクティブなモデル)の状態に合わせる。 */
  _updateRandomAnimationButton(model) {
    const active = !!model?.randomAnimationActive;
    this._btnRandomAnimation.innerHTML = active ? tr("app.039") : tr("app.040");
    this._btnRandomAnimation.classList.toggle("btn-info", active);
    this._btnRandomAnimation.classList.toggle("btn-outline-info", !active);
  }

  _removeModel(id) {
    const index = this._models.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [removed] = this._models.splice(index, 1);
    removed.randomAnimationActive = false; // ループしていれば自然に止まるようにする
    if (removed.animationMixer) {
      this._disposeMixer(removed.animationMixer, removed.vrm.scene);
    }
    this._scene.setVrms(this._models.map((item) => item.vrm));
    if (id === this._activeModelId) {
      const next = this._models[index] ?? this._models[index - 1];
      if (next) this._activateModel(next.id);
      else {
        this._activeModelId = null;
        this._vrm = null;
        this._vrmFile = null;
        this._vrmFilename = "";
        this._boneCtrl.setVrm(null);
        this._boneSphere.setVrm(null);
        this._ui.clearBoneSelection();
        this._materialPanel.setVrm(null);
        document.getElementById("bone-list-container").innerHTML = tr(
          "app.041",
        );
        document.getElementById("expression-controls").innerHTML = tr(
          "app.041",
        );
        this._activeModelName.textContent = tr("app.019");
        this._setButtonsEnabled(false);
        this._renderModelList();
      }
    } else this._renderModelList();
    this._showToast(tr("app.042", removed.name), "secondary");
  }

  _getFootGroundY() {
    const footNames = ["leftFoot", "rightFoot", "leftToes", "rightToes"];
    let ground = Infinity;
    for (const name of footNames) {
      const node = this._vrm.humanoid.getNormalizedBoneNode(name);
      if (!node) continue;
      const position = new THREE.Vector3();
      node.getWorldPosition(position);
      ground = Math.min(ground, position.y);
    }
    return Number.isFinite(ground)
      ? ground
      : new THREE.Box3().setFromObject(this._vrm.scene).min.y;
  }

  _applyPose(pose, expressions = {}) {
    const groundBefore = this._getFootGroundY();
    for (const [name, value] of Object.entries(pose)) {
      const bone = this._vrm.humanoid.getNormalizedBoneNode(name);
      if (!bone) continue;
      if (value.rotation) bone.quaternion.fromArray(value.rotation);
      if (value.position) bone.position.fromArray(value.position);
    }
    this._vrm.scene.updateMatrixWorld(true);
    const groundAfter = this._getFootGroundY();
    // 体格差で hips の平行移動量が異なっても、読込前と同じ接地高さを保つ。
    this._vrm.scene.position.y += groundBefore - groundAfter;
    this._vrm.scene.updateMatrixWorld(true);

    for (const [name, value] of Object.entries(expressions)) {
      this._vrm.expressionManager?.setValue(name, value);
    }
    this._ui.buildExpressionControls(this._getExpressionNames(this._vrm));
    const selected = this._boneCtrl.getSelectedBoneName();
    if (selected) {
      const bone = this._vrm.humanoid.getNormalizedBoneNode(selected);
      if (bone) this._ui.syncSlidersFromBone(selected, bone.quaternion);
    }
  }

  _applyLoadedProject(vrm, model, scene) {
    if (model.transform) {
      vrm.scene.position.fromArray(model.transform.position);
      vrm.scene.quaternion.fromArray(model.transform.quaternion);
      vrm.scene.scale.fromArray(model.transform.scale);
    }
    for (const [name, pose] of Object.entries(model.pose || {})) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      if (bone) {
        bone.quaternion.fromArray(pose.rotation);
        bone.position.fromArray(pose.position);
      }
    }
    for (const [name, value] of Object.entries(model.expressions || {})) {
      vrm.expressionManager?.setValue(name, value);
    }
    if (model.materials) applyMaterialsSnapshot(vrm, model.materials);
    const file = new File(
      [Exporter.dataUrlToArrayBuffer(model.data)],
      model.name,
    );
    this._models.push({
      id: "model-" + Date.now() + "-" + this._models.length,
      name: model.name,
      file,
      vrm,
      ...this._captureInitialPose(vrm),
    });
    if (scene?.background?.image) {
      this._scene.setBackgroundImage(scene.background.image);
    } else if (scene?.background?.color) {
      this._scene.setBackgroundColor(scene.background.color);
      this._applyThemeToScene();
    } // 既定色のままなら現在のテーマに合わせ、入力欄も同期する
    if (typeof scene?.gridVisible === "boolean") {
      this._scene.setGridVisible(scene.gridVisible);
    }
  }

  // =========================================================
  // ボーン操作コールバック
  // =========================================================

  /** ボーンリストからの選択 */
  _onBoneSelectFromList(boneName) {
    this._boneCtrl.selectBoneByName(boneName);
    this._ui.selectBone(boneName);
    this._boneSphere.show(boneName);
  }

  /** キャンバス上クリックからの選択 */
  _onBoneSelectFromCanvas(boneName) {
    this._ui.selectBone(boneName);
    this._boneSphere.show(boneName);
  }

  /** 球・モデルどちらにも当たらない場所をクリック → 選択解除 */
  _onDeselect() {
    this._ui.clearBoneSelection();
    this._boneSphere.hide();
  }

  /** ドラッグ/スライダーによるボーン変化 → スライダー同期 */
  _onBoneChange(boneName, quaternion) {
    this._ui.syncSlidersFromBone(boneName, quaternion);
  }

  /** 球の中心（起点）クリックによる操作対象トグル → トースト通知 */
  _onTargetModeToggle(mode, effectiveBoneName) {
    const label = BONE_LABELS[effectiveBoneName] ?? effectiveBoneName;
    if (mode === "parent") {
      this._showToast(
        tr("app.043", label),
        "info",
      );
    } else {
      this._showToast(tr("app.044"), "secondary");
    }
  }

  /** スライダー変化 → ボーンに適用 */
  _onSliderChange(boneName, axis, deg) {
    if (!this._vrm) return;
    const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    const euler = new THREE.Euler().setFromQuaternion(node.quaternion, "XYZ");
    euler[axis] = THREE.MathUtils.degToRad(deg);
    node.quaternion.setFromEuler(euler);
  }

  /** 個別ボーンのリセット（回転・位置とも初期状態に戻す） */
  _onBoneReset(boneName) {
    if (!this._vrm) return;
    const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    const initialQ = this._initialQuaternions.get(boneName);
    node.quaternion.copy(initialQ ?? new THREE.Quaternion());

    const initialP = this._initialPositions.get(boneName);
    if (initialP) node.position.copy(initialP);

    // スライダーを同期
    this._ui.syncSlidersFromBone(boneName, node.quaternion);
  }

  /** 特定の軸（X/Y/Z）だけを初期回転値にリセット */
  _onAxisReset(boneName, axis) {
    if (!this._vrm) return;
    const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;

    const initialQ = this._initialQuaternions.get(boneName) ??
      new THREE.Quaternion();
    const initialEuler = new THREE.Euler().setFromQuaternion(initialQ, "XYZ");
    const currentEuler = new THREE.Euler().setFromQuaternion(
      node.quaternion,
      "XYZ",
    );
    currentEuler[axis] = initialEuler[axis];
    node.quaternion.setFromEuler(currentEuler);

    this._ui.syncSlidersFromBone(boneName, node.quaternion);
  }

  // =========================================================
  // カメラビュー
  // =========================================================

  /**
   * 指定方向からキャラクターを見るようカメラを移動する
   * @param {'front'|'back'|'left'|'right'|'top'} view
   */
  _setCameraView(view) {
    const controls = this._scene.controls;
    const camera = this._scene.camera;
    const target = controls.target.clone(); // OrbitControls の注視点

    // 現在のカメラ距離を維持する
    const dist = camera.position.distanceTo(target);

    // ビューごとのカメラオフセット方向（ワールド空間）
    const offsets = {
      front: new THREE.Vector3(0, 0, 1), // キャラ前方 = -Z なので +Z が正面方向
      back: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(-1, 0, 0),
      top: new THREE.Vector3(0, 1, 0),
    };

    const offset = offsets[view];
    if (!offset) return;

    const newPos = target.clone().addScaledVector(offset, dist);
    camera.position.copy(newPos);

    // 真上から見る場合は up ベクトルを調整
    if (view === "top") {
      camera.up.set(0, 0, -1);
    } else {
      camera.up.set(0, 1, 0);
    }

    camera.lookAt(target);
    controls.update();
  }

  // =========================================================
  // ミラーリング
  // =========================================================

  /**
   * VRM から表情（Expression）名の一覧を取得する。
   * three-vrm のバージョンによってAPIの形が異なるため、複数の方法を試す。
   */
  /**
   * VRM から表情（Expression）名の一覧を取得する。
   * three-vrm のバージョンによってAPIの形が異なるため、複数の方法を試す。
   * 'neutral'（無表情）は「すべての表情を0にした状態」と同じで、
   * リセットボタンで代用できるため一覧からは除外する。
   */
  _getExpressionNames(vrm) {
    const em = vrm?.expressionManager;
    if (!em) return [];

    let names;
    if (em.expressionMap) {
      names = Object.keys(em.expressionMap);
    } else {
      const set = new Set();
      if (em.presetExpressionMap) {
        for (const key of Object.keys(em.presetExpressionMap)) set.add(key);
      }
      if (em.customExpressionMap) {
        for (const key of Object.keys(em.customExpressionMap)) set.add(key);
      }
      names = [...set];
    }

    return names.filter((name) => name.toLowerCase() !== "neutral");
  }

  /** 表情スライダーの変更を VRM に反映する */
  _onExpressionChange(name, weight) {
    if (!this._vrm?.expressionManager) return;
    this._vrm.expressionManager.setValue(name, weight);
  }

  /** すべての表情を 0 に戻す */
  _resetExpressions() {
    if (!this._vrm?.expressionManager) return;
    for (const name of this._getExpressionNames(this._vrm)) {
      this._vrm.expressionManager.setValue(name, 0);
    }
    this._ui.resetExpressionSliders();
    this._showToast(tr("app.045"), "secondary");
  }

  /**
   * 現在選択中のボーン（と、その子孫すべて）を、左右反対側へミラーする。
   * 例: 「左上腕」を選択して実行すると、左腕全体（上腕〜手〜指）の
   * ポーズが右腕にコピーされる。左右の対がないボーン（体幹など）を
   * 選択している場合は何もしない。
   */
  _mirrorSelectedPart() {
    if (!this._vrm) return;
    const selected = this._boneCtrl.getSelectedBoneName();
    if (!selected) return;

    const mirrorRoot = getMirrorBoneName(selected);
    if (!mirrorRoot) {
      this._showToast(tr("app.046"), "secondary");
      return;
    }

    const humanoid = this._vrm.humanoid;
    const boneNames = getDescendantBoneNames(selected);
    let count = 0;

    for (const srcName of boneNames) {
      const dstName = getMirrorBoneName(srcName);
      if (!dstName) continue; // 体幹など左右のないボーンは対象外
      const srcNode = humanoid.getNormalizedBoneNode(srcName);
      const dstNode = humanoid.getNormalizedBoneNode(dstName);
      if (!srcNode || !dstNode) continue;

      // VRM 正規化ボーンのローカル空間でのミラーリング:
      // X軸が左右方向なので、YZ成分を反転（X軸を鏡面とした鏡像）
      // q_mirror = (qx, -qy, -qz, qw)
      const q = srcNode.quaternion;
      dstNode.quaternion.set(q.x, -q.y, -q.z, q.w).normalize();
      count++;
    }

    const srcLabel = BONE_LABELS[selected] ?? selected;
    const dstLabel = BONE_LABELS[mirrorRoot] ?? mirrorRoot;
    this._showToast(tr("app.047", srcLabel, dstLabel), "primary");
  }

  // =========================================================
  // ポーズリセット
  // =========================================================

  _saveInitialPose() {
    this._initialQuaternions.clear();
    this._initialPositions.clear();
    if (!this._vrm) return;

    for (const boneName of ALL_BONE_NAMES) {
      const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
      if (node) {
        this._initialQuaternions.set(boneName, node.quaternion.clone());
        this._initialPositions.set(boneName, node.position.clone());
      }
    }
  }

  _resetPose() {
    if (!this._vrm) return;
    const model = this._models.find((item) => item.id === this._activeModelId);
    if (model) this._resetModelPose(model);
  }

  /**
   * 指定モデルの全ボーンを、そのモデル読込時に記録した姿勢(initialQuaternions/initialPositions)に戻す。
   * @param {{ silent?: boolean }} [options] silent: true ならトースト通知を出さない
   *   (ランダム再生が次のアニメーションへ移る前の内部的なリセットで使う)
   */
  _resetModelPose(model, { silent = false } = {}) {
    for (const [boneName, q] of model.initialQuaternions) {
      const node = model.vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!node) continue;
      node.quaternion.copy(q);
      const p = model.initialPositions.get(boneName);
      if (p) node.position.copy(p);
    }

    if (model.id !== this._activeModelId) return;
    // アクティブなモデルの場合は、スライダーも同期
    const selected = this._boneCtrl.getSelectedBoneName();
    if (selected) {
      const node = model.vrm.humanoid.getNormalizedBoneNode(selected);
      if (node) this._ui.syncSlidersFromBone(selected, node.quaternion);
    }

    if (!silent) this._showToast(tr("app.048"), "secondary");
  }

  // =========================================================
  // キーボードショートカット
  // =========================================================

  _onKeyDown(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    switch (e.key.toLowerCase()) {
      case "f":
        this._setCameraView("front");
        break;
      case "b":
        this._setCameraView("back");
        break;
      case "r":
        this._setCameraView("right");
        break;
      case "l":
        this._setCameraView("left");
        break;
      case "t":
        this._setCameraView("top");
        break;
    }
  }

  // =========================================================
  // UI ヘルパー
  // =========================================================

  _showLoading(show) {
    this._loadingOverlay.classList.toggle("d-none", !show);
  }

  _setButtonsEnabled(enabled) {
    [
      this._btnLoadPose,
      this._btnToggleAnimation,
      this._btnRandomAnimation,
      this._btnSaveVrma,
      this._btnCopyPose,
      this._btnPastePose,
      this._btnSaveProject,
      this._btnScreenshot,
      this._btnResetPose,
    ].forEach((btn) => {
      btn.disabled = !enabled;
    });
    this._modelButtonsEnabled = enabled;
    this._updateAnimationSelectState();
  }

  _showToast(message, type = "secondary") {
    // Bootstrap toast を動的生成
    const container = this._getToastContainer();

    const toastEl = document.createElement("div");
    toastEl.className =
      `toast align-items-center text-bg-${type} border-0 mb-2`;
    toastEl.setAttribute("role", "alert");
    toastEl.setAttribute("aria-live", "assertive");
    toastEl.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    `;

    // 連続操作で通知が積み重なって邪魔にならないよう、表示は最新の3件までにする
    while (container.children.length >= 3) container.firstElementChild.remove();
    container.appendChild(toastEl);

    const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();

    toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
  }

  _getToastContainer() {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.className = "toast-container position-fixed bottom-0 end-0 p-3";
      container.style.zIndex = "9999";
      document.body.appendChild(container);
    }
    return container;
  }
}

// アプリ起動
window.addEventListener("DOMContentLoaded", () => {
  new App();
});
