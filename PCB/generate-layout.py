from kipy import KiCad

from kipy.board_types import (
    BoardText,
    BoardSegment,
    BoardArc,
    BoardCircle,
    BoardBezier,
    BoardPolygon,
    Via,
    Net,
    Track,
)
from kipy.proto.board.board_types_pb2 import BoardLayer
from kipy.proto.common import HorizontalAlignment, VerticalAlignment, StrokeLineStyle
from kipy.geometry import Vector2, Angle, PolygonWithHoles, PolyLine, PolyLineNode
from kipy.util.units import from_mm, to_mm

import numpy as np

from math import cos, sin, radians, degrees, acos, tan, atan2

from enum import Enum

import time

kicad = KiCad(timeout_ms=30000)  # 10 second timeout for KiCad operations
board = kicad.get_board()

# --- PERFORMANCE: cache nets & footprints to avoid repeated linear scans ---
_nets_cache = None
_footprint_cache = None

DEBUG = False


def _build_net_cache():
    global _nets_cache
    if _nets_cache is None:
        # build a dict once
        _nets_cache = {net.name: net for net in board.get_nets()}
    return _nets_cache


def get_net_by_name(name: str):
    # fast O(1) lookup using cache; builds cache on first use
    return _build_net_cache().get(name)


# LED object to store x size and y size for offset calculations
class LED:
    x = 1.7  # mm
    y = 1.6  # mm
    pad_x = 0.625
    pad_y = 0.475


led = LED()


def get_net_by_name(name: str):
    # NOTE: cached implementation above (_build_net_cache) should be used.
    # This thin wrapper ensures callers use the cache-backed function.
    return _build_net_cache().get(name)


def add_via(cursor, net: str, diameter_mm: float = 0.5, drill_mm: float = 0.3):
    via = Via()
    net_object = get_net_by_name(net)
    if net_object is not None:
        via.position = Vector2.from_xy_mm(cursor["x"], cursor["y"])
        via.diameter = from_mm(diameter_mm)
        via.drill_diameter = from_mm(drill_mm)
        via.net = net_object
        via.locked = True
        items_to_add.append(via)  # Store the via for later addition


def bearing_to_kicad_angle(bearing: float) -> float:
    return (
        360 - bearing - 90
    ) % 360  # Convert bearing angle to KiCad angle (Kicad 0° is East, anti-clockwise is positive)


# Takes the cursor x, y, angle and a distance. Returns the new x, y after moving distance forward.
def vector(cursor, distance, angle=None, edit=False) -> dict[str, float]:
    if not edit:
        cursor = cursor.copy()

    vector_angle = (float(cursor["angle"]) - 90) % 360

    if angle is not None:
        vector_angle = ((angle - 90) + vector_angle) % 360

    angle_rad = radians(vector_angle)
    cursor["x"] = float(cursor["x"]) + cos(angle_rad) * distance
    cursor["y"] = float(cursor["y"]) + sin(angle_rad) * distance
    return cursor


# Take a cursor and x and y offsets in mm, and returns the new cursor after moving to that position.
def relative(cursor, x: float, y: float, edit=False) -> dict[str, float]:
    if not edit:
        cursor = cursor.copy()

    y = -y  # Invert y for KiCad coordinate system

    vector_angle = (float(cursor["angle"]) - 90) % 360

    cursor["x"] = (
        cursor["x"] + x * cos(radians(vector_angle)) - y * sin(radians(vector_angle))
    )
    cursor["y"] = (
        cursor["y"] + x * sin(radians(vector_angle)) + y * cos(radians(vector_angle))
    )

    return cursor


def move_footprint(reference, x: float, y: float, angle: float):
    global footprints
    footprint = get_footprint_by_reference(footprints, reference)
    if footprint is not None:
        footprint.position = Vector2.from_xy_mm(x, y)
        footprint.orientation = Angle.from_degrees(
            degrees=bearing_to_kicad_angle(angle)
        )
        items_to_update.append(footprint)
    else:
        print(f"Footprint {reference} not found!")


def draw_polygon(
    points: list[dict],
    layer=BoardLayer.BL_F_SilkS,
    width: float = 0.0,
    filled: bool = True,
    style=StrokeLineStyle.SLS_SOLID,
    net: str = "",
):
    """Draw a polygon from a list of (x,y) points in mm.

    - `width` is the stroke width in mm.
    - `filled` controls whether the polygon is filled.
    - `style` is the stroke style (dotted/dashed/solid).
    - `net` optionally assigns a net when drawing on copper layers.
    """
    boardPolygon = BoardPolygon()
    boardPolygon.layer = layer

    # Create a polygon (outline) and append nodes for each point.
    poly = PolygonWithHoles()
    outline = PolyLine()

    for cursor in points:
        # points are provided in mm; convert to nm using Vector2.from_xy_mm
        node = PolyLineNode.from_point(Vector2.from_xy_mm(cursor["x"], cursor["y"]))
        outline.append(node)

    # Close the polyline so it's a proper polygon
    outline.closed = True

    poly.outline = outline

    # Append the polygon to the BoardPolygon's polygon list
    boardPolygon.polygons.append(poly)

    # Set stroke attributes
    boardPolygon.attributes.stroke.width = from_mm(width)
    boardPolygon.attributes.stroke.style = style

    # Set fill flag
    boardPolygon.attributes.fill.filled = bool(filled)
    
    boardPolygon.locked = True

    # Optionally set net
    if net:
        boardPolygon.net = get_net_by_name(net)

    items_to_add.append(boardPolygon)


def draw_line(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    width: float = 0.1,
    style=StrokeLineStyle.SLS_SOLID,
    net: str = "",
    layer=BoardLayer.BL_F_SilkS,
) -> None:
    boardSegment = BoardSegment()
    boardSegment.start = Vector2.from_xy_mm(x1, y1)
    boardSegment.end = Vector2.from_xy_mm(x2, y2)
    boardSegment.attributes.stroke.width = from_mm(width)
    boardSegment.attributes.stroke.style = style
    boardSegment.layer = layer
    boardSegment.locked = True

    if net != "":
        boardSegment.net = get_net_by_name(net)

    items_to_add.append(boardSegment)  # Store the segment for later addition


def draw_circle(
    cursor,
    radius: float,
    width: float = 0.0,
    filled: bool = True,
    net: str = "",
    layer=BoardLayer.BL_F_SilkS,
):
    boardCircle = BoardCircle()

    x = cursor["x"]
    y = cursor["y"]
    if "angle" not in cursor:
        cursor["angle"] = 0  # Ensure angle is defined

    radius_point = vector(cursor, radius, 0)

    boardCircle.center = Vector2.from_xy_mm(x, y)
    boardCircle.radius_point = Vector2.from_xy_mm(radius_point["x"], radius_point["y"])

    boardCircle.attributes.stroke.width = from_mm(width)
    boardCircle.attributes.fill.filled = filled
    boardCircle.layer = layer
    boardCircle.locked = True

    if net != "":
        boardCircle.net = get_net_by_name(net)

    items_to_add.append(boardCircle)  # Store the circle for later addition


def draw_arc(
    cursor,
    radius: float,
    start_angle: float,
    end_angle: float,
    width: float = 0.1,
    net: str = "",
    layer=BoardLayer.BL_F_SilkS,
):
    boardArc = BoardArc()

    x = cursor["x"]
    y = cursor["y"]

    start = vector(cursor, radius, start_angle)
    mid = vector(cursor, radius, (start_angle + end_angle) / 2)
    end = vector(cursor, radius, end_angle)

    boardArc.start = Vector2.from_xy_mm(start["x"], start["y"])
    boardArc.mid = Vector2.from_xy_mm(mid["x"], mid["y"])
    boardArc.end = Vector2.from_xy_mm(end["x"], end["y"])

    boardArc.attributes.stroke.width = from_mm(width)
    boardArc.layer = layer
    boardArc.locked = True

    if net != "":
        boardArc.net = get_net_by_name(net)

    items_to_add.append(boardArc)  # Store the arc for later addition


def point_on_bezier(p0, p1, p2, p3, d):
    # Convert inputs to simple [x, y] lists/arrays
    def get_coords(p):
        if hasattr(p, "x") and hasattr(p, "y"):
            return np.array([p.x, p.y], dtype=float)
        elif isinstance(p, dict):
            return np.array([p["x"], p["y"]], dtype=float)
        else:
            return np.array(p, dtype=float)

    P0, P1, P2, P3 = get_coords(p0), get_coords(p1), get_coords(p2), get_coords(p3)

    # Cubic Bezier formula: B(t)
    def bezier(t):
        # (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
        return (
            (1 - t) ** 3 * P0
            + 3 * (1 - t) ** 2 * t * P1
            + 3 * (1 - t) * t**2 * P2
            + t**3 * P3
        )

    # To find t for a given distance d, we discretize the curve into small linear segments
    # to approximate the arc length to t relationship.
    segments = 100
    t_vals = np.linspace(0, 1, segments + 1)
    points = np.array([bezier(t) for t in t_vals])

    # Calculate lengths of segments
    # points[1:] - points[:-1] gives vectors of segments
    # norm gives lengths
    deltas = points[1:] - points[:-1]
    lengths = np.sqrt(np.sum(deltas**2, axis=1))  # segment lengths
    cumulative_lengths = np.concatenate(([0], np.cumsum(lengths)))

    total_length = cumulative_lengths[-1]

    if d <= 0:
        return {"x": float(P0[0]), "y": float(P0[1])}
    if d >= total_length:
        return {"x": float(P3[0]), "y": float(P3[1])}

    # Find which segment d falls into with binary search
    idx = np.searchsorted(cumulative_lengths, d)
    # cumulative_lengths[idx-1] <= d < cumulative_lengths[idx]
    # We want to interpolate between t_vals[idx-1] and t_vals[idx]

    # Handle edge case where d exactly matches a value
    if idx == 0:
        idx = 1

    l_start = cumulative_lengths[idx - 1]
    l_end = cumulative_lengths[idx]

    t_start = t_vals[idx - 1]
    t_end = t_vals[idx]

    # Interpolate t
    fraction = (d - l_start) / (l_end - l_start) if (l_end - l_start) > 0 else 0
    t = t_start + fraction * (t_end - t_start)

    pt = bezier(t)
    return {"x": float(pt[0]), "y": float(pt[1])}


def draw_bezier(
    start_cursor,
    end_cursor,
    control_length: float = 0.5,
    controlL1: float = None,
    controlL2: float = None,
    width: float = 0.25,
    style=StrokeLineStyle.SLS_SOLID,
    net: str = "",
    layer=BoardLayer.BL_F_SilkS,
):
    boardBezier = BoardBezier()
    boardBezier.start = Vector2.from_xy_mm(start_cursor["x"], start_cursor["y"])
    boardBezier.end = Vector2.from_xy_mm(end_cursor["x"], end_cursor["y"])

    # Calculate tangent vectors at start and end
    start_angle_rad = radians(start_cursor["angle"] - 90)
    end_angle_rad = radians(end_cursor["angle"] - 90)

    # Direction vectors for tangents
    start_dir = (cos(start_angle_rad), sin(start_angle_rad))
    end_dir = (cos(end_angle_rad), sin(end_angle_rad))

    # Calculate intersection point of tangent lines
    # Line 1: Start point + t * start_dir
    # Line 2: End point + u * end_dir
    A = np.array([start_cursor["x"], start_cursor["y"]])
    B = np.array([A[0] + start_dir[0], A[1] + start_dir[1]])
    C = np.array([end_cursor["x"], end_cursor["y"]])
    D = np.array([C[0] + end_dir[0], C[1] + end_dir[1]])

    # Find intersection of lines AB and CD
    denominator = (D[1] - C[1]) * (B[0] - A[0]) - (D[0] - C[0]) * (B[1] - A[1])

    if abs(denominator) < 1e-1:
        # Lines are parallel - use simple control points
        if controlL1 and controlL2:
            control1 = vector(start_cursor, controlL1)
            control2 = vector(end_cursor, -controlL2)
        else:
            control1 = vector(start_cursor, control_length)
            control2 = vector(end_cursor, -control_length)

    else:
        ua = (
            (D[0] - C[0]) * (A[1] - C[1]) - (D[1] - C[1]) * (A[0] - C[0])
        ) / denominator
        intersection = A + ua * (B - A)

        # Calculate optimal fraction for circular arc approximation
        fraction = 4 * (2**0.5 - 1) / 3  # ≈0.5528
        # fraction = 1

        # Calculate vectors from points to intersection
        vec_start = np.array(
            [intersection[0] - start_cursor["x"], intersection[1] - start_cursor["y"]]
        )
        vec_end = np.array(
            [intersection[0] - end_cursor["x"], intersection[1] - end_cursor["y"]]
        )

        distance = (
            (vec_end[0] - vec_start[0]) ** 2 + (vec_end[1] - vec_start[1]) ** 2
        ) ** 0.5
        control_length = (1 / 3) * distance
        # Check that vec_start is in the direction of the tangents and at least control_length long
        if (
            np.dot(vec_start, start_dir) < 0
            or np.linalg.norm(vec_start) * fraction < control_length
        ):
            control1 = vector(start_cursor, control_length)
        else:
            control1 = {
                "x": start_cursor["x"]
                + fraction * (intersection[0] - start_cursor["x"]),
                "y": start_cursor["y"]
                + fraction * (intersection[1] - start_cursor["y"]),
            }

        # Check that vec_end is in the opposite direction of the tangents and at least control_length long
        if (
            np.dot(vec_end, end_dir) > 0
            or np.linalg.norm(vec_end) * fraction < control_length
        ):
            control2 = vector(end_cursor, -control_length)
        else:
            control2 = {
                "x": end_cursor["x"] + fraction * (intersection[0] - end_cursor["x"]),
                "y": end_cursor["y"] + fraction * (intersection[1] - end_cursor["y"]),
            }

    boardBezier.control1 = Vector2.from_xy_mm(control1["x"], control1["y"])
    boardBezier.control2 = Vector2.from_xy_mm(control2["x"], control2["y"])

    if style == StrokeLineStyle.SLS_DOT:
        # Calculate curve length to spacing vias correctly
        # We reuse the logic from point_on_bezier but keep it local to avoid double calculation
        def get_coords(p):
            if hasattr(p, "x") and hasattr(p, "y"):
                return np.array([p.x, p.y], dtype=float)
            elif isinstance(p, dict):
                return np.array([p["x"], p["y"]], dtype=float)
            else:
                return np.array(p, dtype=float)

        P0, P1, P2, P3 = (
            get_coords(start_cursor),
            get_coords(control1),
            get_coords(control2),
            get_coords(end_cursor),
        )

        def bezier(t):
            return (
                (1 - t) ** 3 * P0
                + 3 * (1 - t) ** 2 * t * P1
                + 3 * (1 - t) * t**2 * P2
                + t**3 * P3
            )

        # Discretize to find length
        segments = 50
        t_vals = np.linspace(0, 1, segments + 1)
        points = np.array([bezier(t) for t in t_vals])
        deltas = points[1:] - points[:-1]
        lengths = np.sqrt(np.sum(deltas**2, axis=1))
        cumulative_lengths = np.concatenate(([0], np.cumsum(lengths)))
        total_length = cumulative_lengths[-1]

        # Place vias every x mm
        dot_spacing = 0.5

        d_values = [total_length / 2]
        offset = dot_spacing
        while (total_length / 2) + offset <= total_length:
            d_values.append((total_length / 2) + offset)
            d_values.append((total_length / 2) - offset)
            offset += dot_spacing

        for d in d_values:
            # Interpolate options
            idx = np.searchsorted(cumulative_lengths, d)
            if idx == 0:
                idx = 1
            elif idx >= len(cumulative_lengths):
                idx = len(cumulative_lengths) - 1

            l_start = cumulative_lengths[idx - 1]
            l_end = cumulative_lengths[idx]
            t_start = t_vals[idx - 1]
            t_end = t_vals[idx]

            fraction = (d - l_start) / (l_end - l_start) if (l_end - l_start) > 0 else 0
            t = t_start + fraction * (t_end - t_start)

            pt = bezier(t)
            # add_via({"x": pt[0], "y": pt[1]}, net)
            draw_circle({"x": pt[0], "y": pt[1]}, width / 2)

        return

    # if style != StrokeLineStyle.SLS_SOLID:
    #     width *= 2 # Make dotted/dashed lines thicker for visibility

    boardBezier.attributes.stroke.width = from_mm(width)
    boardBezier.attributes.stroke.style = style
    boardBezier.layer = layer
    boardBezier.locked = True

    items_to_add.append(boardBezier)  # Store the bezier for later addition
    return


