"""Deterministic SimCity grid layout with squarified blocks and street gutters."""

from __future__ import annotations

import math
from dataclasses import dataclass

from codecity.analyzer.role_classifier import classify_district_zone, district_for_file
from codecity.models import ZoneType

CITY_CANVAS_W = 140.0
CITY_CANVAS_D = 104.0
AVENUE_GUTTER = 5.0
STREET_GUTTER = 2.6
PLOT_GUTTER = 1.0


@dataclass
class Rect:
    x: float
    z: float
    w: float
    d: float


def _squarify_recursive(
    items: list[tuple[str, float]],
    rect: Rect,
) -> dict[str, Rect]:
    """Pack weighted items into `rect` using the Bruls/Huizing/van Wijk squarified treemap."""
    if not items:
        return {}
    if len(items) == 1:
        return {items[0][0]: rect}

    total_weight = sum(w for _, w in items)
    if total_weight <= 0:
        equal = 1.0 / len(items)
        items = [(k, equal) for k, _ in items]
        total_weight = 1.0

    # Sort descending for cleaner aspect ratios
    sorted_items = sorted(items, key=lambda pair: (-pair[1], pair[0]))
    scale = (rect.w * rect.d) / total_weight
    areas = [(k, max(0.01, w * scale)) for k, w in sorted_items]

    out: dict[str, Rect] = {}
    rem = rect
    idx = 0
    while idx < len(areas):
        short_side = max(0.1, min(rem.w, rem.d))
        row: list[tuple[str, float]] = [areas[idx]]
        idx += 1
        while idx < len(areas):
            cand = [*row, areas[idx]]
            if _worst_aspect(cand, short_side) <= _worst_aspect(row, short_side):
                row = cand
                idx += 1
            else:
                break

        row_area = sum(a for _, a in row)
        if rem.w >= rem.d:
            # Slice vertical column on left
            col_w = min(rem.w, row_area / max(0.1, rem.d))
            cur_z = rem.z
            for k, area in row:
                h = area / max(0.05, col_w)
                out[k] = Rect(x=rem.x, z=cur_z, w=col_w, d=h)
                cur_z += h
            rem = Rect(x=rem.x + col_w, z=rem.z, w=max(0.1, rem.w - col_w), d=rem.d)
        else:
            # Slice horizontal row on top
            row_d = min(rem.d, row_area / max(0.1, rem.w))
            cur_x = rem.x
            for k, area in row:
                w = area / max(0.05, row_d)
                out[k] = Rect(x=cur_x, z=rem.z, w=w, d=row_d)
                cur_x += w
            rem = Rect(x=rem.x, z=rem.z + row_d, w=rem.w, d=max(0.1, rem.d - row_d))

    return out


def _worst_aspect(row: list[tuple[str, float]], side: float) -> float:
    s = sum(a for _, a in row)
    if s <= 0 or side <= 0:
        return float("inf")
    r_max = max(a for _, a in row)
    r_min = min(a for _, a in row)
    s2 = s * s
    side2 = side * side
    return max((side2 * r_max) / s2, s2 / (side2 * r_min))


def _inset(rect: Rect, pad: float) -> Rect:
    p = min(pad, rect.w * 0.28, rect.d * 0.28)
    return Rect(
        x=round(rect.x + p, 3),
        z=round(rect.z + p, 3),
        w=round(max(0.8, rect.w - 2 * p), 3),
        d=round(max(0.8, rect.d - 2 * p), 3),
    )


def compute_stable_city_layout(
    union_file_weights: dict[str, float],
    file_zone_hints: dict[str, list[ZoneType]] | None = None,
) -> tuple[
    dict[str, tuple[float, float, float, float]],
    dict[str, tuple[float, float, float, float, ZoneType]],
]:
    """Compute fixed union plots `(x, z, w, d)` for every file and district across time."""
    if not union_file_weights:
        return {}, {}

    zone_hints = file_zone_hints or {}
    district_files: dict[str, list[tuple[str, float]]] = {}
    for fpath, weight in sorted(union_file_weights.items()):
        dpath = district_for_file(fpath)
        district_files.setdefault(dpath, []).append((fpath, max(12.0, float(weight))))

    # Group districts by ZoneType so neighborhoods form recognizable SimCity sectors
    zone_districts: dict[ZoneType, list[tuple[str, float]]] = {}
    district_zone_map: dict[str, ZoneType] = {}
    for dpath, members in sorted(district_files.items()):
        hints = []
        for fpath, _ in members:
            hints.extend(zone_hints.get(fpath, []))
        ztype = classify_district_zone(dpath, hints)
        district_zone_map[dpath] = ztype
        d_weight = sum(w for _, w in members) + 40.0
        zone_districts.setdefault(ztype, []).append((dpath, d_weight))

    # Order zones deterministically so Harbor hugs front waterfront & Greenbelt wraps outer edge
    zone_order = [
        ZoneType.HARBOR_GATES,
        ZoneType.GALLERY_STOREFRONT,
        ZoneType.DOWNTOWN_CORE,
        ZoneType.VAULTS_RESERVOIR,
        ZoneType.INDUSTRIAL_QUARTER,
        ZoneType.CIVIC_UTILITIES,
        ZoneType.GREENBELT_PARKS,
        ZoneType.SUPPLY_DOCKS,
    ]
    zone_items: list[tuple[str, float]] = []
    for z in zone_order:
        members = zone_districts.get(z)
        if members:
            zone_items.append((z.value, sum(w for _, w in members) + 80.0))

    zone_rects = _squarify_recursive(
        zone_items,
        Rect(x=0.0, z=0.0, w=CITY_CANVAS_W, d=CITY_CANVAS_D),
    )

    file_layout: dict[str, tuple[float, float, float, float]] = {}
    district_layout: dict[str, tuple[float, float, float, float, ZoneType]] = {}

    for z_val, z_rect_raw in zone_rects.items():
        z_enum = ZoneType(z_val)
        z_rect = _inset(z_rect_raw, AVENUE_GUTTER * 0.5)
        d_items = zone_districts[z_enum]
        d_rects = _squarify_recursive(d_items, z_rect)

        for dpath, d_rect_raw in d_rects.items():
            d_rect = _inset(d_rect_raw, STREET_GUTTER * 0.5)
            district_layout[dpath] = (d_rect.x, d_rect.z, d_rect.w, d_rect.d, z_enum)

            inner = _inset(d_rect, 1.2)
            f_items = district_files[dpath]
            f_rects = _squarify_recursive(f_items, inner)
            for fpath, f_rect_raw in f_rects.items():
                # Clamp building aspect ratio nicely so buildings don't turn into thin slivers
                lot = _inset(
                    f_rect_raw,
                    min(PLOT_GUTTER * 0.5, math.sqrt(f_rect_raw.w * f_rect_raw.d) * 0.12),
                )
                file_layout[fpath] = (lot.x, lot.z, lot.w, lot.d)

    return file_layout, district_layout
