#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * generate-animation-list.ts
 *
 * animations/ ディレクトリ(サブディレクトリ配下を含む)に置いた
 * *.fbx / *.glb / *.vrma ファイルを再帰的に列挙し、
 * animations/list.txt に animations/ からの相対パス(1行1ファイル)を書き出す。
 *
 * アプリの「ランダムポーズ再生」機能は、このファイルをブラウザから
 * fetch して読み込むリストとして使う(ブラウザはディレクトリの中身を直接
 * 一覧取得できないため、あらかじめこのスクリプトで一覧を作っておく必要がある)。
 *
 * 使い方 (Deno が必要: https://deno.com/):
 *   1. animations/ フォルダ(または、その下の好きなサブフォルダ)に
 *      *.fbx / *.glb / *.vrma ファイルを置く
 *   2. `deno run --allow-read --allow-write scripts/generate-animation-list.ts` を実行する
 *      (実行権限を付けていれば `./scripts/generate-animation-list.ts` でも可)
 *   3. animations/list.txt が生成される(既存の場合は上書きされる)
 *
 * ファイルを追加・削除・リネームしたら、その都度このスクリプトを
 * 再実行して list.txt を更新してください。
 *
 * 補足:
 *   - 「.」で始まるファイル/フォルダ(.DS_Store など)は無視します。
 *   - シンボリックリンクは辿ります(循環は検出して無視します)。
 */

const EXTENSIONS = /\.(fbx|glb|vrma)$/i;

const animationsDir = new URL("../src/animations/", import.meta.url);
const listPath = new URL("list.txt", animationsDir);
const rootPath = decodeURIComponent(animationsDir.pathname).replace(/\/$/, "");

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

    if (isDirectory) walk(fullPath, relativePath);
    else if (isFile && EXTENSIONS.test(entry.name)) files.push(relativePath);
  }
}

try {
  walk(rootPath, "");
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.error(`ディレクトリが見つかりません: ${rootPath}`);
    console.error(
      "animations/ フォルダを作成し、.fbx / .glb / .vrma ファイルを置いてから再実行してください。",
    );
    Deno.exit(1);
  }
  throw err;
}

files.sort((a, b) => a.localeCompare(b, "ja"));

if (files.length === 0) {
  console.warn(
    `警告: ${rootPath} 以下に .fbx / .glb / .vrma ファイルが見つかりませんでした。list.txt は空のまま作成します。`,
  );
}

Deno.writeTextFileSync(listPath, files.map((name) => name + "\n").join(""));
console.log(
  `${files.length} 件のファイルを ${
    decodeURIComponent(listPath.pathname)
  } に書き出しました。`,
);