def draw_track(
    start_cursor,
    end_cursor,
    net,
    line_width: float = 0.15,
    layer=BoardLayer.BL_F_Cu,
):
    boardTrack = Track()
    boardTrack.start = Vector2.from_xy_mm(start_cursor["x"], start_cursor["y"])
    boardTrack.end = Vector2.from_xy_mm(end_cursor["x"], end_cursor["y"])
    boardTrack.width = from_mm(line_width)
    boardTrack.layer = layer
    net_object = get_net_by_name(net)
    if net_object is not None:
        boardTrack.net = net_object
    boardTrack.locked = True
    items_to_add.append(boardTrack)  # Store the track for later addition


def add_stitching_via(cursor, single_track=False):
    tracklist = cursor.get("track_list", [])
    track = tracklist[0]  # Get the first track in the list
    offset = 0.7 if single_track else -0.7
    pos = relative(track, offset, -1.75)  # Move back to make room for capacitor
    
    add_via(pos, "GND")


def add_capacitor(cursor):
    tracklist = cursor.get("track_list", [])
    track = tracklist[0]  # Get the first track in the list
    pos = relative(track, 0, -1.75)  # Move back to make room for capacitor
    ref = cursor.get("cap_ref_num", 100)
    cursor["cap_ref_num"] = ref + 1
    cursor["cap_counter"] -= cursor["leds_per_cap"]

    # print(f"Adding capacitor C{ref} at ({track['x']:.2f}, {track['y']:.2f}) angle {track['angle']}°")

    move_footprint(f"C{ref}", pos["x"], pos["y"], pos["angle"])
    
    draw_track(
        relative(pos, -0.5, 0),
        relative(pos, -1.1, 0),
        "GND",
        line_width=0.6,
        layer=BoardLayer.BL_F_Cu,
    )
    
    add_via(relative(pos, -1.1, 0), "GND")
    
    draw_track(
        relative(pos, 0.5, 0),
        relative(pos, 1.1, 0),
        "+5V",
        line_width=0.6,
        layer=BoardLayer.BL_F_Cu,
    )
    
    add_via(relative(pos, 1.1, 0), "+5V")
    
    draw_track(
        relative(pos, 0.8, 0),
        relative(pos, 1.1, 0),
        "+5V",
        line_width=0.6,
        layer=BoardLayer.BL_B_Cu,
    )
    
    draw_track(
        relative(pos, 1.1, 0),
        relative(track, 1.1, -3),
        "+5V",
        line_width=0.6,
        layer=BoardLayer.BL_B_Cu,
    )


def add_data_trace(
    start_cursor,
    end_cursor,
    between=False,
    single_track=False,
):

    line_width = 0.15

    points = []
    if between:
        start_track = None
        opposite_start_track = None
        end_track = None
        opposite_end_track = None
        
        # +5V Backside Power
        started_power_trace = False
        for i, track in enumerate(reversed(end_cursor)):
            if track.get("skip", False) == False:
                if single_track:
                    start = relative(track, -0.1, -0.475)
                    end = relative(track, -0.1, -3)
                    draw_track(
                        start,
                        end,
                        "+5V",
                        line_width=0.5,
                        layer=BoardLayer.BL_B_Cu,
                    )
                else:
                    if started_power_trace is False:
                        started_power_trace = True
                        start = relative(track, 0.1, 0.475)
                        end = relative(start, 0.574, -0.574)
                    else:
                        start = relative(track, 0.1, 0.475)
                        end = relative(start, 0.574, 0)
                    draw_track(
                        start,
                        end,
                        "+5V",
                        line_width=0.5,
                        layer=BoardLayer.BL_B_Cu,
                    )
                    draw_track(
                        end,
                        relative(track, 0.574+0.1, -3),
                        "+5V",
                        line_width=0.5,
                        layer=BoardLayer.BL_B_Cu,
                    )


        for i, track in enumerate(reversed(start_cursor)):
            if track.get("skip", False) == False:
                start_track = track
                break
            
        for i, track in enumerate(start_cursor):
            if track.get("skip", False) == False:
                opposite_start_track = track
                break

        for i, track in enumerate(end_cursor):
            if track.get("skip", False) == False:
                end_track = track
                break
            
        for i, track in enumerate(reversed(end_cursor)):
            if track.get("skip", False) == False:
                opposite_end_track = track
                break
            
        if end_track is not None and opposite_start_track is not None:
            if len(start_cursor) == 1:
                start = relative(opposite_start_track, -0.1, -3)
            else:
                start = relative(opposite_start_track, 0.674, -3)
                
            if single_track:
                end = relative(end_track, -0.1, -3)
            else:
                end = relative(end_track, 0.674, -3)
            draw_track(
                start,
                end,
                "+5V",
                line_width=1.0,
                layer=BoardLayer.BL_B_Cu,
            )

        if start_track is None and end_track is None:
            return
        
        connect_data_blocks = True
        if len(start_cursor) != len(end_cursor):
            connect_data_blocks = False

        if start_track and end_track:
            if start_track["ref_num"] + 1 != end_track["ref_num"]:
                start_track = None
                
        if start_track is None:
            net = f"Net-({end_track['ref_num']-1}-DOUT)"
        else:
            net = f"Net-({start_track['ref_num']}-DOUT)"

        if start_track is not None:
            if len(start_cursor) > 1:
                # Data Trace
                points.append(relative(start_track, -LED.pad_x, LED.pad_y))
                points.append(relative(points[-1], 0, 0.0613))
                points.append(relative(points[-1], 0.6, 0.6))
                points.append(relative(points[-1], 0.872, 0))
                points.append(relative(points[-1], 0.287, -0.287))
                
                if opposite_start_track is not None and connect_data_blocks:
                    x = points[-1]["x"]
                    y = opposite_start_track["y"]+0.17
                    points.append(relative(opposite_start_track, 1.134, -1.136+0.491))
                    
                    points.append(relative(points[-1], 0.491, -0.491))             
                    

            else:
                points.append(relative(start_track, LED.pad_x, -LED.pad_y))
                
            if not connect_data_blocks:
                draw_multiline(line_width, points, net)
                points = []


        if end_track is not None:
            if len(end_cursor) > 1:
                points.append(relative(end_track, LED.pad_x, -LED.pad_y))
                # Insert points before the end cursor
                points.insert(-1, relative(points[-1], 0, -0.0613))
                points.insert(-2, relative(points[-2], -0.6, -0.6))
                points.insert(-3, relative(points[-3], -1.0, 0))
                # points.insert(-4, relative(points[-4], -0.491, 0.491))
            else:
                points.append(relative(end_track, -LED.pad_x, LED.pad_y))
                
            if not connect_data_blocks:
                draw_multiline(line_width, points, net)
                points = []
                
        if connect_data_blocks:
            draw_multiline(line_width, points, net)

    else:        
        # Data Trace
        points.append(relative(start_cursor, -LED.pad_x, LED.pad_y))
        points.append(relative(points[-1], 0, 0.0613))
        points.append(relative(points[-1], 0.495, 0.495))
        points.append(relative(points[-1], 0.2606, 0))
        points.append(relative(points[-1], 0.495, 0.495))
        points.append(relative(end_cursor, LED.pad_x, -LED.pad_y))
        net = f"Net-({start_cursor['ref_num']}-DOUT)"

        draw_multiline(line_width, points, net)


def draw_multiline(line_width, points, net):
    for i in range(len(points) - 1):
        draw_track(
            points[i],
            points[i + 1],
            net,
            line_width=line_width,
            layer=BoardLayer.BL_F_Cu,
        )


def draw_station_rectangle(
    start_cursor,
    end_cursor,
    offset_x: float,
    offset_y: float,
    line_width: float = 0.4,
):
    corners = []
    corners.append(relative(start_cursor, -offset_x, -offset_y))
    corners.append(relative(start_cursor, offset_x, -offset_y))
    corners.append(relative(end_cursor, offset_x, offset_y))
    corners.append(relative(end_cursor, -offset_x, offset_y))

    for i in range(4):
        x1 = corners[i]["x"]
        y1 = corners[i]["y"]
        x2 = corners[(i + 1) % 4]["x"]
        y2 = corners[(i + 1) % 4]["y"]
        draw_line(x1, y1, x2, y2, line_width)


def draw_text(
    x: float,
    y: float,
    text: str,
    angle: float = 0,
    font_size_mm: float = 1.7,
    font: str = "LHRVBK+NetworkSans-Bold",
    layer=BoardLayer.BL_F_SilkS,
    bold=True,
    horizontal_align=HorizontalAlignment.HA_LEFT,
    vertical_align=VerticalAlignment.VA_CENTER,
):
    boardText = BoardText()
    boardText.value = text
    boardText.layer = layer
    boardText.attributes.angle = angle
    boardText.attributes.font_name = font
    boardText.attributes.size = Vector2.from_xy_mm(font_size_mm, font_size_mm)
    boardText.attributes.bold = bold
    boardText.position = Vector2.from_xy_mm(x, y)
    boardText.attributes.vertical_alignment = vertical_align
    boardText.attributes.horizontal_alignment = horizontal_align
    boardText.locked = True
    
    items_to_add.append(boardText)  # Store the text for later addition


