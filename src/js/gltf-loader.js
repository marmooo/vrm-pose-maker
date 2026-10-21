/**
 * gltf-loader.js - Draco 圧縮(KHR_draco_mesh_compression)に対応した GLTFLoader を作る
 *
 * GLTFLoader は DRACOLoader を渡さないと、Draco で圧縮された VRM / GLB を
 * 「No DRACOLoader instance provided」で読めない。VRM・ポーズファイルの読込で共通に使う。
 *
 * デコーダ(wasm)は Draco 圧縮のメッシュを初めて読むときにだけ取得されるので、
 * 圧縮していないモデルの読込には影響しない。
 */
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

// importmap で three を CDN から読んでいる場合の既定の場所。バージョンは importmap の three と必ず揃える。
const FALLBACK_DECODER_PATH =
  "https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/";

/** importmap の three/addons/ と同じ場所・同じバージョンのデコーダを指す(解決できなければ既定値)。 */
function decoderPath() {
  try {
    return new URL(
      "../libs/draco/gltf/",
      import.meta.resolve("three/addons/loaders/DRACOLoader.js"),
    ).href;
  } catch {
    return FALLBACK_DECODER_PATH;
  }
}

// ワーカーを使い回すため、DRACOLoader はアプリ全体で1つにする
let dracoLoader = null;

/** Draco 圧縮に対応した GLTFLoader を返す。 */
export function createGLTFLoader() {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(decoderPath());
  }
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  return loader;
}
