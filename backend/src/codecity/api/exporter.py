"""Zero-backend static OSS report exporter, SVG badge maker, and Playwright PNG postcard."""

from __future__ import annotations

import functools
import html
import http.server
import json
import shutil
import socketserver
import subprocess
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from codecity.storage.lakehouse import LakehouseManager
from codecity.storage.queries import query_health_report, query_snapshots


@dataclass
class ExportResult:
    """Paths produced by exporting a static CodeCity OSS report."""

    output_dir: Path
    manifest_path: Path
    badge_path: Path
    postcard_path: Path | None = None


def _default_frontend_dist() -> Path:
    return Path(__file__).resolve().parents[4] / "frontend" / "dist"


def _ensure_frontend_dist(frontend_dist: Path | None) -> Path:
    dist_dir = (frontend_dist or _default_frontend_dist()).resolve()
    if (dist_dir / "index.html").exists():
        return dist_dir
    frontend_root = dist_dir.parent
    bun_bin = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun")
    subprocess.run([bun_bin, "run", "build"], cwd=frontend_root, check=True)
    return dist_dir


def render_grade_badge_svg(grade: str, title: str, owner: str, repo: str) -> str:
    """Render a crisp Shields-style SVG README badge for the repository's City Grade."""
    grade_color = (
        "#10b981" if grade.startswith("A") else "#f59e0b" if grade.startswith("B") else "#ef4444"
    )
    left_txt = html.escape(f"CodeCity · {owner}/{repo}")
    right_txt = html.escape(f"{grade} · {title}")
    left_w = max(110, len(left_txt) * 7 + 18)
    right_w = max(140, len(right_txt) * 7 + 18)
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
    from playwright.sync_api import sync_playwright

    handler = functools.partial(_QuietHandler, directory=str(static_dir))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{port}/index.html"
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                page = browser.new_page(viewport={"width": 1280, "height": 760})
                page.goto(url, wait_until="domcontentloaded")
                page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=25000)
                page.wait_for_timeout(1200)
                page.screenshot(path=str(dest_png))
                browser.close()
        finally:
            httpd.shutdown()
    return dest_png


def export_static_site(
    lake: LakehouseManager,
    owner: str,
    repo: str,
    output_dir: Path,
    *,
    con: duckdb.DuckDBPyConnection | None = None,
    with_postcard: bool = False,
    frontend_dist: Path | None = None,
) -> ExportResult:
    """Package React studio + DuckDB-Wasm + Parquet data into a zero-backend static bundle."""
    out = output_dir.resolve()
    dist_dir = _ensure_frontend_dist(frontend_dist)

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(dist_dir, out)

    data_dir = out / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    def _run_with_con(db_con: duckdb.DuckDBPyConnection) -> dict[str, object]:
        lake.export_repo_parquet(db_con, owner, repo, data_dir)
        snaps = query_snapshots(db_con, lake, owner, repo)
        latest_idx = snaps[-1].snapshot_idx if snaps else 0
        report = query_health_report(db_con, lake, owner, repo, latest_idx)
        repos = lake.list_repos(db_con)
        matched = next((r for r in repos if r.owner == owner and r.repo == repo), None)
        return {
            "report": report,
            "source": matched.repo_url_or_path if matched else f"{owner}/{repo}",
        }

    if con is not None:
        info = _run_with_con(con)
    else:
        with lake.session(read_only=True) as local_con:
            info = _run_with_con(local_con)

    manifest = {
        "mode": "static",
        "owner": owner,
        "repo": repo,
        "source": info["source"],
        "generated_at": datetime.now(UTC).isoformat(),
    }
    manifest_path = data_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    report = info["report"]
    assert isinstance(report, dict)
    badge_svg = render_grade_badge_svg(
        str(report["health_grade"]),
        str(report["city_archetype_title"]),
        owner,
        repo,
    )
    badge_path = out / "badge.svg"
    badge_path.write_text(badge_svg, encoding="utf-8")

    postcard_path: Path | None = None
    if with_postcard:
        postcard_path = capture_postcard_png(out, out / "city-postcard.png")

    return ExportResult(
        output_dir=out,
        manifest_path=manifest_path,
        badge_path=badge_path,
        postcard_path=postcard_path,
    )