def add_station_name(
    cursor,
    name,
    font_size_mm: float = 1.7,
    end_of_line: bool = False,
    text_offset: float = 1.5,
    end_of_line_offset: float = 1.25,
):
    boardText = BoardText()

    name_str, name_dir = name

    if name_str.isupper():
        font_size_mm = 2
        boardText.attributes.font_name = "LHRVBK+NetworkSans-Bold"
    else:
        boardText.attributes.font_name = "LHRVBK+NetworkSans-Medium"

    boardText.layer = BoardLayer.BL_F_SilkS  # Set the layer for the text
    boardText.attributes.size = Vector2.from_xy(
        from_mm(font_size_mm), from_mm(font_size_mm)
    )  # Set font size
    boardText.attributes.bold = True  # Make the text bold
    boardText.attributes.line_spacing = font_size_mm / 2
    boardText.locked = True  # Lock the text in place

    name_str, name_dir = name

    text_to_stroke = 0.5
    stroke_width = 0.4

    cursor = cursor.copy()

    text_pos = None

    # print(f"Adding station name: {name_str} at angle {cursor['angle']}°")

    if end_of_line:
        name_str = name_str.replace(" ", "\n")
        boardText.attributes.line_spacing = font_size_mm * 0.4
        if cursor["angle"] == 90:
            angle = 90
            boardText.attributes.vertical_alignment = VerticalAlignment.VA_CENTER
            boardText.attributes.horizontal_alignment = HorizontalAlignment.HA_LEFT
            line_pos = relative(cursor, end_of_line_offset, 0)
            text_pos = relative(cursor, text_offset, 0)
        else:
            angle = 270
            boardText.attributes.vertical_alignment = VerticalAlignment.VA_CENTER
            boardText.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
            line_pos = relative(cursor, -end_of_line_offset, 0)
            text_pos = relative(cursor, -text_offset, 0)

    else:
        if name_dir == Dir.R:
            cursor["angle"] = (cursor["angle"] + 180) % 360

        if cursor["skip"] is not True:
            cursor = relative(cursor, 0, (led.y / 2 + 0.05), edit=True)

        line_pos = relative(cursor, 0, text_offset - text_to_stroke)

        if cursor["angle"] < 100 and cursor["angle"] > 80:
            name_str = name_str.replace(" ", "\n")
            boardText.attributes.vertical_alignment = VerticalAlignment.VA_BOTTOM
            boardText.attributes.horizontal_alignment = HorizontalAlignment.HA_CENTER
            angle = 0
        elif cursor["angle"] < 280 and cursor["angle"] > 260:
            name_str = name_str.replace(" ", "\n")
            boardText.attributes.vertical_alignment = VerticalAlignment.VA_TOP
            boardText.attributes.horizontal_alignment = HorizontalAlignment.HA_CENTER
            angle = 180
        else:
            if cursor["angle"] > 190 and cursor["angle"] < 350:
                boardText.attributes.vertical_alignment = VerticalAlignment.VA_TOP
                text_offset -= 0.4
            elif cursor["angle"] < 170 and cursor["angle"] > 10:
                boardText.attributes.vertical_alignment = VerticalAlignment.VA_BOTTOM
                text_offset -= 0.4
            else:
                boardText.attributes.vertical_alignment = VerticalAlignment.VA_CENTER

            if line_pos["x"] - cursor["x"] > 0:
                boardText.attributes.horizontal_alignment = HorizontalAlignment.HA_LEFT
                angle = 90
            else:
                boardText.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
                angle = -90
        # draw_line(cursor["x"], cursor["y"], line_pos["x"], line_pos["y"], stroke_width)
        # Draw sharp conrner line using a polygon
        x = stroke_width / 2
        points = [
            relative(cursor, -x, 0),
            relative(cursor, x, 0),
            relative(line_pos, x, 0),
            relative(line_pos, -x, 0),
        ]
        draw_polygon(points)

    # line_pos["angle"] = angle
    if text_pos is None:
        text_pos = relative(cursor, 0, text_offset)

    # draw_line(cursor["x"], cursor["y"], text_pos["x"], text_pos["y"], 0.01)
    boardText.value = name_str
    boardText
    boardText.position = Vector2.from_xy_mm(text_pos["x"], text_pos["y"])

    items_to_add.append(boardText)  # Store the text for later addition


def get_footprint_by_reference(footprints, reference):
    """
    Cached lookup for footprints by reference. If the cache is not built yet,
    build it from the current board footprints (cheap one-time cost).
    """
    global _footprint_cache
    if _footprint_cache is None:
        # Prefer using the provided `footprints` collection (passed from caller)
        # to avoid calling `board.get_footprints()` repeatedly. Fall back to
        # the board API only if no collection was provided.
        src = footprints if footprints else board.get_footprints()
        _footprint_cache = {fp.reference_field.text.value: fp for fp in src}
    return _footprint_cache.get(reference)


def calculate_track_connections(prev_cursor, cursor, tracks):
    """
    Calculate center-aligned track connections between two cursors with offset handling.

    Args:
        prev_cursor: Dictionary containing previous cursor data with keys:
            - "track_list": List of previous track positions
            - "offset": Horizontal offset value (default 0)
        cursor: Dictionary containing current cursor data
        tracks: Number of tracks in current cursor (len(cursor["track_list"]))

    Returns:
        List of (prev_index, curr_index) connection tuples
    """
    n_prev = len(prev_cursor.get("track_list", []))
    n_curr = tracks

    # Default to 0 if offsets not specified
    prev_offset = prev_cursor.get("offset", 0)
    curr_offset = cursor.get("offset", 0)

    # Determine larger and smaller track sets
    if n_prev >= n_curr:
        n_large = n_prev
        n_small = n_curr
        offset_large = prev_offset
        offset_small = curr_offset
    else:
        n_large = n_curr
        n_small = n_prev
        offset_large = curr_offset
        offset_small = prev_offset

    # Calculate relative shift between track sets
    shift = offset_small - offset_large
    connections = []
    total_connections = max(n_prev, n_curr)

    # Generate center-aligned connections with offset compensation
    for k in range(total_connections):
        # Calculate ideal small set index with offset adjustment
        ideal_index = k + shift + (n_small - n_large) / 2

        # Convert to integer index with clamping
        small_index = int(round(ideal_index))
        small_index = max(0, min(n_small - 1, small_index))

        # Map to correct cursor order
        if n_prev >= n_curr:
            connections.append((k, small_index))  # (prev_idx, curr_idx)
        else:
            connections.append((small_index, k))  # (prev_idx, curr_idx)

    return connections


def draw_track_connnection(prev_cursor, prev_idx, cursor, curr_idx, dotted=False):
    if prev_cursor["track_list"][prev_idx]["outline"] is True:
        prev_offset_dist = STATION_OFFSET
    elif prev_cursor["track_list"][prev_idx].get("skip", False):
        prev_offset_dist = 0
    else:
        prev_offset_dist = LED_OFFSET

    if cursor["track_list"][curr_idx]["outline"] is True:
        curr_offset_dist = -STATION_OFFSET
    elif cursor["track_list"][curr_idx].get("skip", False):
        curr_offset_dist = 0
    else:
        curr_offset_dist = -LED_OFFSET

    prev_track = relative(prev_cursor["track_list"][prev_idx], prev_offset_dist, 0)
    curr_track = relative(cursor["track_list"][curr_idx], curr_offset_dist, 0)

    if curr_offset_dist != 0 and prev_offset_dist == 0 and DEBUG:
        add_via(curr_track, f"/{curr_idx}")

    if prev_offset_dist != 0 and curr_offset_dist == 0 and DEBUG:
        add_via(prev_track, f"/{prev_idx}")

    distance = (
        (prev_track["x"] - curr_track["x"]) ** 2
        + (prev_track["y"] - curr_track["y"]) ** 2
    ) ** 0.5

    # prev_distance_from_center = (( (prev_track["x"] - prev_cursor["x"])**2 + (prev_track["y"] - prev_cursor["y"])**2 )**0.5)
    # curr_distance_from_center = (( (curr_track["x"] - cursor["x"])**2 + (curr_track["y"] - cursor["y"])**2 )**0.5)

    style = StrokeLineStyle.SLS_DOT if dotted else StrokeLineStyle.SLS_SOLID

    if cursor["curve"] is None:
        # draw_bezier(prev_track, curr_track, style=style, controlL1=1+prev_distance_from_center*0.1, controlL2=1+curr_distance_from_center*0.1)
        # draw_bezier(prev_track, curr_track, style=style, control_length=(0.275)*cursor["spacing"])
        draw_bezier(
            prev_track,
            curr_track,
            style=style,
            control_length=(1 / 3) * distance,
        )
    else:
        draw_bezier(prev_track, curr_track, style=style)


def flip_dir(cursor):
    cursor["angle"] += 180
    cursor["angle"] %= 360
    # Invert the track list for this direction
    cursor["track_list"] = list(reversed(cursor["track_list"]))

    # Change dirrection for each track in the track list
    for track in cursor["track_list"]:
        track["angle"] += 180
        track["angle"] %= 360


# Enum for orientation of graphical elements (left, right, both)
class Dir(Enum):
    L = 1  # Left
    R = 2  # Right
    L_R = 3  # Both Left and Right


LED_OFFSET = led.x / 2
STATION_LINE_WIDTH = 0.25
STATION_OFFSET = (led.x) / 2 + STATION_LINE_WIDTH + 0.05


def add_block(
    cursor,
    name=None,
    outline=None,
    tracks=None,
    offset: float = 0,
    curve: None | Dir = None,
    connections=None,
    extra_spacing: float = 0.0,
    substation=False,
    backside_power=True,
    skip=False,  # Skip placing LEDs, used for junctions
    dotted=False,
):
    prev_cursor = cursor.copy()

    cursor["name"] = name

    if tracks is None:
        tracks = cursor.get("tracks", 1)
    else:
        cursor["tracks"] = tracks

    if type(skip) == list and len(skip) > 0:
        cursor["skip"] = False
        skip_list = skip
    elif type(skip) == bool and skip:
        cursor["skip"] = True
        skip_list = list(range(tracks))  # Skip all tracks
        # print(f"Skip List: {skip_list}")
    else:
        cursor["skip"] = False
        skip_list = []

    if outline is None:
        outline = False if name is None else True

    cursor["outline"] = outline
    spacing = 0.0

    # Offset adjustment for connection points
    if prev_cursor.get("name") is not None:
        prev_offset_dist = STATION_OFFSET
        spacing += STATION_OFFSET - LED_OFFSET  # Increase spacing for stations
    elif prev_cursor.get("skip", False):
        prev_offset_dist = 0.0
        spacing -= LED_OFFSET  # Reduce spacing for junctions
    else:
        prev_offset_dist = LED_OFFSET

    if cursor.get("name") is not None:
        curr_offset_dist = -STATION_OFFSET
        spacing += STATION_OFFSET - LED_OFFSET  # Increase spacing for stations
    elif cursor.get("skip", False):
        curr_offset_dist = 0.0
        spacing -= LED_OFFSET  # Reduce spacing for junctions
    else:
        curr_offset_dist = -LED_OFFSET

    # connection_shift = False
    #     # Check if a number apears multiple times in either index
    #     prev_indices = [c[0] for c in connections]
    #     curr_indices = [c[1] for c in connections]
    #     for idx in set(prev_indices):
    #         count = prev_indices.count(idx)
    #         if count > 1:
    #             connection_shift = True
    #             break
    #     for idx in set(curr_indices):
    #         count = curr_indices.count(idx)
    #         if count > 1:
    #             connection_shift = True
    #             break

    if extra_spacing == 0.0 and connections is None:

        if (
            prev_cursor.get("track_list")
            and cursor.get("track_list")
            and connections is None
        ):
            connections = calculate_track_connections(prev_cursor, cursor, tracks)

        prev_tracks = len(prev_cursor.get("track_list", []))
        if (prev_tracks == 1 and tracks == 2) or (prev_tracks == 2 and tracks == 1):
            single_track = True  # Special case for 1-to-2 or 2-to-1 track connections
        else:
            single_track = False

        if single_track and offset == 0 and skip == False:
            spacing += cursor["spacing"] * 1.2
        # elif connection_shift:
        #     spacing += cursor["spacing"] * 1.5
        else:
            spacing += cursor["spacing"]
            if prev_cursor.get("skip", False) and cursor.get("skip", False):
                spacing = cursor["spacing"]
    elif extra_spacing > 0.0:
        spacing += cursor["spacing"] * (extra_spacing + 1)
    else:
        spacing += cursor["spacing"] * 1.5

    if (
        connections is None
        and prev_cursor.get("track_list")
        and cursor.get("track_list")
    ):
        connections = calculate_track_connections(prev_cursor, cursor, tracks)

    side_spacing = cursor["side_spacing"]
    cursor["offset"] = offset
    max_track_offset = ((tracks - 1) * side_spacing) / 2

    # Move cursor
    if curve is None:
        cursor = vector(cursor, spacing, edit=True)
        cursor["curve"] = None
    elif curve == Dir.L or curve == Dir.R:
        cursor["curve"] = curve

        angle_step = (
            cursor["angle_step"] if curve == Dir.R else 360 - cursor["angle_step"]
        )

        if curve == Dir.R:
            arc_start = cursor["track_list"][0]

            if prev_cursor["skip"] == False:
                arc_start = relative(arc_start, prev_offset_dist, 0)

            center = relative(arc_start, 0, -cursor["radius"])
            center["angle"] += angle_step
            arc_end = relative(center, 0, cursor["radius"])

            x = 0 if skip == True else -curr_offset_dist
            newPos = relative(arc_end, x, max_track_offset)
        else:
            arc_start = cursor["track_list"][-1]

            if prev_cursor["skip"] == False:
                arc_start = relative(arc_start, prev_offset_dist, 0)

            center = relative(arc_start, 0, cursor["radius"])
            center["angle"] += angle_step
            arc_end = relative(center, 0, -cursor["radius"])

            x = 0 if skip == True else -curr_offset_dist

            newPos = relative(arc_end, x, -max_track_offset)

        # draw_line(
        #     arc_start["x"], arc_start["y"], center["x"], center["y"], 0.1
        # )  # Debug line
        # draw_line(
        #     center["x"], center["y"], arc_end["x"], arc_end["y"], 0.1
        # )  # Debug line

        cursor["x"] = newPos["x"]
        cursor["y"] = newPos["y"]
        cursor["angle"] += angle_step
        cursor["angle"] %= 360

    max_track_offset = ((tracks - 1) * side_spacing) / 2
    offset_mm = cursor.get("offset", 0) * side_spacing
    track_list = []
    for i in range(tracks):
        track_offset = -max_track_offset + i * side_spacing
        track = vector(cursor, track_offset - offset_mm, 0)
        if i in skip_list:
            track["skip"] = True
        else:
            track["skip"] = False
            cursor["ref_num"] += cursor["ref_num_step"]
        track_list.append(track)

    cursor["track_list"] = track_list

    # Set all tracks outline to False initially
    for t in track_list:
        t["outline"] = False

    name_dir = None
    if name is not None:
        global total_stations
        total_stations += 1
        if len(name) > 2:
            name_str, name_dir, outline_tracks = name
        else:
            name_str, name_dir = name
            outline_tracks = [[0, -1]]  # Default to outline all tracks
            # Set outline to all tracks
            for t in track_list:
                t["outline"] = True

        if name_str != "":
            # If the name_str is full caps, and the angle is 90 or 270, place it infront
            if name_dir == Dir.L_R and (
                cursor["angle"] == 90 or cursor["angle"] == 270
            ):
                add_station_name(
                    cursor,
                    [name_str, name_dir],
                    end_of_line=True,
                )
            elif name_dir == Dir.R:
                track = track_list[0]
                add_station_name(track, [name_str, name_dir])
            else:
                track = track_list[-1]
                add_station_name(track, [name_str, name_dir])

        for outline_track in outline_tracks:
            # print(f"Drawing outline for station {name_str} on track {outline_track}")

            start = track_list[outline_track[0]]
            end = track_list[outline_track[1]]

            # Set outline is True for station tracks and any tracks in between
            for i in range(outline_track[0], outline_track[1] + 1):
                track_list[i]["outline"] = True

            x = (led.x + STATION_LINE_WIDTH) / 2 + 0.05
            y = (led.y + STATION_LINE_WIDTH) / 2 + 0.05

            draw_station_rectangle(start, end, x, y, line_width=STATION_LINE_WIDTH)

    # Draw beziers from tracks of prev_cursor to tracks of cursor
    if prev_cursor.get("track_list") and cursor.get("track_list"):

        # Draw all connections
        for prev_idx, curr_idx in connections:
            draw_track_connnection(prev_cursor, prev_idx, cursor, curr_idx, dotted)

    block_has_leds = False
    single_track = len(track_list) == 1
    for i, track in enumerate(track_list):
        if not single_track:
            angle = (track["angle"] + 180) % 360
        else:
            angle = track["angle"]

        if track.get("skip", False) == False:
            move_footprint(
                f"{ref_letter}{track["ref_num"]}", track["x"], track["y"], angle
            )
            global total_leds
            total_leds += 1
            cursor["cap_counter"] += 1
            block_has_leds = True
        elif DEBUG:
            add_via(track, f"/{i}")

    if prev_cursor.get("track_list") is not None:
        add_data_trace(prev_cursor["track_list"], track_list, True, single_track=single_track)

    if cursor["cap_counter"] > cursor["leds_per_cap"] and block_has_leds and name_dir != Dir.R:
        add_capacitor(cursor)
    elif block_has_leds:
        add_stitching_via(cursor, single_track=single_track)

    for i, track in enumerate(track_list):
        # if i == 0 and prev_cursor.get("track_list") is not None:
        #     if (not prev_cursor["track_list"][-1].get("skip", False)) and (
        #         not track.get("skip", False)
        #     ):
        #         if (len(track_list) > 1 and len(prev_cursor["track_list"]) > 1):
        #             add_data_trace(prev_cursor["track_list"][-1], track, True)

        # Draw data trace
        if len(track_list) > i + 1:
            if (not track_list[i].get("skip", False)) and (
                not track_list[i + 1].get("skip", False)
            ):
                if len(track_list) > 1:
                    add_data_trace(track, track_list[i + 1], single_track=single_track)


