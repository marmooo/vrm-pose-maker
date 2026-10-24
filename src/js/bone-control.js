/**
 * bone-control.js - ボーン選択・球面操作
 *
 * PC（マウス）:
 *   左ドラッグ（球外）        : カメラ回転
 *   右ドラッグ（球外）        : カメラパン
 *   左クリック（モデル）      : ボーン選択
 *   左押しっぱなし（球内）    : ボーン回転
 *   右ドラッグ（球内）        : ボーン位置移動
 *   右クリック・離す（球内）  : 親ボーンに切り替え（＝選択自体を切り替える）
 *   左クリック（中心の黄色い起点）: 操作対象トグル（自分 ⇄ 親ボーン）
 *
 * タブレット（タッチ）:
 *   1本指ドラッグ（球外）     : カメラ回転
 *   2本指ドラッグ（球外）     : カメラパン
 *   1本指タップ（モデル）     : ボーン選択
 *   1本指押しっぱなし（球内） : ボーン回転
 *   長押し（球内）            : 親ボーンに切り替え（＝選択自体を切り替える）
 *   2本指ドラッグ（球内）     : ボーン位置移動
 *   1本指タップ（中心の黄色い起点）: 操作対象トグル（自分 ⇄ 親ボーン）
 *
 * 他のアバター（現在選択中ではないモデル）の長押し（マウス・タッチ共通）:
 *   そのアバターを選択する（動かさずに一定時間押し続けたとき）。
 *   押したままドラッグすれば、そのまま選択したアバターの位置移動に移る
 *
 * 「親ボーンに切り替え」（右クリック/長押し）と「操作対象トグル」（起点クリック）は別機能:
 *   - 前者は選択ボーン自体を親ボーンに変更する（球の位置も移動する）
 *   - 後者は選択・球の位置は変えず、ドラッグ操作が実際にどのボーンに
 *     適用されるか（選択ボーン自身 or その親）だけを切り替える
 *
 * 球・モデルどちらにも当たらない場所での左クリック/タップ:
 *   ドラッグせず手を離した（＝クリック） → 選択解除
 *   ドラッグした場合（＝カメラ回転）     → 解除しない（回転しながら見られる）
 */
import * as THREE from "three";
import {
  CHILD_MAP,
  getParentBoneName,
  SELECTABLE_BONE_NAMES,
} from "./bone-hierarchy.js";

// 右クリックが「ドラッグ」と判定するしきい値（px）
const DRAG_THRESHOLD = 5;
// 長押し判定時間（ms）
const LONG_PRESS_MS = 500;

export class BoneController {
  constructor(canvas, sceneManager, callbacks) {
    this._canvas = canvas;
    this._scene = sceneManager;
    this._callbacks = callbacks;

    this._vrm = null;
    this._selectedBoneName = null;
    this._selectedBoneNode = null;

    // ライト位置編集モード(light-gizmo.js)がONの間はボーン操作と競合しない
    // よう、このフラグで入力を無視する(app.js から配線)。
    this._enabled = true;

    // 操作モード: null | 'rotate' | 'translate'
    this._trackingMode = null;

    // 右クリックのドラッグ判定
    this._rightDownPos = null; // { x, y } mousedown時の座標
    this._rightDragged = false; // ドラッグしたかどうか

    // 球/モデルの外側での左クリック → 選択解除の判定
    // （手を離すまで解除しない。ドラッグ＝カメラ回転なら解除しない）
    this._leftDeselectDownPos = null;
    this._leftDeselectDragged = false;

    // モデル上のドラッグ＝現在のモデルの位置移動（クリックなら従来通りボーン選択）
    this._modelPendingBone = null;
    this._modelDownPos = null;

    // 位置移動用
    this._lastClientX = 0;
    this._lastClientY = 0;

    // オブジェクト(GLB/FBX の小物)上の操作: クリック＝選択、ドラッグ＝移動
    this._objectId = null;

    // 他のアバターの長押し（そのアバターを選択）
    this._modelPickTimer = null;
    this._modelPickPos = null;

    // 長押しタイマー
    this._longPressTimer = null;
    this._longPressTriggered = false;

    // タッチ: 2本指追跡
    this._touch2LastX = 0;
    this._touch2LastY = 0;

    // ギズモドラッグ用の状態
    this._gizmoAxisKey = null;
    this._gizmoLastAngle = 0;
    this._gizmoFacingSign = 1;

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._boneSphere = null;

    this._bindEvents();
  }

