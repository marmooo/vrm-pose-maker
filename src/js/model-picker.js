/**
 * model-picker.js - 同梱モデル(src/vrm/)を選ぶモーダル
 *
 * vrm/list.txt(1行1ファイル。scripts/generate-vrm-list.ts で生成)を読み、次の命名規則で
 * モデルとサムネイルを結びつけて一覧表示する。サムネイルの画像形式は何でもよい。
 *
 *   1.vrm              モデル本体(選んだときに初めて取得する)
 *   1_portrait.<画像>  一覧に出す半身画像
 *   1_full_body.<画像> 選択時に大きく出す全身画像
 *
 * どちらの画像も無くてよい(無いときはもう一方、両方無ければ仮の表示にする)。
 * 一覧の段階では画像だけを(遅延読込で)取得するので、モデル本体の通信は選択するまで発生しない。
 * 選択時に VRM の glTF JSON チャンクだけを読んでライセンス情報をプレビューに表示する。
 */
import { tr } from "./i18n.js";

// サムネイルとして扱う拡張子(ブラウザが <img> で表示できるもの)
const IMAGE_EXTENSIONS = [
  "avif",
  "webp",
  "png",
  "apng",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "bmp",
  "svg",
];
// 同じ画像が複数の形式であるときの優先順(軽い形式を先にする)
const IMAGE_PRIORITY = new Map(IMAGE_EXTENSIONS.map((ext, i) => [ext, i]));

const PORTRAIT_SUFFIX = "portrait";
const FULL_BODY_SUFFIX = "full_body";

/** GLB の JSON チャンク先頭を読むときの初期バイト数(ヘッダ12 + チャンクヘッダ8 + 余裕) */
const GLB_PROBE_BYTES = 64 * 1024;

