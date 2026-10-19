/**
 * i18n.js - 表示言語ごとの文言を、HTML側に埋め込んだ辞書から引く最小限のヘルパー。
 *
 * 文言(言語情報)はJSに持たせず、各言語のHTML(index.html / en/index.html)内の
 *   <script type="application/json" id="i18n">{ "キー": "文言" }</script>
 * に置く。JSはキーだけを知っている。文言中の {0}, {1} … は引数で置き換える。
 */
let dictionary = null;

function load() {
  try {
    dictionary = JSON.parse(document.getElementById("i18n").textContent);
  } catch {
    dictionary = {};
  }
}

/** キーに対応する文言を返す(辞書にキーが無ければキーをそのまま返す) */
export function tr(key, ...args) {
  if (!dictionary) load();
  const text = dictionary[key] ?? key;
  return text.replace(
    /\{(\d+)\}/g,
    (m, i) => (args[i] !== undefined ? String(args[i]) : m),
  );
}