  setBoneSphere(boneSphere) {
    this._boneSphere = boneSphere;
  }

  /**
   * ボーン操作の入力を一時的に無効化/再有効化する。
   * ライト位置編集モード(light-gizmo.js)がONの間、キャンバス上のドラッグが
   * ボーン選択・回転と競合しないようにするために使う。
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!this._enabled) {
      // 進行中の操作を安全に打ち切る
      this._trackingMode = null;
      this._modelPendingBone = null;
      this._modelDownPos = null;
      this._leftDeselectDownPos = null;
      this._leftDeselectDragged = false;
      this._rightDownPos = null;
      this._rightDragged = false;
      this._clearLongPressTimer();
      this._clearModelPick();
      this._scene.controls.enabled = true;
      this._canvas.classList.remove("dragging-bone");
      this._boneSphere?.setDragging(false);
      this._boneSphere?.endGizmoRotate();
    }
  }

  setVrm(vrm) {
    this._vrm = vrm;
    this._selectedBoneName = null;
    this._selectedBoneNode = null;
    this._trackingMode = null;
  }

  getSelectedBoneName() {
    return this._selectedBoneName;
  }

  selectBoneByName(boneName) {
    if (!this._vrm) return;
    const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;
    this._selectedBoneName = boneName;
    this._selectedBoneNode = node;
  }

  clearSelection() {
    this._selectedBoneName = null;
    this._selectedBoneNode = null;
    this._trackingMode = null;
  }

  // =========================================================
  // イベントバインド
  // =========================================================

  _bindEvents() {
    const c = this._canvas;
    c.addEventListener("mousedown", (e) => this._onMouseDown(e));
    window.addEventListener("mousemove", (e) => this._onMouseMove(e));
    window.addEventListener("mouseup", (e) => this._onMouseUp(e));
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    // タッチ
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

  // =========================================================
  // マウスイベント
  // =========================================================

  _onMouseDown(e) {
    if (!this._enabled) return;
    if (!this._vrm) return;
    if (e.button !== 0 && e.button !== 2) return;

    const ndc = this._getPointerNDC(e.clientX, e.clientY);
    this._pointer.copy(ndc);
    this._raycaster.setFromCamera(this._pointer, this._scene.camera);

    if (this._boneSphere && this._selectedBoneNode) {
      // 中心の起点（黄色い点）をクリック → 操作対象トグル（自分 ⇄ 親ボーン）。
      // 球面/ギズモのドラッグとは独立した判定なので競合しない。
      if (
        e.button === 0 &&
        this._boneSphere.isDotHit(this._pointer, this._scene.camera)
      ) {
        const toggled = this._boneSphere.toggleTargetMode();
        if (toggled) {
          this._callbacks.onTargetModeToggle?.(
            this._boneSphere.getTargetMode(),
            this._boneSphere.getEffectiveBoneName(),
          );
        }
        return;
      }

      if (this._boneSphere.getManipulationMode() === "gizmo") {
        if (e.button === 0) {
          const axis = this._boneSphere.hitTestGizmoRing(
            this._pointer,
            this._scene.camera,
          );
          if (axis) {
            this._boneSphere.beginGizmoRotate(axis);
            this._gizmoAxisKey = axis;
            this._gizmoFacingSign = this._computeGizmoFacingSign(axis);
            this._gizmoLastAngle = this._gizmoScreenAngle(e.clientX, e.clientY);
            this._trackingMode = "gizmo-rotate";
            this._scene.controls.enabled = false;
            this._canvas.classList.add("dragging-bone");
            this._lastClientX = e.clientX;
            this._lastClientY = e.clientY;
            return;
          }
          // どのリングにも当たらなければ、球外クリックと同じ扱いへフォールスルー
        } else {
          // 右ボタン: 不可視の当たり判定球で従来通り判定
          const sphereHit = this._boneSphere.isSphereHit(
            this._pointer,
            this._scene.camera,
          );
          if (sphereHit) {
            this._rightDownPos = { x: e.clientX, y: e.clientY };
            this._rightDragged = false;
            this._trackingMode = "right-pending";
            this._scene.controls.enabled = false;
            this._canvas.classList.add("dragging-bone");
            this._lastClientX = e.clientX;
            this._lastClientY = e.clientY;
            return;
          }
        }
      } else {
        // 球モード（従来通り）
        const sphereHit = this._boneSphere.isSphereHit(
          this._pointer,
          this._scene.camera,
        );

        if (sphereHit) {
          if (e.button === 0) {
            // 左ボタン: 回転追従開始（新しいドラッグなので連続性の基準をリセット）
            this._boneSphere.resetDragReference();
            this._boneSphere.handleClick(this._pointer, this._scene.camera);
            this._trackingMode = "rotate";
            this._scene.controls.enabled = false;
            this._canvas.classList.add("dragging-bone");
            this._boneSphere.setDragging(true);
          } else {
            // 右ボタン: ドラッグか単クリックか後で判定
            this._rightDownPos = { x: e.clientX, y: e.clientY };
            this._rightDragged = false;
            this._trackingMode = "right-pending";
            this._scene.controls.enabled = false;
            this._canvas.classList.add("dragging-bone");
          }
          this._lastClientX = e.clientX;
          this._lastClientY = e.clientY;
          return;
        }
      }
    }

    // 球外の左クリック: モデルに当たればボーン選択、何もなければ選択解除候補として保留
    // （実際に解除するのはドラッグせずに手を離した時。カメラ回転のドラッグ中は解除しない）
    if (e.button === 0) {
      this._startModelPick(e.clientX, e.clientY);
      const hits = this._raycaster.intersectObjects(
        this._getSkinMeshes(),
        true,
      );
      // アバターより手前にオブジェクトがあれば、そちらを操作する
      const objectHit = this._callbacks.pickObject?.(this._raycaster);
      if (
        objectHit && (!hits.length || objectHit.distance < hits[0].distance)
      ) {
        this._clearModelPick();
        this._objectId = objectHit.id;
        this._trackingMode = "object-pending";
        this._modelDownPos = { x: e.clientX, y: e.clientY };
        this._scene.controls.enabled = false;
        this._lastClientX = e.clientX;
        this._lastClientY = e.clientY;
        return;
      }
      if (hits.length > 0) {
        const boneName = this._findNearestBoneFromIntersection(hits[0]);
        if (boneName) {
          // 部位の選択有無に関わらず、押しただけでは選択せず、ドラッグなら現在のモデルの移動、クリックならボーン選択にする。
          this._trackingMode = "model-pending";
          this._modelPendingBone = boneName;
          this._modelDownPos = { x: e.clientX, y: e.clientY };
          this._scene.controls.enabled = false;
          this._lastClientX = e.clientX;
          this._lastClientY = e.clientY;
          return;
        }
        if (boneName) {
          this._selectBone(boneName);
          return;
        }
      }
      // モデルにもボーン球にも当たらなかった＝完全に外側をクリック
      if (this._selectedBoneName || this._callbacks.hasObjectSelection?.()) {
        this._leftDeselectDownPos = { x: e.clientX, y: e.clientY };
        this._leftDeselectDragged = false;
      }
    }
  }

  _onMouseMove(e) {
    this._cancelModelPickIfMoved(e.clientX, e.clientY);

    // 選択解除の保留中: カメラ回転のためにドラッグしたかどうかを判定
    // （動いたらドラッグ＝カメラ回転とみなし、mouseupでも解除しない）
    if (this._leftDeselectDownPos && !this._leftDeselectDragged) {
      const ddx = e.clientX - this._leftDeselectDownPos.x;
      const ddy = e.clientY - this._leftDeselectDownPos.y;
      if (Math.hypot(ddx, ddy) > DRAG_THRESHOLD) {
        this._leftDeselectDragged = true;
      }
    }

    if (!this._trackingMode) return;

    if (this._trackingMode === "model-pending") {
      const dx = e.clientX - this._modelDownPos.x,
        dy = e.clientY - this._modelDownPos.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this._trackingMode = "model-translate";
        this._scene.controls.enabled = false;
        this._canvas.classList.add("dragging-bone");
      }
    } else if (this._trackingMode === "model-translate") {
      this._translateModel(
        e.clientX - this._lastClientX,
        e.clientY - this._lastClientY,
      );
    } else if (this._trackingMode === "object-pending") {
      const dx = e.clientX - this._modelDownPos.x,
        dy = e.clientY - this._modelDownPos.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this._trackingMode = "object-translate";
        this._callbacks.onObjectSelect?.(this._objectId);
        this._canvas.classList.add("dragging-bone");
      }
    } else if (this._trackingMode === "object-translate") {
      this._callbacks.onObjectDrag?.(
        this._objectId,
        e.clientX - this._lastClientX,
        e.clientY - this._lastClientY,
      );
    } else if (this._trackingMode === "rotate") {
      const ndc = this._getPointerNDC(e.clientX, e.clientY);
      this._boneSphere?.handleClick(ndc, this._scene.camera);
    } else if (this._trackingMode === "gizmo-rotate") {
      const angle = this._gizmoScreenAngle(e.clientX, e.clientY);
      let delta = angle - this._gizmoLastAngle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this._boneSphere?.applyGizmoRotationDelta(delta * this._gizmoFacingSign);
      this._gizmoLastAngle = angle;
    } else if (this._trackingMode === "right-pending") {
      // 右ボタン: 動いたらドラッグ（位置移動）に確定
      const dx = e.clientX - this._rightDownPos.x;
      const dy = e.clientY - this._rightDownPos.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        this._rightDragged = true;
        this._trackingMode = "translate";
        this._boneSphere.setDragging(true);
      }
    } else if (this._trackingMode === "translate") {
      const dx = e.clientX - this._lastClientX;
      const dy = e.clientY - this._lastClientY;
      this._boneSphere?.handleTranslate(dx, dy, this._scene.camera);
    }

    this._lastClientX = e.clientX;
    this._lastClientY = e.clientY;
  }

  _onMouseUp(e) {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0) this._clearModelPick();

    if (
      e.button === 0 && this._leftDeselectDownPos && !this._leftDeselectDragged
    ) {
      // ドラッグせずに手を離した＝カメラ回転ではなくクリック → 選択解除
      this._deselectBone();
    }
    this._leftDeselectDownPos = null;
    this._leftDeselectDragged = false;

    if (e.button === 0 && this._trackingMode === "object-pending") {
      const id = this._objectId;
      this._trackingMode = null;
      this._objectId = null;
      this._modelDownPos = null;
      this._scene.controls.enabled = true;
      this._callbacks.onObjectSelect?.(id);
      return;
    }

    if (e.button === 0 && this._trackingMode === "model-pending") {
      const boneName = this._modelPendingBone;
      this._trackingMode = null;
      this._scene.controls.enabled = true;
      this._modelPendingBone = null;
      this._modelDownPos = null;
      if (boneName) this._selectBone(boneName);
      return;
    }

    if (
      e.button === 2 && this._trackingMode === "right-pending" &&
      !this._rightDragged
    ) {
      // 右クリック（移動なし）→ 親ボーン切り替え
      this._selectParentBone();
    }

    if (this._trackingMode) {
      this._trackingMode = null;
      this._scene.controls.enabled = true;
      this._canvas.classList.remove("dragging-bone");
      this._boneSphere?.setDragging(false);
      this._boneSphere?.endGizmoRotate();
      this._gizmoAxisKey = null;
      this._syncEffectiveBoneChange();
    }

    this._rightDownPos = null;
    this._rightDragged = false;
  }

  // =========================================================
  // タッチイベント
  // =========================================================

  _onTouchStart(e) {
    if (!this._enabled) return;
    if (!this._vrm) return;

    if (e.touches.length === 1) {
      const t = e.touches[0];
      const ndc = this._getPointerNDC(t.clientX, t.clientY);
      this._pointer.copy(ndc);
      this._raycaster.setFromCamera(this._pointer, this._scene.camera);

      if (this._boneSphere && this._selectedBoneNode) {
        // 中心の起点（黄色い点）をタップ → 操作対象トグル（自分 ⇄ 親ボーン）
        if (this._boneSphere.isDotHit(ndc, this._scene.camera)) {
          e.preventDefault();
          const toggled = this._boneSphere.toggleTargetMode();
          if (toggled) {
            this._callbacks.onTargetModeToggle?.(
              this._boneSphere.getTargetMode(),
              this._boneSphere.getEffectiveBoneName(),
            );
          }
          return;
        }

        const sphereHit = this._boneSphere.isSphereHit(
          this._pointer,
          this._scene.camera,
        );

        if (this._boneSphere.getManipulationMode() === "gizmo") {
          const axis = this._boneSphere.hitTestGizmoRing(
            this._pointer,
            this._scene.camera,
          );
          if (axis) {
            e.preventDefault();
            // 長押しタイマー開始（親ボーン切り替え。リング上でも従来通り使える）
            this._longPressTriggered = false;
            this._longPressTimer = setTimeout(() => {
              this._longPressTriggered = true;
              this._selectParentBone();
            }, LONG_PRESS_MS);

            this._boneSphere.beginGizmoRotate(axis);
            this._gizmoAxisKey = axis;
            this._gizmoFacingSign = this._computeGizmoFacingSign(axis);
            this._gizmoLastAngle = this._gizmoScreenAngle(t.clientX, t.clientY);
            this._trackingMode = "gizmo-rotate";
            this._scene.controls.enabled = false;
            this._canvas.classList.add("dragging-bone");
            this._lastClientX = t.clientX;
            this._lastClientY = t.clientY;
            return;
          }
          // どのリングにも当たらなければ球外タップと同じ扱いへフォールスルー
        } else if (sphereHit) {
          e.preventDefault();
          // 長押しタイマー開始（親ボーン切り替え）
          this._longPressTriggered = false;
          this._longPressTimer = setTimeout(() => {
            this._longPressTriggered = true;
            this._selectParentBone();
          }, LONG_PRESS_MS);

          // 1本指: 回転追従（新しいドラッグなので連続性の基準をリセット）
          this._boneSphere.resetDragReference();
          this._boneSphere.handleClick(ndc, this._scene.camera);
          this._trackingMode = "rotate";
          this._scene.controls.enabled = false;
          this._canvas.classList.add("dragging-bone");
          this._boneSphere.setDragging(true);
          this._lastClientX = t.clientX;
          this._lastClientY = t.clientY;
          return;
        }
      }

      // 球外: モデルタップでボーン選択、何もなければ選択解除候補として保留
      // （実際に解除するのはドラッグせずに指を離した時。カメラ回転中は解除しない）
      this._startModelPick(t.clientX, t.clientY);
      const hits = this._raycaster.intersectObjects(
        this._getSkinMeshes(),
        true,
      );
      const objectHit = this._callbacks.pickObject?.(this._raycaster);
      if (
        objectHit && (!hits.length || objectHit.distance < hits[0].distance)
      ) {
        e.preventDefault();
        this._clearModelPick();
        this._objectId = objectHit.id;
        this._trackingMode = "object-pending";
        this._modelDownPos = { x: t.clientX, y: t.clientY };
        this._scene.controls.enabled = false;
        this._lastClientX = t.clientX;
        this._lastClientY = t.clientY;
        return;
      }
      if (hits.length > 0) {
        const boneName = this._findNearestBoneFromIntersection(hits[0]);
        if (boneName) {
          e.preventDefault();
          this._trackingMode = "model-pending";
          this._modelPendingBone = boneName;
          this._modelDownPos = { x: t.clientX, y: t.clientY };
          this._scene.controls.enabled = false;
          this._lastClientX = t.clientX;
          this._lastClientY = t.clientY;
          return;
        }
        if (boneName) this._selectBone(boneName);
      } else if (
        this._selectedBoneName || this._callbacks.hasObjectSelection?.()
      ) {
        this._leftDeselectDownPos = { x: t.clientX, y: t.clientY };
        this._leftDeselectDragged = false;
      }
    } else if (e.touches.length === 2) {
      // 2本指
      this._clearLongPressTimer();
      this._clearModelPick();

      if (this._boneSphere && this._selectedBoneNode) {
        // どちらかのタッチが球内なら位置移動モード
        const t0 = e.touches[0];
        const ndc0 = this._getPointerNDC(t0.clientX, t0.clientY);
        this._raycaster.setFromCamera(ndc0, this._scene.camera);
        const inSphere = this._boneSphere.isSphereHit(ndc0, this._scene.camera);

        if (inSphere) {
          e.preventDefault();
          this._trackingMode = "translate";
          this._scene.controls.enabled = false;
          this._boneSphere.setDragging(true);
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          this._touch2LastX = midX;
          this._touch2LastY = midY;
          this._lastClientX = midX;
          this._lastClientY = midY;
        }
      }
    }
  }

  _onTouchMove(e) {
    if (e.touches.length >= 1) {
      this._cancelModelPickIfMoved(e.touches[0].clientX, e.touches[0].clientY);
    }

    // 選択解除の保留中: ドラッグ（カメラ回転）したかどうかを判定
    if (
      this._leftDeselectDownPos && !this._leftDeselectDragged &&
      e.touches.length >= 1
    ) {
      const t = e.touches[0];
      const ddx = t.clientX - this._leftDeselectDownPos.x;
      const ddy = t.clientY - this._leftDeselectDownPos.y;
      if (Math.hypot(ddx, ddy) > DRAG_THRESHOLD) {
        this._leftDeselectDragged = true;
      }
    }

    if (!this._trackingMode) return;
    e.preventDefault();
    this._clearLongPressTimer();

    if (this._trackingMode === "object-pending" && e.touches.length === 1) {
      const t = e.touches[0];
      if (
        Math.hypot(
          t.clientX - this._modelDownPos.x,
          t.clientY - this._modelDownPos.y,
        ) > DRAG_THRESHOLD
      ) {
        this._trackingMode = "object-translate";
        this._callbacks.onObjectSelect?.(this._objectId);
        this._canvas.classList.add("dragging-bone");
      }
      this._lastClientX = t.clientX;
      this._lastClientY = t.clientY;
    } else if (
      this._trackingMode === "object-translate" && e.touches.length === 1
    ) {
      const t = e.touches[0];
      this._callbacks.onObjectDrag?.(
        this._objectId,
        t.clientX - this._lastClientX,
        t.clientY - this._lastClientY,
      );
      this._lastClientX = t.clientX;
      this._lastClientY = t.clientY;
    } else if (
      this._trackingMode === "model-pending" && e.touches.length === 1
    ) {
      const t = e.touches[0];
      if (
        Math.hypot(
          t.clientX - this._modelDownPos.x,
          t.clientY - this._modelDownPos.y,
        ) > DRAG_THRESHOLD
      ) {
        this._trackingMode = "model-translate";
        this._canvas.classList.add("dragging-bone");
      }
      this._lastClientX = t.clientX;
      this._lastClientY = t.clientY;
    } else if (
      this._trackingMode === "model-translate" && e.touches.length === 1
    ) {
      const t = e.touches[0];
      this._translateModel(
        t.clientX - this._lastClientX,
        t.clientY - this._lastClientY,
      );
      this._lastClientX = t.clientX;
      this._lastClientY = t.clientY;
    } else if (this._trackingMode === "rotate" && e.touches.length === 1) {
      const t = e.touches[0];
      const ndc = this._getPointerNDC(t.clientX, t.clientY);
      this._boneSphere?.handleClick(ndc, this._scene.camera);
      this._lastClientX = t.clientX;
      this._lastClientY = t.clientY;
    } else if (
      this._trackingMode === "gizmo-rotate" && e.touches.length === 1
    ) {
      const t = e.touches[0];
      const angle = this._gizmoScreenAngle(t.clientX, t.clientY);
      let delta = angle - this._gizmoLastAngle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this._boneSphere?.applyGizmoRotationDelta(delta * this._gizmoFacingSign);
      this._gizmoLastAngle = angle;
      this._lastClientX = t.clientX;
      this._lastClientY = t.clientY;
    } else if (this._trackingMode === "translate" && e.touches.length >= 2) {
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = midX - this._lastClientX;
      const dy = midY - this._lastClientY;
      this._boneSphere?.handleTranslate(dx, dy, this._scene.camera);
      this._lastClientX = midX;
      this._lastClientY = midY;
    }
  }

  _onTouchEnd(e) {
    this._clearLongPressTimer();
    this._clearModelPick();

    if (this._leftDeselectDownPos && !this._leftDeselectDragged) {
      // ドラッグせずに指を離した＝カメラ回転ではなくタップ → 選択解除
      this._deselectBone();
    }
    this._leftDeselectDownPos = null;
    this._leftDeselectDragged = false;

    if (!this._trackingMode) return;

    if (this._trackingMode === "object-pending" && e.touches.length === 0) {
      const id = this._objectId;
      this._trackingMode = null;
      this._objectId = null;
      this._modelDownPos = null;
      this._scene.controls.enabled = true;
      this._callbacks.onObjectSelect?.(id);
      return;
    }

    if (this._trackingMode === "model-pending" && e.touches.length === 0) {
      const boneName = this._modelPendingBone;
      this._trackingMode = null;
      this._scene.controls.enabled = true;
      this._modelPendingBone = null;
      this._modelDownPos = null;
      if (boneName) this._selectBone(boneName);
      return;
    }

    // タッチが残っていない or 1本指になったら終了
    if (
      e.touches.length === 0 ||
      ((this._trackingMode === "translate" && e.touches.length < 2) ||
        ((this._trackingMode === "model-translate" ||
          this._trackingMode === "object-translate") &&
          e.touches.length === 0))
    ) {
      this._trackingMode = null;
      this._scene.controls.enabled = true;
      this._canvas.classList.remove("dragging-bone");
      this._boneSphere?.setDragging(false);
      this._boneSphere?.endGizmoRotate();
      this._gizmoAxisKey = null;
      this._syncEffectiveBoneChange();
    }
  }

  /** モデル上をドラッグした時の、現在のモデルの画面平面に沿った位置移動。 */
  _translateModel(dx, dy) {
    if (!this._vrm) return;
    const rect = this._canvas.getBoundingClientRect();
    const distance = this._scene.camera.position.distanceTo(
      this._scene.controls.target,
    );
    const unitsPerPixel = 2 *
      Math.tan(THREE.MathUtils.degToRad(this._scene.camera.fov / 2)) *
      distance / rect.height;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
      this._scene.camera.quaternion,
    );
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
      this._scene.camera.quaternion,
    );
    this._vrm.scene.position.addScaledVector(right, dx * unitsPerPixel);
    this._vrm.scene.position.addScaledVector(up, -dy * unitsPerPixel);
  }

  /**
   * ギズモドラッグ用: 選択中ボーンのスクリーン座標を中心とした、
   * マウス位置の角度（ラジアン）を返す。
   */
  _gizmoScreenAngle(clientX, clientY) {
    if (!this._selectedBoneNode) return 0;
    const originWorld = new THREE.Vector3();
    this._selectedBoneNode.getWorldPosition(originWorld);
    const projected = originWorld.clone().project(this._scene.camera);
    const rect = this._canvas.getBoundingClientRect();
    const originX = (projected.x * 0.5 + 0.5) * rect.width + rect.left;
    const originY = (-projected.y * 0.5 + 0.5) * rect.height + rect.top;
    return Math.atan2(clientY - originY, clientX - originX);
  }

  /**
   * リングがカメラ側を向いているか奥を向いているかで、画面上の
   * ドラッグ角度と実際の回転方向の対応が逆になる。ドラッグ開始時に
   * 一度だけ判定する（ドラッグ中はカメラ操作を無効化しているため
   * カメラは動かない＝毎フレーム再計算する必要はない）。
   */
  _computeGizmoFacingSign(axisKey) {
    if (!this._boneSphere || !this._selectedBoneNode) return 1;
    const worldAxis = this._boneSphere.getGizmoWorldAxis(axisKey);
    const originWorld = new THREE.Vector3();
    this._selectedBoneNode.getWorldPosition(originWorld);
    const camToOrigin = new THREE.Vector3()
      .subVectors(this._scene.camera.position, originWorld).normalize();
    return worldAxis.dot(camToOrigin) >= 0 ? 1 : -1;
  }

  // =========================================================
  // 他のアバターの長押し → そのアバターを選択
  // =========================================================

  /**
   * 押した位置に「現在選択中ではないアバター」が（選択中のアバターより手前に）あれば、
   * 長押し判定を開始する。動かさずに LONG_PRESS_MS 経過したらコールバックで通知する。
   */
  _startModelPick(clientX, clientY) {
    this._clearModelPick();
    if (!this._callbacks.onModelLongPress) return;
    const others = this._callbacks.getOtherVrms?.() ?? [];
    if (!others.length) return;

    const meshesOf = (vrm) => {
      const meshes = [];
      vrm.scene.traverse((obj) => {
        if (obj.isSkinnedMesh) meshes.push(obj);
      });
      return meshes;
    };
    const activeHit = this._raycaster.intersectObjects(
      this._getSkinMeshes(),
      true,
    )[0];
    let nearest = null;
    for (const vrm of others) {
      const hit = this._raycaster.intersectObjects(meshesOf(vrm), true)[0];
      if (hit && (!nearest || hit.distance < nearest.distance)) {
        nearest = { vrm, distance: hit.distance };
      }
    }
    if (!nearest || (activeHit && activeHit.distance <= nearest.distance)) {
      return;
    }

    this._modelPickPos = { x: clientX, y: clientY };
    this._modelPickTimer = setTimeout(() => {
      const vrm = nearest.vrm;
      const pos = this._modelPickPos;
      this._clearModelPick();
      // 長押しで選択したので、指を離したときの「選択解除」は行わない
      this._leftDeselectDownPos = null;
      this._leftDeselectDragged = false;
      navigator.vibrate?.(30);
      this._callbacks.onModelLongPress(vrm);

      // 押したままドラッグすれば、選択したアバターをそのまま移動できる状態へ移る
      // （setVrm で操作状態がリセットされるので、選択した後に設定する）
      if (this._vrm === vrm) {
        this._trackingMode = "model-translate";
        this._scene.controls.enabled = false;
        this._canvas.classList.add("dragging-bone");
        this._lastClientX = pos.x;
        this._lastClientY = pos.y;
      }
    }, LONG_PRESS_MS);
  }

  _cancelModelPickIfMoved(clientX, clientY) {
    if (!this._modelPickPos) return;
    const dx = clientX - this._modelPickPos.x;
    const dy = clientY - this._modelPickPos.y;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) this._clearModelPick();
  }

  _clearModelPick() {
    if (this._modelPickTimer) {
      clearTimeout(this._modelPickTimer);
      this._modelPickTimer = null;
    }
    this._modelPickPos = null;
  }

  _clearLongPressTimer() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
  }

  /**
   * ドラッグ終了時、実際に変更が加わったボーン（操作対象トグルが
   * 'parent' なら親ボーン）の名前と回転をコールバックに通知する。
   */
  _syncEffectiveBoneChange() {
    if (!this._selectedBoneNode || !this._vrm) return;
    const effName = this._boneSphere?.getEffectiveBoneName() ??
      this._selectedBoneName;
    const effNode = this._vrm.humanoid.getNormalizedBoneNode(effName) ??
      this._selectedBoneNode;
    this._callbacks.onBoneChange(effName, effNode.quaternion);
  }

  // =========================================================
  // 親ボーン切り替え
  // =========================================================

  _selectParentBone() {
    if (!this._selectedBoneName || !this._vrm) return;

    // VRM humanoid の親ボーンを探す
    const parentName = this._findParentBoneName(this._selectedBoneName);
    if (!parentName) return;

    this._callbacks.onParentBoneSelect(parentName);
  }

  /**
   * VRM ヒューマンボーン階層で親ボーン名を返す（共通定義: bone-hierarchy.js）
   */
  _findParentBoneName(boneName) {
    return getParentBoneName(boneName);
  }

  // =========================================================
  // ボーン選択（スキンメッシュ）
  // =========================================================

  _getSkinMeshes() {
    const meshes = [];
    if (!this._vrm) return meshes;
    this._vrm.scene.traverse((obj) => {
      if (obj.isSkinnedMesh) meshes.push(obj);
    });
    return meshes;
  }

  /**
   * クリックした3D座標に一番近い「骨の線分」（ボーン位置→子ボーン位置）を
   * 持つボーンを選ぶ。
   *
   * 以前はクリックした三角形の頂点スキンウェイトから推定していたが、
   * 低ポリゴンのアバターだと1つの三角形がすねのような細い部位の
   * 膝〜足首にまたがってしまい、隣接ボーン（太もも・足首）のウェイトの
   * 方が強く出て誤選択されることがあった。スキンウェイトに依存しない
   * 幾何学的な距離判定にすることで、細い部位でも安定して選択できる。
   */
  _findNearestBoneFromIntersection(intersection) {
    const point = intersection.point;
    if (!point || !this._vrm) return null;

    let bestBone = null;
    let bestDist = Infinity;

    for (const boneName of SELECTABLE_BONE_NAMES) {
      const node = this._vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!node) continue;
      const bonePos = new THREE.Vector3();
      node.getWorldPosition(bonePos);

      const childName = CHILD_MAP[boneName];
      const childNode = childName
        ? this._vrm.humanoid.getNormalizedBoneNode(childName)
        : null;

      let dist;
      if (childNode) {
        const childPos = new THREE.Vector3();
        childNode.getWorldPosition(childPos);
        dist = this._pointToSegmentDistance(point, bonePos, childPos);
      } else {
        dist = point.distanceTo(bonePos);
      }

      if (dist < bestDist) {
        bestDist = dist;
        bestBone = boneName;
      }
    }

    return bestBone;
  }

  /** 点 p から線分 ab までの最短距離 */
  _pointToSegmentDistance(p, a, b) {
    const ab = new THREE.Vector3().subVectors(b, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq < 1e-10) return p.distanceTo(a);
    let t = new THREE.Vector3().subVectors(p, a).dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = a.clone().addScaledVector(ab, t);
    return p.distanceTo(closest);
  }

  _selectBone(boneName) {
    this._selectedBoneName = boneName;
    this._selectedBoneNode = this._vrm.humanoid.getNormalizedBoneNode(boneName);
    this._callbacks.onBoneSelect(boneName);
  }

  /**
   * 球にもモデルにも当たらない場所（完全に外側）をクリック/タップした時に
   * 選択状態を解除する。
   */
  _deselectBone() {
    this._selectedBoneName = null;
    this._selectedBoneNode = null;
    this._trackingMode = null;
    this._callbacks.onDeselect?.();
  }
}
