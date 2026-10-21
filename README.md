# VRM Pose Maker

A browser-based tool for posing VRM avatars (bone rotation/position,
expressions, camera, background) and saving the result. Runs entirely
client-side (Three.js + `@pixiv/three-vrm`, loaded via CDN `importmap` — no
build step, no server).

Open `src/index.html` in a browser (served over `http://`/`https://`, not
`file://`, since ES module imports and some browser APIs require it).

## Features

- Load one or more VRM models into the same scene, switch between them via the
  face-icon chips in the sidebar. A start-up picker offers the bundled models
  (see "Bundled models" below), or you can choose a file from your device.
- Pose bones by dragging in 3D (sphere or gizmo manipulation mode).
- Load poses/animations from a `.glb`, `.fbx` or `.vrma` file with one button
  ("ポーズ読込", the format is detected from the extension), and pause on a good
  frame to capture a pose.
- Play a random animation (`.fbx` / `.glb` / `.vrma`, including files in
  sub-folders) on loop, automatically moving to another random one each time the
  current one finishes — useful for browsing a large pile of reference
  animations without building a picker UI for them.
- Edit scene lighting (add/remove any number of ambient, directional, point,
  spot or hemisphere lights; color, intensity and all other per-type parameters)
  and material appearance (every parameter of three-vrm's MToon shader, plus the
  common properties of non-MToon/fallback PBR materials) — see "Lights and
  materials" below.
- Draco-compressed (`KHR_draco_mesh_compression`) VRM / GLB files load too. The
  decoder is fetched from the same CDN and version as three.js the first time a
  compressed mesh is loaded, so uncompressed models are not affected.
- Adjust facial expressions.
- Edit background color/image and toggle the floor grid.
- Save/load a pose, save/load a whole project, copy/paste a pose via the
  clipboard, and take a screenshot.

## Bundled models (start-up picker)