def permanent_offset(cursor, offset):
    cursor = relative(cursor, 0, -offset * cursor["side_spacing"], edit=True)


def add_tunnel(cursor, tracks, before=False):
    ANGLE = 35  # degrees

    if cursor.get("track_list")[tracks[0]].get("skip", False):
        cursor_offset = 0.25
    else:
        cursor_offset = 2.0

    if len(tracks) > 1:
        start = cursor["track_list"][tracks[0]]
        end = cursor["track_list"][tracks[-1]]

        midpoint = {
            "x": (start["x"] + end["x"]) / 2,
            "y": (start["y"] + end["y"]) / 2,
            "angle": (start["angle"] + end["angle"]) / 2,
        }

        distance = ((end["x"] - start["x"]) ** 2 + (end["y"] - start["y"]) ** 2) ** 0.5

    else:
        midpoint = cursor["track_list"][tracks[0]]
        distance = cursor["side_spacing"] / 2

    radius = distance + 0.5  # Add some extra radius for tunnel arc

    if before:
        offset = radius - cursor_offset
        start_angle = (270 - ANGLE) % 360
        end_angle = (270 + ANGLE) % 360
    else:
        offset = -(radius - cursor_offset)
        start_angle = (90 - ANGLE) % 360
        end_angle = (90 + ANGLE) % 360

    centre = relative(midpoint, offset, 0)

    draw_arc(centre, radius, start_angle, end_angle, width=0.4)


def add_bridge(cursor):
    x = cursor["x"]
    y = cursor["y"]
    width = 1.0
    height = 2.5
    angle = cursor["angle"]
    line_width = 0.4
    wing_length = 0.8

    # Calculate the four corners of the rectangle centered at (x, y)
    hw = width / 2
    hh = height / 2

    # Rectangle corners before rotation (relative to center)
    corners = [(x - hw, y - hh), (x + hw, y - hh), (x + hw, y + hh), (x - hw, y + hh)]

    # Rotate each corner around (x, y) by 'angle' degrees
    theta = radians(angle)
    cos_theta = cos(theta)
    sin_theta = sin(theta)
    rotated_corners = []
    for cx, cy in corners:
        dx = cx - x
        dy = cy - y
        rx = x + dx * -cos_theta - dy * sin_theta
        ry = y + dx * sin_theta + dy * -cos_theta
        rotated_corners.append((rx, ry))

    # Draw lines between consecutive corners
    for i in [0, 2]:
        x1, y1 = rotated_corners[i]
        x2, y2 = rotated_corners[(i + 1) % 4]
        draw_line(x1, y1, x2, y2, line_width)

    # Draw the bridge wings
    for i in range(4):
        x, y = rotated_corners[i]

        if i == 0:
            wing_angle = (angle - 45) % 360
        elif i == 1:
            wing_angle = (angle - 135) % 360
        elif i == 2:
            wing_angle = (angle + 135) % 360
        elif i == 3:
            wing_angle = (angle + 45) % 360

        # Extrapolate from from the center to the corner then wing length from the corner
        wing_x = x + wing_length * cos(radians(wing_angle))
        wing_y = y - wing_length * sin(radians(wing_angle))

        # Draw the wing line
        draw_line(x, y, wing_x, wing_y, line_width)

    # Draw the keep out zone
    keep_out_width = 2
    keep_out_length = 6
    x1, y1 = calc_from_xy(
        cursor["x"], cursor["y"], 0, keep_out_length / 2, cursor["angle"]
    )
    x2, y2 = calc_from_xy(
        cursor["x"], cursor["y"], 0, -keep_out_length / 2, cursor["angle"]
    )

    draw_line(
        x1,
        y1,
        x2,
        y2,
        width=keep_out_width,
        layer=BoardLayer.BL_Dwgs_User,
    )


def clear_silk_screen():
    shapes = board.get_shapes()
    text = board.get_text()

    for shape_item in shapes:
        if shape_item.layer == BoardLayer.BL_F_SilkS:
            if shape_item.locked:
                items_to_remove.append(shape_item)

    for text_item in text:
        if text_item.layer == BoardLayer.BL_F_SilkS:
            if text_item.locked:
                items_to_remove.append(text_item)


def clear_copper():
    vias = board.get_vias()
    for via in vias:
        if via.locked:
            items_to_remove.append(via)

    tracks = board.get_tracks()
    for track in tracks:
        if track.locked:
            items_to_remove.append(track)


ref_letter = "D"
cap_ref_letter = "C"
cursor: dict[str, float] = {
    "ref_num": 100,
    "ref_num_step": 1,
    "cap_ref_num": 100,
    "leds_per_cap": 12,
    "cap_counter": 0,
    "x": 0,
    "y": 0,
    "angle": 0,
    "angle_step": 45,
    "radius": 3,
    "spacing": led.x + 0.6,
    "side_spacing": led.y + 0.6 - 0.138,
    "tracks": 1,
    "name": None,
    "offset": 0,
}

total_leds = 0
total_stations = 0
footprints = board.get_footprints()
items_to_add = []
items_to_remove = []
items_to_update = []

# Global variables for line starts
richmond = {}
caufield = {}
southYarra = {}
northMelbourne = {}
metroTunnelSouth = {}
metroTunnelNorth = {}
mp6 = {}
flindersStreet = {}
mp26 = {}
mp20 = {}
mp1 = {}
cityLoopSouth = {}
cityLoopNorth = {}
mp25 = {}


