/**
 * controls.js - ライト編集・マテリアル編集パネルで使う、汎用的な入力UI部品。
 * ボーン回転スライダー(ui.js)と似た見た目になるよう、同じCSSクラスを再利用している。
 *
 * どの部品も「resetValue」を渡すと、隣に初期値へ戻すボタン(↺)が付く。
 * resetValue を省略した場合は、その部品を作った時点の value がそのまま
 * リセット先になる。
 */

import { tr } from "./i18n.js";
function createResetButton(onClick, title = tr("ctl.001")) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-sm btn-outline-secondary control-reset-btn";
  btn.innerHTML = '<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="/vrm-pose-maker/icons/bootstrap-icons.svg#arrow-counterclockwise"/></svg>';
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * ラベルの横に「?」アイコンを付け、押した時だけヒント文章を表示する。
 * ラベルに長い説明文を埋め込むとスライダーの並びが見にくくなるため、
 * 普段は隠しておき、必要な人だけ押して読めるようにしている。
 * @param {string} label
 * @param {string} [hint] 省略時は「?」アイコン自体を表示しない
 * @returns {{ labelRow: HTMLElement, hintEl: HTMLElement|null }}
 */
function createLabelWithHint(label, hint, labelTag = "span") {
  const labelRow = document.createElement("span");
  labelRow.className =
    "control-label-wrap d-inline-flex align-items-center gap-1";

  const labelEl = document.createElement(labelTag);
  labelEl.className = "control-label";
  labelEl.textContent = label;
  labelRow.appendChild(labelEl);

  let hintEl = null;
  if (hint) {
    const hintBtn = document.createElement("button");
    hintBtn.type = "button";
    hintBtn.className = "control-hint-btn";
    hintBtn.textContent = "?";
    hintBtn.title = tr("ctl.002");

    hintEl = document.createElement("div");
    hintEl.className = "control-hint-text";
    hintEl.textContent = hint;
    hintEl.hidden = true;

    hintBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hintEl.hidden = !hintEl.hidden;
    });
    labelRow.appendChild(hintBtn);
  }

  return { labelRow, hintEl };
}

/**
 * ラベル・数値入力・スライダー・リセットボタンの4点セットを作る。
 * @param {object} opts
 * @param {string} opts.label
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} [opts.step=0.01]
 * @param {number} opts.value
 * @param {number} [opts.resetValue] 省略時は value をリセット先にする
 * @param {(value: number) => void} opts.onChange
 * @param {number} [opts.decimals] 数値入力欄の小数点以下桁数(省略時はstepから推定)
 * @returns {{ element: HTMLElement, setValue: (value: number) => void }}
 */
export function createSlider(
  { label, hint, min, max, step = 0.01, value, resetValue, onChange, decimals },
) {
  const dp = decimals ?? Math.max(0, -Math.floor(Math.log10(step)) || 0);
  const resetTo = resetValue ?? value;

  const wrapper = document.createElement("div");
  wrapper.className = "control-slider-group";

  const labelRow = document.createElement("div");
  labelRow.className = "d-flex align-items-center gap-2 mb-1";

  const { labelRow: labelWrap, hintEl } = createLabelWithHint(label, hint);
  labelWrap.classList.add("flex-shrink-1");

  const numInput = document.createElement("input");
  numInput.type = "number";
  numInput.className =
    "form-control form-control-sm text-end control-value-input ms-auto";
  numInput.min = String(min);
  numInput.max = String(max);
  numInput.step = String(step);
  numInput.value = value.toFixed(dp);

  const resetBtn = createResetButton(() => set(resetTo));

  labelRow.append(labelWrap, numInput, resetBtn);
  wrapper.appendChild(labelRow);
  if (hintEl) wrapper.appendChild(hintEl);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "form-range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  wrapper.appendChild(slider);

  const clamp = (v) => Math.max(min, Math.min(max, v));
  function set(v) {
    v = clamp(v);
    slider.value = String(v);
    numInput.value = v.toFixed(dp);
    onChange(v);
  }
  slider.addEventListener("input", () => set(parseFloat(slider.value)));
  numInput.addEventListener(
    "change",
    () => set(parseFloat(numInput.value) || 0),
  );

  return { element: wrapper, setValue: set };
}

