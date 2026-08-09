# Voxel

An infinite, procedurally generated block sandbox that runs entirely in the
browser. No build step, no bundler, no image or audio assets — every texture is
painted, every surface normal derived and every sound synthesised at runtime, so
the whole game is the files in this repository plus one copy of Three.js.

## Running it

The game uses ES modules and an import map, so it has to be served over HTTP
rather than opened as a file:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Requires a browser with WebGL 2 (`sampler2DArray` is used for the block atlas).

## Playing

| Action | Control |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Jump / fly up | `Space` |
| Sneak / fly down | `Shift` — you will not walk off a ledge while sneaking |
| Sprint | `Ctrl` |
| Fly (creative) | double-tap `Space` |
| Mine | hold left mouse |
| Attack an animal | left mouse, while aiming at one |
| Place | right mouse |
| Pick block | middle mouse |
| Hotbar | scroll, or `1`–`9` |
| Inventory / block palette | `E` |
| Chat and commands | `T` and `/` |
| Change view | `F5` |
| Debug overlay | `F3` |
| Screenshot | `F2` |
| Pause | `Esc` |

Movement uses Minecraft's own numbers rather than approximations of them:
gravity of 32 blocks per second squared, a jump that peaks at 1.25 blocks,
4.317 walking and 5.612 sprinting. The distances those produce — clearing a
one-block step, the length of a sprint jump, how far you fall before it hurts —
are the ones your hands already know.

Commands include `/tp`, `/gamemode`, `/time`, `/give`, `/locate`, `/mobs`,
`/rd`, `/seed` and `/help`.

### On a phone or tablet

Mobile mode swaps the keyboard and mouse for on-screen controls and resizes the
whole interface for a small screen. It turns itself on for touchscreens and can
be forced either way under **Settings → Mobile → Mobile Mode**, which matters on
tablets and touchscreen laptops where the device cannot tell you how it is being
held.

| Action | Control |
| --- | --- |
| Move | the stick, bottom left — push it fully to sprint |
| Turn | push the stick sideways |
| Look | drag anywhere the stick and buttons are not |
| Mine | press and hold on the block you are aiming at |
| Place | tap once |
| Jump / fly up | the large button, bottom right |
| Sneak / fly down | the button above it |
| Fly (creative) | the wing button toggles it |
| Hotbar | tap a slot |
| Inventory, chat, view, fullscreen, menu | the `⋯` button in the corner |

Turning is what makes a stick feel like a mouse. Pushed sideways it steers
rather than sidesteps, so you end up facing the way you are travelling instead
of crabbing along still looking at where you started. Put a finger on the look
surface and it reverts to sidestepping for as long as that finger is down —
two thumbs is desktop controls, one thumb is steering.

**Settings → Mobile** has a look-speed slider, a switch for that turning
behaviour, and a left-handed layout that mirrors the stick and the buttons.

**Survival** costs you blocks to build with, and fall, lava, drowning and void
damage are live. **Creative** gives you every block, flight and no damage.

### Structures

Villages, desert temples, igloos, swamp huts, ruined towers, buried dungeons,
boulders and fallen logs generate across the world. `/locate village` will tell
you where the nearest one of any kind is, and **Structures** on the world
creation screen scales how common they all are.

They are placed on a coarse grid — one cell per structure kind, a couple of
dozen chunks across — where each cell decides from a hash of its own
coordinates whether it holds something and where inside itself it sits.
Generating a chunk asks only the handful of cells whose structures could
possibly reach it, so a village eighty blocks across costs nothing to the
chunks it does not touch, and both halves of one that straddles a chunk border
agree exactly because both are computed from the same cell.

### Animals

Pigs, cows, sheep and chickens wander the surface, graze, watch you when you
come close, and bolt when hit. Sheep come in five fleeces and yield the wool
you can see them wearing. They spawn in a ring around the player, in herds, on
ground their species actually lives on, and are forgotten once you walk far
enough away.

Every animal in the world is drawn in **one draw call**. Rather than parenting
boxes into the scene graph — where a herd of cows would be forty draws on top
of a world that already spends hundreds — each frame writes every animal's
transformed vertices into one shared buffer. That also puts them in the same
material as the terrain, so they light, fog and shadow exactly like the ground
they are standing on.

### Shaders

**Settings → Shaders** owns the things that make the world look photographed
rather than diagrammed. All of them are separate, and all of them are off by
default on a phone.

**Sun shadows** draw the world a second time from the sun's point of view. The
baked skylight already knows what is under a roof, but it knows nothing about
which *direction* the light comes from — so without this a tree lays no shadow
on the grass beside it and a wall lights the same on both faces. Only a box
around the player is covered, its edge dissolved rather than cut, and the light
camera moves in whole texels so shadow edges do not crawl as you walk.
**Cloud shadows** drift over the ground on top of that, which is the cheapest
effect here and, over open country, one of the most convincing.

