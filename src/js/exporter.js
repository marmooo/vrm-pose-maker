/** VRMA / project export helpers */
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ALL_BONE_NAMES } from "./bone-hierarchy.js";

import { tr } from "./i18n.js";
export class Exporter {
  /**
   * VRMC_vrm_animation 1.0 の1秒間の静止ポーズを表す glTF JSON を組み立てる。
   * バイナリ(.glb)には分割せず、バッファは data URI として JSON に埋め込む
   * （glTF/VRMAの仕様上どちらの形でも有効）。そうすることで、ファイル保存でも
   * クリップボードへのコピーでも同じ JSON テキストをそのまま使い回せる。
   */
  static _buildVrmaJson(vrm, expressionNames = []) {
    const nodes = [],
      humanBones = {},
      channels = [],
      samplers = [],
      accessors = [],
      bufferViews = [];
    const chunks = [];
    const push = (values, type) => {
      const data = new Float32Array(values);
      const offset = chunks.reduce((n, x) => n + x.byteLength, 0);
      chunks.push(new Uint8Array(data.buffer));
      const view = bufferViews.push({
        buffer: 0,
        byteOffset: offset,
        byteLength: data.byteLength,
      }) - 1;
      const accessor = accessors.push({
        bufferView: view,
        componentType: 5126,
        count: type === "SCALAR"
          ? data.length
          : data.length / (type === "VEC3" ? 3 : 4),
        type,
        min: type === "SCALAR" ? [0] : undefined,
        max: type === "SCALAR" ? [1] : undefined,
      }) - 1;
      return accessor;
    };
    const time = push([0, 1], "SCALAR");
    const addTrack = (node, path, value, type) => {
      const output = push([...value, ...value], type);
      const sampler =
        samplers.push({ input: time, output, interpolation: "STEP" }) - 1;
      channels.push({ sampler, target: { node, path } });
    };
    for (const boneName of ALL_BONE_NAMES) {
      const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!bone) continue;
      const node = nodes.push({ name: boneName }) - 1;
      humanBones[boneName] = { node };
      addTrack(node, "rotation", bone.quaternion.toArray(), "VEC4");
      if (boneName === "hips") {
        addTrack(node, "translation", bone.position.toArray(), "VEC3");
      }
    }
    const preset = {}, custom = {};
    for (const name of expressionNames) {
      if (/^look(?:Up|Down|Left|Right)$/i.test(name)) continue;
      const node = nodes.push({ name: `expression_${name}` }) - 1;
      const slot = { node };
      (/^(neutral|happy|angry|sad|relaxed|surprised|aa|ih|ou|ee|oh|blink|blinkLeft|blinkRight)$/i
          .test(name)
        ? preset
        : custom)[name] = slot;
      addTrack(node, "translation", [
        vrm.expressionManager?.getValue?.(name) ?? 0,
        0,
        0,
      ], "VEC3");
    }
    const bin = new Uint8Array(chunks.reduce((n, x) => n + x.byteLength, 0));
    let cursor = 0;
    for (const chunk of chunks) {
      bin.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    const extension = { specVersion: "1.0", humanoid: { humanBones } };
    if (Object.keys(preset).length || Object.keys(custom).length) {
      extension.expressions = { preset, custom };
    }
    return {
      asset: { version: "2.0", generator: "VRM Pose Editor" },
      extensionsUsed: ["VRMC_vrm_animation"],
      extensions: { VRMC_vrm_animation: extension },
      nodes,
      animations: [{ name: "Pose", samplers, channels }],
      buffers: [{
        byteLength: bin.byteLength,
        uri: "data:application/octet-stream;base64," +
          Exporter._arrayBufferToBase64(bin.buffer),
      }],
      bufferViews,
      accessors,
    };
  }
  /** ポーズを .vrma (JSON形式のglTF) ファイルとしてダウンロードする。 */
  static saveVrma(vrm, filename = "pose.vrma", expressionNames = []) {
    const json = Exporter._buildVrmaJson(vrm, expressionNames);
    Exporter._download(
      new Blob([JSON.stringify(json)], { type: "model/gltf+json" }),
      filename,
    );
  }
  /** ファイル保存とまったく同じ VRMA(JSON) をそのままテキストとしてクリップボードにコピーする。 */
  static async copyVrmaToClipboard(vrm, expressionNames = []) {
    if (!navigator.clipboard?.writeText) throw new Error(tr("exp.001"));
    const json = Exporter._buildVrmaJson(vrm, expressionNames);
    await navigator.clipboard.writeText(JSON.stringify(json));
  }
  /** クリップボードにコピーされたポーズを読み取り、readVrmaPose と同じ形式で返す。 */
  static async pasteVrmaFromClipboard() {
    if (!navigator.clipboard?.readText) throw new Error(tr("exp.002"));
    const text = await navigator.clipboard.readText();
    if (!text.includes("VRMC_vrm_animation")) throw new Error(tr("exp.003"));
    return Exporter.readVrmaPose(new Blob([text], { type: "model/gltf+json" }));
  }
  static _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000; // 一度に文字列化するバイト数(呼び出しスタック上限を避けるため分割する)
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  static async createProject(
    models,
    sceneState,
    getExpressionNames,
    getMaterials,
  ) {
    return {
      format: "vrm-pose-project",
      version: 3,
      savedAt: new Date().toISOString(),
      scene: sceneState,
      models: await Promise.all(models.map(async ({ vrm, file, name }) => ({
        name,
        data: await Exporter._fileToDataUrl(file),
        transform: {
          position: vrm.scene.position.toArray(),
          quaternion: vrm.scene.quaternion.toArray(),
          scale: vrm.scene.scale.toArray(),
        },
        pose: Exporter._pose(vrm),
        expressions: Object.fromEntries(
          getExpressionNames(vrm).map(
            (n) => [n, vrm.expressionManager?.getValue?.(n) ?? 0],
          ),
        ),
        materials: getMaterials(vrm),
      }))),
    };
  }
  static _pose(vrm) {
    return Object.fromEntries(
      ALL_BONE_NAMES.map((n) => {
        const b = vrm.humanoid.getNormalizedBoneNode(n);
        return b
          ? [n, {
            rotation: b.quaternion.toArray(),
            position: b.position.toArray(),
          }]
          : null;
      }).filter(Boolean),
    );
  }
  static _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  /** .glb / .vrma / .gltf ファイルを GLTFLoader で解析して返す。 */
  static async parseGltf(file) {
    // 欲しいのはボーンとアニメーションだけ。メッシュ・マテリアル・画像は読み込まない
    // (ランダム再生で何百回も読み込んでも、メモリを無駄に使わず速く読める)。
    const data = Exporter._stripGltfGeometry(await file.arrayBuffer());
    return new Promise((resolve, reject) =>
      new GLTFLoader().parse(data, "", resolve, reject)
    );
  }
  /** glTF の JSON からメッシュ・スキン・マテリアル・テクスチャ・画像を取り除く(アニメーションとノードは残す)。 */
  static _stripGltfJson(json) {
    for (
      const key of [
        "meshes",
        "materials",
        "textures",
        "images",
        "samplers",
        "skins",
        "cameras",
      ]
    ) delete json[key];
    for (const node of json.nodes ?? []) {
      delete node.mesh;
      delete node.skin;
      delete node.camera;
      delete node.weights;
    }
    for (const anim of json.animations ?? []) {
      anim.channels = (anim.channels ?? []).filter((c) =>
        c.target?.path !== "weights"
      );
    }
    return json;
  }
  /** GLB / JSON 形式どちらの glTF/VRMA も受け付け、上記の取り除きを行った ArrayBuffer を返す。失敗したら元のまま返す。 */
  static _stripGltfGeometry(data) {
    try {
      const dv = new DataView(data);
      const pad4 = (bytes) => {
        const n = (4 - (bytes.length % 4)) % 4;
        if (!n) return bytes;
        const out = new Uint8Array(bytes.length + n);
        out.set(bytes);
        out.fill(0x20, bytes.length);
        return out;
      };
      if (
        dv.byteLength >= 20 && dv.getUint32(0, true) === 0x46546c67 &&
        dv.getUint32(16, true) === 0x4e4f534a
      ) { // 'glTF' + 'JSON'
        const jsonLength = dv.getUint32(12, true);
        const json = JSON.parse(
          new TextDecoder().decode(new Uint8Array(data, 20, jsonLength)),
        );
        const jsonBytes = pad4(
          new TextEncoder().encode(
            JSON.stringify(Exporter._stripGltfJson(json)),
          ),
        );
        const rest = new Uint8Array(data, 20 + jsonLength);
        const out = new Uint8Array(20 + jsonBytes.length + rest.length);
        const outView = new DataView(out.buffer);
        out.set(new Uint8Array(data, 0, 4));
        outView.setUint32(4, 2, true);
        outView.setUint32(8, out.length, true);
        outView.setUint32(12, jsonBytes.length, true);
        out.set(new Uint8Array(data, 16, 4), 16);
        out.set(jsonBytes, 20);
        out.set(rest, 20 + jsonBytes.length);
        return out.buffer;
      }
      const json = JSON.parse(new TextDecoder().decode(data)); // .vrma / .gltf (JSON テキスト)
      return new TextEncoder().encode(
        JSON.stringify(Exporter._stripGltfJson(json)),
      ).buffer;
    } catch {
      return data;
    }
  }
  /** 解析済み glTF の VRMC_vrm_animation 拡張(無ければ undefined)を返す。 */
  static getVrmaExtension(gltf) {
    return gltf.parser.json.extensions?.VRMC_vrm_animation;
  }
  /**
   * VRMA が「1ポーズだけの静止データ」(= このアプリの「ポーズ保存」で出力したものなど)かどうか。
   * すべてのトラックで、全キーフレームの値が最初のキーフレームと同じなら静止ポーズとみなす。
   */
  static isStaticAnimation(clip) {
    if (!clip || !clip.tracks.length) return true;
    const stride = (track) => track.values.length / track.times.length;
    return clip.tracks.every((track) => {
      const n = stride(track);
      if (!Number.isInteger(n)) return false;
      for (let i = n; i < track.values.length; i++) {
        if (Math.abs(track.values[i] - track.values[i % n]) > 1e-5) {
          return false;
        }
      }
      return true;
    });
  }
  /** Read the first static frame in a VRMA file as normalized bone transforms. */
  static async readVrmaPose(file) {
    return Exporter.poseFromGltf(await Exporter.parseGltf(file));
  }
  /** 解析済みの VRMA から、最初のフレームのポーズ・表情を取り出す。 */
  static async poseFromGltf(gltf) {
    const extension = Exporter.getVrmaExtension(gltf);
    if (!extension?.humanoid?.humanBones || !gltf.animations[0]) {
      throw new Error(tr("exp.004"));
    }
    const nodeToBone = new Map(
      Object.entries(extension.humanoid.humanBones).map((
        [bone, value],
      ) => [value.node, bone]),
    );
    const pose = {};
    const clip = gltf.animations[0];
    const findTrack = (node, path) =>
      clip.tracks.find((track) =>
        track.name === node.uuid + "." + path ||
        track.name === node.name + "." + path
      );
    for (const [index, boneName] of nodeToBone) {
      const node = await gltf.parser.getDependency("node", index);
      const rotation = findTrack(node, "quaternion");
      const position = findTrack(node, "position");
      // VRMA は通常 hips だけが平行移動トラックを持つ。トラックのない
      // ボーンにゼロ位置を適用すると骨格が崩れるため、position は存在時のみ返す。
      const transform = {};
      if (rotation) {
        transform.rotation = Array.from(rotation.values.slice(0, 4));
      } // 一部のVRMAはトラックではなくノード初期値に回転を持つ。
      else if (
        node.quaternion.x || node.quaternion.y || node.quaternion.z ||
        node.quaternion.w !== 1
      ) transform.rotation = node.quaternion.toArray();
      if (position) {
        transform.position = Array.from(position.values.slice(0, 3));
      }
      pose[boneName] = transform;
    }
    const expressions = {};
    for (const group of ["preset", "custom"]) {
      for (
        const [name, slot] of Object.entries(
          extension.expressions?.[group] || {},
        )
      ) {
        const node = await gltf.parser.getDependency("node", slot.node);
        const track = findTrack(node, "position");
        expressions[name] = track ? track.values[0] : node.position.x;
      }
    }
    return { pose, expressions };
  }
  static dataUrlToArrayBuffer(dataUrl) {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }
  static saveScreenshot(
    sceneManager,
    filename = "screenshot.png",
    options = {},
  ) {
    const a = document.createElement("a");
    a.href = sceneManager.getScreenshot(options);
    a.download = filename;
    a.click();
  }
  static _download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
