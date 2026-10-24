/**
 * vrm-loader.js - VRM ファイル読込ロジック
 */
import * as THREE from "three";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

import { tr } from "./i18n.js";
import { createGLTFLoader } from "./gltf-loader.js";
export class VrmLoader {
  constructor() {
    this._loader = createGLTFLoader(); // Draco 圧縮された VRM も読める
    this._loader.register((parser) => new VRMLoaderPlugin(parser));
  }

  /**
   * File オブジェクトから VRM を読み込む
   * @param {File} file
   * @param {(progress: number) => void} onProgress - 0~1
   * @returns {Promise<import('@pixiv/three-vrm').VRM>}
   */
  loadFromFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);

      this._loader.load(
        url,
        (gltf) => {
          URL.revokeObjectURL(url);

          const vrm = gltf.userData.vrm;
          if (!vrm) {
            reject(new Error(tr("vrm.001")));
            return;
          }

          // Y軸反転 (VRM0向け)
          VRMUtils.rotateVRM0(vrm);

          // VRMのLookAt（自動視線制御）を無効化。
          // 有効なままだと毎フレーム目・頭のボーンを自動的に上書きしてしまい、
          // 手動でドラッグした角度と実際の見た目がズレる・戻ってしまう原因になる。
          if (vrm.lookAt) {
            vrm.lookAt.autoUpdate = false;
          }

          // 不要なメッシュの最適化を無効化（ボーン操作に必要なため）
          // VRMUtils.removeUnnecessaryVertices(vrm.scene);

          // メッシュごとに別々のスケルトンを持つモデルは、毎フレーム各スケルトンのボーン行列を
          // GPUへ送るので重い。1つのスケルトンにまとめて転送を減らす(見た目・ボーン操作は変わらない)。
          try {
            VRMUtils.combineSkeletons(gltf.scene);
          } catch (e) {
            console.warn("[vrm-pose-app] combineSkeletons failed", e);
          }

          // ライトの「影を落とす」設定に意味を持たせるため、影の投影・受けを有効にしておく
          vrm.scene.traverse((obj) => {
            if (!obj.isMesh) return;
            obj.castShadow = true;
            obj.receiveShadow = true;

            // 視錐台カリングを無効にする。メッシュの「画面内か」の判定用の境界球は、読み込み時の姿勢で
            // 一度だけ計算されて使い回される。ポーズ・アニメーションで骨が動いて、頭が境界球の外へ
            // 出ると、画面に映っているのに「画面外」と判断され、顔や髪がメッシュごと描かれなくなる。
            // キャラクターは数体しか置かないので、常に描くコストは問題にならない。
            obj.frustumCulled = false;

            // 重要: three.jsはシャドウマップ(深度)描画時、既定では各マテリアルの
            // side を自動的に反転させる(FrontSide→深度はBackSideで描画、等)。
            // これは「閉じた(水密な)」ジオメトリでの自己遮蔽(shadow acne/
            // peter-panning)を抑えるための最適化だが、VRMモデルの髪の毛の
            // カード・スカートの増し布のような「裏面の存在しない1枚ペラの
            // メッシュ」では致命的に働く: 深度描画がBackSideに強制され、
            // 裏面を持たないそのメッシュはほぼ何も深度を書き込めなくなる。
            // この状態でメインパス側が「影の中かどうか」を判定すると、
            // 本来あるべき深度が存在しないために常に「影の中」と判定されて
            // しまい、キャラクター全体が黒く潰れて(暗い背景色に紛れて)消えた
            // ように見える、という不具合につながっていた
            // (near/far・biasの調整だけでは直らなかった理由はこれ)。
            // material.shadowSide を明示的に DoubleSide にして、この自動反転を
            // 無効化する(表面と同じ向きで深度を描画させる)ことで解消する。
            const materials = Array.isArray(obj.material)
              ? obj.material
              : [obj.material];
            for (const mat of materials) {
              if (mat) mat.shadowSide = THREE.DoubleSide;
            }
          });

          resolve(vrm);
        },
        (event) => {
          if (onProgress && event.lengthComputable) {
            onProgress(event.loaded / event.total);
          }
        },
        (error) => {
          URL.revokeObjectURL(url);
          reject(error);
        },
      );
    });
  }

  loadFromArrayBuffer(buffer, onProgress) {
    return this.loadFromFile(
      new File([buffer], "project-model.vrm", { type: "model/gltf-binary" }),
      onProgress,
    );
  }
}