If `vrm/list.txt` exists, a modal listing the bundled models opens at start-up
(and when you press "VRM読込" / "Add VRM"; it also has a "choose a file from this
device" button). Only the thumbnails are fetched while browsing the list — a
model's `.vrm` is downloaded only after you choose it.

Put the files in `src/vrm/` (sub-folders are fine) using this naming:

```
src/vrm/
  1.vrm              the model
  1_portrait.png     thumbnail shown in the list (waist-up, 3:4)   — optional
  1_full_body.png    larger preview shown when selected (3:4)      — optional
  list.txt           generated, see below
```

- Thumbnails may be **any image format** (`png`, `webp`, `avif`, `jpg`, `gif`,
  `bmp`, `svg`). If the same thumbnail exists in several formats the lighter one
  is used (`avif` > `webp` > `png` > `jpg` …), so converting a PNG to WebP and
  keeping both files is fine.
- Either thumbnail may be missing: the other one is used, and a placeholder icon
  is shown when there is neither.
- Generate the list (re-run whenever you add, remove or rename files):

  ```
  deno run --allow-read --allow-write scripts/generate-vrm-list.ts
  ```

  It writes `src/vrm/list.txt` (one relative path per line, natural sort order,
  so `2` comes before `10`) and warns about models without thumbnails. The list
  location is set by `data-vrm-list` on `<body>` in each language's HTML. Without
  a list the app behaves as before (a file dialog).

### Making the thumbnails

The footer has two buttons, "半身撮影" (Portrait shot) and "全身撮影" (Full-body
shot). They photograph the model being edited from the front, in its **current
pose and expression**, and save a transparent 600×800 PNG (twice VRoid Hub's
300×400) named `<model>_portrait.png` / `<model>_full_body.png` — exactly the
names above. The camera is framed automatically: the portrait runs from the top
of the head to the waist (the hips bone), the full-body shot fits the whole body
including outstretched arms. The on-screen view is not touched, and other
models, the floor grid and the editing overlays are left out. Pose the model
first (reset the pose for a neutral stance) and drop the files into `src/vrm/`.

If a VRM already contains an embedded thumbnail, you can extract it as a starting
point (VRM0 and VRM1 are both supported; a VRM can hold only one):

```
deno run --allow-read --allow-write scripts/extract-vrm-thumbnail.ts model.vrm [more.vrm ...] [--out-dir dir]
```

`docs/` is the generated site (`build.sh` copies and minifies `src/`), so run
`build.sh` after adding models.

## Saving and loading poses

## Random animation playback

"ランダムポーズ再生" plays a random `.fbx` / `.glb` / `.vrma` from the
`animations/` folder (sub-folders at any depth included), then automatically
loads another random one each time the current one finishes. Rather than a hard
cut, it smoothly blends from the end pose of the finishing clip to the start
pose of the next one (bone rotations/positions are interpolated directly, since
each load creates a fresh `AnimationMixer` and three.js's built-in `crossFadeTo`
only works between actions on the same mixer). It keeps playing on whichever
model it was started on even if you switch to a different model in the meantime
(same as manually-loaded animations); click the button again to stop it. Loading
a file manually, or starting random playback on a model that already has one
running, stops the previous random loop for that model first.

This is meant for browsing a large collection of reference animations you
already have, without needing a picker UI for hundreds of files:

1. Put your `.fbx` / `.glb` / `.vrma` files in `animations/` (a sibling of
   `src/`, at the project root — create the folder if it doesn't exist). Files
   may be organised in sub-folders; they are found recursively.
2. Generate the list the app reads, using [Deno](https://deno.com/):
   ```
   deno run --allow-read --allow-write scripts/generate-animation-list.ts
   ```
   This writes `animations/list.txt` (one path relative to `animations/` per
   line, e.g. `dance/step1.fbx`; hidden files/folders starting with `.` are
   skipped). Re-run it whenever you add, remove, or rename files in
   `animations/`.
3. Open the app and click "ランダムポーズ再生". A file that fails to load (e.g.
   a `.glb` without humanoid bones) is skipped and another one is picked.

The app fetches `animations/list.txt` (a plain text file, not part of the
`import`ed JS) at runtime, picks a random line from it, and fetches that file by
its relative path. The URL it fetches the list from is a single
`const ANIMATION_LIST_URL` near the top of `src/js/app.js` — change it there if
you serve `animations/` from somewhere else (e.g. a different relative path, or
an absolute URL). The transition duration is `RANDOM_ANIMATION_TRANSITION_S`
(seconds, set to `0` to disable it) right next to it.

Since browsers can't list a folder's contents directly over `fetch`/`http`,
`list.txt` has to be generated ahead of time — that's all the script does.

## Lights and materials

The "背景・ライト" (background/lights) tab's lower half is a lights editor: add
any number of lights (ambient, directional, point, spot, hemisphere), and edit
each one's color, intensity, and type-specific settings (position for everything
but ambient/hemisphere; distance/decay for point/spot; angle/ penumbra for spot;
ground color for hemisphere; a shadow-casting toggle for everything but
ambient/hemisphere). Lights apply to the whole scene, not a single model.

Shadow casting is off by default (models still have `castShadow`/
`receiveShadow` set, so self-shadowing shows up as soon as you enable it on a
light) because re-rendering a shadow map every frame is one of the more
expensive things a WebGL scene can do — turn it on per-light only if you want
that look, and expect it to cost noticeably more CPU/GPU than the default.

Every light's shadow camera (near/far, and for a directional light the
left/right/top/bottom frustum too) is sized for this app's scale — a single
character roughly human-height — rather than three.js's own defaults, which
assume a large outdoor scene (far=500, and for directional an 11×11-unit
frustum) and leave almost no depth precision for anything small and close
together, like a VRM's layered clothes/hair/skin. That's a real quality
improvement on its own, but it wasn't the cause of a more serious bug this app
used to have: turning "影を落とす" on for a **spot light** made the whole
character vanish outright. That one traced back to a genuine version mismatch
between the two pinned libraries — `@pixiv/three-vrm@3.1.3`'s MToon shader still
referenced a shadow-map shader variable (`vSpotShadowCoord`) that three.js
renamed/restructured (`vSpotLightCoord`) for spot lights a number of releases
before `three@0.169.0`, so the shader failed to compile and nothing using that
material drew at all, for any spot light with shadows on. The fix was bumping
three-vrm to `3.5.5`, which added the matching compatibility branch for current
three.js — not an app bug on this project's end, but worth recording here in
case the pinned CDN versions ever need revisiting again.

Positioning a light with the X/Y/Z number sliders alone is hard to picture, so
there's also a "ビューでライト位置を編集" (edit light position in the viewport)
switch at the top of the lights editor. Turning it on draws a colored handle
sphere in the 3D view at each light's position (ambient and hemisphere lights
have no position, so they don't get one). On top of that:

- Directional and spot lights get a line from the handle to the origin (the
  light's target — always the origin in this app), so you can see which way the
  light is actually pointing.
- Spot lights also get a cone wireframe built from their angle and distance
  sliders, and point lights get a sphere wireframe sized to their distance
  slider, so the "range" those two sliders already control (attenuation
  distance, cone angle) is something you can actually see instead of just
  numbers. A point light's distance of 0 means "infinite range" and isn't
  drawable, so no sphere is shown in that case.
- Both of those range indicators end in a small white handle you can grab
  directly: for a spot light it sits at the tip of the cone, for a point light
  it sits on the sphere's surface (along the camera's right side, so it's
  reachable from any angle). Dragging it in/out changes the distance slider's
  value live, same as moving the number — pull it away from the light to widen
  the range, push it in to shrink it. Since a point light at distance 0 has no
  sphere to show yet, its handle still appears at a default radius of 3 so
  there's something to grab to set an initial range.

While this mode is on:

- Drag a handle to move that light in the camera's screen plane.
- Shift+drag a handle to push/pull it along the camera's view direction (depth),
  since plane-dragging alone can't reach "nearer/farther".
- Click a handle without dragging to just select it — its card in the list
  scrolls into view and highlights, so you can confirm which light you're
  looking at before tweaking its other sliders.

Turning the switch on disables bone selection/posing in the viewport so the two
don't fight over the same drag gestures; turn it back off to return to posing.
The numeric X/Y/Z sliders stay in sync and still work normally — the handles are
just another way to set the same values.

Each light card also has an on/off switch next to its type name, and a "ソロ"
(solo) button (the target-looking icon). The switch just zeroes that light's
intensity (remembering the previous value so turning it back on restores it) — a
card dims as soon as its light is off, so a glance at the list tells you what's
actually lit without needing any extra status text. Solo is a shortcut for that
same switch: it turns the chosen light on and every other light off in one
click, which is the fastest way to judge what one light is doing on its own —
most useful for a directional light, where a direction change can be hard to see
once it's mixed in with ambient light and others, especially on a toon-shaded
(MToon) model whose lit/shadow boundary is a hard edge rather than a gradient.
Since solo is really just flipping the same per-light switches, nothing is
hidden or special-cased — you can always tell what's on by looking at which
cards are dim, and turn any of them back on individually. If a light still looks
like it's doing nothing even solo'd, the next thing to check is that material's
"シェーデ ィングの境界" (shading shift) and "トゥーニー" (shading toony) sliders
on the マテリアル tab — pushed to certain extremes, MToon can keep a whole mesh
in its "lit" zone (or its "shade" zone) regardless of light direction.

On that note: a directional light is a parallel-ray light like sunlight — every
point in the scene gets hit by light coming from the exact same direction, with
no falloff by distance. But "same direction everywhere" is not the same as
"lights every surface equally." Like real sunlight, how lit a given point on the
model looks still depends on the angle between that surface and the light
direction: a patch facing toward the light is lit, a patch facing away from it
isn't — so lighting the character from the front legitimately leaves the back
comparatively dark, the same way the back of a person facing the sun is in their
own shadow. (That falloff by surface angle happens automatically; it's separate
from cast shadows, which is the "影を落とす" checkbox and handles one part of
the model blocking the light from reaching another, like an arm shadowing the
torso.) If flipping the directional light's position doesn't produce that kind
of front/back difference even once you solo it, that's a real sign something's
off with the model's shading setup rather than the light itself.

The "マテリアル" tab is a per-model materials editor. It lists every unique
material used by the active model's meshes, plus a first, default-selected
"すべてのマテリアル" (all materials) entry that edits every material on the
model at once — handy for a quick, uniform stylistic change without having to
click through each part individually. A few properties are deliberately left out
of that bulk mode (opacity, alpha cutoff, "enable transparency", and PBR+
transmission): VRMs routinely rely on different materials having different
values for these — face-shadow decals, blush, and eyelashes are typically
semi-transparent overlays while the body/hair are fully opaque, and PBR+
transmission is what makes a surface glass-like. Broadcasting one of those
values to every material at once tends to make the whole model transparent or
punch holes in it, so these only show up once you pick that one specific
material.

For a single material (whether picked directly or reached by editing "all"), it
exposes:

- For `@pixiv/three-vrm`'s **MToonMaterial** (VRM's toon shader): every
  parameter it has — lit color, shade color/shift/toony, GI equalization,
  parametric rim light, matcap tint, outline (mode/width/color/lighting mix),
  emissive, UV animation scroll/rotation, alpha (opacity/cutoff/transparency),
  double-sided, ignore-vertex-color, VRM0-compat shading, and debug view mode.
  Texture slots themselves aren't editable (there's no image upload here), but
  every numeric/color factor that modulates them is.
