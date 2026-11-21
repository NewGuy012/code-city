"""Deterministic SimCity quantized urban parcel layout, plazas, and street-grid builder."""

from __future__ import annotations

import math
from dataclasses import dataclass

from codecity.analyzer.role_classifier import classify_district_zone, district_for_file
from codecity.models import ZoneType

CITY_CANVAS_W = 140.0
CITY_CANVAS_D = 104.0
AVENUE_GUTTER = 6.0
STREET_GUTTER = 3.6
SIDEWALK_MARGIN = 1.1
PARCEL_GAP = 0.45


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
            col_w = min(rem.w, row_area / max(0.1, rem.d))
            cur_z = rem.z
            for k, area in row:
                h = area / max(0.05, col_w)
                out[k] = Rect(x=rem.x, z=cur_z, w=col_w, d=h)
                cur_z += h
            rem = Rect(x=rem.x + col_w, z=rem.z, w=max(0.1, rem.w - col_w), d=rem.d)
        else:
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
    p = min(pad, rect.w * 0.25, rect.d * 0.25)
    return Rect(
        x=round(rect.x + p, 3),
        z=round(rect.z + p, 3),
        w=round(max(1.2, rect.w - 2 * p), 3),
        d=round(max(1.2, rect.d - 2 * p), 3),
    )


def _desired_parcel_cells(weight: float, idx: int) -> tuple[int, int]:
    """Map SLOC-derived weight to standard urban parcel footprints (`1x1`, `1x2`, `2x2`, `2x3`)."""
    if weight >= 520:
        return (3, 2) if idx % 2 == 0 else (2, 3)
    if weight >= 240:
        return (2, 2)
    if weight >= 100:
        return (2, 1) if idx % 2 == 0 else (1, 2)
    return (1, 1)


