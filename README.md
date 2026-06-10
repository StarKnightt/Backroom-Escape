# BACKROOMS — LEVEL 0

A first-person survival horror game that runs entirely in the browser.
Built with **Next.js + Three.js**. Every asset — textures, the monster, the
level, every sound — is **generated procedurally at runtime**. There are no
image or audio files in this project.

![genre](https://img.shields.io/badge/genre-horror-1a1a1a) ![engine](https://img.shields.io/badge/three.js-r184-b8a440)

## The game

You noclipped out of reality into Level 0: an endless office of mono-yellow
wallpaper, damp carpet and buzzing fluorescent light.

- **Find all 8 journal pages** pinned to the walls.
- **Find the exit door** (look for the green glow) — it only opens once you
  hold every page.
- **Avoid the Wanderer.** It roams the halls, kills the lights around it,
  and hunts by sound and sight. If you stare at it, it freezes… for a while.
  If it screams — run.

### Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Look |
| Shift | Sprint (limited stamina, cancels sneak) |
| C | Toggle sneak — silent feet, slower, much harder for it to notice you |
| F | Flashlight |
| E | Interact (pages / door) |
| Esc | Pause |

**On phones/tablets** the game switches to touch controls automatically:
left virtual stick to walk (push it all the way to run), drag the right
side of the screen to look, on-screen TORCH / SNEAK / interact buttons.
Portrait orientation shows a "rotate your device" screen — Level 0 only
exists in landscape. Rendering runs at the device's native resolution
(pixel ratio capped at 2).

Headphones strongly recommended. Each run generates a fresh maze from a new
seed.

### Dev cheats

Type **`redrum`** at any point mid-run to unlock the cheat keys, then:

| Key | Cheat |
| --- | --- |
| G | God mode — it can't take you |
| N | Noclip — walk through walls, 2.4× speed |
| B | Fullbright — floodlight the whole level |
| X | Freeze / release the entity |
| P | Grant all 8 pages instantly |
| T | Teleport to the exit door |

A toast confirms every toggle, and while any cheat is active a green
`CHEATS: …` line stays pinned under the objective so you always know
what's on.

## Tech highlights

- **Authentic Level 0 layout** — one huge open floor "randomly segmented"
  into rooms by thin partition walls (recursive division with door gaps),
  exactly like the original 2002 photo: chevron wallpaper, beige carpet,
  drop ceiling, columns of rectangular fluorescent fixtures. **Every room
  is enterable** — wall-aware BFS guarantees full connectivity.
- **Procedural PBR textures** — chevron wallpaper, carpet, ceiling tiles,
  doors and the entity's skin are painted onto canvases at boot (albedo +
  normal maps derived via Sobel-filtered height fields + roughness maps).
- **Full 3D player character** — articulated body (hips, knees) visible
  when you look down, plus a first-person fist gripping a black torch:
  four articulated fingers (proximal/middle/distal segments with knuckle
  joints) wrapped around the barrel, thumb on the switch, jacket cuff at
  the wrist. The spotlight beams out of the torch lens.
- **Articulated 3D entity** — two-segment limbs with knees and elbows,
  skeletal hands with four too-long fingers that splay when it lunges, a
  gaunt lathe-modeled skull, sunken ribs, and procedural gait/twitch
  animation. A* pathfinding (wall-edge aware) with a
  roam / stalk / chase / search state machine, freeze-when-observed
  behavior, and a "horror director" that quietly relocates it near you if
  things stay calm too long.
- **Dynamic light orchestration** — hundreds of emissive fixtures (single
  InstancedMesh with HDR instance colors) backed by a pool of 12 real point
  lights assigned to the nearest fixtures each frame. The entity suppresses
  lights around itself.
- **100% synthesized audio** — WebAudio graph: fluorescent hum, room tone,
  dissonant fear drone, heartbeat scheduler, footsteps, whispers, the
  chase screech, and a procedural convolution reverb.
- **Post-processing** — bloom, FXAA, plus a custom "fear shader": film
  grain, heartbeat-synced vignette, chromatic aberration and VHS tearing
  that all scale with a composite fear level.
- **Hardened input** — the game stays in the browser tab (no forced
  fullscreen); the pointer lock keeps the cursor captured while playing.
  Relocks respect Chromium's ~1.3s cooldown, a watchdog pauses the game
  within half a second if the lock silently dies (so a free cursor can
  never wander onto the close button unnoticed), a grace window swallows
  the garbage mouse deltas Chromium fires as the lock engages, spike
  deltas are dropped, overlay buttons ignore the second half of accidental
  double-clicks, and the frame loop is allocation-free (no GC stutter).
  Sneak lives on C, not Ctrl — players hold their sneak key out of habit,
  and a held Ctrl turns W into Ctrl+W, which closes the tab and cannot be
  blocked by JS. Pressing Ctrl in-game shows a one-time "sneak is on C"
  toast. OS key repeats are filtered so held keys can't strobe toggles
  (the old cause of phantom footsteps while sneaking).
- **Mobile support** — touch joystick + look pad + on-screen buttons,
  landscape enforcement, native-resolution rendering, no pointer lock
  required.

## Run it

```bash
pnpm install
pnpm dev      # http://localhost:3000
```

## Dev smoke tests

Headless Edge scripts (require a local Edge install):

```bash
node scripts/smoke.mjs     # boot + walk + screenshots
node scripts/inspect.mjs   # staged scenes: corridor, entity, page, door, body
node scripts/flow.mjs      # page pickup -> death -> retry
node scripts/diag.mjs      # bright-lit geometry/model diagnostics
node scripts/cheats.mjs    # redrum unlock + every cheat toggle
node scripts/mobile.mjs    # emulated phone: rotate prompt + touch controls
```

Screenshots land in `scripts/shots/`.