- For a non-MToon material (a plain PBR/`MeshStandardMaterial`-style fallback,
  which some VRMs use instead of MToon): color, opacity, alpha cutoff,
  transparency, double-sided, wireframe, metalness/roughness, and emissive.
- If that material actually is `MeshPhysicalMaterial` ("PBR+" — only ever
  generated when the VRM's glTF has `KHR_materials_*` extensions such as
  clearcoat, transmission, sheen, or iridescence attached to it), the extra PBR+
  parameters (clearcoat/clearcoat roughness, IOR, transmission,
  thickness/attenuation distance/attenuation color, sheen/sheen roughness/ sheen
  color, specular intensity/color, iridescence/iridescence IOR,
  anisotropy/rotation, dispersion) show up too, automatically.

Other shading models some VRM tools let you preview with (Phong, Lambert, Basic,
Toon, matcap-only) aren't things a VRM file itself can contain — glTF/VRM has no
extension for them, so they only exist in an app if that app added a separate
"convert this material to a different shading model" feature. This app doesn't
have that; it only edits whatever material a loaded VRM actually came with
(always MToon or PBR/PBR+ in practice).

One MToon quirk worth knowing: the outline you see is rendered by a **separate,
cloned material** three-vrm generates at load time (only if the model's outline
was already enabled then). Editing outline settings here keeps that clone in
sync automatically, and turning outlines on for a material that didn't have any
at load time creates that second pass on the fly — but this is all handled for
you; it's only mentioned in case the outline ever looks like it "lags" a manual
edit made some other way (e.g. directly through the browser console).

