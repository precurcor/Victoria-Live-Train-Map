# Victoria Rail Layout Studio

An offline, millimetre-based layout editor built from the Kea train map in this fork. It lets you arrange stations, parallel tracks and hardware, change LED density, and generate a linked KiCad project.

**Start:** download the package, extract it, then open **Victoria-Rail-Layout-Studio.html** in a current desktop browser. No installation, server, account or internet connection is required. All dependencies are bundled. Save project files somewhere you keep backups.

The packaged download is [releases/Victoria-Rail-Layout-Studio.zip](releases/Victoria-Rail-Layout-Studio.zip). It includes the program, source, this guide and an example Victoria KiCad export. On GitHub, open the ZIP and use **Download raw file**. In the extracted package, the program is at the top level. The SVG/editor appearance uses standard fonts; final KiCad typography and silk clearance still require inspection.

## Design your board

1. **Board:** set width, height and snap grid. The outline changes; LED and component sizes do not scale.
2. **Stations:** search for a station and click it to zoom in. Drag the station column to move it. Drag its text separately. Set coordinates, angle, track count and track pitch in the right panel. Shift-click stations to move several together; arrow keys nudge them.
3. **Intermediate LEDs:** Shift-select two neighbouring stations, then **Rebuild span**. Seven LEDs per track on three tracks gives **21 intermediate LEDs**, plus the station LEDs. Old intermediate blocks are retired without reusing their identities. At junctions, enable intermediate nodes in Board and edit the individual connections instead; rebuilding across a branch is deliberately blocked.
4. **Track shape:** click a connection. Change its LED count, or use target pitch in millimetres. Drag the diamond to bend the bundle. Lane mappings such as `1:1, 2:2, 3:3` are editable. **Connect** joins two station/node endpoints. **Insert station** splits a connection.
5. **Hardware:** move the original buttons, MCU, USB and power components. Use **Select controller group** to move nearby electronics together. Set the bare OLED reservation and encoder dimensions/position. You can add mounting holes and import KiCad footprints for other parts. Imported pads are unconnected until their circuit is designed.
6. **Preview / save / export:** Preview shows sample illumination, not live trains. **Save project** writes a reopenable `.rail.json`. **Open** restores it. **Export KiCad** writes the circuit/layout bundle; SVG and LED mapping exports are also available.

**Undo/redo:** Ctrl+Z / Ctrl+Shift+Z. **Pan:** Space+drag or middle/right drag. **Zoom:** wheel. **Fit:** F. **Save/open:** Ctrl+S / Ctrl+O. Browser autosave can be restored through Projects, but is not a substitute for a saved file.

## Starting projects and station coverage

| Preset | Contents |
|---|---|
| Victoria expansion | All 320 stations in the fork's source catalogue, plus **West Tarneit** from the supplied map: 321 station labels. Includes Warrnambool, Ararat, Maryborough, Bendigo, Echuca, Swan Hill, Shepparton, Albury and Bairnsdale branches. |
| Original Kea topology | All 1,042 original LEDs, 227 station labels and their extracted lane connections; larger board margin for expansion. |
| Three-track spacing study | Camberwell–Box Hill, six stations, three tracks, seven intermediate columns per span: 123 LEDs. SVG/project/mapping export; no complete PCB export because this study omits the controller circuit. |

The original LED geometry, rotation and supply net were compared with every source footprint. New regional track counts are **provisional layout assumptions**, not a signalling or track survey. Their placement is a starting arrangement and has conflicts to resolve. West Tarneit has no ID in the bundled feed snapshot, so none is invented. The catalogue is a snapshot from your fork, not an automatically updated list of operational stations. The editor also supports custom stations.

The map LEDs use the source **XL-1615RGBC-WS2812B-S** footprint, with a nominal **1.6 × 1.5 mm** body. Actual pads come from the source PCB. Changing board size does not change this footprint.

## What the KiCad export contains

- A native `.kicad_pcb` with placed LEDs, capacitors, the existing controller/power/USB footprints, board outline and station artwork.
- The original main and USB schematics, unchanged. Eight regenerated LED-sheet hierarchies and a regenerated capacitor hierarchy, with matching PCB/schematic instance paths.
- Real DIN/DOUT, supply and ground nets. Chains 1, 5 and 6 retain the source `+5V_CH2` domain; chains 2, 3, 4, 7 and 8 use `+5V_CH1`.
- Embedded source footprint and symbol libraries and a `.kicad_pro` project. Original machine-specific 3D model paths are omitted.
- LED address CSV/JSON, station records, a C++ address-table header, editable project JSON and an appearance SVG.

Open **KiCad/Melbourne-Live-Train-Map.kicad_pro**. The upstream filename is retained to preserve schematic instance identity.

**This is an unrouted engineering export, not an orderable PCB.** Moving parts invalidates existing copper, so the exporter removes all tracks, vias and fills, including the original antenna copper. PCB artwork is not electrical routing. The editor's proximity/boundary checks are approximate; they do not replace KiCad's pad, clearance, silk, antenna or power checks. Automatic capacitor positions and grouping also require review.

Bare OLED and encoder objects are currently **mechanical reservations on Dwgs.User**, not manufactured component footprints. Their real part numbers, FPC/pin geometry, driver/interface circuitry and GPIO connections still need to be selected. Importing a footprint does not create its schematic or firmware support. There is no native Altium export or automatic autorouting.

The existing firmware and backend are not rewritten by a layout export. New LED indices and regional blocks must be integrated before live/timetable modes work on a changed board. See [INTEGRATION.md](INTEGRATION.md).

## Validation and development

The automated tests verify original geometry/power, all catalogue stations, three-track spacing, stable IDs, save/load, protected junctions, controls through a DOM stub, every generated LED/capacitor's schematic pin labels, every PCB path, preserved circuit nets and portable libraries. The DOM stub has no layout engine and does not prove real browser behaviour.

**Remaining gates:** interactive browser testing and native KiCad loading/ERC/DRC. This build environment had no native KiCad; its cloud browser policy prohibited opening the local application. No claim of passing either gate is made.

```sh
# From the hardware repository root; Node 20+ and Python 3.12+.
node --test layout-studio/tests/*.test.js
python3 layout-studio/tools/build.py

# On a machine with KiCad 9+ installed, after extracting an editor export:
python3 layout-studio/tools/validate-kicad.py /path/to/extracted/export
```

On Windows, supply `--cli "C:\Program Files\KiCad\9.0\bin\kicad-cli.exe"` if KiCad is not on PATH. The validator runs KiCad's netlist, ERC and DRC commands, checks each LED's four schematic pins against the manifest, and records results. Unrouted connections will produce DRC findings; do not suppress those to manufacture a board.

Before relying on a layout, exercise dragging, label movement, undo/redo, save/reopen and ZIP download in your browser. In KiCad, check schematic/board parity, finish the missing circuits, route the board, check current and voltage drop, review RF geometry, and resolve ERC/DRC findings.

Source files are plain JavaScript, HTML and Python. `tools/build.py` creates the standalone HTML. `tools/extract_assets.py` rebuilds the bundled snapshot from this repository and a sibling `LED-Rails-Backend` checkout; it needs Python 3.12+ for the upstream generator syntax. The extractor executes only selected geometry functions, never the KiCad client or source-board writes. Arbitrary KiCad PCB import is not implemented; project JSON is the editing format.

Hardware/code derivation: GPL-3.0-or-later; Kea Studios / Chris Dirks attribution retained. JSZip is bundled under its MIT licence in `vendor/JSZIP-LICENSE.md`. Station records are derived from the fork's public transport data snapshot; their provenance is recorded in INTEGRATION.md.
