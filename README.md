# Open Dark Colony

Clon jugable de **Dark Colony** (SSI / Alternative Reality Technologies, 1997) escrito en
TypeScript para el navegador. No incluye ningún recurso del juego: lee en tiempo de ejecución
los **ficheros originales** (sprites, animaciones, mapas, escenarios, tablas, sonidos e
interfaz) desde una instalación existente, así que los gráficos y sonidos son exactamente los
del juego. Lo que es propio es el motor: render, simulación, IA, interfaz e intérprete de
misiones.

Los formatos se obtuvieron por ingeniería inversa del ejecutable `DC.EXE` con
[REA](https://github.com/morluto/rea) (MCP de ingeniería inversa) sobre Ghidra; la
especificación está en [`docs/FORMATS.md`](docs/FORMATS.md) y el proceso en
[`docs/REVERSE-ENGINEERING.md`](docs/REVERSE-ENGINEERING.md) (ambos en inglés).

## Jugar en el navegador

**https://edulazaro.github.io/open-dark-colony/**

La versión publicada no lleva datos del juego. Al abrirla pide la carpeta de tu instalación de
Dark Colony (la que contiene `GAMESTAT/`, `SPRITES/`, `SCENARIO/`…) o un ZIP con ella; también
se puede soltar en la ventana. Los ficheros se leen en el navegador, **no se suben a ningún
sitio**, y se guardan en su IndexedDB (unos 90 MB) para no pedirlos en la siguiente visita.
La opción «Cambiar datos del juego» del menú los borra.

Se publica sola con [`.github/workflows/pages.yml`](.github/workflows/pages.yml) en cada push
a `main` (compila, pasa los tests y sube `dist/`). Para activarlo la primera vez:
*Settings → Pages → Build and deployment → Source: GitHub Actions*.

## Requisitos (para ejecutarlo en local)

- Node.js 20 o superior.
- Una instalación de Dark Colony (carpeta con `DC.EXE`, `GAMESTAT/`, `SPRITES/`, `ANIMATE/`,
  `SCENARIO/`, `INTRFACE/`, `SOUND/`…). Por defecto se busca en `C:/code/DCOLONY`; para otra
  ruta usa la variable `DC_DATA`.

## Uso

Bash (Linux, macOS, Git Bash):

```bash
npm install
npm run dev                        # http://localhost:5173
DC_DATA=/ruta/a/DCOLONY npm run dev

npm run build && npm start         # versión compilada en http://localhost:8080
PORT=3000 npm start                # otro puerto
npm test                           # valida los parsers contra todos los ficheros del juego
npm run typecheck
```

PowerShell (Windows):

```powershell
npm install
npm run dev                                    # http://localhost:5173

# El juego instalado en otra carpeta (vale para esta ventana de PowerShell)
$env:DC_DATA = "D:\Juegos\DCOLONY"
npm run dev

# Versión compilada (Windows PowerShell 5.1 no admite &&)
npm run build; if ($LASTEXITCODE -eq 0) { npm start }   # http://localhost:8080
$env:PORT = "3000"; npm start                  # otro puerto

npm test
npm run typecheck

# Abrir directamente una escaramuza en el navegador
Start-Process "http://localhost:5173/?map=scenario/mplayer/d2play01.scn&race=1"

# Volver a los valores por defecto
Remove-Item Env:DC_DATA, Env:PORT -ErrorAction SilentlyContinue
```

Los tests que necesitan los ficheros originales se saltan si no encuentran la instalación; el
resto (disparadores de misión, sonido) se ejecuta siempre.

Atajo para pruebas: `http://localhost:5173/?map=scenario/mplayer/d2play01.scn&race=1`.

## Ingeniería inversa

`bash tools/re/setup-rea.sh` instala en `.re/` (≈1,7 GB, fuera del repositorio) REA, Ghidra
12.1.4, un JDK 21 y un Node 22 portátil, sin tocar el Node del sistema. Después,
`python tools/re/rea_client.py` decompila funciones de `DC.EXE` (ver
[`docs/REVERSE-ENGINEERING.md`](docs/REVERSE-ENGINEERING.md)). La salida de Ghidra se queda en
`.re/out/` y no se publica: el repositorio sólo contiene la descripción de los formatos y un
motor escrito desde cero.

Desde PowerShell, llama al `bash` de Git explícitamente (el `bash` a secas puede ser el de WSL):

```powershell
& "C:\Program Files\Git\bin\bash.exe" tools/re/setup-rea.sh

# Decompilar el cargador de .FIN y las funciones que llama
python tools/re/rea_client.py d:0x4230ac c:0x4230ac   # salida en .re\out\decomp\

# Otro DC.EXE
$env:DC_EXE = "D:\Juegos\DCOLONY\DC.EXE"
python tools/re/rea_client.py d:0x4230ac
```

## Qué incluye

- Render fiel: teselas `.BTS`/`.MAP`, sprites `.SPR` (RLE y crudos) y animaciones compuestas
  `.FIN` con la regla de colocación y orden de profundidad del renderizador original, colores
  de equipo por remapeo de paleta, efectos translúcidos, sombras, ciclo día/noche con luces.
- Interfaz original: HUD `intrface.gif`, botones y layout leídos de `intrface/maine`,
  iconos de `mainbut.spr`, contadores de dinero/días, fuentes bitmap y cursores animados.
- Ciudades sobre la plataforma pentagonal: los edificios caen como *pods* desde órbita en su
  hueco (animaciones `*BUILD`), con el árbol tecnológico de `DEPEND.TXT`.
- Economía de Petra-7: Exploiters/Brozaars se despliegan sobre los respiraderos y los
  convierten en torres de extracción.
- Combate con los datos de `GAMESTAT`/`WEAPSTAT`/`MBULLET` (alcances, cadencia, blindajes,
  artillería con daño en área, minas, sanadores), muertes, sangre y explosiones.
- Pathfinding A*, niebla de guerra (visión distinta de día y de noche), minimapa, grupos,
  selección por recuadro, doble clic, modo mover/atacar.
- IA: economía, construcción según dependencias, oleadas de ataque y defensa de la ciudad.
- Sonido dirigido por datos (`SOUND2.DAT`, `SLIST.DAT`, `*.AMB`).
- Escaramuza en los ~55 mapas multijugador y las campañas humana (15 misiones) y Taar (15),
  con el intérprete de disparadores original (`.TRO`): refuerzos en nave de desembarco,
  mensajes de misión, casillas trampa (`.MTG`), erupciones de respiraderos, alianzas y finales
  de misión con sus textos (`.00N`).
- Enciclopedia original (`encyclo/`): renders 3D girando, fichas técnicas y narración.
- Artefactos neutrales capturables y ascensos del comandante por bajas (umbrales de `GAMESTAT`).

## Limitaciones conocidas

- Balance aproximado: la escala de daño y los tiempos de producción no están en los datos y se
  han ajustado a mano (`DAMAGE_SCALE`, coste → tiempo).
- La IA de los rivales es propia (economía, oleadas y defensa), no la del original.
- Artefactos: se capturan al tocarlos, pero sus poderes especiales no están implementados; tampoco
  "inspirar tropas", el segundo ataque del cyborg ni el robo de dinero.
- Guardar partida sólo en escaramuza (el estado interno de los disparadores de campaña no se
  serializa).
- Sin multijugador en red, vídeos AVI ni música de CD.

## Controles

| Acción | Control |
|---|---|
| Seleccionar | clic izquierdo / arrastrar recuadro / doble clic (mismo tipo) |
| Mover, atacar, extraer | clic derecho (o clic izquierdo en el suelo con unidades seleccionadas) |
| Mover y atacar | `A` o botón del panel |
| Alto / desplegar | `S` / `D` |
| Grupos | `Ctrl+1..9` crear, `1..9` seleccionar |
| Cámara | flechas, bordes de la pantalla, minimapa; `H` ir a la ciudad, `Espacio` centrar |
| Pausa / velocidad / sonido | `P` / `+` `-` / `M` |
| Puntos de ruta | `Mayús` + clic derecho |
| Producción | panel derecho (pestaña 1 construir, 2 investigar, 3 opciones); clic derecho cancela |
| Guardar partida | pestaña 3 (opciones), sólo en escaramuza; se carga desde el menú principal |
| Deseleccionar / salir al terminar | `Esc` |
| Depuración | `F9` revela el mapa, `F10` +5000 de dinero |

## Estructura

```
src/data/     parsers de los formatos originales (spr, fin, map/bts, scn, stats) y origen de
              los datos: servidor /dc/ o ficheros elegidos en el navegador (vfs, local)
src/render/   paletas, caché de sprites, animaciones, terreno y render del mundo
src/game/     reglas, simulación (world.ts), A*, IA, carga de escenarios, disparadores de misión
src/ui/       HUD (game-screen.ts), menús, layout de interfaz, fuentes bitmap
src/audio/    sistema de sonido
tools/re/     scripts de ingeniería inversa (cliente REA, decodificadores en Python)
docs/         especificación de formatos y proceso de ingeniería inversa
```

## Licencia

El código de este repositorio se distribuye bajo la licencia [MIT](LICENSE).

Dark Colony y todos sus recursos (gráficos, sonidos, mapas, textos y el ejecutable) son
propiedad de sus respectivos titulares y **no** están cubiertos por esta licencia. Este proyecto
no distribuye contenido del juego; necesitas tu propia copia.
