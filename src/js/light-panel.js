/**
 * light-panel.js - ライト編集パネル。
 * シーン内のライト(SceneManager.lights)を一覧表示し、種類ごとに応じた
 * スライダー・カラーピッカーで編集できるようにする。ライトの追加・削除も行う。
 */
import { createCheckbox, createColorInput, createSlider } from "./controls.js";

import { tr } from "./i18n.js";
const LIGHT_TYPE_LABELS = {
  ambient: tr("light.001"),
  hemisphere: tr("light.002"),
  directional: tr("light.003"),
  point: tr("light.004"),
  spot: tr("light.005"),
};

export class LightPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('./scene.js').SceneManager} sceneManager
   * @param {{ onChange?: () => void, lightGizmo?: import('./light-gizmo.js').LightGizmo, onToggleEditMode?: (enabled: boolean) => void }} [callbacks]
   */
  constructor(
    container,
    sceneManager,
    { onChange, lightGizmo, onToggleEditMode } = {},
  ) {
    this._container = container;
    this._scene = sceneManager;
    this._onChange = onChange ?? (() => {});
    this._gizmo = lightGizmo ?? null;
    this._onToggleEditMode = onToggleEditMode ?? (() => {});
  }

  /** ライト一覧をゼロから描画し直す。ライトの追加・削除の後に呼ぶ。 */
  build() {
    this._container.innerHTML = "";
    if (this._gizmo) this._container.appendChild(this._buildEditModeToggle());
    this._container.appendChild(this._buildAddRow());

    if (!this._scene.lights.length) {
      const empty = document.createElement("div");
      empty.className = "text-secondary small p-2";
      empty.textContent = tr("light.006");
      this._container.appendChild(empty);
    } else {
      for (const entry of this._scene.lights) {
        this._container.appendChild(this._buildLightCard(entry));
      }
    }

    this._gizmo?.sync(this._scene.lights);
    if (this._gizmo?.getSelectedId()) {
      this.highlightLight(this._gizmo.getSelectedId());
    }
  }

  /**
   * ライトの点灯/消灯を切り替える。消灯は intensity を0にするだけ(実体は
   * 削除しない)で、再点灯時に戻せるよう直前の強度を entry._prevIntensity に
   * 退避しておく。カード側の見た目(スイッチのON/OFF・枠の明るさ)がそのまま
   * 状態を表すので、「今プレビュー中です」のような注記は不要にしている。
   */
  _setLightEnabled(id, enabled) {
    const entry = this._scene.getLight(id);
    if (!entry) return;
    const light = entry.light;
    if (enabled) {
      if (light.intensity <= 0) {
        const fallback = entry.type === "ambient" || entry.type === "hemisphere"
          ? 0.5
          : 1;
        light.intensity = entry._prevIntensity > 0
          ? entry._prevIntensity
          : fallback;
      }
    } else if (light.intensity > 0) {
      entry._prevIntensity = light.intensity;
      light.intensity = 0;
    }
  }

  /**
   * 「ソロ」: 指定したライトだけを点灯状態にし、他はすべて消灯する。
   * 各ライトのON/OFFスイッチを一括操作するショートカットにすぎないので、
   * ソロ後も気に入らなければどのライトのスイッチでも個別に戻せる。
   */
  _solo(id) {
    for (const entry of this._scene.lights) {
      this._setLightEnabled(entry.id, entry.id === id);
    }
    this.build();
    this._notify();
  }

  /**
   * ビューポート上のハンドルがドラッグされて選ばれたライトのカードを
   * ハイライトし、スクロールして見えるようにする(light-gizmo.jsから呼ばれる)。
   * @param {string|null} id
   */
  highlightLight(id) {
    const cards = this._container.querySelectorAll(".light-card");
    for (const card of cards) {
      const match = card.dataset.lightId === id;
      card.classList.toggle("light-card-selected", match);
      if (match) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  _buildEditModeToggle() {
    const wrapper = document.createElement("div");
    wrapper.className = "form-check form-switch mb-3";

    const input = document.createElement("input");
    input.className = "form-check-input";
    input.type = "checkbox";
    input.role = "switch";
    input.id = "toggle-light-edit-mode";
    input.checked = this._gizmo.isEnabled();

    const label = document.createElement("label");
    label.className = "form-check-label small";
    label.setAttribute("for", "toggle-light-edit-mode");
    label.innerHTML = tr("light.007");

    const hint = document.createElement("div");
    hint.className = "text-secondary small mb-1";
    hint.style.lineHeight = "1.4";
    hint.textContent = tr("light.008");

    input.addEventListener("change", () => {
      this._gizmo.setEnabled(input.checked);
      this._onToggleEditMode(input.checked);
      hint.classList.toggle("d-none", !input.checked);
    });
    hint.classList.toggle("d-none", !input.checked);

    wrapper.append(input, label);
    const group = document.createElement("div");
    group.append(wrapper, hint);
    return group;
  }

  _notify() {
    this._onChange();
  }

  _buildAddRow() {
    const wrapper = document.createElement("div");
    wrapper.className = "d-flex gap-2 mb-3";

    const select = document.createElement("select");
    select.className = "form-select form-select-sm";
    for (const [value, label] of Object.entries(LIGHT_TYPE_LABELS)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.value = "point";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-sm btn-outline-body text-nowrap";
    addBtn.innerHTML = tr("light.009");
    addBtn.addEventListener("click", () => {
      const type = select.value;
      const isAmbientLike = type === "ambient" || type === "hemisphere";
      // 物理ベースのライティングでは point/spot は intensity=1 だとほぼ見えないため、
      // 最初から目に見える明るさになるデフォルト値にしておく
      this._scene.addLight(type, { intensity: isAmbientLike ? 0.5 : 20 });
      this.build();
      this._notify();
    });

    wrapper.append(select, addBtn);
    return wrapper;
  }

  _buildLightCard({ id, type, light, original }) {
    const isOn = light.intensity > 0;

    const card = document.createElement("div");
    card.className = "light-card mb-3 p-2 border border-secondary rounded";
    card.classList.toggle("light-card-off", !isOn);
    card.dataset.lightId = id;

    const header = document.createElement("div");
    header.className = "d-flex align-items-center justify-content-between mb-2";

    // 点灯/消灯スイッチ。カードの明るさ(light-card-off)と常に連動しているので、
    // 一覧をざっと見ただけでどれが点いているか分かる(別途「プレビュー中」の
    // ような注記を出さなくても状態が自明になる)。
    const litSwitchWrapper = document.createElement("div");
    litSwitchWrapper.className = "form-check form-switch mb-0 me-2";
    const litSwitch = document.createElement("input");
    litSwitch.className = "form-check-input";
    litSwitch.type = "checkbox";
    litSwitch.role = "switch";
    litSwitch.checked = isOn;
    litSwitch.title = isOn ? tr("light.010") : tr("light.011");
    litSwitch.addEventListener("change", () => {
      this._setLightEnabled(id, litSwitch.checked);
      this.build();
      this._notify();
    });
    litSwitchWrapper.appendChild(litSwitch);

    const title = document.createElement("span");
    title.className = "small fw-bold";
    title.textContent = LIGHT_TYPE_LABELS[type] ?? type;

    const titleGroup = document.createElement("div");
    titleGroup.className = "d-flex align-items-center";
    titleGroup.append(litSwitchWrapper, title);

    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.className = "btn btn-sm btn-outline-warning";
    soloBtn.innerHTML = '<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="/vrm-pose-maker/icons/bootstrap-icons.svg#bullseye"/></svg>';
    soloBtn.title = tr("light.012");
    soloBtn.addEventListener("click", () => this._solo(id));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-sm btn-outline-danger";
    removeBtn.innerHTML = '<svg width="1em" height="1em" fill="currentColor" aria-hidden="true"><use href="/vrm-pose-maker/icons/bootstrap-icons.svg#trash"/></svg>';
    removeBtn.title = tr("light.013");
    removeBtn.addEventListener("click", () => {
      this._scene.removeLight(id);
      this.build();
      this._notify();
    });

    const btnGroup = document.createElement("div");
    btnGroup.className = "d-flex gap-1";
    btnGroup.append(soloBtn, removeBtn);

    header.append(titleGroup, btnGroup);
    card.appendChild(header);

    const isAmbientLike = type === "ambient" || type === "hemisphere";

    card.appendChild(
      createColorInput({
        label: isAmbientLike ? tr("light.014") : tr("mat.058"),
        value: "#" + light.color.getHexString(),
        resetValue: original.color,
        onChange: (hex) => {
          light.color.set(hex);
          this._notify();
        },
      }).element,
    );

    card.appendChild(
      createSlider({
        label: tr("light.015"),
        min: 0,
        max: isAmbientLike ? 3 : 50,
        step: isAmbientLike ? 0.05 : 0.5,
        value: light.intensity,
        resetValue: original.intensity,
        onChange: (v) => {
          light.intensity = v;
          this._notify();
        },
      }).element,
    );

    if (type === "hemisphere") {
      card.appendChild(
        createColorInput({
          label: tr("light.016"),
          value: "#" + light.groundColor.getHexString(),
          resetValue: original.groundColor,
          onChange: (hex) => {
            light.groundColor.set(hex);
            this._notify();
          },
        }).element,
      );
    }

    if (!isAmbientLike) {
      for (const axis of ["x", "y", "z"]) {
        const axisIndex = { x: 0, y: 1, z: 2 }[axis];
        card.appendChild(
          createSlider({
            label: tr("light.017", axis.toUpperCase()),
            min: -10,
            max: 10,
            step: 0.1,
            value: light.position[axis],
            resetValue: original.position?.[axisIndex],
            onChange: (v) => {
              light.position[axis] = v;
              this._notify();
            },
          }).element,
        );
      }
    }

    if (type === "point" || type === "spot") {
      card.appendChild(
        createSlider({
          label: tr("light.018"),
          min: 0,
          max: 30,
          step: 0.1,
          value: light.distance,
          resetValue: original.distance,
          onChange: (v) => {
            light.distance = v;
            this._notify();
          },
        }).element,
      );
      card.appendChild(
        createSlider({
          label: tr("light.019"),
          min: 0,
          max: 4,
          step: 0.1,
          value: light.decay,
          resetValue: original.decay,
          onChange: (v) => {
            light.decay = v;
            this._notify();
          },
        }).element,
      );
    }

    if (type === "spot") {
      card.appendChild(
        createSlider({
          // 上限はMath.PI/2ちょうどにしない: 影を落とす設定のシャドウカメラの
          // 視野角が2×angleから計算されるため、ちょうど90度だと視野角180度の
          // 不正なカメラになってしまう(影を落とすがONの時にクラッシュしうる)。
          label: tr("light.020"),
          min: 0,
          max: Math.PI / 2 - 0.05,
          step: 0.01,
          value: light.angle,
          resetValue: original.angle,
          onChange: (v) => {
            light.angle = v;
            this._notify();
          },
        }).element,
      );
      card.appendChild(
        createSlider({
          label: tr("light.021"),
          min: 0,
          max: 1,
          step: 0.01,
          value: light.penumbra,
          resetValue: original.penumbra,
          onChange: (v) => {
            light.penumbra = v;
            this._notify();
          },
        }).element,
      );
    }

    if ("castShadow" in light) {
      card.appendChild(
        createCheckbox({
          label: tr("light.022"),
          checked: light.castShadow,
          resetValue: original.castShadow,
          onChange: (checked) => {
            light.castShadow = checked;
            this._notify();
          },
        }).element,
      );
    }

    return card;
  }
}
