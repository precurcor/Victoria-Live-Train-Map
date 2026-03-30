from kipy import KiCad

from kipy.board_types import (
    BoardText,
    BoardSegment,
    BoardArc,
    BoardBezier,
    BoardPolygon,
    Via,
    Net,
)
from kipy.proto.board.board_types_pb2 import BoardLayer
from kipy.proto.common import HorizontalAlignment, VerticalAlignment, StrokeLineStyle
from kipy.geometry import Vector2, Angle, PolygonWithHoles, PolyLine, PolyLineNode
from kipy.util import from_mm

import os

kicad = KiCad(timeout_ms=30000)  # 10 second timeout for KiCad operations
board = kicad.get_board()

board_texts = board.get_text()

# Fetch station names from stops.txt
station_names = {}
# open blocksFromTimetable\stops.txt and read lines (csv format)
# stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding,level_id,platform_code
path = os.path.join(os.path.dirname(__file__), "blocksFromTimetable", "stops.txt")
with open(path, "r", encoding="utf-8") as f:
    for line in f.readlines()[1:]:
        parts = line.strip().split(",")
        if len(parts) < 2:
            continue
        stop_name = parts[1].strip().upper()
        # Remove quotation marks
        stop_name = stop_name.replace('"', "")
        # Remove " Station" suffix
        if stop_name.endswith("STATION"):
            stop_name = stop_name.replace(" STATION", "")
            stop_name = stop_name.replace(" RAILWAY", "")
            station_names[stop_name] = True

# Check each board text against station names
for item in board_texts:
    text_value = item.value.strip().upper()
    text_value = text_value.replace("\n", " ")
    if text_value not in station_names:
        print(f"Warning: Station name '{text_value}' not found in stops.txt")