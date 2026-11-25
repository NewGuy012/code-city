"""Zero-backend static OSS report exporter, SVG badge maker, and Playwright PNG postcard."""

from __future__ import annotations

import functools
import html
import http.server
import json
import shutil
import socketserver
import subprocess
import tempfile
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from codecity.analyzer.plugins.base import find_bun
from codecity.storage.lakehouse import LakehouseManager


@dataclass
class ExportResult:
    """Paths produced by exporting a static CodeCity OSS report."""

    output_dir: Path
    manifest_path: Path
    badge_path: Path
    postcard_path: Path | None = None


def default_frontend_dist() -> Path:
    return Path(__file__).resolve().parents[4] / "frontend" / "dist"


def _ensure_frontend_dist(frontend_dist: Path | None) -> Path:
    dist_dir = (frontend_dist or default_frontend_dist()).resolve()
    if (dist_dir / "index.html").exists():
        return dist_dir
    bun_bin = find_bun()
    if not bun_bin:
        raise FileNotFoundError("Bun executable not found to build frontend dist")
    subprocess.run([bun_bin, "run", "build"], cwd=dist_dir.parent, check=True)
    return dist_dir


def render_grade_badge_svg(grade: str, title: str, owner: str, repo: str) -> str:
    """Render a Shields-style SVG README badge for the repository's City Grade."""
    grade_color = (
        "#10b981" if grade.startswith("A") else "#f59e0b" if grade.startswith("B") else "#ef4444"
    )
    left_raw = f"CodeCity · {owner}/{repo}"
    right_raw = f"{grade} · {title}"
    left_txt = html.escape(left_raw)
    right_txt = html.escape(right_raw)
    left_w = max(110, len(left_raw) * 7 + 18)
    right_w = max(140, len(right_raw) * 7 + 18)
    total_w = left_w + right_w
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="24" role="img">\n'
        f'  <linearGradient id="g" x2="0" y2="100%">'
        f'<stop offset="0" stop-color="#fff" stop-opacity=".12"/>'
        f'<stop offset="1" stop-opacity=".15"/></linearGradient>\n'
        f'  <clipPath id="r"><rect width="{total_w}" height="24" rx="5" fill="#fff"/></clipPath>\n'
        f'  <g clip-path="url(#r)">\n'
        f'    <rect width="{left_w}" height="24" fill="#0f172a"/>\n'
        f'    <rect x="{left_w}" width="{right_w}" height="24" fill="{grade_color}"/>\n'
        f'    <rect width="{total_w}" height="24" fill="url(#g)"/>\n'
        f"  </g>\n"
        f'  <g fill="#f8fafc" text-anchor="middle" '
        f'font-family="Verdana,Geneva,sans-serif" font-size="11" font-weight="bold">\n'
        f'    <text x="{left_w / 2:.1f}" y="16">{left_txt}</text>\n'
        f'    <text x="{left_w + right_w / 2:.1f}" y="16" fill="#07111a">{right_txt}</text>\n'
        f"  </g>\n"
        f"</svg>\n"
    )


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def capture_postcard_png(static_dir: Path, dest_png: Path) -> Path:
    """Serve `static_dir` briefly and capture a Playwright PNG City Postcard."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright is required to capture City Postcard PNGs.") from exc

    handler = functools.partial(_QuietHandler, directory=str(static_dir))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{port}/index.html?postcard=1"
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                try:
                    page = browser.new_page(viewport={"width": 1280, "height": 760})
                    page.goto(url, wait_until="domcontentloaded")
                    page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=25000)
                    page.wait_for_timeout(1200)
                    page.screenshot(path=str(dest_png))
                finally:
                    browser.close()
        finally:
            httpd.shutdown()
            thread.join(timeout=5)
    return dest_png


def export_static_site(
    lake: LakehouseManager,
    owner: str,
    repo: str,
    output_dir: Path,
    *,
    open_con: Callable[[], AbstractContextManager[duckdb.DuckDBPyConnection]] | None = None,
    with_postcard: bool = False,
    frontend_dist: Path | None = None,
) -> ExportResult:
    """Package React studio + DuckDB-Wasm + Parquet data into a zero-backend static bundle."""
    out = output_dir.resolve()
    protected = {Path("/"), Path.home().resolve(), Path.cwd().resolve(), lake.data_dir.resolve()}
    if any(p == out or p.is_relative_to(out) for p in protected):
        raise ValueError(f"Refusing to overwrite protected directory: {out}")

    dist_dir = _ensure_frontend_dist(frontend_dist)
    con_ctx = open_con() if open_con is not None else lake.session(read_only=True)
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=".codecity_stage_", dir=out.parent) as td:
        stage_root = Path(td)
        pq_dir = stage_root / "parquet"
        with con_ctx as db_con:
            matched = lake.get_repo(db_con, owner, repo)
            if matched is None:
                raise KeyError(f"Repository not found: {owner}/{repo}")
            lake.export_repo_parquet(db_con, owner, repo, pq_dir)

        bundle_dir = stage_root / "bundle"
        shutil.copytree(dist_dir, bundle_dir)
        data_dir = bundle_dir / "data"
        shutil.rmtree(data_dir, ignore_errors=True)
        shutil.move(str(pq_dir), str(data_dir))

        manifest = {
            "mode": "static",
            "owner": owner,
            "repo": repo,
            "source": matched.repo_url_or_path,
            "generated_at": datetime.now(UTC).isoformat(),
        }
        (data_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        (bundle_dir / "badge.svg").write_text(
            render_grade_badge_svg(matched.latest_grade, matched.latest_title, owner, repo),
            encoding="utf-8",
        )
        if with_postcard:
            capture_postcard_png(bundle_dir, bundle_dir / "city-postcard.png")

        if out.exists():
            shutil.rmtree(out)
        shutil.move(str(bundle_dir), str(out))

    return ExportResult(
        output_dir=out,
        manifest_path=out / "data" / "manifest.json",
        badge_path=out / "badge.svg",
        postcard_path=(out / "city-postcard.png") if with_postcard else None,
    )