def burnley_group(cursor):
    global mp1
    cap_ref = cursor["cap_ref_num"]
    cursor = mp1
    cursor["ref_num"] = 100
    cursor["cap_ref_num"] = cap_ref

    # Richmond Station
    connections = [
        (1, 0),
        (2, 1),
        (3, 2),
        (4, 3),
        (5, 4),
        (6, 5),
        (7, 6),
        (10, 7),
        (11, 8),
    ]
    connections += [(4, 0), (9, 9)]  # Crossovers #(1,0), (2,0),
    add_block(
        cursor,
        ("Richmond", Dir.R),
        outline=True,
        tracks=10,
        extra_spacing=1.0,
        connections=connections,
    )

    global richmond
    richmond = cursor.copy()  # South Yarra Group starts here
    add_block(
        cursor, tracks=4, curve=Dir.L, connections=[(9, 3), (8, 2), (7, 1), (6, 0)]
    )
    # Crossover from centre tracks to outer tracks (East Richmond 1&2)
    add_block(
        cursor,
        ["East Richmond", Dir.L, [(0, 0), (3, 3)]],
        connections=[(3, 3), (2, 2), (1, 1), (0, 0), (2, 3), (1, 0)],
    )
    add_block(cursor)
    add_block(
        cursor,
        ("Burnley", Dir.R),
        connections=[(3, 3), (2, 2), (1, 1), (0, 0), (2, 3), (0, 1)],
    )
    burnley = cursor.copy()
    # Crossover
    permanent_offset(cursor, -0.5)
    connections = [(3, 3), (2, 2), (1, 1), (0, 0)]
    connections += [(0, 1), (1, 2), (2, 3), (3, 2)]  # Crossovers
    add_block(
        cursor,
        tracks=5,
        skip=True,
        # extra_spacing=1,
        connections=connections,
    )
    glenWaverley_start = cursor.copy()  # Glen Waverley Line starts here

    # permanent_offset(cursor, 0.5)

    add_block(cursor, tracks=3, connections=[(2, 1), (1, 0)], curve=Dir.L)
    draw_track_connnection(burnley, 3, cursor, 2)
    
    add_block(cursor, ("Hawthorn", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Glenferrie", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Auburn", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor,
        ("Camberwell", Dir.R),
        connections=[(2, 2), (1, 1), (0, 0), (1, 2), (0, 1)],
    )  # Sidings (right side)
    # Crossover
    add_block(
        cursor,
        skip=True,
        tracks=4,
        offset=-0.5,
        connections=[(2, 2), (1, 1), (0, 0), (2, 1), (1, 0), (0, 1), (1, 2)],  # (2, 3),
    )
    alamein_start = cursor.copy()  # Alamein Line starts here
    add_block(cursor, tracks=3, extra_spacing=3, connections=[(2, 2), (1, 1), (0, 0)])
    add_block(cursor, ("East Camberwell", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Canterbury", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Chatham", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Union", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor,
        ("Box Hill", Dir.R),
        connections=[(2, 2), (1, 1), (0, 0), (1, 2), (2, 1), (0, 1), (1, 0)],
    )
    # Crossover
    add_block(cursor, tracks=2, connections=[(2, 1), (1, 1), (1, 0), (0, 0)])
    add_block(cursor, ("Laburnum", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor,
        ("Blackburn", Dir.R),
        tracks=3,
        connections=[(1, 2), (1, 1), (0, 1), (0, 0)],
    )
    # Crossover
    add_block(cursor, tracks=2, skip=True, connections=[(2, 1), (1, 1), (0, 0)])
    cursor["angle_step"] /= 2
    add_block(cursor, curve=Dir.R)
    add_block(cursor, name=("Nunawading", Dir.L), curve=Dir.R)
    cursor["angle_step"] *= 2
    add_block(cursor)
    add_block(cursor, ("Mitcham", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Heatherdale", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor,
        ("Ringwood", Dir.L),
        tracks=3,
        offset=0.5,
        connections=[(1, 2), (1, 1), (0, 1), (0, 0)],
    )
    # Crossover
    add_block(
        cursor,
        skip=True,
        offset=0.5,
        connections=[(2, 2), (2, 1), (1, 1), (1, 0), (0, 0), (0, 1)],
    )  # Junction block, no LEDs
    belgrave_start = cursor.copy()  # Belgrave Line starts here
    add_block(
        cursor, skip=True, tracks=2, connections=[(2, 1), (1, 1), (1, 0)]
    )  # Sidings (right side)
    add_block(cursor, extra_spacing=1)
    add_block(cursor, ("Ringwood East", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Croydon", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor, ("Mooroolbark", Dir.L), connections=[(1, 1), (1, 0), (0, 0)]
    )  # Elevated station
    add_block(cursor, tracks=1)
    add_block(cursor, ("LILYDALE", Dir.L_R), tracks=2)  # Elevated station
    # Siding tree
    # End of Metro, mothballed beyond here

    # === Belgrave Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = belgrave_start
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    add_block(
        cursor, tracks=2, curve=Dir.R, skip=True, connections=[(1, 1), (0, 0)]
    )  # Sidings (left/north side)
    add_block(cursor, extra_spacing=1)
    add_block(cursor, ("Heathmont", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor, ("Bayswater", Dir.R), connections=[(1, 1), (0, 1), (0, 0)]
    )  # Sidings (left/north side)
    add_block(cursor)
    add_block(cursor, ("Boronia", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Ferntree Gully", Dir.R))
    add_block(cursor, tracks=1)
    add_block(cursor, ("Upper Ferntree Gully", Dir.R), tracks=2)  # Sidings (Both sides)
    add_block(cursor, tracks=1)
    add_block(cursor, ("Upwey", Dir.R), tracks=2)
    add_block(cursor, tracks=1)
    add_block(cursor, ("Tecoma", Dir.R))
    add_block(cursor)
    add_block(cursor, ("BELGRAVE", Dir.R), tracks=2)
    # add_block(cursor, skip=True, dotted=True, extra_spacing=1.0)
    # End of Metro, Puffing Billy beyond here

    # === Alamein Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = alamein_start.copy()
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    # cursor["angle_step"] = 90
    # cursor["radius"] /= 2
    add_block(cursor, tracks=2, curve=Dir.R, skip=True, connections=[(0, 0)])
    # cursor["angle_step"] = 45
    # cursor["radius"] *= 2

    add_block(cursor, extra_spacing=1.5, skip=True, connections=[(0, 0)])
    draw_track_connnection(alamein_start, 2, cursor, 1)

    add_block(cursor, extra_spacing=1.5)
    # Crossover
    add_block(cursor, skip=True, curve=Dir.R)
    add_block(cursor, ("Riversdale", Dir.L), connections=[(1, 1), (0, 1), (0, 0)])
    add_block(cursor)
    add_block(cursor, ("Willison", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Hartwell", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Burwood", Dir.L))
    add_block(cursor)

    add_block(
        cursor,
        ("Ashburton", Dir.L),
        offset=-0.5,
        tracks=1,
        connections=[(1, 0), (0, 0)],
    )
    permanent_offset(cursor, -0.5)
    add_block(cursor)
    add_block(cursor, ("ALAMEIN", Dir.L))
    # End of Line

    # === Glen Waverley Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = glenWaverley_start
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    add_block(cursor, skip=True, tracks=2, connections=[(3, 1), (0, 0)], curve=Dir.R)
    add_block(cursor, connections=[(1, 1), (0, 1), (0, 0)])
    add_block(cursor, ("Heyington", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Kooyong", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Tooronga", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Gardiner", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Glen Iris", Dir.L))
    cursor["angle_step"] /= 2
    add_block(cursor, curve=Dir.L)
    add_block(cursor, skip=True, curve=Dir.L)
    # Crossover
    add_block(cursor, ("Darling", Dir.R), connections=[(0, 0), (1, 1), (0, 1)])
    cursor["angle_step"] *= 2
    add_block(cursor)
    add_block(cursor, ("East Malvern", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Holmesglen", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Jordanville", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Mount Waverley", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Syndal", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor, ("GLEN WAVERLEY", Dir.L_R), connections=[(0, 0), (1, 1), (0, 1), (1, 0)]
    )  # Sidings (left/north side)
    # End of Line

    print(f"Burnley Group = {cursor['ref_num']-100} LEDs")
    return cursor


def pakenham_cranbourne_group(cursor):
    cap_ref = cursor["cap_ref_num"]
    cursor = richmond.copy()
    cursor["ref_num"] = 400
    cursor["cap_ref_num"] = cap_ref

    permanent_offset(cursor, 2.0)

    add_block(
        cursor, tracks=6, connections=[(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5)]
    )
    add_block(cursor, ("South Yarra", Dir.R), extra_spacing=0.5)
    global southYarra
    southYarra = cursor.copy()  # Sandringham Line starts here

    add_block(
        cursor,
        tracks=4,
        offset=-1,
        skip=True,
        extra_spacing=1,
        connections=[(2, 0), (3, 1), (4, 2), (5, 3)],
    )

    # Linking block for Metro Tunnel south portal
    connections = [(0, 0), (1, 1), (2, 2), (3, 5)]
    add_block(
        cursor,
        skip=True,
        offset=-1,
        extra_spacing=1,
        tracks=6,
        connections=connections,
    )

    add_tunnel(cursor, [3, 4], before=True)
    # add_tunnel(cursor["track_list"][3], before=True)
    # add_tunnel(cursor["track_list"][4], before=True)

    global metroTunnelSouth
    metroTunnelSouth = cursor.copy()

    permanent_offset(cursor, -1)
    connections = [(0, 0), (1, 1), (2, 2), (3, 2), (4, 3), (5, 3)]
    add_block(cursor, tracks=4, extra_spacing=1, connections=connections)

    connections = [(0, 0), (1, 1), (2, 2), (2, 3), (3, 3), (3, 2)]
    add_block(cursor, ("Hawksburn", Dir.R), connections=connections)
    add_block(cursor)
    add_block(cursor, ("Toorak", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Armadale", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Malvern", Dir.R))
    add_block(cursor)
    # Crossover
    connections = [(0, 0), (1, 1), (0, 1), (1, 0), (2, 2), (3, 3), (2, 3), (3, 2)]
    add_block(cursor, ("Caulfield", Dir.L), connections=connections)
    global caufield
    caufield = cursor.copy()  # Frankston Line starts here
    # Crossover
    permanent_offset(cursor, -1.0)
    add_block(cursor, tracks=2, connections=[(3, 1), (2, 0), (2, 1)])
    add_block(cursor, ("Carnegie", Dir.L))  # Elevated station
    add_block(cursor)
    add_block(cursor, ("Murrumbeena", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Hughesdale", Dir.L))
    add_block(cursor)
    # Crossover
    add_block(cursor, ("Oakleigh", Dir.L), connections=[(1, 1), (0, 0), (0, 1)])
    # Crossover
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor, ("Huntingdale", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Clayton", Dir.L))
    add_block(cursor)
    # Crossover
    connections = [(0, 0), (0, 1), (1, 1), (1, 2)]
    add_block(
        cursor, ("Westall", Dir.L), tracks=3, offset=-0.5, connections=connections
    )
    # Crossover
    # connections = [(0,0), (0,1), (1,1), (1,2), (2,2)]
    add_block(cursor, offset=-0.5)  # Sidings ( left/north side)
    # Crossover
    connections = [(0, 0), (1, 0), (1, 1), (2, 1)]
    add_block(cursor, ("Springvale", Dir.L), tracks=2, connections=connections)
    add_block(cursor)
    add_block(cursor, ("Sandown Park", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Noble Park", Dir.L))  # Elevated station
    add_block(cursor)
    add_block(cursor, ("Yarraman", Dir.L))
    add_block(cursor)
    # Crossover
    permanent_offset(cursor, 0.5)
    connections = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2)]
    add_block(
        cursor, ("Dandenong", Dir.L), tracks=3, connections=connections
    )  # Sidings (both sides)
    # Crossover
    connections = [(0, 0), (0, 1), (1, 0), (1, 1), (1, 2), (2, 1), (2, 2)]
    add_block(cursor, connections=connections)
    cranbourne_start = cursor.copy()  # Cranbourne Line starts here

    connections = [(1, 0), (2, 1)]
    add_block(cursor, curve=Dir.L, tracks=2, connections=connections)
    # Disused General Motors Station
    add_block(cursor, ("Hallam", Dir.L))  # Elevated station
    add_block(cursor)
    add_block(cursor, ("Narre Warren", Dir.R))  # Elevated station
    add_block(cursor)
    add_block(cursor, ("Berwick", Dir.L))
    # Crossover
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor, ("Beaconsfield", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Officer", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Cardinia Road", Dir.R))
    add_block(cursor)
    add_block(cursor, ("PAKENHAM", Dir.L))  # Elevated station
    add_block(cursor)
    # Crossover
    connections = [(0, 1), (1, 1), (1, 2), (0, 2)]
    connections += [(0, 0), (1, 3)]
    add_block(
        cursor,
        ["East Pakenham", Dir.R, [[1, 2]]],
        tracks=4,
        skip=[0, 3],
        connections=connections,
    )  # Quad tracks (left/north side)
    connections = [(0, 1), (1, 1), (2, 2), (3, 2)]
    add_block(cursor, skip=True, connections=connections)
    add_block(
        cursor,
        tracks=2,
        skip=True,
        dotted=True,
        extra_spacing=1.0,
        connections=[(1, 0), (2, 1)],
    )
    # End of Metro, VLine beyond here (sidings on left/north side)

    # === Cranbourne Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = cranbourne_start
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    connections = [(1, 1), (0, 0)]
    add_block(cursor, tracks=2, curve=Dir.R, connections=connections)
    add_block(cursor, ("Lynbrook", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Merinda Park", Dir.R))
    add_block(cursor)
    # Crossover
    connections = [(0, 0), (1, 0), (1, 1), (0, 1)]
    add_block(
        cursor, ("CRANBOURNE", Dir.R), connections=connections
    )  # Sidings (left/north side)
    # End of metro, former South Gippsland line beyond here
    print(f"Dandenong Group = {cursor['ref_num']-400} LEDs")

    return cursor


def frankston_sandringham_group(cursor):
    # === Frankston Line ===
    cap_ref = cursor["cap_ref_num"]
    cursor = caufield
    cursor["ref_num"] = 600
    cursor["cap_ref_num"] = cap_ref
    
    cursor["radius"] *= 2
    
    connections = [(0, 0), (0, 1), (1, 1), (1, 2)]
    add_block(
        cursor, tracks=3, offset=0.5, curve=Dir.R, connections=connections
    )  # Sidings (right/west side)

    cursor["radius"] /= 2

    # connections = [(0,0), (1,1), (2,2), (2,1)]
    permanent_offset(cursor, 0.5)
    add_block(cursor, ("Glen Huntly", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Ormond", Dir.R))
    add_block(cursor)
    add_block(cursor, ("McKinnon", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Bentleigh", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Patterson", Dir.R))
    add_block(cursor)
    # Crossover
    connections = [(0, 0), (1, 1), (2, 1), (2, 2)]
    add_block(cursor, skip=True, connections=connections)
    connections = [(0, 0), (1, 1), (1, 0), (2, 2)]
    add_block(cursor, ("Moorabbin", Dir.R), connections=connections)
    # Crossover
    connections = [(0, 0), (1, 0), (1, 1), (2, 1)]
    permanent_offset(cursor, -0.5)
    add_block(cursor, tracks=2, connections=connections)
    add_block(cursor, ("Highett", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Southland", Dir.R))
    add_block(cursor)

    # Crossover
    connections = [(0, 0), (0, 1), (1, 1), (1, 2)]
    add_block(
        cursor, ("Cheltenham", Dir.R), tracks=3, offset=0.5, connections=connections
    )

    cursor["angle_step"] /= 2

    # Crossover
    connections = [(0, 0), (1, 1), (2, 1)]
    add_block(cursor, tracks=2, connections=connections)

    add_block(cursor, ("Mentone", Dir.R))
    add_block(cursor, curve=Dir.L)
    add_block(cursor, ("Parkdale", Dir.R), curve=Dir.L)  # Elevated station
    add_block(cursor)
    # Crossover
    connections = [(0, 0), (1, 1), (0, 1)]
    add_block(
        cursor, ("Mordialloc", Dir.R), connections=connections
    )  # Elevated station
    # Crossover, Sidings (left/north side)

    connections = [(0, 0), (1, 1), (0, 1)]
    add_block(cursor, connections=connections)

    add_block(cursor, ("Aspendale", Dir.R))
    add_block(cursor, curve=Dir.L)
    add_block(cursor, ("Edithvale", Dir.R), curve=Dir.L)
    add_block(cursor)
    add_block(cursor, ("Chelsea", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Bonbeach", Dir.R))
    add_block(cursor, connections=[(0, 0), (1, 1), (0, 1)])
    add_block(cursor, ("Carrum", Dir.L))  # Elevated station
    add_block(cursor)
    add_block(cursor, ("Seaford", Dir.R))
    add_block(cursor)
    # Crossover, Sidings (left/north side)
    connections = [(0, 0), (1, 1), (0, 1)]
    add_block(cursor, ("Kananook", Dir.L), connections=connections)
    # Crossover
    connections = [(0, 0), (1, 1), (1, 0)]
    add_block(cursor, connections=connections)

    # connections = [(0, 0), (1, 1), (1, 0)]
    # add_block(cursor, skip=True, connections=connections)

    connections = [(0, 0), (0, 1), (1, 0), (1, 1)]
    add_block(
        cursor, ("FRANKSTON", Dir.R), offset=0, connections=connections
    )  # Sidings (left/east side)

    # === Stony Point Line ===
    # add_block(
    #     cursor,
    #     outline=True,
    #     tracks=1,
    #     offset=0.5,
    #     connections=[(1, 0)],
    #     extra_spacing=-0.25,
    # )  # Platform 3 (Stony Point Line)

    # cursor["spacing"] += 0.1

    permanent_offset(cursor, -0.5)
    add_block(cursor, tracks=1, connections=[(1, 0)])
    add_block(cursor, ("Leawarra", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Baxter", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Somerville", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Tyabb", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Hastings", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Bittern", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Morradoo", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Crib Point", Dir.R))
    add_block(cursor)
    add_block(cursor, ("STONY POINT", Dir.L_R))
    # End of Line

    # === Sandringham Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = southYarra
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    cursor["angle_step"] *= 2
    cursor["radius"] /= 2
    add_block(cursor, skip=True, tracks=2, curve=Dir.R, connections=[(1, 1), (0, 0)])
    add_block(cursor, extra_spacing=0.5)
    add_block(cursor, skip=True, extra_spacing=0.5)
    cursor["angle_step"] /= 2
    cursor["radius"] *= 2
    add_block(cursor, ("Prahran", Dir.R), curve=Dir.L)
    add_block(cursor)
    add_block(cursor, ("Windsor", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Balaclava", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Ripponlea", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Elsternwick", Dir.R))
    # Crossover
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor, ("Gardenvale", Dir.R))
    add_block(cursor)
    add_block(cursor, ("North Brighton", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Middle Brighton", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(
        cursor, ("Brighton Beach", Dir.R), connections=[(1, 1), (0, 0), (0, 1)]
    )  # Platform 1 no longer used, Sidings (right/west side)
    add_block(cursor)
    add_block(cursor, ("Hampton", Dir.R))
    add_block(cursor)
    add_block(
        cursor, ("SANDRINGHAM", Dir.R), tracks=1, offset=0.5, extra_spacing=0.5
    )  # Sidings (left/east side)

    print(f"Frankston and Sandringham Group = {cursor['ref_num']-600} LEDs")
    return cursor


def werribee_sunbury_group(cursor):
    
    cap_ref = cursor["cap_ref_num"]
    global mp20
    cursor = mp20
    cursor["ref_num"] = 800
    cursor["cap_ref_num"] = cap_ref

    flip_dir(cursor)

    # === Werribee Line ===

    cursor["angle_step"] /= 2

    # Marker Point 21
    connections = [(2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9)]
    add_block(
        cursor, curve=Dir.L, skip=[0, 1], tracks=10, offset=0, connections=connections
    )

    # Marker Point 22
    connections = [(2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9)]
    add_block(
        cursor, skip=True, curve=Dir.L, tracks=10, offset=0, connections=connections
    )

    cursor["angle_step"] *= 2

    # Marker Point 23
    permanent_offset(cursor, -1)
    connections = [(2, 0), (3, 2), (4, 3), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9)]
    connections += [(4, 5), (5, 6)]
    add_block(
        cursor, skip=True, tracks=12, offset=0, extra_spacing=1, connections=connections
    )
    add_tunnel(cursor, tracks=[1], before=True)
    add_tunnel(cursor, tracks=[4], before=True)
    mp23 = cursor.copy()

    global cityLoopNorth
    draw_track_connnection(cityLoopNorth, 2, cursor, 1, True)
    draw_track_connnection(cityLoopNorth, 2, cursor, 4, True)

    # Marker Point 24 / North Melbourne Station
    permanent_offset(cursor, -1)
    # (10, 8), (11, 9)
    connections = [(0, 0), (2, 1), (3, 2), (5, 3), (6, 4), (7, 5), (8, 6), (9, 7)]
    connections += [(1, 0), (1, 1), (4, 2), (4, 3)]
    connections += [(6, 5), (5, 4)]
    add_block(
        cursor,
        ["North Melbourne", Dir.R, [[0, 5]]],
        tracks=10,
        extra_spacing=1,
        connections=connections,
        skip=[6, 7, 8, 9],
    )  # Sidings (left/south side)
    global northMelbourne
    northMelbourne = cursor.copy()

    draw_track_connnection(mp23, 10, cursor, 8, True)
    draw_track_connnection(mp23, 11, cursor, 9, True)

    # Marker Point 25
    connections = [(0, 2), (1, 3), (2, 4), (3, 5), (4, 6), (5, 7)]
    connections += [(4, 8), (5, 9), (6, 10), (7, 11), (8, 10), (9, 11)]
    connections += [(2, 2), (3, 3)]
    connections += [(0, 0), (1, 1)]
    add_block(
        cursor, skip=True, tracks=12, offset=1, extra_spacing=1, connections=connections
    )
    global mp25
    mp25 = cursor.copy()  # Upfield Line starts here on Tracks 0,1

    # Marker Point 26
    connections = [
        (2, 0),
        (3, 1),
        (4, 2),
        (5, 3),
        (6, 4),
        (7, 5),
        (8, 6),
        (9, 7),
        (10, 8),
        (11, 9),
    ]
    connections += [(2, 2), (3, 3), (4, 4), (5, 5)]
    add_block(cursor, skip=[8, 9], tracks=10, extra_spacing=1, connections=connections)
    global mp26
    mp26 = cursor.copy()
    # Cragieburn Line starts here

    # South Kensington Station
    connections = [(2, 2), (3, 3), (4, 4), (5, 5)]
    connections += [(9, 7), (8, 6)]
    skip = [3, 2, 1, 0]
    add_block(
        cursor,
        ["South Kensington", Dir.L, [[4, 5]]],
        skip=skip,
        curve=Dir.L,
        tracks=8,
        offset=1,
        connections=connections,
    )
    # add_tunnel(cursor, tracks=[0, 1], before=True)
    # name = ["South Kensington", Dir.L]
    # add_station_name(cursor["track_list"][5], name, text_offset=5.5, end_of_line_offset=5.25)
    global metroTunnelNorth
    metroTunnelNorth = cursor.copy()

    # permanent_offset(cursor, -1)
    connections = [(2, 0), (3, 1), (4, 2), (5, 3), (6, 4), (7, 5)]
    add_block(
        cursor, tracks=6, skip=[4, 5], extra_spacing=0.75, connections=connections
    )

    connections = [(0, 0), (1, 1), (2, 4), (3, 5), (4, 2), (5, 3)]
    add_block(
        cursor, ("Footscray", Dir.R), extra_spacing=1.5, connections=connections
    )  # Platform 3,4 are for VLine
    footscray = cursor.copy()  # Sunbury Line starts here

    add_block(cursor, tracks=2, curve=Dir.L, connections=[(5, 1), (4, 0)])
    add_block(cursor, ("Seddon", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Yarraville", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Spotswood", Dir.L))
    add_block(cursor)
    # Crossover
    add_block(cursor, ("Newport", Dir.L), connections=[(1, 1), (0, 0), (0, 1)])
    newport = cursor.copy()
    # add_linking_blocks(cursor, 1, empty=True)

    # Crossover
    # Williamstown Line starts here
    add_block(cursor, curve=Dir.R, skip=True)
    add_block(cursor, connections=[(1, 0), (0, 0), (0, 1), (1, 1)])
    altona_loop_start = cursor.copy()  # Altona Loop Line starts here
    add_block(cursor, skip=True, extra_spacing=4.5)
    add_block(cursor)
    add_block(cursor, skip=True, extra_spacing=2.5)

    # Crossover

    add_block(cursor, skip=True, tracks=3, curve=Dir.R, connections=[(0, 0), (1, 1)])
    pre_laverton = cursor.copy()
    add_block(
        cursor,
        ("Laverton", Dir.L),
        tracks=3,
        connections=[(1, 1), (0, 0), (1, 0)],
    )
    laverton = cursor.copy()

    permanent_offset(cursor, 0.5)

    add_block(cursor, tracks=2, connections=[(1, 1), (0, 0), (2, 1)])
    add_block(cursor, ("Aircraft", Dir.L), connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor)
    add_block(cursor, ("Williams Landing", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Hoppers Crossing", Dir.L))
    add_block(cursor)
    # Crossover
    add_block(cursor, skip=True, connections=[(1, 1), (0, 0), (0, 1), (1, 0)])
    add_block(
        cursor,
        ("WERRIBEE", Dir.L),
        tracks=3,
        offset=0.5,
        connections=[(1, 2), (1, 1), (0, 0), (0, 1)],
    )
    add_block(
        cursor,
        skip=True,
        offset=0.5,
        extra_spacing=1,
        dotted=True,
        connections=[(1, 1), (2, 2), (0, 1)],
    )
    # End of Metro, Freight beyond here

    # === Altona Loop Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = altona_loop_start
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    cursor["angle_step"] *= 2

    add_block(cursor, skip=True, curve=Dir.L, tracks=1)
    add_block(cursor)

    add_block(cursor, ("Seaholme", Dir.L), curve=Dir.R)
    add_block(cursor)
    add_block(cursor, ("Altona", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Westona", Dir.L), tracks=2)

    # add_block(cursor, skip=True, tracks=1)

    add_block(cursor, curve=Dir.R, tracks=1)
    # add_block(cursor, skip=True, extra_spacing=0.78, tracks=2, offset=0.45)

    flip_dir(cursor)
    flip_dir(pre_laverton)
    flip_dir(laverton)

    draw_track_connnection(laverton, 0, cursor, 0)
    draw_track_connnection(pre_laverton, 1, cursor, 0)

    cursor["angle_step"] /= 2

    # === Williamstown Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = newport
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    add_block(
        cursor, skip=True, tracks=2, curve=Dir.L
    )  # Sidings & Shops (right/west side)
    add_block(cursor, tracks=2, connections=[(1, 1), (0, 0), (1, 0)])
    add_block(cursor, ("North Williamstown", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Williamstown Beach", Dir.L))
    add_block(cursor)
    # Crossover
    add_block(cursor, ("WILLIAMSTOWN", Dir.L), tracks=1, extra_spacing=0.5, offset=-0.5)
    # End of Line

    # === Sunbury Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = footscray
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    rrl = [2, 3]  # RRL tracks

    permanent_offset(cursor, 1.0)
    add_block(
        cursor,
        tracks=4,
        connections=[(3, 3), (2, 2), (1, 1), (0, 0)],
        skip=rrl,
        extra_spacing=1,
    )
    # Crossover
    connections = [(0, 0), (1, 1), (2, 2), (3, 3), (1, 0)]
    add_block(
        cursor,
        ["Middle Footscray", Dir.R, [[0, 1]]],
        skip=rrl,
        connections=connections,
        extra_spacing=1,
    )
    # Crossover
    connections = [(0, 0), (1, 1), (2, 2), (3, 3), (0, 1)]
    add_block(cursor, connections=connections, extra_spacing=1)
    # Crossover
    connections = [(0, 0), (0, 1), (1, 2), (2, 3), (3, 4), (1, 1)]
    add_block(
        cursor,
        ["West Footscray", Dir.R, [[0, 2]]],
        skip=[3, 4],
        tracks=5,
        offset=0.5,
        connections=connections,
        extra_spacing=1,
    )
    # Crossover
    connections = [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (0, 1)]
    add_block(cursor, skip=True, offset=0.5, connections=connections, extra_spacing=1)
    connections = [(0, 0), (1, 0), (2, 1), (3, 2), (4, 3), (1, 1)]
    add_block(cursor, tracks=4, connections=connections, extra_spacing=1)
    add_block(cursor, ["Tottenham", Dir.R, [[0, 1]]], skip=rrl, extra_spacing=1)
    add_block(cursor, skip=rrl, extra_spacing=1)
    # Crossover
    add_block(
        cursor,
        ("Sunshine", Dir.L),
        connections=[(3, 3), (2, 2), (1, 1), (0, 0), (0, 1), (3, 2)],
        extra_spacing=1,
    )
    # Crossover

    savepoint = cursor.copy()

    add_block(
        cursor, skip=True, extra_spacing=2, dotted=True, connections=[(3, 3), (2, 2)]
    )

    cursor = savepoint

    cursor["angle_step"] *= 2
    # cursor["radius"] *= 2

    add_block(
        cursor,
        tracks=2,
        skip=True,
        curve=Dir.R,
        connections=[(0, 0), (1, 1), (2, 0), (3, 1)],
    )  # VLine merges here

    cursor["angle_step"] /= 2
    # cursor["radius"] /= 2

    add_block(cursor, connections=[(1, 1), (0, 0), (1, 0)])

    add_block(cursor, ("Albion", Dir.L))

    albion = cursor.copy()  # Airport Line starts here

    # Crossover
    # add_block(cursor, skip=True, extra_spacing=2)
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor, ("Ginifer", Dir.L))
    add_block(cursor)
    add_block(cursor, ("St Albans", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Keilor Plains", Dir.L))
    add_block(cursor)
    # Crossover
    connections = [(0, 0), (0, 1), (1, 2), (1, 1), (1, 0)]
    add_block(
        cursor, ("Watergardens", Dir.L), tracks=3, offset=-0.5, connections=connections
    )
    # Crossover with center sidings
    connections = [(2, 1), (1, 1), (0, 0), (1, 0)]
    add_block(cursor, tracks=2, connections=connections)  # Sidings (left/south side)
    add_block(cursor, ("Diggers Rest", Dir.L))
    add_block(cursor)
    add_block(cursor, skip=True, connections=[(1, 1), (0, 0), (0, 1)])
    connections = [(0, 0), (1, 2), (1, 1), (1, 0)]
    add_block(
        cursor,
        ["SUNBURY", Dir.L, [[0, 0], [2, 2]]],
        skip=[1],
        tracks=3,
        offset=-0.5,
        extra_spacing=0.5,
        connections=connections,
    )  # 2 platforms with through track

    add_block(cursor, skip=True, dotted=True, offset=-0.5, extra_spacing=1)

    # End of Metro, VLine beyond here, Sidings (both sides)

    # === Airport Line ===
    # ref_num = cursor["ref_num"]
    # cursor = albion
    # cursor["ref_num"] = ref_num

    # add_block(cursor, curve=Dir.R, skip=True, tracks=2)
    # add_block(cursor, extra_spacing=1.5)
    # add_block(cursor, ("Keilor East", Dir.R))
    # add_block(cursor)
    # add_block(
    #     cursor,
    #     ("Melbourne\nAirport", Dir.R),
    #     connections=[(1, 1), (0, 0), (0, 1), (1, 0)],
    # )

    print(f"Werribee and Sunbury Group = {cursor['ref_num']-800} LEDs")
    return cursor


def upfield_craigieburn_group(cursor):
    cap_ref = cursor["cap_ref_num"]

    # === Craigieburn Line ===
    global mp26
    cursor = mp26
    cursor["ref_num"] = 1000
    cursor["cap_ref_num"] = cap_ref

    # === Craigieburn Line ===
    permanent_offset(cursor, 4.0)

    connections = [(0, 0), (1, 1), (6, 0), (7, 1)]

    add_block(cursor, tracks=2, skip=True, connections=connections, extra_spacing=4)

    add_block(cursor, ("Kensington", Dir.R), connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor)
    add_block(cursor, ("Newmarket", Dir.R))
    savepoint = cursor.copy()  # Flemington Racecourse Line starts here

    # === Flemington Racecourse Line ===
    add_block(cursor, tracks=2, extra_spacing=3.5)
    # Crossover
    connections = [(0, 0), (1, 1), (1, 0)]
    add_block(
        cursor, ["Showgrounds", Dir.L, [[0, 0]]], connections=connections
    )  # Platform 1 only
    connections = [(0, 0), (1, 1), (0, 1)]
    add_block(cursor, connections=connections)
    add_block(
        cursor, ("Flemington\nRacecourse", Dir.L), connections=[(0, 0), (1, 1), (1, 0)]
    )

    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = savepoint
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    # add_linking_blocks(cursor, 1, empty=True)
    add_block(cursor, skip=True, curve=Dir.R)
    add_block(cursor, extra_spacing=0.5)
    add_block(cursor, ("Ascot Vale", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Moonee Ponds", Dir.R))
    add_block(cursor)
    # Crossover
    # add_block(cursor, skip=True, connections=[(1, 1), (0, 0), (1, 0)])
    connections = [(0, 1), (1, 1), (1, 2), (0, 2), (0, 0)]
    add_block(
        cursor, ("Essendon", Dir.R), tracks=3, offset=0.5, connections=connections
    )
    add_block(cursor, tracks=2, skip=True, extra_spacing=0.5)
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor, ("Glenbervie", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Strathmore", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Pascoe Vale", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Oak Park", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Glenroy", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Jacana", Dir.R))
    add_block(cursor)
    # Crossover, freight only Albion–Jacana line merges here
    connections = [(0, 0), (1, 1), (1, 0), (0, 1)]
    add_block(
        cursor, ("Broadmeadows", Dir.R), connections=connections
    )  # Platform 3 is for standard gauge trains
    # Crossover, sidings (left/west side)
    add_block(cursor)
    add_block(cursor, ("Coolaroo", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(cursor, ("Roxburgh Park", Dir.R), connections=[(1, 1), (0, 0), (1, 0)])
    add_block(cursor)
    # Crossover
    add_block(
        cursor, ("CRAIGIEBURN", Dir.R), connections=[(1, 1), (0, 0), (0, 1), (1, 0)]
    )
    add_block(cursor, skip=True, dotted=True, extra_spacing=1)
    # End of Metro, VLine beyond here, Sidings (both left/west side)

    # === Upfield Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    global mp25
    cursor = mp25.copy()
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    add_block(
        cursor,
        skip=True,
        tracks=2,
        extra_spacing=1,
        offset=6,
        connections=[(1, 1), (0, 0)],
    )

    draw_track_connnection(mp25, 2, cursor, 0)
    draw_track_connnection(mp25, 3, cursor, 1)

    cursor["angle_step"] *= 2

    add_block(cursor, skip=True, tracks=2, curve=Dir.R, connections=[(1, 1), (0, 0)])

    cursor["angle_step"] /= 2

    add_block(cursor, extra_spacing=3)
    add_block(cursor, ("Macaulay", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Flemington Bridge", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Royal Park", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Jewell", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Brunswick", Dir.R))

    cursor["angle_step"] /= 2

    add_block(cursor, curve=Dir.L)
    add_block(cursor, ("Anstey", Dir.R), curve=Dir.L)
    add_block(cursor)
    add_block(cursor, ("Moreland", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Coburg", Dir.R))
    # Crossover
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    add_block(cursor, ("Batman", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Merlynston", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Fawkner", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Gowrie", Dir.R))
    add_block(cursor, tracks=1)
    add_block(cursor, ("UPFIELD", Dir.R))
    # End of Line, Sidings (both sides), mothballed? beyond here

    print(f"Upfield and Craigieburn Group = {cursor['ref_num']-1000} LEDs")
    return cursor


def mernda_hurstbridge_group(cursor):
    cap_ref = cursor["cap_ref_num"]
    global mp6
    cursor = mp6
    cursor["ref_num"] = 1200
    cursor["cap_ref_num"] = cap_ref

    cursor["angle_step"] /= 2

    permanent_offset(cursor, -5)

    # === Mernda Line ===
    add_block(
        cursor, skip=True, tracks=2, extra_spacing=1, connections=[(13, 0), (13, 1)]
    )

    add_block(
        cursor,
        skip=[2],
        tracks=3,
        offset=-0.5,
        extra_spacing=4,
        connections=[(0, 0), (1, 1)],
    )
    add_tunnel(cursor, [2], before=True)
    global cityLoopSouth
    flip_dir(cityLoopSouth)

    draw_track_connnection(cityLoopSouth, 0, cursor, 2, True)

    add_block(
        cursor,
        tracks=2,
        skip=True,
        connections=[(0, 0), (1, 1), (2, 1)],
    )
    # add_block(cursor, connections=[(0, 0), (1, 1), (1, 0)], extra_spacing=1)
    add_block(cursor, ("Jolimont", Dir.R), connections=[(0, 0), (1, 1), (1, 0)])
    add_block(cursor, curve=Dir.L)

    # add_tunnel(cursor, [0,1], before=False)
    add_block(cursor, ("West Richmond", Dir.R), curve=Dir.L)
    # add_tunnel(cursor, [0,1], before=True)

    add_block(cursor)
    add_block(cursor, ("North Richmond", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Collingwood", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Victoria Park", Dir.R))
    # Crossover, (rarely ever used)
    add_block(cursor, connections=[(1, 1), (0, 0), (0, 1)])
    # Crossover
    add_block(
        cursor, ("Clifton Hill", Dir.R), connections=[(1, 1), (0, 0), (0, 1), (1, 0)]
    )
    # Crossover
    add_block(cursor, skip=True, tracks=3, connections=[(0, 0), (0, 1), (1, 1), (1, 2)])
    hurstbridge_start = cursor.copy()  # Hurstbridge Line starts here

    permanent_offset(cursor, -0.5)
    add_block(cursor, skip=True, tracks=2, connections=[(2, 1), (1, 0), (1, 1)])
    cursor["angle_step"] *= 2
    add_block(cursor, skip=True, tracks=2, curve=Dir.L)
    cursor["angle_step"] /= 2
    add_block(cursor, extra_spacing=1)
    add_block(cursor, ("Rushall", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Merri", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Northcote", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Croxton", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Thornbury", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Bell", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Preston", Dir.L))
    add_block(cursor, curve=Dir.R)
    add_block(cursor, ("Regent", Dir.L), curve=Dir.R)
    add_block(cursor)
    # Crossover
    add_block(cursor, ("Reservoir", Dir.L), connections=[(0, 0), (1, 1), (0, 1)])
    add_block(cursor)
    # Crossover
    add_block(cursor, ("Ruthven", Dir.L), connections=[(0, 0), (1, 1), (0, 1)])
    add_block(cursor)
    add_block(cursor, ("Keon Park", Dir.L))
    add_block(cursor, curve=Dir.R)
    add_block(cursor, ("Thomastown", Dir.L), curve=Dir.R)
    add_block(cursor)
    add_block(cursor, ("Lalor", Dir.R))
    add_block(cursor)
    # Crossover, Sidings (left/west side)
    add_block(cursor, ("Epping", Dir.L), connections=[(0, 0), (1, 1), (0, 1), (1, 0)])
    add_block(cursor)
    # Crossover
    add_block(
        cursor, ("South Morang", Dir.R), connections=[(0, 0), (1, 1), (1, 0), (0, 1)]
    )
    add_block(cursor)
    add_block(cursor, ("Middle Gorge", Dir.L))
    add_block(cursor)
    add_block(cursor, ("Hawkstowe", Dir.R))
    add_block(cursor)
    # Crossover
    add_block(cursor, ("MERNDA", Dir.L_R), connections=[(0, 0), (1, 1), (0, 1), (1, 0)])
    # End of Line, Sidings (both sides)

    # === Hurstbridge Line ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = hurstbridge_start
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    permanent_offset(cursor, 0.5)

    # add_linking_blocks(cursor, 1, empty=True)
    # Crossover
    add_block(cursor, tracks=2, skip=True, connections=[(0, 0), (1, 1)])
    add_block(cursor, skip=True, extra_spacing=0.5)
    add_block(cursor, connections=[(0, 0), (1, 1), (1, 0)])
    add_block(cursor, ("Westgarth", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Dennis", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Fairfield", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Alphington", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Darebin", Dir.R))
    add_block(cursor)
    add_block(cursor, ("Ivanhoe", Dir.R))
    add_block(cursor, curve=Dir.R)
    add_block(cursor, ("Eaglemont", Dir.L), curve=Dir.R)
    add_block(cursor)
    add_block(cursor, ("Heidelberg", Dir.L), connections=[(0, 0), (1, 1), (0, 1)])
    add_block(cursor, connections=[(0, 0), (1, 1), (0, 1)])
    add_block(cursor, ("Rosanna", Dir.R))
    add_block(cursor)
    # Crossover, Sidings (left/west side)
    add_block(cursor, skip=True, connections=[(0, 0), (1, 1), (0, 1)])
    add_block(
        cursor,
        ("Macleod", Dir.L),
        tracks=3,
        offset=-0.5,
        connections=[(0, 0), (1, 1), (1, 2)],
    )
    add_block(cursor, tracks=2, connections=[(0, 0), (1, 1)])
    add_block(cursor, ("Watsonia", Dir.R))
    add_block(cursor)
    add_block(
        cursor, ("Greensborough", Dir.L), connections=[(0, 0), (1, 1), (0, 1), (1, 0)]
    )
    add_block(cursor, connections=[(0, 0), (1, 1), (1, 0)])
    add_block(cursor, ("Montmorency", Dir.R), connections=[(0, 0), (1, 1), (0, 1)])
    add_block(cursor, tracks=1)
    add_block(cursor, ("Eltham", Dir.L), tracks=2)  # Sidings (left/west side)
    add_block(cursor, tracks=1)
    add_block(cursor, ("Diamond Creek", Dir.R), tracks=2)
    add_block(cursor)
    add_block(cursor, ("Wattle Glen", Dir.L), tracks=1)
    add_block(cursor)
    add_block(cursor, ("HURSTBRIDGE", Dir.L_R), tracks=1)  # Sidings (left/west side)
    # End of Line, Sidings (both sides)

    print(f"Mernda and Hurstbridge Group = {cursor['ref_num']-1200} LEDs")
    return cursor


def city_loop_group(cursor):
    cursor["x"] = 127.4
    cursor["y"] = 120.7
    cursor["angle"] = 180
    cursor["ref_num"] = 1400
    

    # Marker Point 20
    add_block(cursor, tracks=10, skip=True, extra_spacing=1, offset=1)

    global mp20
    mp20 = cursor.copy()

    # Marker Point 19
    # connections = [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7)]
    # # connections += [(4, 6), (5, 7)]
    # add_block(
    #     cursor, tracks=10, skip=True, extra_spacing=1, offset=1, connections=connections
    # )

    # Marker Point 18
    connections = [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7)]
    connections += [(5, 3), (4, 2)]
    connections += [(0, 1), (1, 0)]
    connections += [(6, 8), (7, 9)]
    add_block(
        cursor, tracks=12, skip=True, extra_spacing=1, offset=0, connections=connections
    )

    # Marker Point 17
    connections = [
        (0, 0),
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 5),
        (5, 6),
        (6, 7),
    ]
    connections += [(7, 7)]
    connections += [(8, 10), (9, 11)]
    add_block(
        cursor, tracks=12, skip=True, extra_spacing=1, offset=1, connections=connections
    )
    add_tunnel(cursor, tracks=[8, 9], before=True)
    add_tunnel(cursor, tracks=[4], before=True)
    mp17 = cursor.copy()

    # Marker Point 16
    connections = [
        (0, 0),
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 3),
        (4, 4),
        (5, 4),
        (6, 5),
        (7, 6),
        (7, 7),
        (8, 7),
        (9, 8),
        (10, 9),
        (11, 10),
    ]
    connections += [(5, 5), (6, 4)]
    connections += [(7, 5)]
    connections += [(10, 10)]
    add_block(
        cursor,
        ["Southern Cross", Dir.R, [[0, 5], [7, 8], [10, 10]]],
        skip=[6, 9],
        tracks=11,
        extra_spacing=1,
        offset=0.5,
        connections=connections,
    )

    # Marker Point 15
    connections = [
        (0, 1),
        (1, 2),
        (4, 3),
        (5, 4),
        (6, 5),
        (7, 6),
        (8, 7),
        (9, 8),
    ]  # Straight connections
    connections += [(2, 1), (3, 2)]
    connections += [(10, 7)]
    skip = [0, 1, 2, 3, 4, 5, 6, 7]
    add_block(
        cursor,
        ["", Dir.L, [[8, 8]]],
        tracks=9,
        skip=skip,
        extra_spacing=0.5,
        offset=0.5,
        connections=connections,
    )

    # Marker Point 14
    permanent_offset(cursor, 1)
    connections = [
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6),
        (7, 7),
    ]  # Straight connections
    connections += [(1, 3)]
    connections += [(7, 5)]
    connections += [(8, 7)]
    add_block(
        cursor,
        tracks=9,
        skip=True,
        extra_spacing=0.5,
        offset=-0.5,
        connections=connections,
    )

    # Marker Point 13 Flinders Street Viaducts Start
    # permanent_offset(cursor, 1)
    connections = [
        (1, 0),
        (2, 1),
        (3, 2),
        (4, 3),
        (5, 3),
        (6, 4),
        (7, 5),
    ]  # Straight connections
    connections += [(6, 5)]
    add_block(
        cursor, tracks=6, skip=True, extra_spacing=1, offset=0, connections=connections
    )

    # cursor["angle_step"] *= 2
    # cursor["radius"] *= 2
    connections = [(0, 0), (1, 1), (2, 3), (3, 4), (4, 5), (5, 6)]
    add_block(
        cursor, tracks=7, curve=Dir.L, skip=[2], offset=0, connections=connections
    )
    # cursor["angle_step"] /= 2

    # Marker Point 12 Flinders Street Viaducts End

    connections = [(0, 0), (1, 1), (3, 3), (4, 4), (5, 5), (6, 6)]
    add_block(
        cursor, tracks=7, curve=Dir.L, skip=[2], offset=0, connections=connections
    )
    # cursor["radius"] /= 2

    # Marker Point 11
    connections = [(5, 7), (6, 8), (4, 6), (1, 3), (0, 2)]  # Straight connections
    connections += [(6, 6), (4, 8), (3, 6), (3, 4), (1, 2)]
    add_block(
        cursor, tracks=11, skip=True, extra_spacing=1, offset=0, connections=connections
    )
    mp11 = cursor.copy()

    # Marker Point 10
    connections = [
        # (8, 9),
        # (7, 8),
        (7, 7),
        (6, 6),
        (4, 4),
        (3, 3),
        (2, 2),
    ]
    connections += [(6, 4), (2, 3)]
    add_block(
        cursor, tracks=11, skip=True, extra_spacing=1, offset=0, connections=connections
    )
    mp10 = cursor.copy()

    # Marker Point 10 and 1/2
    connections = [
        # (9, 10),
        # (8, 9),
        # (8, 8),
        (7, 7),
        (6, 6),
        (4, 4),
        (3, 3),
        (2, 2),
    ]
    connections += [(4, 2)]  # (2, 1)
    add_block(
        cursor, tracks=11, skip=True, extra_spacing=1, offset=0, connections=connections
    )
    draw_track_connnection(mp11, 8, cursor, 10)
    draw_track_connnection(mp11, 7, cursor, 9)
    draw_track_connnection(mp11, 7, cursor, 8)

    # Marker Point 9 / Flinders Street Station
    connections = [
        (10, 10),
        (9, 9),
        (8, 8),
        (7, 7),
        (6, 6),
        (4, 4),
        (3, 3),
        (2, 2),
    ]
    connections += [(6, 7), (6, 5), (4, 5), (3, 4), (2, 1)]  # (1, 0)
    add_block(
        cursor,
        ["Flinders Street", Dir.R, [[0, 0], [2, 10]]],
        skip=[1],
        tracks=11,
        extra_spacing=1,
        connections=connections,
    )
    draw_track_connnection(mp10, 2, cursor, 0)

    permanent_offset(cursor, -1.5)

    # Marker Point 8
    connections = [
        (0, 1),
        (1, 2),
        (2, 3),
        (3, 4),
        (4, 5),
        (5, 6),
        (6, 7),
        (7, 8),
        (8, 9),
        (9, 10),
    ]
    connections += [(1, 1), (10, 10), (10, 12), (9, 10), (8, 10)]
    connections += [(3, 3), (2, 4), (7, 7)]
    add_block(
        cursor,
        ["", Dir.L, [[0, 1], [12, 12]]],
        skip=[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13],
        tracks=14,
        offset=1,
        connections=connections,
    )

    # original_side_spacing = cursor["side_spacing"]
    # cursor["side_spacing"] = original_side_spacing*(2/3)

    # Marker Point 7
    connections = [
        (0, 0),
        (1, 1),
        (2, 1),
        (3, 2),
        (4, 3),
        (5, 4),
        (5, 5),
        (6, 6),
        (6, 7),
        (7, 8),
        (8, 9),
        (9, 10),
        (10, 11),
    ]
    connections += [(1, 0), (5, 6), (6, 5), (9, 9), (10, 10), (10, 12), (12, 13)]
    add_block(
        cursor, skip=True, tracks=14, extra_spacing=0, offset=1, connections=connections
    )
    add_tunnel(cursor, tracks=[8], before=False)
    mp7 = cursor.copy()

    # Marker Point 6
    connections = [
        (0, 0),
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6),
        (7, 7),
        (9, 9),
        (10, 10),
        (11, 11),
        (12, 12),
        (13, 13),
    ]
    connections += [(9, 8), (12, 13)]
    connections += [(0, 1), (1, 2), (5, 4), (6, 7)]
    add_block(
        cursor, skip=True, tracks=14, extra_spacing=1, offset=1, connections=connections
    )
    add_tunnel(cursor, tracks=[12], before=False)

    global mp6
    mp6 = cursor.copy()  # Clifton Hill group starts here

    # Marker Point 5
    connections = [
        (0, 0),
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6),
        (7, 7),
        (8, 8),
        (9, 9),
        (10, 10),
        (11, 11),
    ]
    # connections = [(0,0)]
    cursor["angle_step"] /= 2
    add_block(cursor, tracks=12, offset=0, curve=Dir.R, connections=connections)

    add_block(cursor, skip=True, tracks=12, offset=0, curve=Dir.R)
    cursor["angle_step"] *= 2

    # Marker Point 4
    connections = [
        # (0, 0),
        # (1, 1),
        (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6),
        (7, 7),
        (8, 8),
        (9, 9),
        (10, 10),
    ]
    connections += [(11, 12), (9, 7), (8, 6), (3, 5), (2, 4), (1, 3), (0, 2)]
    add_block(
        cursor,
        skip=True,
        tracks=13,
        offset=-0.5,
        extra_spacing=1,
        connections=connections,
    )
    add_tunnel(cursor, tracks=[11], before=True)
    mp4 = cursor.copy()

    # Marker Point 3
    connections = [
        # (0, 0),
        # (1, 1),
        (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6),
        (7, 7),
        (8, 8),
        (9, 9),
        (10, 10),
    ]
    connections += [
        (12, 11),
        (11, 10),
        (11, 11),
        (7, 5),
        (6, 4),
        (6, 8),
        (7, 9),
        (3, 5),
        (2, 4),
    ]
    add_block(
        cursor,
        skip=True,
        tracks=12,
        offset=0,
        extra_spacing=1,
        connections=connections,
    )
    # add_tunnel(cursor, tracks=[9], before=True)
    mp3 = cursor.copy()

    permanent_offset(cursor, -1)

    # Marker Point 2
    # cursor["side_spacing"] = (9*cursor["side_spacing"])/12  # Scale side spacing for 10 tracks in Burnley Group
    connections = [(7, 7), (8, 8), (9, 9), (10, 10), (11, 11)]
    connections += [(6, 5), (5, 4), (4, 2), (3, 1), (2, 0)]
    add_block(
        cursor, skip=True, tracks=12, offset=0, extra_spacing=1, connections=connections
    )
    add_tunnel(cursor, tracks=[3], before=True)
    add_tunnel(cursor, tracks=[6], before=True)
    mp2 = cursor.copy()

    # Marker Point 1
    connections = [
        (0, 1),
        (1, 2),
        # (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6),
        # (7, 7),
        (8, 7),
        (9, 9),
        (10, 10),
        (11, 11),
    ]
    connections += [(2, 3), (3, 4), (6, 5), (7, 6)]
    add_block(
        cursor, skip=True, tracks=12, offset=0, extra_spacing=1, connections=connections
    )

    # cursor["side_spacing"] = original_side_spacing  # Restore side spacing

    global mp1
    mp1 = cursor.copy()  # Burnley group starts here

    # === City Loop ===
    ref_num = cursor["ref_num"]
    cap_ref = cursor["cap_ref_num"]
    cursor = mp6.copy()
    cursor["ref_num"] = ref_num
    cursor["cap_ref_num"] = cap_ref

    # Tunnel from Flinders Street to City Loop
    # cursor["radius"] *= 2
    cursor["angle_step"] *= 2

    connections = [(12, 3)]
    add_block(
        cursor, tracks=4, skip=True, curve=Dir.L, connections=connections, dotted=True
    )

    draw_track_connnection(mp7, 8, cursor, 2, True)

    cursor["angle_step"] /= 2

    flip_dir(mp2)
    flip_dir(mp4)
    draw_track_connnection(mp2, 5, cursor, 0, True)
    draw_track_connnection(mp2, 8, cursor, 0, True)
    draw_track_connnection(mp4, 1, cursor, 1, True)

    connections = [(0, 0), (1, 1), (2, 2), (3, 3)]
    add_block(cursor, extra_spacing=1, connections=connections, dotted=True)
    global cityLoopSouth
    cityLoopSouth = cursor.copy()

    # === City Loop Stations ===
    # cursor["radius"] *= 2
    add_block(cursor, ("Parliament", Dir.R), extra_spacing=1, dotted=True)
    add_block(cursor, curve=Dir.L, dotted=True)
    add_block(cursor, skip=True, curve=Dir.L, dotted=True)

    add_block(cursor, ("Melbourne Central", Dir.L), extra_spacing=1.25, dotted=True)
    add_block(cursor, dotted=True, extra_spacing=1)
    add_block(cursor, ("Flagstaff", Dir.R), extra_spacing=1, dotted=True)
    add_block(cursor, dotted=True, extra_spacing=1)

    global cityLoopNorth
    cityLoopNorth = cursor.copy()

    draw_track_connnection(cursor, 3, mp17, 9, True)
    draw_track_connnection(cursor, 1, mp17, 8, True)
    draw_track_connnection(cursor, 0, mp17, 4, True)

    cursor["radius"] /= 2

    print(f"City Loop Group = {cursor["ref_num"]-1400} LEDs")
    return cursor


def metro_tunnel_group(cursor):
    global metroTunnelNorth
    flip_dir(metroTunnelNorth)
    cap_ref = cursor["cap_ref_num"]
    cursor = metroTunnelNorth.copy()
    cursor["ref_num"] = 1600
    cursor["cap_ref_num"] = cap_ref

    # === Metro Tunnel ===
    permanent_offset(cursor, -4.0)

    add_block(
        cursor,
        skip=True,
        extra_spacing=1,
        tracks=2,
        connections=[],
    )
    add_tunnel(cursor, [0, 1], before=False)

    draw_track_connnection(metroTunnelNorth, 4, cursor, 0)
    draw_track_connnection(metroTunnelNorth, 5, cursor, 1)

    add_block(
        cursor,
        extra_spacing=10.5,
        tracks=2,
        dotted=True,
        # connections=[(6, 0), (7, 1)],
    )
    add_block(cursor, ("Arden", Dir.L), extra_spacing=2, dotted=True)
    add_block(cursor, dotted=True, extra_spacing=2)
    add_block(cursor, ("Parkville", Dir.L), extra_spacing=2, dotted=True)

    cursor["angle_step"] *= 2
    cursor["radius"] *= 2

    add_block(cursor, curve=Dir.R, dotted=True)

    cursor["angle_step"] /= 2
    cursor["radius"] /= 2

    # add_block(cursor, skip=True, dotted=True)
    add_block(
        cursor, ("State Library", Dir.L), extra_spacing=3.25, dotted=True
    )  # Connects to Melbourne Central
    add_block(cursor, extra_spacing=5, dotted=True)
    add_block(
        cursor, ("Town Hall", Dir.R), extra_spacing=3, dotted=True
    )  # Connects to Flinders Street
    add_block(cursor, extra_spacing=12.5, dotted=True)
    # cursor["radius"] /= 2
    add_block(cursor, ("An  ac", Dir.R), curve=Dir.L, extra_spacing=1, dotted=True)
    add_block(cursor, curve=Dir.L, extra_spacing=1, dotted=True)
    add_block(cursor, skip=True, extra_spacing=7, dotted=True)

    global metroTunnelSouth
    draw_track_connnection(cursor, 0, metroTunnelSouth, 3, True)
    draw_track_connnection(cursor, 1, metroTunnelSouth, 4, True)

    print(f"Metro Tunnel Group = {cursor['ref_num']-1600} LEDs")
    return cursor


def tweak_board(items_to_add):
    # Manually tweak some items on the board after generation
    for item in items_to_add:
        if type(item) is BoardText:
            if "Melbourne\nCentral" in item.value:
                item.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(0.5), item.position.y
                )

            elif "Flinders\nStreet" in item.value:
                item.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(0.5), item.position.y
                )

            elif "Nunawading" in item.value:
                item.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(0.5), item.position.y
                )

            elif "Mitcham" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(0.75), item.position.y
                )

            elif "Heatherdale" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(2), item.position.y
                )

            elif "Eaglemont" in item.value:
                item.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(0.5), item.position.y
                )

            elif "Heidelberg" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(1), item.position.y
                )

            elif "Mount\nWaverley" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(3.0), item.position.y
                )

            elif "Darling" in item.value:
                item.attributes.horizontal_alignment = HorizontalAlignment.HA_RIGHT
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(0.5), item.position.y
                )

            elif "Epping" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(1.5), item.position.y
                )

            elif "South\nMorang" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(1.5), item.position.y
                )

            elif "Diamond\nCreek" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(1.0), item.position.y
                )

            elif "Cardinia\nRoad" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(2.0), item.position.y
                )

            elif "PAKENHAM" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(2.5), item.position.y
                )

            elif "Edithvale" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(1.0), item.position.y
                )

            elif "Leawarra" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(1.5), item.position.y
                )

            elif "Somerville" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(0.0), item.position.y
                )

            elif "Hastings" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(1.0), item.position.y
                )

            elif "Morradoo" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(1.75), item.position.y
                )

            elif "West\nFootscray" in item.value:
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(1.0), item.position.y
                )

            elif item.value == "Middle\nFootscray":
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(1.0), item.position.y
                )

            elif item.value == "Footscray":
                item.position = Vector2.from_xy(
                    item.position.x + from_mm(3.0), item.position.y
                )

            elif item.value == "South\nKensington":
                item.position = Vector2.from_xy(
                    item.position.x - from_mm(2.0), item.position.y
                )

            elif item.value == "An  ac":
                # Work around for missing 'z' in Network Sans font
                x = to_mm(item.position.x) - 3.55
                y = to_mm(item.position.y) + 1
                draw_text(x, y, "z", font="Franklin Gothic Medium", bold=False)

            elif "Crib\nPoint" in item.value:
                item.value = "Crib Point"


start_time = time.time()
clear_copper()
clear_silk_screen()
board.remove_items(items_to_remove)

# Wait 1s to ensure the board is cleared before adding new items
time.sleep(1)

for group_func in [
    city_loop_group,
    burnley_group,
    pakenham_cranbourne_group,
    frankston_sandringham_group,
    werribee_sunbury_group,
    upfield_craigieburn_group,
    mernda_hurstbridge_group,
    metro_tunnel_group,
]:
    cursor = group_func(cursor)


print(f"Python Time taken: {(time.time() - start_time)*1000:.2f} ms\n")
start_time = time.time()

tweak_board(items_to_add)

board.update_items(items_to_update)
board.create_items(items_to_add)

print(f"Total = {total_leds} LEDs")
# print(f"Total Stations = {total_stations}")
# print(f"Average LEDs per Station = {total_leds/total_stations:.1f}")
print(f"KiCad Time taken: {(time.time() - start_time)*1000:.2f} ms")