Both lights and per-model material edits are included when you save a project
(see below), so they survive reloading it.

### `.vrma` file (pose only, one model)

**Save**: "ポーズ保存" writes the current pose of the active model to a `.vrma`
file. **Load**: "ポーズ読込" accepts `.glb`, `.fbx` and `.vrma` (detected by
extension). A `.vrma`/`.glb` holding a single static pose (like the files this
app saves) is applied as a pose you can keep editing; a multi-frame
`.vrma`/`.glb` or an `.fbx` is played as an animation — pause it on a good frame
to capture the pose. A `.glb` that is not a VRMA is retargeted from Mixamo-style
bone names, the same as `.fbx`.

A `.vrma` file produced by this app is a plain-text
[glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) JSON
document (not the binary `.glb` container — the single data buffer it needs is
embedded directly in the JSON as a `data:` URI, which is an equally valid way to
store a glTF/VRMA file) using the
[`VRMC_vrm_animation` 1.0](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0)
extension. It only contains one static frame held for one second (a `STEP`
interpolated keyframe at t=0 and t=1), not a real animation — it's a convenient
way to store/exchange a single pose using a format other VRM tools (that support
VRMA) can also read. It stores, per humanoid bone: local rotation (and, for
`hips` only, position), plus any non-neutral facial expression weights under
`extensions.VRMC_vrm_animation.expressions`.

