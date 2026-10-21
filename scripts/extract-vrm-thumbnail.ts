// VRM ファイルに埋め込まれたサムネイル画像を取り出して保存する。
//
// 使い方:
//   deno run --allow-read --allow-write scripts/extract-vrm-thumbnail.ts model.vrm
//   deno run --allow-read --allow-write scripts/extract-vrm-thumbnail.ts a.vrm b.vrm --out-dir thumbs
//
// 出力ファイル名は <VRM のファイル名(拡張子なし)>.<png|jpg|webp>。
// --out-dir を省略すると VRM と同じフォルダに保存する。
//
// VRM0 (extensions.VRM.meta.texture) と VRM1 (extensions.VRMC_vrm.meta.thumbnailImage) の両方に対応。

import { basename, dirname, extname, join } from "node:path";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

type GltfJson = {
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  textures?: { source?: number }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number }[];
  extensions?: {
    VRM?: { meta?: { texture?: number } };
    VRMC_vrm?: { meta?: { thumbnailImage?: number } };
  };
};

type Thumbnail = { data: Uint8Array; ext: string };

function parseGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("GLB (VRM) ファイルではありません");
  }
  const totalLength = Math.min(view.getUint32(8, true), bytes.byteLength);

  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) throw new Error("GLB のチャンクが壊れています");
    if (chunkType === CHUNK_JSON && json === null) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)));
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, end);
    }
    offset = end;
  }
  if (json === null) throw new Error("JSON チャンクが見つかりません");
  return { json, bin };
}

function findThumbnailImageIndex(json: GltfJson): number | null {
  // VRM1: meta.thumbnailImage は images の index
  const v1 = json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (typeof v1 === "number") return v1;

  // VRM0: meta.texture は textures の index → source が images の index
  const v0 = json.extensions?.VRM?.meta?.texture;
  if (typeof v0 === "number" && v0 >= 0) {
    const source = json.textures?.[v0]?.source;
    if (typeof source === "number") return source;
  }
  return null;
}

function extFromMime(mime: string | undefined, data: Uint8Array): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  // mimeType が無いときはマジックナンバーで判定
  if (data[0] === 0x89 && data[1] === 0x50) return "png";
  if (data[0] === 0xff && data[1] === 0xd8) return "jpg";
  if (data[0] === 0x52 && data[1] === 0x49) return "webp";
  return "bin";
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) {
    throw new Error("外部 URI の画像には対応していません");
  }
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (!meta.endsWith(";base64")) {
    return new TextEncoder().encode(decodeURIComponent(body));
  }
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export function extractThumbnail(vrmBytes: Uint8Array): Thumbnail | null {
  const { json, bin } = parseGlb(vrmBytes);
  const imageIndex = findThumbnailImageIndex(json);
  if (imageIndex === null) return null;

  const image = json.images?.[imageIndex];
  if (!image) throw new Error(`images[${imageIndex}] が存在しません`);

  if (image.bufferView !== undefined) {
    const bv = json.bufferViews?.[image.bufferView];
    if (!bv) throw new Error(`bufferViews[${image.bufferView}] が存在しません`);
    if (!bin) throw new Error("BIN チャンクが見つかりません");
    const start = bv.byteOffset ?? 0;
    const data = bin.slice(start, start + bv.byteLength); // コピーして返す
    return { data, ext: extFromMime(image.mimeType, data) };
  }
  if (image.uri) {
    const data = decodeDataUri(image.uri);
    return { data, ext: extFromMime(image.mimeType, data) };
  }
  return null;
}

async function main(args: string[]): Promise<number> {
  const files: string[] = [];
  let outDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out-dir" || arg === "-o") {
      outDir = args[++i] ?? null;
      if (outDir === null) {
        console.error("--out-dir にはフォルダ名が必要です");
        return 1;
      }
    } else if (arg === "--help" || arg === "-h") {
      files.length = 0;
      break;
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error(
      "使い方: deno run --allow-read --allow-write scripts/extract-vrm-thumbnail.ts <model.vrm>... [--out-dir <dir>]",
    );
    return 1;
  }

  if (outDir !== null) await Deno.mkdir(outDir, { recursive: true });

  let failed = 0;
  for (const file of files) {
    try {
      const bytes = await Deno.readFile(file);
      const thumb = extractThumbnail(bytes);
      if (thumb === null) {
        console.warn(`スキップ: ${file} (サムネイルが埋め込まれていません)`);
        failed++;
        continue;
      }
      const stem = basename(file, extname(file));
      const dest = join(outDir ?? dirname(file), `${stem}.${thumb.ext}`);
      await Deno.writeFile(dest, thumb.data);
      console.log(`保存: ${dest} (${(thumb.data.byteLength / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.error(`失敗: ${file}: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
