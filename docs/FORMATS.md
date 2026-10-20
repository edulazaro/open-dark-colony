# Formatos de datos de Dark Colony

Especificación obtenida por ingeniería inversa de `DC.EXE` (Watcom C/C++ 32 bits, Win95) con
[REA](https://github.com/morluto/rea) + Ghidra 12.1.4, y verificada contra todos los ficheros del
juego (`npm test` recorre los 284 `.SPR`, los `.FIN` de `ANIM.DAT`, los 70+ mapas y las tablas).
Las direcciones `FUN_xxxxxxxx` son las funciones decompiladas que sirvieron de evidencia
(reproducibles con `python tools/re/rea_client.py d:0x…`).

Enteros en little endian. Paletas VGA de 6 bits por canal (0..63; se escalan con `v<<2 | v>>4`).

## `.SPR` — sprites (`sprites/`, `intrface/`, `encyclo/`, `cursor/`)

Cargados por `FUN_00422dec` (cadena `"sprites/%s"`).

| Offset | Tipo | Campo |
|---|---|---|
| 0 | u16 | tipo: `0x81` = RLE con tamaño por frame, `0x01` = crudo |
| 2 | u16 | número de frames `n` |
| 4 | u32 | tamaño de datos (sin las cabeceras de frame) |
| 8 | u8[768] | paleta del sprite |
| 0x308 | `n` × {i16 w, i16 h, i16 x, i16 y} | tamaño y posición del frame en el lienzo de render 3D |
| … | | datos de los frames |

- **0x81**: por frame `u32 tamaño` + RLE por filas: byte con signo `c`; `c < 0` ⇒ saltar `-c`
  píxeles transparentes; `c ≥ 0` ⇒ copiar `c+1` píxeles literales.
- **0x01**: `w*h` bytes; el índice 0 es transparente.
- Las entradas `(45,0,63)` de la paleta son huecos que rellena la paleta del terreno
  (en 8 bits el juego usa una única paleta: la del `.BTS`).
- **Color de equipo**: rampa de 6 tonos en los índices **138–143** ("teal"); se remapea a otras
  rampas de la paleta de terreno (96 rojo, 102 azul, 108 amarillo, 114 violeta, 120 verde,
  126 naranja). La aserción `op->remap < TEAL_NUM + 2` confirma el mecanismo.

## `.FIN` — animaciones (`animate/`, lista en `ANIM.DAT`)

Decompilado de `FUN_004230ac` (`animate.c`, cadenas `"animate/%s"`, `"Animation Headers"`,
`"Frame parts"`).

```
u16 versión (29) | u16 nframes | u16 nanims | u16 njuice
njuice × char[8]                             nombres de .SPR ("juice files")
nanims × { char[16] nombre, i16 primero, i16 último }
nframes × { i16 npartes, i16 retardo, 8 × { char[16] evento, i16, i16 } }   (164 bytes)
Σnpartes × { char[8] spr, i16 sprite, i16 dx, i16 dy, i16 z, i16 ?, i16 capa, i16 espejo }  (22 bytes)
```

- Duración de un frame en ticks de 15 Hz: `((retardo || 15) + 3) * 15 / 100`.
- Nombres: `<SPRITE><ACCIÓN><DIR>`; acciones `STAND`, `SHUF`, `MOVE`, `FIREA/B`, `DIEA/B/C`,
  `BUILD` (salida de fábrica / caída del pod), `DEPLOY`, `BLOODA..G`, `BURN`, `SCRCH`, `EXPLODE`…
- Direcciones: 0 = sur, 4 = oeste, 8 = norte, 12 = este (16 pasos, sentido antihorario).
- **Colocación** (renderizador `FUN_0044f95c` y lista de dibujo `FUN_00432dec`, entradas de
  0x1C bytes): `izquierda = x + dx + (espejo ? 0 : spr.x)`; `abajo = y + dy` — el sprite se
  apoya por su borde inferior y la coordenada `y` del frame del `.SPR` no se usa. El mundo usa
  el eje Y hacia arriba (`y_pantalla = alto_mapa − y − 1`).
- Capas (`switch` del renderizador): 0/1 normal (1 con sombra), 2 sólo sombra, 3 mapa de luz
  nocturno, 4/5 efectos translúcidos. La lista se ordena por profundidad (borde inferior).
- Sombra proyectada de la capa 1 (`FUN_0045c7b0`): la silueta se aplasta verticalmente a
  `0x28/256` de su altura y se cizalla `0x80/256` hacia la izquierda a partir de la base;
  se dibuja oscureciendo el terreno con una tabla de remapeo (`.RMP`).

## `.BTS` — teselas de terreno (`scenario/desert.bts`, `jungle`, `atlantis`, `htrain`)

`FUN_0044e5b8` (`mapit.c`, `"kev: remappings"`):

```
u32 id máximo (5100) | u32 n | u8 paleta[768] | n × { u32 id, u8 píxeles[32*32] }
```

## `.MAP` — mapa

`FUN_0044e720` (`mapit.c`, `"map"`, `"AFgetc(f) == mapinfo->xsize"`):

```
u32 ancho | u32 alto | ancho*alto × { u16 tesela base, u16 tesela superpuesta } | ancho*alto × u16 flags
```

- Las teselas se referencian por **id** (no por índice) a través de la tabla de remapeo del `.BTS`;
  la superpuesta usa el índice 0 como transparente.
- `flags`: bit 7 (`0x80`) = casilla transitable; bits 10..14 = tipo de bloque (sonido ambiente).
- `.MTG`: `u8 ancho, u8 alto` + 1 byte por casilla = id del disparador `trip` que se activa al
  entrar una unidad en esa casilla (0 = ninguno).
- `.PTH` (rutas precalculadas), `.OVH`/`.O16` (vista general 8/16 bits) — no necesarios.

## Misiones: `.TRO`, `.MSG`, `.00N`

Intérprete en `src/game/triggers.ts` (desensamblado de `trigger.c`: cargador `FUN_0043c2b4`,
compilador de ecuaciones a notación polaca `FUN_004390b0`, evaluador `FUN_00439a24`, ejecutor
`FUN_0043a144`).

```
<id> norm|trip <vidas> (<condición>)
<verbo> <args…>
end
```

- `norm`: ids 0..127, se evalúan cada 8 fotogramas; `trip`: al pisar una casilla marcada en el `.MTG`.
- Condiciones: `c` reloj (fotogramas/16), `S`/`t` equipo/tipo de quien pisa, `r` aleatorio,
  `b(eq,familia)` edificio en pie, `s(eq,stat[,tipo])` estadísticas, `m(x,y)`, `v(x,y,eq)`;
  `&&`/`||` son AND/OR bit a bit de 16 bits como en el original.
- Verbos: `reinforce` (nave de desembarco), `reinforce2`, `waypoint`, `newtype`, `newrate`,
  `setmoney`, `exomoney`, `ai`, `aimsg`, `abduct`, `artifact`, `ally`, `vision`, `dfiddle`,
  `setlifes`, `setarray`, `msg`, `bail` (fin: 0 gana / 1 pierde + texto `.00N`)…
- `.MSG`: bloques `text N` + línea; `.00N`: textos finales con códigos de color `~N`.

## `.SCN` — escenario (texto)

```
<tileset.bts>
<nombre base del mapa>
<título>
<6 enteros de cabecera>          [?, ?, empieza de noche, media jornada en ticks (6750), fase inicial, ticks de transición]
TEAM <id> <activo>
<bando>      %Race <raza> %Money <índice dinero> %AI <tipo IA>
%TeamColour <lista -1>  %Depend <8 + -1>  %TeamAllies <15 + -1>
%AISlots <x y punto de reunión> <x y centro de la ciudad>
%City <(existe, vida) por familia; normalmente 5 parejas, HUMAN03 trae 6> <8 filas × 5 niveles de mejora>
… × 8 equipos
<x y tipo equipo vida flag>*     objetos; tipo = índice de GAMESTAT
<x y 40 caudal cantidad>*        respiraderos de Petra-7 (5 campos; caudal 0 = dormido)
```

Coordenadas con el eje Y hacia arriba. La **2.ª pareja de `%AISlots` es el centro de la plataforma
pentagonal de la ciudad** (coincide con la tesela central del pentágono en todos los mapas).
Los edificios de la ciudad comparten ese ancla: sus offsets en los `.FIN` ya los colocan en su hueco.

## Tablas de `gamestat/`

- `GAMESTAT.TXT` (`FUN_004385f8`, formato `"%s %d … %d"` de 33 enteros): por tipo — sprite,
  raza, giro, velocidad, visión día/noche, 3 armas (por nivel de mejora), 2 tamaños, clase de
  blindaje, vida, vuela, …, unidad equivalente del otro bando, no seleccionable.
- `WEAPSTAT.TXT`: `id sprite clase sonido cadencia daño velocidad alcance tipo_explosión …`.
  El campo sonido indexa la categoría `GUN` de `SLIST.DAT`.
- `MBULLET.TXT`: % de daño [clase de arma][clase de blindaje] (10 × 9).
- `DEPEND.TXT`: `id coste texto tipo …` — edificio (familia, nivel, raza), unidad (tipo) o
  mejora (tipo, arma/blindaje, nivel), seguido de dependencias terminadas en -1. El campo
  *texto* es el id del botón en `intrface/maine`.
- `UNITID.TXT`: tipo de unidad → id de texto (nombre).
- `HSCENE.TXT` / `GSCENE.TXT`: lista de misiones de campaña.

## Interfaz

- `intrface/maine`: layout del HUD (`pushb`, `checkb`, `count`, `picture`, `group`, `in_text`,
  `scount`, `textmsg`); los iconos son frames de `intrface/mainbut.spr` (dígitos: frames 104–113).
- Fuentes `intrface/mfonto*.spr`: frame = código ASCII − 31; el frame 0 guarda la celda.
- `intrface/*.gif`: fondos (HUD `intrface.gif`, menús `loader.gif`, `story.gif`…).

## Sonido

Ver `src/audio/sound.ts`: `SOUND2.DAT` (id → WAV, nº de buffers, volumen en centésimas de dB,
bucle), `SLIST.DAT` (categorías `GUN ACK SEL DEA AMB DPY EXP XTR`), `*.AMB` (ambiente por
terreno, día/noche y tipo de bloque). Deducido desensamblando `sound.c`.