**Screen effects** render the world into a floating-point buffer instead of
straight to the screen. That is what makes the rest possible: colours are
allowed past white, and **bloom** and **sun shafts** get to see how far past.
Tone mapping then happens once, filmically, at the end — where it can keep a
blown-out sky warm instead of washing it grey.

### Lighting

**Settings → Video → Lighting** picks between two shading models.

**Fancy** lights every pixel rather than every face. Each texture carries a
derived normal map, so cobble reads as rounded stones and planks have grooves
that catch the sun; a roughness value per material gives ice, obsidian and ore
a highlight that tracks the sun across the sky while dirt and moss stay matte;
water gets its highlight from the analytic slope of the waves it is actually
displaced by; and lava, glowstone and torches emit light of their own, only
from the parts of the texture that are bright — a torch glows at the flame and
not down the stick.

**Fast** is the flat-shaded look with none of that. It is a real saving on a
phone GPU, and it is what mobile mode picks on a first run.

Worlds are saved to IndexedDB in your browser. Only your *edits* are stored —
terrain is a pure function of the seed, so regenerating it is faster and far
smaller than reading it back.

## Layout

```
src/
  core/        renderer, input, settings, audio synthesis, IndexedDB saves
  world/       chunk storage, lighting, streaming, terrain and structures
  render/      texture painting, greedy mesher, materials, sky, shadows, post
  entity/      player physics, the third-person avatar, animals
  game/        session orchestration, interaction, inventory, particles
  ui/          menus, HUD, loading screen, chat, debug overlay, touch controls
```

A few pieces are worth knowing about before changing anything:

- **`render/mesher.js`** has no Three.js or DOM references by design. It takes
  typed arrays in and returns typed arrays out so the same code can run in a
  worker later.
- **`world/lighting.js`** computes a chunk's light in isolation; that is only
  correct for generation. **`world/light-update.js`** owns everything after
  that — incremental edits and light crossing chunk seams.
- **`world/constants.js`** has no imports at all, so workers can pull in the
  world dimensions without dragging in the renderer.
- Sky, fog and world lighting all read from **`render/sky.js`**, which is the
  single source of truth for time of day.
- **`render/atlas.js`** paints two array textures, not one. The second holds a
  normal, a roughness and an emissive value per texel, and its normals are
  derived from the colours that were just painted — everything drawn dark in a
  hand-drawn block texture is drawn dark *because it is a recess*, so reading
  height back out of the paint gets the relief right and every texture added
  later gets its normals for free.
- **`render/materials.js`** rebuilds the tangent frame per pixel from screen
  space derivatives rather than a vertex attribute. Greedy meshing means one
  quad can span a hundred blocks, and a tangent attribute would make the mesher
  emit and the GPU carry data the rasteriser already has.
- **`ui/touch-controls.js`** writes into the same `core/input.js` that the
  keyboard and mouse write into — analog movement, held *actions* and virtual
  mouse buttons. Nothing downstream of `Input` knows which one is driving, so
  there is no separate touch code path in the player or in interaction.
- **`core/engine.js`** refuses to configure the camera from a zero-sized
  viewport, and repairs a non-finite camera before every frame. Both exist
  because a single `width / 0` there poisons the projection matrix and every
  later frame culls the whole scene — the world goes black permanently while the
  HUD carries on as though nothing happened.
- **`render/shadows.js`** writes distance-from-the-light into a float *colour*
  target rather than reading a depth texture back. The obvious version was
  tried first and its depth attachment stayed empty under this renderer, which
  is a bad failure to inherit: a shadow term that silently always says "lit" is
  invisible until you go looking for it.
- **`render/post.js`** owns tone mapping whenever it is switched on, and
  `core/engine.js` gives it up in the same call. Exactly one of the two may do
  it — mapping on the way into the buffer would clip the very highlights the
  bloom and sun shafts exist to find.
- **`ui/loading.js`** splits its moving parts by who drives them. The checklist
  and bar follow real progress; the block mark and the bar's sheen are CSS
  transforms, so they keep running on the compositor through the long
  synchronous stretches of terrain generation — which is exactly when a loading
  screen has to prove it has not hung.
- Anything written inside a GLSL template literal must avoid backticks, even in
  a comment. One in a comment closes the template and the module fails to parse
  with an error pointing at a word in the shader.

## Not implemented

Deliberate omissions, so nothing here reads as a bug:

- No crafting or tools. Mining speed depends on block hardness alone.
- No hostile mobs. The animals are passive: they can be hit, they panic and
  run, and nothing in the world will come after you.
- No dropped-item entities — mined blocks and what an animal yields go straight
  to the inventory, and dropping an item discards it.
- No fluid simulation. Water and lava are static blocks; placing water gives
  you one block of water, not a flow.
- Chests, furnaces and crafting tables are decoration. Structures place them
  because a room without them reads as unfinished, but none of them open.
- The shadow map covers a box around the player rather than the whole view, so
  distant terrain is lit but never shadowed.
- Chunk generation and meshing run on the main thread under a per-frame time
  budget. The mesher is written to be worker-ready if that budget ever stops
  being enough.
