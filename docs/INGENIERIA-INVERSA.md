# Cómo se hizo la ingeniería inversa

## Herramientas

- [REA](https://github.com/morluto/rea) 6.7.0 (`rea-agents`), servidor MCP de ingeniería inversa,
  con el proveedor **Ghidra 12.1.4** (headless) y JDK 21. REA necesita Node 22, que se instala de
  forma portátil en `.re/` sin tocar el Node del sistema: `bash tools/re/setup-rea.sh`.
- `tools/re/rea_client.py`: cliente MCP mínimo que mantiene abierta la sesión de Ghidra (cada
  invocación de la CLI de REA tardaba ~40 s en arrancar) y decompila lotes de funciones a partir
  de referencias a cadenas (`x:`), llamadas (`c:`/`r:`) o direcciones (`d:`).
- Decodificadores en Python (`tools/re/spr.py`, `fin.py`, `maprender.py`, `compose.py`,
  `citytest.py`) para validar hipótesis renderizando a PNG antes de portarlas a TypeScript.

## Proceso

1. **Inventario** con `rea inspect` / `rea search` sobre `DC.EXE`: PE x86 de 32 bits, Watcom
   C/C++ 1995, 1269 funciones y 1212 cadenas. Las aserciones conservan nombres de ficheros
   fuente (`animate.c`, `mapit.c`, `sprites.c`, `sound.c`, `objects.c`…) y de campos
   (`gs->map->xsize`, `frame_parts[i].juice_file->cells.number`…), lo que guía la búsqueda.
2. **Cadenas → funciones**: `"animate/%s"` → `FUN_004230ac` (cargador de `.FIN`),
   `"sprites/%s"` → `FUN_00422dec`, `"kev: remappings"` → `FUN_0044e5b8` (`.BTS`), `"map"` +
   `"AFgetc(f) == mapinfo->xsize"` → `FUN_0044e720` (`.MAP`/`.MTG`), `"gamestat/gamestat.txt"`
   → `FUN_004385f8`, `"Error loading the scenario file"` → `FUN_0041a61c` (`.SCN`).
3. **Hipótesis y verificación**: cada formato se validó renderizando (p. ej. el mapa completo de
   `HUMAN01` a partir de `DESERT.BTS`) y con tests que recorren todos los ficheros del juego.
4. **Colocación de sprites**: la primera hipótesis (usar el `x,y` de cada frame del `.SPR` en
   ambos ejes) funcionaba con soldados pero fallaba con respiraderos y efectos. Siguiendo con REA
   la lista de dibujo (`FUN_00432dec`, entradas de 0x1C bytes) hasta su consumidor
   (`FUN_0044f95c`) se vio que el recorte vertical usa `y − (alto − z)`: el sprite se apoya por
   abajo y sólo el eje horizontal usa el offset del frame. Con esa regla la ciudad completa
   (cinco edificios y la torre central) encaja exactamente en su plataforma pentagonal.
5. **Ciudades**: cotejando la tesela central del pentágono en todos los mapas se dedujo que la
   segunda pareja de `%AISlots` del `.SCN` es el centro de la ciudad.
6. **Sonido y disparadores de misión** se delegaron en subagentes que desensamblaron `sound.c`
   (categorías `GUN/ACK/SEL/DEA/AMB/DPY/EXP/XTR`, volúmenes en centésimas de dB) y `trigger.c`
   (cargador `FUN_0043c2b4`, compilador de ecuaciones a notación polaca `FUN_004390b0`,
   evaluador `FUN_00439a24`, ejecutor `FUN_0043a144`, bucles `FUN_0043aca4`/`FUN_0043ad04`).
   De ahí salió que `.MTG` es el mapa de casillas trampa, que las acciones se ejecutan en orden
   inverso y el reloj día/noche de la cabecera del `.SCN`.
7. **Sombras**: el blitter `FUN_0045c7b0` aplasta la silueta a `0x28/256` y la cizalla `0x80/256`.

Las salidas de Ghidra (pseudo-C) quedan en `.re/out/decomp/` (no versionado).
