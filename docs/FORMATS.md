# Dark Colony data formats

Specification reverse-engineered from `DC.EXE` (Watcom C/C++ 32-bit, Win95) with
[REA](https://github.com/morluto/rea) + Ghidra 12.1.4, and verified against every game file
(`npm test` walks all 284 `.SPR` files, the `.FIN` files listed in `ANIM.DAT`, the 70+ maps and
the tables). The `FUN_xxxxxxxx` addresses are the decompiled functions used as evidence
(reproducible with `python tools/re/rea_client.py d:0x…`).

Integers are little-endian. Palettes are VGA, 6 bits per channel (0..63; scaled with `v<<2 | v>>4`).

## `.SPR` — sprites (`sprites/`, `intrface/`, `encyclo/`, `cursor/`)

Loaded by `FUN_00422dec` (string `"sprites/%s"`).

| Offset | Type | Field |
|---|---|---|
| 0 | u16 | type: `0x81` = RLE with per-frame size, `0x01` = raw |
| 2 | u16 | frame count `n` |
| 4 | u32 | data size (excluding frame headers) |
| 8 | u8[768] | sprite palette |
| 0x308 | `n` × {i16 w, i16 h, i16 x, i16 y} | frame size and position on the 3D render canvas |
| … | | frame data |

- **0x81**: per frame, `u32 size` + row-based RLE: signed byte `c`; `c < 0` ⇒ skip `-c`
  transparent pixels; `c ≥ 0` ⇒ copy `c+1` literal pixels.
- **0x01**: `w*h` bytes; index 0 is transparent.
- Palette entries `(45,0,63)` are placeholders filled in from the terrain palette
  (in 8-bit mode the game uses a single palette: the `.BTS` one).
- **Team colour**: a 6-shade ramp at indices **138–143** ("teal") is remapped to other ramps
  of the terrain palette (96 red, 102 blue, 108 yellow, 114 violet, 120 green, 126 orange).
  The assertion `op->remap < TEAL_NUM + 2` confirms the mechanism.

## `.FIN` — animations (`animate/`, listed in `ANIM.DAT`)

Decompiled from `FUN_004230ac` (`animate.c`, strings `"animate/%s"`, `"Animation Headers"`,
`"Frame parts"`).

```
u16 version (29) | u16 nframes | u16 nanims | u16 njuice
njuice × char[8]                             .SPR names ("juice files")
nanims × { char[16] name, i16 first, i16 last }
nframes × { i16 nparts, i16 delay, 8 × { char[16] event, i16, i16 } }   (164 bytes)
Σnparts × { char[8] spr, i16 sprite, i16 dx, i16 dy, i16 z, i16 ?, i16 layer, i16 mirror }  (22 bytes)
```

- Frame duration in 15 Hz ticks: `((delay || 15) + 3) * 15 / 100`.
- Names: `<SPRITE><ACTION><DIR>`; actions `STAND`, `SHUF`, `MOVE`, `FIREA/B`, `DIEA/B/C`,
  `BUILD` (leaving the factory / pod drop), `DEPLOY`, `BLOODA..G`, `BURN`, `SCRCH`, `EXPLODE`…
- Directions: 0 = south, 4 = west, 8 = north, 12 = east (16 steps, counter-clockwise).
- **Placement** (renderer `FUN_0044f95c` and draw list `FUN_00432dec`, 0x1C-byte entries):
  `left = x + dx + (mirror ? 0 : spr.x)`; `bottom = y + dy` — the sprite rests on its bottom
  edge and the `y` of the `.SPR` frame is not used. The world uses a Y-up axis
  (`screen_y = map_height − y − 1`).
- Layers (renderer `switch`): 0/1 normal (1 casts a shadow), 2 shadow only, 3 night light
  map, 4/5 translucent effects. The list is sorted by depth (bottom edge).
- Cast shadow for layer 1 (`FUN_0045c7b0`): the silhouette is squashed vertically to
  `0x28/256` of its height and sheared `0x80/256` to the left from its base; it is drawn by
  darkening the terrain with a remap table (`.RMP`).

## `.BTS` — terrain tiles (`scenario/desert.bts`, `jungle`, `atlantis`, `htrain`)

`FUN_0044e5b8` (`mapit.c`, `"kev: remappings"`):

```
u32 max id (5100) | u32 n | u8 palette[768] | n × { u32 id, u8 pixels[32*32] }
```

## `.MAP` — map

`FUN_0044e720` (`mapit.c`, `"map"`, `"AFgetc(f) == mapinfo->xsize"`):

```
u32 width | u32 height | width*height × { u16 base tile, u16 overlay tile } | width*height × u16 flags
```

- Tiles are referenced by **id** (not by index) through the `.BTS` remap table;
  the overlay tile uses index 0 as transparent.
- `flags`: bit 7 (`0x80`) = passable tile; bits 10..14 = block type (ambient sound).
- `.MTG`: `u8 width, u8 height` + 1 byte per tile = id of the `trip` trigger fired when a
  unit enters that tile (0 = none).
- `.PTH` (precomputed paths), `.OVH`/`.O16` (8/16-bit overview) — not needed.

## Missions: `.TRO`, `.MSG`, `.00N`

Interpreter in `src/game/triggers.ts` (disassembled from `trigger.c`: loader `FUN_0043c2b4`,
equation-to-Polish-notation compiler `FUN_004390b0`, evaluator `FUN_00439a24`, executor
`FUN_0043a144`).

```
<id> norm|trip <lives> (<condition>)
<verb> <args…>
end
```

- `norm`: ids 0..127, evaluated every 8 frames; `trip`: fired when a unit steps on a tile
  marked in the `.MTG`.
- Conditions: `c` clock (frames/16), `S`/`t` team/type of the unit stepping on the tile,
  `r` random, `b(team,family)` building standing, `s(team,stat[,type])` statistics, `m(x,y)`,
  `v(x,y,team)`; `&&`/`||` are 16-bit bitwise AND/OR, as in the original.
- Verbs: `reinforce` (dropship), `reinforce2`, `waypoint`, `newtype`, `newrate`,
  `setmoney`, `exomoney`, `ai`, `aimsg`, `abduct`, `artifact`, `ally`, `vision`, `dfiddle`,
  `setlifes`, `setarray`, `msg`, `bail` (end: 0 win / 1 lose + `.00N` text)…
- `.MSG`: `text N` blocks + one line; `.00N`: end-of-mission texts with `~N` colour codes.

## `.SCN` — scenario (text)

```
<tileset.bts>
<map base name>
<title>
<6 header integers>          [?, ?, starts at night, half day in ticks (6750), initial phase, transition ticks]
TEAM <id> <active>
<side>      %Race <race> %Money <money index> %AI <AI type>
%TeamColour <list -1>  %Depend <8 + -1>  %TeamAllies <15 + -1>
%AISlots <x y rally point> <x y city centre>
%City <(exists, hp) per family; usually 5 pairs, HUMAN03 has 6> <8 rows × 5 upgrade levels>
… × 8 teams
<x y type team hp flag>*     objects; type = GAMESTAT index
<x y 40 rate amount>*        Petra-7 vents (5 fields; rate 0 = dormant)
```

Coordinates use a Y-up axis. The **2nd `%AISlots` pair is the centre of the city's pentagonal
platform** (it matches the pentagon's centre tile on every map). City buildings share that
anchor: their offsets in the `.FIN` files already put them in their slot.

## `gamestat/` tables

- `GAMESTAT.TXT` (`FUN_004385f8`, format `"%s %d … %d"` with 33 integers): per type — sprite,
  race, turn rate, speed, day/night vision, 3 weapons (per upgrade level), 2 sizes, armour
  class, hit points, flies, …, equivalent unit on the other side, not selectable.
- `WEAPSTAT.TXT`: `id sprite class sound rate damage speed range explosion_type …`.
  The sound field indexes the `GUN` category of `SLIST.DAT`.
- `MBULLET.TXT`: damage % [weapon class][armour class] (10 × 9).
- `DEPEND.TXT`: `id cost text type …` — building (family, level, race), unit (type) or
  upgrade (type, weapon/armour, level), followed by dependencies terminated by -1. The
  *text* field is the button id in `intrface/maine`.
- `UNITID.TXT`: unit type → text id (name).
- `HSCENE.TXT` / `GSCENE.TXT`: campaign mission lists.

## Interface

- `intrface/maine`: HUD layout (`pushb`, `checkb`, `count`, `picture`, `group`, `in_text`,
  `scount`, `textmsg`); icons are frames of `intrface/mainbut.spr` (digits: frames 104–113).
- Fonts `intrface/mfonto*.spr`: frame = ASCII code − 31; frame 0 holds the cell size.
- `intrface/*.gif`: backgrounds (HUD `intrface.gif`, menus `loader.gif`, `story.gif`…).

## Sound

See `src/audio/sound.ts`: `SOUND2.DAT` (id → WAV, number of buffers, volume in hundredths of
a dB, loop), `SLIST.DAT` (categories `GUN ACK SEL DEA AMB DPY EXP XTR`), `*.AMB` (ambience per
terrain, day/night and block type). Derived by disassembling `sound.c`.
