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

    this._el = document.getElementById("model-picker");
    this._grid = document.getElementById("model-picker-grid");
    this._previewImg = document.getElementById("model-picker-preview-img");
    this._previewEmpty = document.getElementById("model-picker-preview-empty");
    this._previewName = document.getElementById("model-picker-preview-name");
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
  }

  async _loadSelected() {
    const entry = this._selected;
    if (!entry) return;
    this._hide();
    const ok = await this._onLoad(entry);
    if (ok === false) this._modal.show();
  }
}
