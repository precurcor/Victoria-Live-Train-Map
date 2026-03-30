# Melbourne Live Train Map

[![Hardware, Software and Documentation License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL3+-yellow.svg)](LICENSE)
[![Made with KiCad](https://img.shields.io/badge/Made%20with-KiCad-blue?logo=kicad)](https://kicad.org/)

**You can support my work by buying this train map through my store:** [**https://keastudios.co.nz/store/**](https://keastudios.co.nz/store)

A physical, real-time LED map of the Melbourne train network, powered by an ESP32-S3 microcontroller. Train movements are displayed using addressable RGB LEDs, with live data fetched over Wi-Fi.

![Overview_at_Southern_Cross](Images/Overview_at_Southern_Cross.avif)

## Features

- **Real-time Train Tracking:** Displays the locations of trains on the Melbourne network.
- **Addressable LEDs:** WS2812B-compatible RGB LEDs for a vibrant display.
- **Wi-Fi Connectivity:** ESP32-S3's built-in Wi-Fi fetches live train data.
- **Adjustable Brightness:** You can use the buttons to adjust the brightness of the LEDs.
- **Adaptive Brightness:** The circuit board has an ambient light sensor to automatically adjust the brightness of the LEDs.
- **Open Source:** Hardware and firmware are open source under GPL-3.0.

![Flinders_St_Close_Up](Images/Flinders_St_Close_Up.avif)

## PCB Design

- Designed in **KiCad V9.0** using [my JLCPCB KiCad Library](https://github.com/CDFER/jlcpcb-kicad-library)
- **View Online:** [Interactive PCB Layout (Kicanvas)](https://kicanvas.org/?github=https%3A%2F%2Fgithub.com%2FCDFER%2FMelbourne-Live-Train-Map%2Ftree%2Fmain%2FPCB)
- **Source Files:** `/PCB` directory

![Schematic](Images/Schematic.avif)

![ESP32_PCB](Images/ESP32_PCB.avif)

## Software / Firmware

The ESP32-S3 firmware is maintained in a separate repository: [LED-Rails-Firmware](https://github.com/CDFER/LED-Rails-Firmware)

![ESP32_Close_Up](Images/ESP32_Close_Up.avif)

## Contributing

Contributions are welcome! Open an issue or submit a pull request for improvements, bug fixes, or feature suggestions.

![Stony_Point_Overview](Images/Stony_Point_Overview.avif)

## License

This project is released under the GPL-3.0-or-later license.

© 2026 Chris Dirks
