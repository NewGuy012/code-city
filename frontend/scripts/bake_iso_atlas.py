"""Bake 3D-rendered WebP 2D isometric sprite atlases (480 building sprites + emissive + nature)."""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


def _find_bun() -> str:
    found = shutil.which("bun")
    if found:
        return found
    home_bun = Path.home() / ".bun" / "bin" / "bun"
    if home_bun.exists():
        return str(home_bun)
    raise FileNotFoundError("Bun executable not found on PATH or ~/.bun/bin/bun")


def main() -> None:
    frontend_dir = Path(__file__).resolve().parents[1]
    entry_ts = frontend_dir / "scripts" / "bake_atlas_entry.ts"
    out_dir = frontend_dir / "public" / "sprites"
    out_dir.mkdir(parents=True, exist_ok=True)

    bun_bin = _find_bun()
    with tempfile.TemporaryDirectory() as tmp:
        bundle_js = Path(tmp) / "bake_bundle.js"
        subprocess.run(
            [
                bun_bin,
                "build",
                str(entry_ts),
                "--outfile",
                str(bundle_js),
                "--target",
                "browser",
                "--format",
                "iife",
            ],
            cwd=frontend_dir,
            check=True,
        )
        script_src = bundle_js.read_text(encoding="utf-8")

    html = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
        "<body style='margin:0;background:transparent'></body></html>"
    )

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl"],
        )
        page = browser.new_page()
        page.set_content(html)
        page.add_script_tag(content=script_src)
        data = page.evaluate("() => window.__CODECITY_BAKE__()")
        browser.close()

    for key, fname in [
        ("buildings_t0", "buildings_t0.webp"),
        ("buildings_t1", "buildings_t1.webp"),
        ("buildings_t2", "buildings_t2.webp"),
        ("emissive_t0", "buildings_emissive_t0.webp"),
        ("emissive_t1", "buildings_emissive_t1.webp"),
        ("emissive_t2", "buildings_emissive_t2.webp"),
        ("nature", "nature_atlas.webp"),
    ]:
        b64 = data[key].split(",", 1)[1]
        dest = out_dir / fname
        dest.write_bytes(base64.b64decode(b64))
        print(f"Wrote {dest.name}: {dest.stat().st_size / 1024:.1f} KB")

    manifest_path = out_dir / "atlas_manifest.json"
    manifest_path.write_text(json.dumps(data["manifest"], indent=2), encoding="utf-8")
    print(f"Wrote {manifest_path.name} into {out_dir}")

    # Remove superseded single-sheet atlases if present
    for old_file in (
        "buildings_atlas.png",
        "buildings_emissive.png",
        "buildings_atlas.webp",
        "buildings_emissive.webp",
    ):
        p = out_dir / old_file
        if p.exists():
            os.unlink(p)


if __name__ == "__main__":
    main()
