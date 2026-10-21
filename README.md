# VRM Pose Maker

A browser-based tool for posing VRM avatars (bone rotation/position,
expressions, camera, background) and saving the result. Runs entirely
client-side (Three.js + `@pixiv/three-vrm`, loaded via CDN `importmap` — no
build step, no server).

## Features

- Load one or more VRM models into the same scene. A start-up picker lists the
  bundled models (`src/vrm/`); files can also be chosen, dropped or pasted.
  Draco-compressed VRM / GLB files are supported.
- Pose bones by dragging in 3D (sphere or gizmo), with sliders, or mirror a limb
  to the other side.
- Load a pose or animation from `.glb` / `.fbx` / `.vrma`, pause on a good
  frame, or play random animations from `src/animations/` on loop.
- Adjust facial expressions.
- Edit lights (ambient / directional / point / spot / hemisphere) and every
  MToon / PBR material parameter.
- Edit the background (color, image or video) and toggle the floor grid.
- Save / load a pose (`.vrma`), copy / paste a pose via the clipboard, and save
  / load a whole project (`.vrmposer.json`).
- Take a screenshot (up to ×4, optionally transparent), or shoot a waist-up /
  full-body transparent PNG (600×800) for the model picker.

## Bundled models

Put models and thumbnails in `src/vrm/` (sub-folders allowed) and generate the
list with [Deno](https://deno.com/):

```
src/vrm/1.vrm            the model
src/vrm/1_portrait.png   list thumbnail, waist-up (optional)
src/vrm/1_full_body.png  preview shown when selected (optional)
```

```sh
deno run --allow-read --allow-write scripts/generate-vrm-list.ts
```

Thumbnails can be any image format (`png`, `webp`, `avif`, `jpg`, …); the
footer's "半身撮影" / "全身撮影" buttons save them with these names. Random
animations use `scripts/generate-animation-list.ts` the same way, and
`scripts/extract-vrm-thumbnail.ts` extracts a VRM's embedded thumbnail. `docs/`
is the generated site; run `build.sh` after changing `src/`.

## File formats

### `.vrma` (pose only)

A glTF 2.0 JSON document using the
[`VRMC_vrm_animation` 1.0](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0)
extension, holding one static frame: per humanoid bone the local rotation (plus
position for `hips`), and non-neutral expression weights. The clipboard copy is
the same JSON as text.

### `.vrmposer.json` (whole scene)

Everything needed to restore a scene, including the original VRM bytes, so a
project is self-contained (and large). Older versions (`1`, `2`) still load.

```jsonc
{
  "format": "vrm-pose-project",
  "version": 3,
  "savedAt": "2026-09-21T12:34:56.000Z",
  "scene": {
    "background": { "color": "#1a1a2e", "image": "data:image/png;base64,... | null" },
    "gridVisible": true,
    "camera": {
      "position": [x, y, z],
      "quaternion": [x, y, z, w],
      "target": [x, y, z],
      "fov": 30
    },
    "lights": [
      {
        "id": "light-...",
        "type": "ambient|directional|point|spot|hemisphere",
        "color": "#ffffff",
        "intensity": 1,
        "position": [x, y, z],              // not for ambient/hemisphere
        "groundColor": "#444444",           // hemisphere only
        "distance": 0, "decay": 2,          // point/spot only
        "angle": 0.5, "penumbra": 0.2,      // spot only
        "castShadow": false                 // not for ambient/hemisphere
      }
    ]
  },
  "models": [
    {
      "name": "character.vrm",
      "data": "data:model/gltf-binary;base64,...",   // the original .vrm, embedded
      "transform": { "position": [x, y, z], "quaternion": [x, y, z, w], "scale": [x, y, z] },
      "pose": {
        "hips": { "rotation": [x, y, z, w], "position": [x, y, z] },
        "spine": { "rotation": [x, y, z, w] }
        // one entry per humanoid bone; position only for hips
      },
      "expressions": { "happy": 0, "blink": 1 },     // name -> weight (0-1)
      "materials": {
        // keyed by material name ("material-<index>" if unnamed)
        "Face": { "type": "mtoon", "color": "#ffffff", "shadeColorFactor": "#c8c8c8", "...": "..." }
      }
    }
  ]
}
```