function extensionOf(path) {
  const m = /\.([^./]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

/**
 * list.txt の本文を、モデルごとの情報の配列にする(純粋関数)。
 * @param {string} text list.txt の内容
 * @param {string} baseUrl 一覧の中の相対パスを解決する基準のURL(list.txt 自身のURL)
 * @returns {{ key: string, name: string, fileName: string, vrmUrl: string,
 *   portraitUrl: string|null, fullBodyUrl: string|null }[]}
 */
export function parseModelList(text, baseUrl) {
  const entries = new Map(); // key(拡張子を除いた相対パス) → 情報
  const images = []; // { key, slot, ext, path }

  for (const raw of text.split(/\r?\n/)) {
    const path = raw.trim();
    if (!path || path.startsWith("#")) continue;
    const ext = extensionOf(path);
    if (ext === "vrm") {
      const key = path.slice(0, -4);
      if (!entries.has(key)) {
        entries.set(key, {
          key,
          name: key.split("/").pop(),
          fileName: path.split("/").pop(),
          vrmPath: path,
          portrait: null,
          fullBody: null,
        });
      }
    } else if (IMAGE_PRIORITY.has(ext)) {
      const m = new RegExp(
        `^(.+)_(${PORTRAIT_SUFFIX}|${FULL_BODY_SUFFIX})\\.[^./]+$`,
        "i",
      ).exec(path);
      if (m) {
        images.push({
          key: m[1],
          slot: m[2].toLowerCase() === PORTRAIT_SUFFIX
            ? "portrait"
            : "fullBody",
          ext,
          path,
        });
      }
    }
  }

  // 画像をモデルへ割り当てる(同じ枠に複数あれば、優先順位が高い形式を採用)
  for (const image of images) {
    const entry = entries.get(image.key);
    if (!entry) continue;
    const current = entry[image.slot];
    if (
      !current ||
      IMAGE_PRIORITY.get(image.ext) < IMAGE_PRIORITY.get(current.ext)
    ) {
      entry[image.slot] = { path: image.path, ext: image.ext };
    }
  }

  const resolve = (path) => new URL(path, baseUrl).href;
  return [...entries.values()].map((entry) => ({
    key: entry.key,
    name: entry.name,
    fileName: entry.fileName,
    vrmUrl: resolve(entry.vrmPath),
    portraitUrl: entry.portrait ? resolve(entry.portrait.path) : null,
    fullBodyUrl: entry.fullBody ? resolve(entry.fullBody.path) : null,
  }));
}

/**
 * ArrayBuffer 先頭から GLB の JSON チャンクを取り出す。
 * チャンク全体が buffer に収まっていない場合は必要なバイト数を返す。
 * @returns {{ json: object } | { needBytes: number } | null}
 */
function parseGlbJsonFromBuffer(buffer) {
  if (buffer.byteLength < 20) return { needBytes: 20 };
  const view = new DataView(buffer);
  // magic "glTF"
  if (view.getUint32(0, true) !== 0x46546c67) return null;
  const jsonChunkLength = view.getUint32(12, true);
  const jsonChunkType = view.getUint32(16, true);
  // 0x4E4F534A = "JSON"
  if (jsonChunkType !== 0x4e4f534a) return null;
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonChunkLength;
  if (buffer.byteLength < jsonEnd) return { needBytes: jsonEnd };
  const jsonBytes = new Uint8Array(buffer, jsonStart, jsonChunkLength);
  const text = new TextDecoder("utf-8").decode(jsonBytes);
  try {
    return { json: JSON.parse(text) };
  } catch {
    return null;
  }
}

/**
 * VRM(GLB) の URL からメタ情報だけを取得する(メッシュは読まない)。
 * Range 対応サーバでは JSON チャンク分だけ取得する。
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} VRM0 meta または VRM1 meta、失敗時 null
 */
export async function fetchVrmMeta(url, signal) {
  const tryParse = (buf) => {
    const r = parseGlbJsonFromBuffer(buf);
    if (!r || r.needBytes) return r;
    const ext = r.json?.extensions;
    if (!ext) return null;
    // VRM 1.0
    if (ext.VRMC_vrm?.meta) return ext.VRMC_vrm.meta;
    // VRM 0.x
    if (ext.VRM?.meta) return ext.VRM.meta;
    return null;
  };

  // まず先頭だけ Range で取る
  let res = await fetch(url, {
    headers: { Range: `bytes=0-${GLB_PROBE_BYTES - 1}` },
    signal,
  });
  if (!res.ok && res.status !== 206) {
    // Range 非対応なら全文
    res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return tryParse(await res.arrayBuffer());
  }
  let buffer = await res.arrayBuffer();
  let parsed = tryParse(buffer);
  if (parsed && parsed.needBytes) {
    // JSON チャンクがプローブより大きい場合は必要分を取り直す
    res = await fetch(url, {
      headers: { Range: `bytes=0-${parsed.needBytes - 1}` },
      signal,
    });
    if (!res.ok && res.status !== 206) {
      res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
    buffer = await res.arrayBuffer();
    parsed = tryParse(buffer);
  }
  if (!parsed || parsed.needBytes) return null;
  return parsed;
}

/**
 * meta オブジェクトから表示用のライセンス情報を作る。
 * 長い URL は出さず、短いラベル（バッジ）とリンク先だけ返す。
 * @returns {{ label: string, url: string|null }}
 */
export function formatLicenseFromMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return { label: "", url: null };
  }

  // リンク先の優先順位: モデル固有の otherLicenseUrl > 標準 licenseUrl
  const otherUrl =
    (typeof meta.otherLicenseUrl === "string" && meta.otherLicenseUrl) ||
    (typeof meta.otherPermissionUrl === "string" && meta.otherPermissionUrl) ||
    null;
  const licenseUrl = (typeof meta.licenseUrl === "string" && meta.licenseUrl) ||
    null;
  const url = otherUrl || licenseUrl;

  // VRM 0.0: licenseName（CC_BY など）があれば短いラベルに使う
  if (typeof meta.licenseName === "string" && meta.licenseName) {
    const name = meta.licenseName.replace(/_/g, " ");
    // "Other" だけだと意味が薄いので、リンクがあるなら "License" に寄せる
    const label = name === "Other" && url ? "License" : name;
    return { label, url };
  }

  // VRM 1.0 など: 常に短い "License" バッジ（URL があるときだけ表示）
  if (url) {
    return { label: "License", url };
  }

  return { label: "", url: null };
}

export class ModelPicker {
  /**
   * @param {object} options
   * @param {string} options.listUrl list.txt のURL
   * @param {(entry: object) => Promise<boolean|void>} options.onLoad
   *   モデルが選ばれたとき。false を返す(取得に失敗した)と、モーダルを開き直す。
   * @param {() => void} options.onChooseDevice 「この端末のファイルから選ぶ」が押されたとき
   */
  constructor({ listUrl, onLoad, onChooseDevice }) {
    this._listUrl = listUrl;
    this._onLoad = onLoad;
    this._onChooseDevice = onChooseDevice;
    this._entries = [];
    this._selected = null;
    this._cards = new Map(); // key → ボタン要素
    this._metaCache = new Map(); // vrmUrl → meta | null
    this._metaAbort = null;

    this._el = document.getElementById("model-picker");
    this._grid = document.getElementById("model-picker-grid");
    this._previewImg = document.getElementById("model-picker-preview-img");
    this._previewEmpty = document.getElementById("model-picker-preview-empty");
    this._previewName = document.getElementById("model-picker-preview-name");
    this._previewLicense = document.getElementById(
      "model-picker-preview-license",
    );
    this._btnLoad = document.getElementById("model-picker-load");
    this._btnDevice = document.getElementById("model-picker-device");
    this._modal = this._el
      ? bootstrap.Modal.getOrCreateInstance(this._el)
      : null;

    this._btnLoad?.addEventListener("click", () => this._loadSelected());
    this._btnDevice?.addEventListener("click", () => {
      // ファイル選択ダイアログはユーザー操作の中で開く必要があるので、閉じる前に呼ぶ
      this._onChooseDevice();
      this._hide();
    });
  }

  /** 一覧を読み込んで表示を作る。戻り値は一覧に載ったモデルの数(一覧が無ければ 0)。 */
  async init() {
    if (!this._el) return 0;
    const res = await fetch(this._listUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${this._listUrl}`);
    const baseUrl = new URL(this._listUrl, location.href).href;
    this._entries = parseModelList(await res.text(), baseUrl);
    this._buildGrid();
    return this._entries.length;
  }

  /** モーダルを開く。一覧が空など、開けなかったときは false。 */
  open() {
    if (!this._modal || !this._entries.length) return false;
    this._modal.show();
    return true;
  }

  _buildGrid() {
    this._grid.replaceChildren();
    this._cards.clear();
    for (const entry of this._entries) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "model-card";
      card.setAttribute("aria-pressed", "false");
      card.title = entry.name;

      const frame = document.createElement("div");
      frame.className = "model-card-frame";
      const src = entry.portraitUrl ?? entry.fullBodyUrl;
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = tr("picker.001", entry.name);
        img.loading = "lazy";
        img.decoding = "async";
        frame.append(img);
      } else {
        frame.append(this._placeholderIcon());
      }

      const label = document.createElement("div");
      label.className = "model-card-name";
      label.textContent = entry.name;

      card.append(frame, label);
      card.addEventListener("click", () => this._select(entry));
      card.addEventListener("dblclick", () => {
        this._select(entry);
        this._loadSelected();
      });
      this._grid.append(card);
      this._cards.set(entry.key, card);
    }
  }

  /**
   * モーダルを閉じる。フォーカスがモーダル内に残ったまま閉じると、閉じた(aria-hidden な)要素に
   * フォーカスがある状態になり警告が出るので、先にフォーカスを外す。
   */
  _hide() {
    if (this._el.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    this._modal.hide();
  }

  _placeholderIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "40%");
    svg.setAttribute("height", "40%");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("text-secondary");
    const use = document.createElementNS(ns, "use");
    use.setAttribute(
      "href",
      "/vrm-pose-maker/icons/bootstrap-icons.svg#person-circle",
    );
    svg.append(use);
    return svg;
  }

  _setLicenseDisplay(label, url) {
    const el = this._previewLicense;
    if (!el) return;
    el.replaceChildren();
    if (!label) {
      el.classList.add("d-none");
      return;
    }
    el.classList.remove("d-none");
    // Bootstrap の badge をそのまま使う（独自スタイルは不要）
    const badgeClass =
      "badge rounded-pill text-bg-secondary fw-normal text-decoration-none";
    if (url) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = badgeClass;
      a.textContent = label;
      a.title = url;
      el.append(a);
    } else {
      const span = document.createElement("span");
      span.className = badgeClass;
      span.textContent = label;
      el.append(span);
    }
  }

  async _loadAndShowLicense(entry) {
    const el = this._previewLicense;
    if (!el) return;

    // 直前の取得をキャンセル
    if (this._metaAbort) {
      this._metaAbort.abort();
      this._metaAbort = null;
    }

    const cached = this._metaCache.get(entry.vrmUrl);
    if (cached !== undefined) {
      const { label, url } = formatLicenseFromMeta(cached);
      this._setLicenseDisplay(label, url);
      return;
    }

    el.classList.remove("d-none");
    el.textContent = "…";

    const ac = new AbortController();
    this._metaAbort = ac;
    const selectedKey = entry.key;

    try {
      const meta = await fetchVrmMeta(entry.vrmUrl, ac.signal);
      if (this._selected?.key !== selectedKey) return; // 選択が変わっていた
      this._metaCache.set(entry.vrmUrl, meta);
      const { label, url } = formatLicenseFromMeta(meta);
      // メタは読めたがライセンス欄が空のときは何も出さない
      this._setLicenseDisplay(label, url);
    } catch (e) {
      if (e?.name === "AbortError") return;
      if (this._selected?.key !== selectedKey) return;
      this._metaCache.set(entry.vrmUrl, null);
      this._setLicenseDisplay("", null);
    } finally {
      if (this._metaAbort === ac) this._metaAbort = null;
    }
  }

  _select(entry) {
    this._selected = entry;
    for (const [key, card] of this._cards) {
      card.setAttribute("aria-pressed", String(key === entry.key));
    }
    this._btnLoad.disabled = false;

    // 右側のプレビュー(狭い画面では非表示)。全身画像を優先し、無ければ半身画像。
    const src = entry.fullBodyUrl ?? entry.portraitUrl;
    this._previewName.textContent = entry.name;
    if (src) {
      this._previewImg.src = src;
      this._previewImg.alt = tr(
        entry.fullBodyUrl ? "picker.002" : "picker.001",
        entry.name,
      );
      this._previewImg.classList.remove("d-none");
      this._previewEmpty.classList.add("d-none");
    } else {
      this._previewImg.classList.add("d-none");
      this._previewEmpty.textContent = tr("picker.003");
      this._previewEmpty.classList.remove("d-none");
    }

    // 選択モデルの VRM メタからライセンスを読み、画像の下に表示
    this._loadAndShowLicense(entry);
  }

  async _loadSelected() {
    const entry = this._selected;
    if (!entry) return;
    this._hide();
    const ok = await this._onLoad(entry);
    if (ok === false) this._modal.show();
  }
}
