#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * generate-vrm-list.ts
 *
 * src/vrm/ ディレクトリ(サブディレクトリ配下を含む)に置いた
 * モデル(*.vrm)とそのサムネイル画像を再帰的に列挙し、
 * src/vrm/list.txt に vrm/ からの相対パス(1行1ファイル)を書き出す。
 *
 * アプリ(起動時のモデル選択モーダル)は、このファイルをブラウザから fetch して
 * 同梱モデルの一覧として使う(ブラウザはディレクトリの中身を直接一覧取得できないため、
 * あらかじめこのスクリプトで一覧を作っておく必要がある)。
 *
 * ファイルの置き方(命名規則):
 *   vrm/1.vrm              モデル本体
 *   vrm/1_portrait.png     一覧に出す半身画像(3:4 推奨。任意)
 *   vrm/1_full_body.png    選択時にプレビューする全身画像(3:4 推奨。任意)
 *   画像の形式は何でもよい(png / webp / avif / jpg / gif / bmp / svg)。
 *   同じ画像が複数の形式であるときは、軽い形式(avif > webp > png > jpg …)をアプリが使う。
 *   画像はアプリの「半身撮影」「全身撮影」ボタンで保存できる(ファイル名もこの規則になる)。
 *
 * 使い方 (Deno が必要: https://deno.com/):
 *   `deno run --allow-read --allow-write scripts/generate-vrm-list.ts`
 *   ファイルを追加・削除・リネームしたら、その都度再実行して list.txt を更新してください。
 *
 * 補足:
 *   - 「.」で始まるファイル/フォルダ(.DS_Store など)は無視します。
 *   - URL として扱えない名前(# ? % を含む)は警告を出して除外します。
 *   - 並び順は名前順(数字は数値として比較: 2 → 10)。アプリの一覧もこの順に並びます。
 *   - シンボリックリンクは辿ります(循環は検出して無視します)。
 */

const MODEL_EXTENSIONS = /\.vrm$/i;
const IMAGE_EXTENSIONS = /\.(avif|webp|png|apng|jpe?g|jfif|gif|bmp|svg)$/i;

const vrmDir = new URL("../src/vrm/", import.meta.url);
const listPath = new URL("list.txt", vrmDir);
const rootPath = decodeURIComponent(vrmDir.pathname).replace(/\/$/, "");

const files: string[] = [];
const visited = new Set<string>();

function walk(dirPath: string, relativeDir: string): void {
  const realDir = Deno.realPathSync(dirPath);
  if (visited.has(realDir)) return; // シンボリックリンクによる循環を避ける
  visited.add(realDir);

  for (const entry of Deno.readDirSync(dirPath)) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = `${dirPath}/${entry.name}`;
    const relativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;

    let isDirectory = entry.isDirectory;
    let isFile = entry.isFile;
    if (entry.isSymlink) {
      try {
        const stat = Deno.statSync(fullPath);
        isDirectory = stat.isDirectory;
        isFile = stat.isFile;
      } catch {
        continue; // リンク切れ
      }
    }

    if (isDirectory) {
      walk(fullPath, relativePath);
    } else if (
      isFile &&
      (MODEL_EXTENSIONS.test(entry.name) || IMAGE_EXTENSIONS.test(entry.name))
    ) {
      if (/[#?%]/.test(relativePath)) {
        console.warn(
          `警告: URL として扱えない文字(# ? %)を含むため除外しました: ${relativePath}`,
        );
        continue;
      }
      files.push(relativePath);
    }
  }
}

try {
  walk(rootPath, "");
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.error(`ディレクトリが見つかりません: ${rootPath}`);
    console.error(
      "src/vrm/ フォルダを作成し、.vrm ファイル(と画像)を置いてから再実行してください。",
    );
    Deno.exit(1);
  }
  throw err;
}

files.sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));

const models = files.filter((name) => MODEL_EXTENSIONS.test(name));
if (models.length === 0) {
  console.warn(
    `警告: ${rootPath} 以下に .vrm ファイルが見つかりませんでした。list.txt は空のまま作成します。`,
  );
}

// サムネイルが無いモデルを知らせる(無くてもアプリは動く。その場合は仮のアイコンが出る)
const fileSet = new Set(files.map((name) => name.replace(/\.[^./]+$/, "")));
for (const model of models) {
  const stem = model.replace(/\.vrm$/i, "");
  const missing = ["portrait", "full_body"].filter((slot) =>
    !fileSet.has(`${stem}_${slot}`)
  );
  if (missing.length > 0) {
    console.warn(
      `注意: ${model} に画像がありません: ${
        missing.map((slot) => `${stem}_${slot}.*`).join(", ")
      }`,
    );
  }
}

Deno.writeTextFileSync(listPath, files.map((name) => name + "\n").join(""));
console.log(
  `${files.length} 件のファイル(モデル ${models.length} 件)を ${
    decodeURIComponent(listPath.pathname)
  } に書き出しました。`,
);
