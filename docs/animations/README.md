Put your `.fbx` / `.glb` / `.vrma` animation files in this folder. Sub-folders
are fine — files are found recursively.

Then run, from the project root (requires [Deno](https://deno.com/)):

```
deno run --allow-read --allow-write scripts/generate-animation-list.ts
```

This (re)generates `list.txt` here (one path relative to this folder per line),
which the app's "ランダムポーズ再生" (random pose playback) button reads to know
which files it can pick from. Re-run the script any time you add, remove, or
rename files in this folder.
