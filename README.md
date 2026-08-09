# Voxel

An infinite, procedurally generated block sandbox that runs entirely in the
browser. No build step, no bundler, no image or audio assets — every texture is
painted and every sound is synthesised at runtime, so the whole game is the
files in this repository plus one copy of Three.js.

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
| Place | right mouse |
| Pick block | middle mouse |
| Hotbar | scroll, or `1`–`9` |
| Inventory / block palette | `E` |
| Chat and commands | `T` and `/` |
| Change view | `F5` |
| Debug overlay | `F3` |
| Screenshot | `F2` |
| Pause | `Esc` |

Commands include `/tp`, `/gamemode`, `/time`, `/give`, `/rd`, `/seed` and
`/help`.

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

Worlds are saved to IndexedDB in your browser. Only your *edits* are stored —
terrain is a pure function of the seed, so regenerating it is faster and far
smaller than reading it back.

## Layout

```
src/
  core/        renderer, input, settings, audio synthesis, IndexedDB saves
  world/       chunk storage, lighting, streaming, terrain generation
  render/      texture painting, greedy mesher, materials, sky, box models
  entity/      player physics and the third-person avatar
  game/        session orchestration, interaction, inventory, particles
  ui/          menus, HUD, inventory screen, chat, debug overlay, touch controls
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
- **`ui/touch-controls.js`** writes into the same `core/input.js` that the
  keyboard and mouse write into — analog movement, held *actions* and virtual
  mouse buttons. Nothing downstream of `Input` knows which one is driving, so
  there is no separate touch code path in the player or in interaction.
- **`core/engine.js`** refuses to configure the camera from a zero-sized
  viewport, and repairs a non-finite camera before every frame. Both exist
  because a single `width / 0` there poisons the projection matrix and every
  later frame culls the whole scene — the world goes black permanently while the
  HUD carries on as though nothing happened.

## Not implemented

Deliberate omissions, so nothing here reads as a bug:

- No crafting or tools. Mining speed depends on block hardness alone.
- No mobs, and no dropped-item entities — mined blocks go straight to the
  inventory, and dropping an item discards it.
- No fluid simulation. Water and lava are static blocks; placing water gives
  you one block of water, not a flow.
- Chunk generation and meshing run on the main thread under a per-frame time
  budget. The mesher is written to be worker-ready if that budget ever stops
  being enough.
