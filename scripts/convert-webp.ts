import { fromFileUrl } from "jsr:@std/path";

const root = fromFileUrl(new URL("../src/vrm", import.meta.url));
const quality = 90;

async function convert(dir: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;

    if (entry.isDirectory) {
      await convert(path);
      continue;
    }

    if (!entry.isFile || !/\.png$/i.test(entry.name)) continue;

    const output = path.replace(/\.png$/i, ".webp");
    const command = new Deno.Command("cwebp", {
      args: ["-quiet", "-q", String(quality), path, "-o", output],
      stdout: "null",
      stderr: "piped",
    });

    const result = await command.output();

    if (!result.success) {
      console.error(
        `${path}: ${new TextDecoder().decode(result.stderr)}`,
      );
      continue;
    }

    console.log(`${path} -> ${output}`);
  }
}

await convert(root);
