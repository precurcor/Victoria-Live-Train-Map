# Victoria Rail Layout Studio 1.1

An offline, millimetre-based layout editor built from the Kea train map in this fork. It lets you arrange stations, parallel tracks and hardware, change LED density, and generate a linked KiCad project.

**Start:** download the package, extract it, then open **Victoria-Rail-Layout-Studio.html** in a current desktop browser. No installation, server, account or internet connection is required. All dependencies are bundled. Save project files somewhere you keep backups.

The packaged download is [releases/Victoria-Rail-Layout-Studio.zip](releases/Victoria-Rail-Layout-Studio.zip). It includes the program, source, START-HERE.txt, this guide and an example Victoria KiCad export. On GitHub, open the ZIP and use **Download raw file**. In the extracted package, the program is at the top level. The SVG/editor appearance uses standard fonts; final KiCad typography and silk clearance still require inspection.

## Design your board

1. **Board:** set width, height and snap grid. The outline changes; LED and component sizes do not scale.
2. **Stations:** search for a station and click it to zoom in. Drag the station column to move it. Drag its text separately. Set coordinates, angle, track count and track pitch in the right panel. Drag across empty canvas to select a group, or Shift-click to add/remove objects. Group moves preserve relative spacing and bends; arrow keys nudge the selection.
3. **Intermediate LEDs:** Shift-select two neighbouring stations, then **Rebuild span**. Seven LEDs per track on three tracks gives **21 intermediate LEDs**, plus the station LEDs. Old intermediate blocks are retired without reusing their identities. At junctions, enable intermediate nodes in Board and edit the individual connections instead; rebuilding across a branch is deliberately blocked.
4. **Track shape:** click a connection. Change its LED count, or use target pitch in millimetres. Drag the diamond to bend the bundle. Lane mappings such as `1:1, 2:2, 3:3` are editable. **Connect** joins two station/node endpoints. **Insert station** splits a connection and replaces one intermediate column where available, preserving the total LED count. Bent routes retain their shape. Zero-count connections gain the new station’s LEDs.
5. **Hardware:** move the original buttons, MCU, USB and power components. Use **Select controller group** to move nearby electronics together. Set the bare OLED reservation and encoder dimensions/position. You can add mounting holes and import KiCad footprints for other parts. Use **Assign KiCad footprint** on an OLED/encoder reservation to replace it with the exact part’s pads. Set each pad’s verified net name in the inspector; blank means unconnected, `NC` means intentionally unused. A matching numbered-pin schematic symbol and its footprint library are exported. Enable **Capacitors** in Board to move and rotate generated decoupling capacitors; placement overrides follow their starting LED group.
6. **Preview / save / export:** Preview shows sample illumination, not live trains. **Save project** writes a reopenable `.rail.json`. **Open** restores it. **Export KiCad** writes the circuit/layout bundle; SVG and LED mapping exports are also available.

**Undo/redo:** Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y). **Pan:** Space+drag or middle/right drag. **Zoom:** wheel. **Fit:** F. **Save/open:** Ctrl+S / Ctrl+O. Browser autosave can be restored through Projects, but is not a substitute for a saved file.

## Starting projects and station coverage

| Preset | Contents |
|---|---|
| Victoria expansion | All 320 stations in the fork's source catalogue, plus **West Tarneit** from the supplied map: 321 station labels and 1,600 LEDs. Includes Warrnambool, Ararat, Maryborough, Bendigo, Echuca, Swan Hill, Shepparton, Albury and Bairnsdale branches. |
| Original Kea topology | All 1,042 original LEDs, 227 station labels and their extracted lane connections; larger board margin for expansion. |
| Three-track spacing study | Camberwell–Box Hill, six stations, three tracks, seven intermediate columns per span: 123 LEDs. Exports an LED-only PCB and linked schematics; an external controller and power supply are required. |

The original LED geometry, rotation and supply net were compared with every source footprint. New regional track counts are **provisional layout assumptions**, not a signalling or track survey. The default placement passes the editor’s LED-distance and board-boundary checks; label placement, pad clearances and routing still need review in your final design. West Tarneit has no ID in the bundled feed snapshot, so none is invented. The catalogue is a snapshot from your fork, not an automatically updated list of operational stations. The editor also supports custom stations.

The map LEDs use the source **XL-1615RGBC-WS2812B-S** footprint, with a nominal **1.6 × 1.5 mm** body. Actual pads come from the source PCB. Changing board size does not change this footprint.

## What the KiCad export contains