def _pack_urban_parcels(
    items: list[tuple[str, float]],
    inner: Rect,
) -> dict[str, Rect]:
    """Quantize buildings onto modular city parcels (`1x1`, `1x2`, `2x2`, `2x3`) inside `inner`."""
    if not items:
        return {}

    sorted_items = sorted(items, key=lambda pair: (-pair[1], pair[0]))
    desired = [
        (fpath, weight, *_desired_parcel_cells(weight, idx))
        for idx, (fpath, weight) in enumerate(sorted_items)
    ]

    # Choose grid resolution large enough to fit every parcel cleanly
    aspect = inner.w / max(0.5, inner.d)

    for scale_shrink in (0, 1, 2):
        specs = []
        for fpath, _weight, cw, cd in desired:
            if scale_shrink == 1:
                cw = max(1, min(2, cw))
                cd = max(1, min(2, cd))
            elif scale_shrink == 2:
                cw = 1
                cd = 1
            specs.append((fpath, cw, cd))

        need_cells = sum(cw * cd for _, cw, cd in specs)
        target_cells = max(need_cells * 1.18, float(len(specs)))
        cols = max(1, round(math.sqrt(target_cells * aspect)))
        rows = max(1, math.ceil(target_cells / cols))
        # Ensure widest/deepest single parcel fits inside grid
        max_cw = max(cw for _, cw, _ in specs)
        max_cd = max(cd for _, _, cd in specs)
        cols = max(cols, max_cw)
        rows = max(rows, max_cd)
        while cols * rows < need_cells:
            if inner.w / max(1, cols) >= inner.d / max(1, rows):
                cols += 1
            else:
                rows += 1

        # Attempt skyline / shelf placement on the cols x rows boolean grid
        for attempt in range(4):
            cur_cols = cols + (attempt // 2)
            cur_rows = rows + ((attempt + 1) // 2)
            occupied = [[False] * cur_cols for _ in range(cur_rows)]
            placed: dict[str, tuple[int, int, int, int]] = {}
            ok = True

            for fpath, cw, cd in specs:
                candidates = [(cw, cd)]
                if cw != cd:
                    candidates.append((cd, cw))
                if cw > 1 or cd > 1:
                    candidates.append((1, 1))

                spot: tuple[int, int, int, int] | None = None
                for tw, th in candidates:
                    if tw > cur_cols or th > cur_rows:
                        continue
                    for r in range(cur_rows - th + 1):
                        for c in range(cur_cols - tw + 1):
                            if all(
                                not occupied[rr][cc]
                                for rr in range(r, r + th)
                                for cc in range(c, c + tw)
                            ):
                                spot = (c, r, tw, th)
                                break
                        if spot is not None:
                            break
                    if spot is not None:
                        break

                if spot is None:
                    ok = False
                    break

                c0, r0, tw, th = spot
                for rr in range(r0, r0 + th):
                    for cc in range(c0, c0 + tw):
                        occupied[rr][cc] = True
                placed[fpath] = spot

            if ok:
                cell_w = inner.w / cur_cols
                cell_d = inner.d / cur_rows
                gap_x = min(PARCEL_GAP, cell_w * 0.14)
                gap_z = min(PARCEL_GAP, cell_d * 0.14)
                out: dict[str, Rect] = {}
                for fpath, (c0, r0, tw, th) in placed.items():
                    px = inner.x + c0 * cell_w + gap_x * 0.5
                    pz = inner.z + r0 * cell_d + gap_z * 0.5
                    pw = max(0.75, tw * cell_w - gap_x)
                    pd = max(0.75, th * cell_d - gap_z)
                    out[fpath] = Rect(
                        x=round(px, 3),
                        z=round(pz, 3),
                        w=round(pw, 3),
                        d=round(pd, 3),
                    )
                return out

    return {}


def compute_stable_city_layout(
    union_file_weights: dict[str, float],
    file_zone_hints: dict[str, list[ZoneType]] | None = None,
) -> tuple[
    dict[str, tuple[float, float, float, float]],
    dict[str, tuple[float, float, float, float, ZoneType]],
]:
    """Compute fixed quantized urban plots `(x, z, w, d)` for every file and district."""
    if not union_file_weights:
        return {}, {}

    zone_hints = file_zone_hints or {}
    district_files: dict[str, list[tuple[str, float]]] = {}
    for fpath, weight in sorted(union_file_weights.items()):
        dpath = district_for_file(fpath)
        district_files.setdefault(dpath, []).append((fpath, max(12.0, float(weight))))

    zone_districts: dict[ZoneType, list[tuple[str, float]]] = {}
    for dpath, members in sorted(district_files.items()):
        hints: list[ZoneType] = []
        for fpath, _ in members:
            hints.extend(zone_hints.get(fpath, []))
        ztype = classify_district_zone(dpath, hints)
        d_weight = sum(w for _, w in members) + 45.0
        zone_districts.setdefault(ztype, []).append((dpath, d_weight))

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
            zone_items.append((z.value, sum(w for _, w in members) + 90.0))

    zone_rects = _squarify_recursive(
        zone_items,
        Rect(x=2.0, z=2.0, w=CITY_CANVAS_W - 4.0, d=CITY_CANVAS_D - 4.0),
    )

    file_layout: dict[str, tuple[float, float, float, float]] = {}
    district_layout: dict[str, tuple[float, float, float, float, ZoneType]] = {}

    for z_val, z_rect_raw in zone_rects.items():
        z_enum = ZoneType(z_val)
        z_rect = _inset(z_rect_raw, AVENUE_GUTTER * 0.45)
        d_items = zone_districts[z_enum]
        d_rects = _squarify_recursive(d_items, z_rect)

        for dpath, d_rect_raw in d_rects.items():
            d_rect = _inset(d_rect_raw, STREET_GUTTER * 0.45)
            district_layout[dpath] = (d_rect.x, d_rect.z, d_rect.w, d_rect.d, z_enum)

            inner = _inset(d_rect, SIDEWALK_MARGIN)
            f_rects = _pack_urban_parcels(district_files[dpath], inner)
            for fpath, lot in f_rects.items():
                file_layout[fpath] = (lot.x, lot.z, lot.w, lot.d)

    return file_layout, district_layout
