"""Bake pre-rendered 2D isometric sprite atlases (30 building variants x 4 angles + emissive)."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ARCHETYPES = [
    "grand_terminal",
    "city_hall",
    "archive_vault",
    "twin_silos",
    "factory",
    "office_tower",
    "glass_pavilion",
    "watchtower",
    "civic_kiosk",
    "park_stadium",
]
TIERS = ["low", "mid", "high"]
ANGLES = ["N", "E", "S", "W"]

HTML_PAINTER = r"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;background:transparent">
<canvas id="buildings"></canvas>
<canvas id="emissive"></canvas>
<script>
const ARCHETYPES = __ARCHETYPES__;
const TIERS = __TIERS__;
const ANGLES = __ANGLES__;
const CW = 96, CH = 128, AX = 48, AY = 114;

const bCanvas = document.getElementById('buildings');
bCanvas.width = TIERS.length * ANGLES.length * CW;
bCanvas.height = ARCHETYPES.length * CH;
const bCtx = bCanvas.getContext('2d');

const eCanvas = document.getElementById('emissive');
eCanvas.width = bCanvas.width;
eCanvas.height = bCanvas.height;
const eCtx = eCanvas.getContext('2d');

// Neutral architectural shades designed to accept subtle DataMap tinting cleanly while staying realistic
const PAL = {
  grand_terminal: { roof: '#7dd3fc', left: '#0369a1', right: '#0c4a6e', trim: '#bae6fd', podium: '#475569' },
  city_hall:      { roof: '#fde68a', left: '#d97706', right: '#92400e', trim: '#fef9c3', podium: '#cbd5e1' },
  archive_vault:  { roof: '#e2e8f0', left: '#94a3b8', right: '#475569', trim: '#f8fafc', podium: '#64748b' },
  twin_silos:     { roof: '#c7d2fe', left: '#6366f1', right: '#3730a3', trim: '#e0e7ff', podium: '#334155' },
  factory:        { roof: '#fdba74', left: '#c2410c', right: '#7c2d12', trim: '#fed7aa', podium: '#44403c' },
  office_tower:   { roof: '#93c5fd', left: '#2563eb', right: '#1e3a8a', trim: '#dbeafe', podium: '#64748b' },
  glass_pavilion: { roof: '#67e8f9', left: '#0891b2', right: '#164e63', trim: '#cffafe', podium: '#334155' },
  watchtower:     { roof: '#5eead4', left: '#0f766e', right: '#134e4a', trim: '#ccfbf1', podium: '#1e293b' },
  civic_kiosk:    { roof: '#cbd5e1', left: '#64748b', right: '#334155', trim: '#f1f5f9', podium: '#475569' },
  park_stadium:   { roof: '#4ade80', left: '#16a34a', right: '#14532d', trim: '#bbf7d0', podium: '#15803d' },
};

function isoProj(x, z, y, angleIdx) {
  // Rotate (x,z) in local [-1, 1] space by angleIdx * 90 deg
  const rad = angleIdx * Math.PI * 0.5;
  const rx = x * Math.cos(rad) - z * Math.sin(rad);
  const rz = x * Math.sin(rad) + z * Math.cos(rad);
  const sx = (rx - rz) * 18;
  const sy = (rx + rz) * 9 - y;
  return { x: sx, y: sy };
}

function drawQuad(ctx, pts, fill, stroke = null, lw = 0.8) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

function drawBox(ctx, ox, oy, x0, z0, x1, z1, y0, h, pal, angleIdx, stroke = 'rgba(15,23,42,0.75)') {
  const P = (x, z, y) => {
    const p = isoProj(x, z, y, angleIdx);
    return { x: ox + p.x, y: oy + p.y };
  };
  const t00 = P(x0, z0, y0 + h), t10 = P(x1, z0, y0 + h), t11 = P(x1, z1, y0 + h), t01 = P(x0, z1, y0 + h);
  const b00 = P(x0, z0, y0),     b10 = P(x1, z0, y0),     b11 = P(x1, z1, y0),     b01 = P(x0, z1, y0);

  // Pick 2 front-facing side quads using outward normal in rotated space
  const faces = [
    { pts: [t01, t11, b11, b01], nx: 0, nz: 1 },
    { pts: [t10, t00, b00, b10], nx: 0, nz: -1 },
    { pts: [t10, t11, b11, b10], nx: 1, nz: 0 },
    { pts: [t00, t01, b01, b00], nx: -1, nz: 0 },
  ];
  const rad = angleIdx * Math.PI * 0.5;
  const visible = faces
    .map(f => {
      const rnx = f.nx * Math.cos(rad) - f.nz * Math.sin(rad);
      const rnz = f.nx * Math.sin(rad) + f.nz * Math.cos(rad);
      const depthScore = rnx + rnz;
      const midX = (f.pts[0].x + f.pts[1].x) * 0.5;
      return { ...f, depthScore, midX };
    })
    .filter(f => f.depthScore > 0.01)
    .sort((a, b) => a.midX - b.midX);

  if (visible[0]) drawQuad(ctx, visible[0].pts, pal.left, stroke, 0.8);
  if (visible[1]) drawQuad(ctx, visible[1].pts, pal.right, stroke, 0.8);
  drawQuad(ctx, [t00, t10, t11, t01], pal.roof, stroke, 0.8);
  return { P, visible };
}

function drawWindowGrid(ctx, eCtx, ox, oy, x0, z0, x1, z1, y0, h, floors, cols, angleIdx, warmColor, coolColor) {
  const P = (x, z, y) => {
    const p = isoProj(x, z, y, angleIdx);
    return { x: ox + p.x, y: oy + p.y };
  };
  const rad = angleIdx * Math.PI * 0.5;
  const testFaces = [
    { nx: 0, nz: 1, mk: (u, v) => P(x0 + (x1 - x0) * u, z1, y0 + h * v) },
    { nx: 0, nz: -1, mk: (u, v) => P(x1 - (x1 - x0) * u, z0, y0 + h * v) },
    { nx: 1, nz: 0, mk: (u, v) => P(x1, z0 + (z1 - z0) * u, y0 + h * v) },
    { nx: -1, nz: 0, mk: (u, v) => P(x0, z1 - (z1 - z0) * u, y0 + h * v) },
  ];
  for (const tf of testFaces) {
    const rnx = tf.nx * Math.cos(rad) - tf.nz * Math.sin(rad);
    const rnz = tf.nx * Math.sin(rad) + tf.nz * Math.cos(rad);
    if (rnx + rnz <= 0.01) continue;
    for (let fl = 0; fl < floors; fl++) {
      const v0 = 0.08 + (fl / floors) * 0.84;
      const v1 = v0 + (0.55 / floors) * 0.84;
      for (let c = 0; c < cols; c++) {
        const u0 = 0.1 + (c / cols) * 0.8;
        const u1 = u0 + (0.62 / cols) * 0.8;
        const pts = [tf.mk(u0, v0), tf.mk(u1, v0), tf.mk(u1, v1), tf.mk(u0, v1)];
        drawQuad(ctx, pts, coolColor, null);
        // Deterministic lit night windows (~62%)
        if (((fl * 7 + c * 13 + angleIdx * 3) % 5) !== 0) {
          drawQuad(eCtx, pts, warmColor, null);
        }
      }
    }
  }
}

for (let ai = 0; ai < ARCHETYPES.length; ai++) {
  const arch = ARCHETYPES[ai];
  const pal = PAL[arch];
  for (let ti = 0; ti < TIERS.length; ti++) {
    const tierScale = ti === 0 ? 0.52 : ti === 1 ? 0.8 : 1.08;
    for (let rot = 0; rot < ANGLES.length; rot++) {
      const colIdx = ti * 4 + rot;
      const ox = colIdx * CW + AX;
      const oy = ai * CH + AY;

      if (arch === 'park_stadium') {
        // Lush green turf + running track + tiered bleachers + light towers
        drawBox(bCtx, ox, oy, -0.95, -0.95, 0.95, 0.95, 0, 4, { roof: '#15803d', left: '#166534', right: '#14532d' }, rot);
        drawBox(bCtx, ox, oy, -0.82, -0.82, 0.82, -0.58, 4, 7 * tierScale, { roof: '#cbd5e1', left: '#94a3b8', right: '#64748b' }, rot);
        drawBox(bCtx, ox, oy, -0.82, 0.58, 0.82, 0.82, 4, 7 * tierScale, { roof: '#cbd5e1', left: '#94a3b8', right: '#64748b' }, rot);
        // Inner oval
        const cPt = isoProj(0, 0, 4.5, rot);
        bCtx.save();
        bCtx.translate(ox + cPt.x, oy + cPt.y);
        bCtx.scale(1, 0.5);
        bCtx.beginPath();
        bCtx.arc(0, 0, 12, 0, Math.PI * 2);
        bCtx.fillStyle = '#22c55e';
        bCtx.fill();
        bCtx.strokeStyle = '#fde68a';
        bCtx.lineWidth = 2;
        bCtx.stroke();
        bCtx.restore();
        // Stadium floodlights in emissive
        for (const [lx, lz] of [[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]]) {
          const pBase = isoProj(lx, lz, 4, rot);
          const pTop = isoProj(lx, lz, 15 + ti * 3, rot);
          bCtx.strokeStyle = '#94a3b8';
          bCtx.lineWidth = 1.5;
          bCtx.beginPath();
          bCtx.moveTo(ox + pBase.x, oy + pBase.y);
          bCtx.lineTo(ox + pTop.x, oy + pTop.y);
          bCtx.stroke();
          eCtx.fillStyle = '#fef9c3';
          eCtx.beginPath();
          eCtx.arc(ox + pTop.x, oy + pTop.y, 2.3, 0, Math.PI * 2);
          eCtx.fill();
        }
        continue;
      }

      const baseH = Math.round(32 * tierScale + (arch === 'city_hall' ? 14 : arch === 'office_tower' ? 10 : 0));

      if (arch === 'office_tower') {
        drawBox(bCtx, ox, oy, -0.92, -0.92, 0.92, 0.92, 0, 9, { roof: '#94a3b8', left: pal.podium, right: '#334155' }, rot);
        const shaftH = baseH;
        drawBox(bCtx, ox, oy, -0.78, -0.78, 0.78, 0.78, 9, shaftH, pal, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.78, -0.78, 0.78, 0.78, 9, shaftH, 4 + ti * 2, 4, rot, 'rgba(253,224,71,0.88)', 'rgba(224,242,254,0.34)');
        drawBox(bCtx, ox, oy, -0.48, -0.48, 0.48, 0.48, 9 + shaftH, 7, { roof: pal.trim, left: '#64748b', right: '#334155' }, rot);
        // Rooftop helipad ring
        const hp = isoProj(0, 0, 9 + shaftH + 7.5, rot);
        bCtx.strokeStyle = '#facc15';
        bCtx.lineWidth = 1.2;
        bCtx.beginPath();
        bCtx.ellipse(ox + hp.x, oy + hp.y, 5, 2.6, 0, 0, Math.PI * 2);
        bCtx.stroke();
      } else if (arch === 'city_hall') {
        drawBox(bCtx, ox, oy, -0.94, -0.94, 0.94, 0.94, 0, 8, { roof: '#e2e8f0', left: '#94a3b8', right: '#475569' }, rot);
        drawBox(bCtx, ox, oy, -0.78, -0.78, 0.78, 0.78, 8, baseH * 0.75, pal, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.78, -0.78, 0.78, 0.78, 8, baseH * 0.75, 3 + ti, 3, rot, 'rgba(254,240,138,0.92)', 'rgba(255,251,235,0.4)');
        const crownY = 8 + baseH * 0.75;
        drawBox(bCtx, ox, oy, -0.5, -0.5, 0.5, 0.5, crownY, 10, { roof: '#fef08a', left: '#f59e0b', right: '#b45309' }, rot);
        const sp0 = isoProj(0, 0, crownY + 10, rot);
        const sp1 = isoProj(0, 0, crownY + 25, rot);
        bCtx.strokeStyle = '#fef08a';
        bCtx.lineWidth = 2;
        bCtx.beginPath();
        bCtx.moveTo(ox + sp0.x, oy + sp0.y);
        bCtx.lineTo(ox + sp1.x, oy + sp1.y);
        bCtx.stroke();
        eCtx.fillStyle = '#fde047';
        eCtx.beginPath();
        eCtx.arc(ox + sp1.x, oy + sp1.y, 3, 0, Math.PI * 2);
        eCtx.fill();
      } else if (arch === 'grand_terminal') {
        drawBox(bCtx, ox, oy, -0.92, -0.72, 0.92, 0.72, 0, baseH * 0.72, pal, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.92, -0.72, 0.92, 0.72, 0, baseH * 0.72, 2 + ti, 4, rot, 'rgba(125,211,252,0.9)', 'rgba(224,242,254,0.45)');
        // Clocktower on +X, -Z corner so rotation shows it moving!
        const ctH = baseH * 0.72 + 16 + ti * 4;
        drawBox(bCtx, ox, oy, 0.35, -0.75, 0.85, -0.25, 0, ctH, { roof: '#fef08a', left: '#0284c7', right: '#075985' }, rot);
        const dial = isoProj(0.6, -0.5, ctH - 3, rot);
        eCtx.fillStyle = '#fef08a';
        eCtx.beginPath();
        eCtx.arc(ox + dial.x, oy + dial.y, 2.8, 0, Math.PI * 2);
        eCtx.fill();
      } else if (arch === 'twin_silos') {
        drawBox(bCtx, ox, oy, -0.88, -0.88, 0.88, 0.88, 0, 5, { roof: '#475569', left: '#334155', right: '#1e293b' }, rot);
        const sH = baseH * 0.9;
        drawBox(bCtx, ox, oy, -0.76, -0.38, -0.1, 0.38, 5, sH, pal, rot);
        drawBox(bCtx, ox, oy, 0.1, -0.38, 0.76, 0.38, 5, sH, pal, rot);
        // Connecting pipe catwalk
        drawBox(bCtx, ox, oy, -0.3, -0.12, 0.3, 0.12, 5 + sH * 0.65, 3, { roof: '#e0e7ff', left: '#818cf8', right: '#4f46e5' }, rot);
        // Tank status lights
        const l1 = isoProj(-0.43, 0, 5 + sH + 2, rot);
        const l2 = isoProj(0.43, 0, 5 + sH + 2, rot);
        eCtx.fillStyle = '#a5b4fc';
        eCtx.fillRect(ox + l1.x - 1.5, oy + l1.y - 1.5, 3, 3);
        eCtx.fillRect(ox + l2.x - 1.5, oy + l2.y - 1.5, 3, 3);
      } else if (arch === 'factory') {
        const fH = baseH * 0.72;
        drawBox(bCtx, ox, oy, -0.9, -0.82, 0.9, 0.82, 0, fH, pal, rot);
        // Sawtooth skylight monitors
        drawBox(bCtx, ox, oy, -0.75, -0.65, -0.15, 0.65, fH, 6, { roof: '#fed7aa', left: '#ea580c', right: '#9a3412' }, rot);
        drawBox(bCtx, ox, oy, 0.05, -0.65, 0.55, 0.65, fH, 6, { roof: '#fed7aa', left: '#ea580c', right: '#9a3412' }, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.9, -0.82, 0.9, 0.82, 0, fH, 2, 4, rot, 'rgba(251,146,60,0.88)', 'rgba(254,215,170,0.32)');
        // Twin smokestacks on back-right corner
        for (const sz of [-0.45, 0.25]) {
          drawBox(bCtx, ox, oy, 0.58, sz - 0.12, 0.82, sz + 0.12, fH, 14 + ti * 3, { roof: '#ef4444', left: '#57534e', right: '#292524' }, rot);
        }
      } else if (arch === 'archive_vault') {
        drawBox(bCtx, ox, oy, -0.92, -0.92, 0.92, 0.92, 0, 6, { roof: '#cbd5e1', left: '#64748b', right: '#334155' }, rot);
        drawBox(bCtx, ox, oy, -0.78, -0.78, 0.78, 0.78, 6, baseH * 0.82, pal, rot);
        drawBox(bCtx, ox, oy, -0.64, -0.64, 0.64, 0.64, 6 + baseH * 0.82, 5, { roof: '#f8fafc', left: '#cbd5e1', right: '#64748b' }, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.78, -0.78, 0.78, 0.78, 6, baseH * 0.82, 2, 3, rot, 'rgba(196,181,253,0.85)', 'rgba(226,232,240,0.35)');
      } else if (arch === 'glass_pavilion') {
        drawBox(bCtx, ox, oy, -0.76, -0.76, 0.76, 0.76, 0, 7, { roof: '#475569', left: '#334155', right: '#1e293b' }, rot);
        // Cantilevered upper glazed box
        drawBox(bCtx, ox, oy, -0.9, -0.88, 0.9, 0.88, 7, baseH * 0.78, pal, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.9, -0.88, 0.9, 0.88, 7, baseH * 0.78, 2 + ti, 4, rot, 'rgba(103,232,249,0.88)', 'rgba(207,250,254,0.45)');
        // Rooftop green garden strip
        drawBox(bCtx, ox, oy, -0.6, -0.58, 0.6, 0.58, 7 + baseH * 0.78, 3, { roof: '#4ade80', left: '#16a34a', right: '#14532d' }, rot);
      } else if (arch === 'watchtower') {
        drawBox(bCtx, ox, oy, -0.82, -0.82, 0.82, 0.82, 0, baseH * 0.85, pal, rot);
        drawBox(bCtx, ox, oy, -0.46, -0.46, 0.46, 0.46, baseH * 0.85, 11, { roof: '#99f6e4', left: '#0d9488', right: '#115e59' }, rot);
        const dish = isoProj(0.2, -0.2, baseH * 0.85 + 15, rot);
        bCtx.fillStyle = '#e2e8f0';
        bCtx.beginPath();
        bCtx.arc(ox + dish.x, oy + dish.y, 4, 0, Math.PI);
        bCtx.fill();
        eCtx.fillStyle = '#2dd4bf';
        eCtx.beginPath();
        eCtx.arc(ox + dish.x, oy + dish.y - 2, 2.2, 0, Math.PI * 2);
        eCtx.fill();
      } else {
        // civic_kiosk
        drawBox(bCtx, ox, oy, -0.86, -0.86, 0.86, 0.86, 0, 5, { roof: '#cbd5e1', left: '#64748b', right: '#334155' }, rot);
        drawBox(bCtx, ox, oy, -0.68, -0.68, 0.68, 0.68, 5, baseH * 0.68, pal, rot);
        drawBox(bCtx, ox, oy, -0.45, -0.45, 0.45, 0.45, 5 + baseH * 0.68, 5, { roof: '#f1f5f9', left: '#94a3b8', right: '#475569' }, rot);
        drawWindowGrid(bCtx, eCtx, ox, oy, -0.68, -0.68, 0.68, 0.68, 5, baseH * 0.68, 2, 2, rot, 'rgba(253,224,71,0.85)', 'rgba(226,232,240,0.4)');
      }
    }
  }
}

window.__ATLAS_DATA__ = {
  buildings: bCanvas.toDataURL('image/png'),
  emissive: eCanvas.toDataURL('image/png'),
};
</script>
</body>
</html>
"""


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out_dir = root / "public" / "sprites"
    out_dir.mkdir(parents=True, exist_ok=True)

    html = (
        HTML_PAINTER.replace("__ARCHETYPES__", json.dumps(ARCHETYPES))
        .replace("__TIERS__", json.dumps(TIERS))
        .replace("__ANGLES__", json.dumps(ANGLES))
    )

    import base64

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.set_content(html)
        data = page.evaluate("() => window.__ATLAS_DATA__")
        browser.close()

    for key, fname in [
        ("buildings", "buildings_atlas.png"),
        ("emissive", "buildings_emissive.png"),
    ]:
        b64 = data[key].split(",", 1)[1]
        (out_dir / fname).write_bytes(base64.b64decode(b64))

    print(f"Baked 30-sprite isometric atlas + emissive mask into {out_dir}")


if __name__ == "__main__":
    main()