- A native `.kicad_pcb` with placed LEDs, capacitors, the existing controller/power/USB footprints, board outline and station artwork.
- The original main and USB circuits; their files remain byte-for-byte unchanged unless an assigned component requires a new user-components hierarchy in the main sheet. Eight regenerated LED-sheet hierarchies and a regenerated capacitor hierarchy, with matching PCB/schematic instance paths.
- Real DIN/DOUT, supply and ground nets. Chains 1, 5 and 6 retain the source `+5V_CH2` domain; chains 2, 3, 4, 7 and 8 use `+5V_CH1`.
- Embedded source footprint and symbol libraries and a `.kicad_pro` project. Original machine-specific 3D model paths are omitted.
- LED address CSV/JSON, station records, a C++ address-table header, editable project JSON and an appearance SVG.

Open **KiCad/Melbourne-Live-Train-Map.kicad_pro**. The upstream filename is retained to preserve schematic instance identity.

**This is an unrouted engineering export, not an orderable PCB.** Moving parts invalidates existing copper, so the exporter removes all tracks, vias and fills, including the original antenna copper. PCB artwork is not electrical routing. The editor's proximity/boundary checks are approximate; they do not replace KiCad's pad, clearance, silk, antenna or power checks. Capacitor grouping and initial positions require review. Moving a capacitor is saved, but changing LED density or capacitor grouping can create different groups and fresh automatic positions.

Bare OLED and encoder objects start as **mechanical reservations on Dwgs.User**. Assign an exact `.kicad_mod` footprint to export real pads and a matching numbered-pin symbol. The generic symbol uses passive pins: it preserves your declared connections but cannot validate device-specific pin types or power requirements. Real part numbers, FPC/pin geometry, driver/interface circuitry and GPIO connections still need to be selected from the part datasheet; assigning a footprint does not implement display/encoder firmware. There is no native Altium export or automatic autorouting.

The existing firmware and backend are not rewritten by a layout export. New LED indices and regional blocks must be integrated before live/timetable modes work on a changed board. See [INTEGRATION.md](INTEGRATION.md).

## Validation and development

The 23 automated regression tests cover original geometry/power, station coverage, parallel and curved columns, insertion counts, stable IDs, group drag/marquee/cancel, undo/redo, save/reopen and recovery, assigned component pins, capacitor overrides, actual downloadable ZIP contents, schematic hierarchy and preserved circuit nets. Interactive handlers run through a DOM stub, and the renderer’s SVG was visually inspected. The DOM stub has no layout engine and does not prove real browser behaviour.

**Native validation:** the GitHub workflow installs KiCad 9 and opens original, Victoria and assigned-component study exports. It checks native netlist generation, every LED pin net and schematic/PCB parity, and retains ERC/DRC reports as build artifacts. A passing format/parity gate does not clear electrical or unrouted-board findings.

**Browser limitation:** full interactive browser testing remains unverified because the available browser policy prohibits opening this local application. The event/download tests and SVG inspection do not replace a real browser session.

```sh
# From the hardware repository root; Node 20+ and Python 3.12+.
node --test layout-studio/tests/*.test.js
python3 layout-studio/tools/build.py

# On a machine with KiCad 9+ installed, after extracting an editor export:
python3 layout-studio/tools/validate-kicad.py /path/to/extracted/export
```

On Windows, supply `--cli "C:\Program Files\KiCad\9.0\bin\kicad-cli.exe"` if KiCad is not on PATH. The validator runs KiCad's netlist, ERC and DRC commands, checks each LED's four schematic pins against the manifest, and records results. Unrouted connections will produce DRC findings; do not suppress those to manufacture a board.

Before relying on a layout, exercise dragging, label movement, undo/redo, save/reopen and ZIP download in your browser. In KiCad, check schematic/board parity, finish the missing circuits, route the board, check current and voltage drop, review RF geometry, and resolve ERC/DRC findings.

Version 1.0 `.rail.json` projects remain supported; their existing coordinates and block IDs are retained. The new regional arrangement applies when you choose a fresh Victoria preset.

Source files are plain JavaScript, HTML and Python. `tools/build.py` creates the standalone HTML. `tools/extract_assets.py` rebuilds the bundled snapshot from this repository and a sibling `LED-Rails-Backend` checkout; it needs Python 3.12+ for the upstream generator syntax. The extractor executes only selected geometry functions, never the KiCad client or source-board writes. Arbitrary KiCad PCB import is not implemented; project JSON is the editing format. The native validation workflow uses the [official KiCad Ubuntu PPA](https://www.kicad.org/download/linux-distros/).

Hardware/code derivation: GPL-3.0-or-later; Kea Studios / Chris Dirks attribution retained. JSZip is bundled under its MIT licence in `vendor/JSZIP-LICENSE.md`. Station records are derived from the fork's public transport data snapshot; their provenance is recorded in INTEGRATION.md.
