# How the three repositories fit together

The hardware repository describes the physical product: KiCad schematics, PCB, parts and the Python placement generator. The ESP32-S3 runs the separate firmware. A Bun/TypeScript server in the backend repository converts transport data into the logical LED-block updates the firmware displays.

| Stage | Existing implementation | Why a larger layout matters |
|---|---|---|
| Fetch transport data | Backend `railNetwork.ts`, network configuration and the static/timetable loaders; `server.ts` publishes endpoints. Melbourne configuration includes Metro and V/Line vehicle feeds. | Feed coverage alone does not create map blocks or new station display information. |
| Match trains to blocks | `trackBlocks.ts`, `railNetworks/MEL/trackBlocks.kml` and network configuration. | New stations and intermediate LEDs need new geographic block/transition definitions. |
| Serve board updates | Versioned JSON endpoints configured per network, alongside vehicles/status/map endpoints. | Keep a distinct layout/version so an old board cannot accidentally receive incompatible addressing. |
| Drive physical LEDs | Firmware `src/network.cpp`, `src/mapRenderer.cpp`, `src/mapLeds.cpp`, board definitions and LED buffers. | The current block-to-strip calculation assumes contiguous block ranges; this editor's changed layout needs an explicit lookup. |
| Other product features | Buttons, brightness/ambient sensor, Wi-Fi, web control panel, display modes and timetable/schedule code remain in the existing firmware. | Preserve these code paths while adding the new layout and the OLED/encoder interface. |

This editor is a new directory in the hardware fork. It does not alter the running backend, existing firmware, API keys or original PCB. It preserves the main/USB circuit in its exports but cannot guarantee the original hardware behaviour after the PCB has been rearranged and rerouted.

## Addressing contract

Every LED gets a stable **block ID**, a **channel (1–8)** and a **zero-based index** in that channel. Old LEDs retain their logical IDs. New IDs start at 2000, increase monotonically and are not recycled. Decreasing then increasing a corridor's count restores previously allocated slot IDs. Undo/project JSON preserves the registry.

Physical chain order is deterministic: original block order, with new corridor LEDs grouped after their source node's first active block. It is an electrical ordering contract, not a route optimiser. The PCB and regenerated schematic use the same ordering. `led-manifest.json` is authoritative; do not derive new indices using `block - startBlock`.

For a final design:

1. Update the board's `LED_n_PIXELS` definitions to `LAYOUT_CHAIN_LENGTHS` and integrate the block/channel/index table into the `CMD_SET_BLOCK` path in `src/mapLeds.cpp`. All existing display modes must use the same lookup. Review RAM and WS2812 refresh time with the new totals.
2. Extend the geographic KML/configuration for each new or subdivided block and recheck directional transitions, branches and junctions. A diagram's millimetre coordinates are not GPS coordinates. Per-edge `fraction` is a design parameter, not a validated real railway position.
3. Regenerate timetable-derived block arrays for the changed layout and test live, timetable, offline, brightness and web-control modes.
4. Give the bare OLED and push encoder exact part numbers. Add their real symbols, footprints and circuits in KiCad, then assign available GPIOs after checking boot, USB, sensor and existing controls. The display can use a station-detail endpoint without putting transport API credentials on the device.
5. Add nonblocking encoder/debounce and display tasks, a station/favourites menu and station-platform/departure data handling. Vehicle positions alone are not a promise of reliable next-departure/platform information. Those features are not implemented in this editor.

## Source snapshots

- Hardware: `precurcor/Victoria-Live-Train-Map`, commit `f628db0917e4a076e77e99ff934c330375196ae1`.
- Station data: `precurcor/LED-Rails-Backend`, commit `553fb6478ea161bf26eaaa0c6da397858f452421`, `railNetworks/MEL/stops.txt`. That file concatenates Metro and V/Line CSV variants; the extractor handles their different field positions and excludes entrances/replacement buses from rail platforms.
- Firmware reviewed: `precurcor/LED-Rails-Firmware`, commit `dc68f96292ae73c56ce648faa794d75013e02c57`.
- West Tarneit is added from the user-supplied September 2026 map and marked as lacking a source feed identity.

KiCad writers follow the official [schematic format](https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/) and [shared S-expression format](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/). The native validation helper uses the documented [KiCad 9 CLI](https://docs.kicad.org/9.0/en/cli/cli.html).