/**
 * ラベル付きのカラーピッカー(+リセットボタン)を作る。
 * @param {{ label: string, value: string, resetValue?: string, onChange: (hex: string) => void }} opts
 */
export function createColorInput({ label, hint, value, resetValue, onChange }) {
  const resetTo = resetValue ?? value;

  const wrapper = document.createElement("div");
  wrapper.className = "control-color-group-outer";

  const row = document.createElement("div");
  row.className = "control-color-group d-flex align-items-center gap-2 mb-2";

  const { labelRow: labelWrap, hintEl } = createLabelWithHint(label, hint);
  labelWrap.classList.add("flex-grow-1");

  const input = document.createElement("input");
  input.type = "color";
  input.className = "form-control form-control-color form-control-sm";
  input.value = value;

  function set(v) {
    input.value = v;
    onChange(v);
  }
  input.addEventListener("input", () => set(input.value));

  const resetBtn = createResetButton(() => set(resetTo));

  row.append(labelWrap, input, resetBtn);
  wrapper.appendChild(row);
  if (hintEl) wrapper.appendChild(hintEl);
  return { element: wrapper, setValue: set };
}

/**
 * ラベル付きのセレクトボックス(+リセットボタン)を作る。
 * @param {{ label: string, options: {value: string, label: string}[], value: string, resetValue?: string, onChange: (value: string) => void }} opts
 */
export function createSelect(
  { label, hint, options, value, resetValue, onChange },
) {
  const resetTo = resetValue ?? value;

  const wrapper = document.createElement("div");
  wrapper.className = "mb-2";

  const { labelRow: labelWrap, hintEl } = createLabelWithHint(label, hint);
  labelWrap.classList.add(
    "form-label",
    "small",
    "text-secondary",
    "mb-1",
    "d-flex",
  );

  const selectRow = document.createElement("div");
  selectRow.className = "d-flex align-items-center gap-2";

  const select = document.createElement("select");
  select.className = "form-select form-select-sm flex-grow-1";
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === value) el.selected = true;
    select.appendChild(el);
  }

  function set(v) {
    select.value = v;
    onChange(v);
  }
  select.addEventListener("change", () => set(select.value));

  const resetBtn = createResetButton(() => set(resetTo));

  selectRow.append(select, resetBtn);
  wrapper.append(labelWrap, selectRow);
  if (hintEl) wrapper.appendChild(hintEl);
  return { element: wrapper, setValue: set };
}

/**
 * ラベル付きのチェックボックス(スイッチ、+リセットボタン)を作る。
 * @param {{ label: string, checked: boolean, resetValue?: boolean, onChange: (checked: boolean) => void }} opts
 */
export function createCheckbox({ label, hint, checked, resetValue, onChange }) {
  const resetTo = resetValue ?? checked;

  const wrapper = document.createElement("div");
  wrapper.className = "control-checkbox-group-outer";

  const row = document.createElement("div");
  row.className = "d-flex align-items-center gap-2 mb-2";

  const switchWrap = document.createElement("div");
  switchWrap.className =
    "form-check form-switch mb-0 d-flex align-items-center gap-1";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "form-check-input";
  input.role = "switch";
  input.checked = checked;

  const { labelRow: labelWrap, hintEl } = createLabelWithHint(
    label,
    hint,
    "label",
  );
  const labelEl = labelWrap.querySelector(".control-label");
  labelEl.classList.add("form-check-label", "small");

  const id = "chk-" + Math.random().toString(36).slice(2, 9);
  input.id = id;
  labelEl.htmlFor = id;

  function set(v) {
    input.checked = v;
    onChange(v);
  }
  input.addEventListener("change", () => set(input.checked));

  const resetBtn = createResetButton(() => set(resetTo));

  switchWrap.append(input, labelWrap);
  row.append(switchWrap, resetBtn);
  wrapper.appendChild(row);
  if (hintEl) wrapper.appendChild(hintEl);
  return { element: wrapper, setValue: set };
}

/** 折りたたみ可能なセクション見出しを作る(内容は呼び出し側でcontentに追加する)。 */
export function createSection(title) {
  const wrapper = document.createElement("div");
  wrapper.className = "control-section mb-3";

  const heading = document.createElement("div");
  heading.className = "control-section-title small fw-bold text-secondary mb-2";
  heading.textContent = title;

  const content = document.createElement("div");

  wrapper.append(heading, content);
  return { element: wrapper, content };
}
