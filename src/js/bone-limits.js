/**
 * bone-limits.js - ボーンごとの可動域(data/bone-limits.json)の読み込みと参照
 *
 * 可動域の定義本体は JSON にある(他のツールからも使い回せるよう、three.js に依存しない形式)。
 * 座標系・オイラー順・左右ミラー規則は JSON 内の frame / eulerOrder / mirror を参照。
 *
 * JSON には左と中央のボーンだけが書かれており、右のボーンは
 * 「YZ 平面でのミラー」(x はそのまま、y と z は [min,max] → [-max,-min])で導出する。
 */

const DEG = Math.PI / 180;
const URL_LIMITS = new URL("../data/bone-limits.json", import.meta.url);

/** 反対側のボーン名(left↔right)。対がなければ null */
function mirrorName(name) {
  if (name.startsWith("left")) return "right" + name.slice(4);
  if (name.startsWith("right")) return "left" + name.slice(5);
  return null;
}

/** JSON のボーン定義 → 実行時用(ラジアン、軸ごとの [min,max]) */
function toRuntime(def, mirrored) {
  const range = (axis) => {
    const [lo, hi] = def[axis].range;
    const r = mirrored && axis !== "x" ? [-hi, -lo] : [lo, hi];
    return [r[0] * DEG, r[1] * DEG];
  };
  return {
    order: def.order,
    x: range("x"),
    y: range("y"),
    z: range("z"),
    randomize: def.randomize ?? true, // true | false | "explicit"
    curl: def.curl ?? null,
  };
}

let table = null; // { boneName: runtime def }
let loading = null;

/** 可動域テーブルを読み込む(2回目以降はキャッシュを返す) */
export function loadBoneLimits() {
  if (table) return Promise.resolve(table);
  loading ??= fetch(URL_LIMITS)
    .then((res) => {
      if (!res.ok) throw new Error(`bone-limits.json: HTTP ${res.status}`);
      return res.json();
    })
    .then((json) => {
      const t = {};
      for (const [name, def] of Object.entries(json.bones)) {
        t[name] = toRuntime(def, false);
        const other = mirrorName(name);
        if (other && name.startsWith("left")) t[other] = toRuntime(def, true);
      }
      table = t;
      return t;
    })
    .catch((e) => {
      loading = null; // 次回また試せるように
      throw e;
    });
  return loading;
}

/**
 * 指定ボーンの可動域を取得(loadBoneLimits 完了後に使う)
 * @param {string} boneName
 * @returns {{order:string, x:[number,number], y:[number,number], z:[number,number],
 *            randomize:boolean|"explicit", curl:string|null}|null} 角度はラジアン。定義がなければ null
 */
export function getBoneLimit(boneName) {
  return table?.[boneName] ?? null;
}