### Drag & drop and file paste

Files can be dropped anywhere on the window, or pasted with Ctrl+V after copying
them in the file manager (Explorer / Finder). They are sorted by extension:
`.vrm` adds a model, `.glb` / `.fbx` / `.vrma` is handled like "ポーズ読込", and
`.vrmposer.json` loads a project. (Browsers cannot put a _file_ on the clipboard
from a web page, so "ポーズをクリップボードにコピー" stays text-based; use
"ポーズ保存" to get a file.)

### Clipboard copy/paste (pose only, quick transfer between models)

"ポーズをクリップボードにコピー" builds the exact same VRMA JSON described above
and writes it to the system clipboard as plain text — no extra encoding on top,
since it's already JSON text. "ポーズをクリップボードから貼付" reads that text
back and applies it to whichever model is currently active — so the usual flow
is: select model A → copy → select model B → paste, to copy a pose from one
loaded model to another without saving a file. The clipboard content is exactly
what a saved `.vrma` file would contain, so pasting a `.vrma` file's contents
(opened as text) works too, and vice versa.

### Project file (`.vrmposer.json`, whole scene)

"プロジェクト保存"/"プロジェクト読込" save and restore everything: every loaded
model (the original VRM file data itself, embedded), its pose, expressions,
material edits, and placement in the scene, plus the background, grid, lights
and camera. This is the only format that survives closing the browser tab and
keeps multiple models together.

It's a JSON file with this shape:

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
        "id": "light-...",                  // stable id, used to match lights across saves
        "type": "ambient|directional|point|spot|hemisphere",
        "color": "#ffffff",
        "intensity": 1,
        "position": [x, y, z],              // omitted for ambient/hemisphere
        "groundColor": "#444444",           // hemisphere only
        "distance": 0, "decay": 2,          // point/spot only
        "angle": 0.5, "penumbra": 0.2,      // spot only
        "castShadow": false                 // everything but ambient/hemisphere
      }
    ]
  },
  "models": [
    {
      "name": "character.vrm",
      "data": "data:model/gltf-binary;base64,...",   // the original .vrm file, embedded whole
      "transform": {
        "position": [x, y, z],
        "quaternion": [x, y, z, w],
        "scale": [x, y, z]
      },
      "pose": {
        "hips": { "rotation": [x, y, z, w], "position": [x, y, z] },
        "spine": { "rotation": [x, y, z, w] }
        // ... one entry per humanoid bone that exists on the model, rotation always
        // present, position only present for bones the app tracks a position for (hips)
      },
      "expressions": { "happy": 0, "blink": 1 }, // expression name -> weight (0-1)
      "materials": {
        // one entry per unique material on the model, keyed by the material's
        // name (or "material-<index>" if it has none); see the "Lights and
        // materials" section above for what each field means
        "Face": { "type": "mtoon", "color": "#ffffff", "shadeColorFactor": "#c8c8c8", "...": "..." },
        "Hair": { "type": "mtoon", "outlineWidthMode": "worldCoordinates", "...": "..." }
      }
    }
  ]
}
```

Because the original `.vrm` bytes are embedded as a base64 data URL inside
`data`, a project file is fully self-contained and portable — you don't need to
keep the original `.vrm` files around to reopen a project. This also makes
project files noticeably larger than the `.vrm` files that went into them (each
model's data is base64-encoded, plus pose/scene/material metadata), and can be
large still with just a couple of avatars loaded.

A project file saved by an older version of this app (`"version": 2` or `1`,
without `materials` and with the older flat `lights` shape) still loads fine —
missing fields just mean nothing to restore for that part.

### Screenshot

"スクリーンショット" saves a plain `.png` of the current 3D view — no pose/scene
data is embedded in it.

### Removed: VRM export

An earlier version could re-export the posed model as a new `.vrm`. That's been
removed since this app is only meant for arranging/checking a pose, not for
producing a final VRM asset — use the `.vrma` or project format above to carry
the pose elsewhere instead.
