# How the reverse engineering was done

## Tools

- [REA](https://github.com/morluto/rea) 6.7.0 (`rea-agents`), a reverse-engineering MCP server,
  with the **Ghidra 12.1.4** provider (headless) and JDK 21. REA needs Node 22, which is
  installed portably in `.re/` without touching the system Node: `bash tools/re/setup-rea.sh`.
- `tools/re/rea_client.py`: a minimal MCP client that keeps the Ghidra session open (each REA
  CLI invocation took ~40 s to start) and decompiles batches of functions from string
  references (`x:`), calls (`c:`/`r:`) or addresses (`d:`).
- Python decoders (`tools/re/spr.py`, `fin.py`, `maprender.py`, `compose.py`, `citytest.py`)
  to validate hypotheses by rendering to PNG before porting them to TypeScript.

## Process

1. **Inventory** with `rea inspect` / `rea search` on `DC.EXE`: 32-bit x86 PE, Watcom
   C/C++ 1995, 1269 functions and 1212 strings. The assertions keep the source file names
   (`animate.c`, `mapit.c`, `sprites.c`, `sound.c`, `objects.c`…) and field names
   (`gs->map->xsize`, `frame_parts[i].juice_file->cells.number`…), which guide the search.
2. **Strings → functions**: `"animate/%s"` → `FUN_004230ac` (`.FIN` loader),
   `"sprites/%s"` → `FUN_00422dec`, `"kev: remappings"` → `FUN_0044e5b8` (`.BTS`), `"map"` +
   `"AFgetc(f) == mapinfo->xsize"` → `FUN_0044e720` (`.MAP`/`.MTG`), `"gamestat/gamestat.txt"`
   → `FUN_004385f8`, `"Error loading the scenario file"` → `FUN_0041a61c` (`.SCN`).
3. **Hypotheses and verification**: every format was validated by rendering (e.g. the full
   `HUMAN01` map from `DESERT.BTS`) and with tests that walk all the game files.
4. **Sprite placement**: the first hypothesis (using each `.SPR` frame's `x,y` on both axes)
   worked for soldiers but failed for vents and effects. Following the draw list
   (`FUN_00432dec`, 0x1C-byte entries) with REA to its consumer (`FUN_0044f95c`) showed that
   vertical clipping uses `y − (height − z)`: the sprite rests on its bottom edge and only the
   horizontal axis uses the frame offset. With that rule the whole city (five buildings and the
   central tower) fits exactly on its pentagonal platform.
5. **Cities**: comparing the pentagon's centre tile across all maps showed that the second
   `%AISlots` pair in the `.SCN` is the city centre.
6. **Sound and mission triggers** were delegated to subagents that disassembled `sound.c`
   (categories `GUN/ACK/SEL/DEA/AMB/DPY/EXP/XTR`, volumes in hundredths of a dB) and `trigger.c`
   (loader `FUN_0043c2b4`, equation-to-Polish-notation compiler `FUN_004390b0`, evaluator
   `FUN_00439a24`, executor `FUN_0043a144`, loops `FUN_0043aca4`/`FUN_0043ad04`).
   That revealed that `.MTG` is the trip-tile map, that a trigger's actions run in reverse
   order, and the day/night clock in the `.SCN` header.
7. **Shadows**: the blitter `FUN_0045c7b0` squashes the silhouette to `0x28/256` and shears it
   by `0x80/256`.

Ghidra's output (pseudo-C) stays in `.re/out/decomp/` (not versioned).
