"""Phase 6 E2E Playwright Studio verification against live FastAPI + Quack + DuckDB-Wasm."""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import uvicorn
from playwright.sync_api import sync_playwright

from codecity.analyzer.pipeline import analyze_repository
from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
from tests.test_phase1_polyglot_analyzer import _create_polyglot_fixture_repo


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_live_studio_e2e_2d_datamaps_tour_notes_3d_timescrub_and_quack(tmp_path: Path) -> None:
    repo_dir = tmp_path / "poly-city"
    _create_polyglot_fixture_repo(repo_dir)

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    analyze_repository(
        str(repo_dir),
        lakehouse=lake,
        owner="acme",
        repo="poly-city",
        max_keyframes=6,
        workers=2,
    )

    port = _free_port()
    app = create_app(lakehouse=lake, enable_quack=True)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait until uvicorn + Quack lifespan are ready
    import httpx

    base_url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            r = httpx.get(f"{base_url}/api/health", timeout=1.0)
            if r.status_code == 200:
                break
        except Exception:
            time.sleep(0.1)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--use-angle=swiftshader"],
            )
            page = browser.new_page(viewport={"width": 1360, "height": 840})
            page_errors: list[str] = []
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            page.goto(base_url, wait_until="domcontentloaded")
            page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=25000)
            page.wait_for_selector('[data-testid="city-grade-badge"]', timeout=15000)

            # 1. Switch SimCity Data Maps
            for mode in (
                "hotspots",
                "pollution",
                "bus_factor",
                "languages",
                "format_drift",
                "living",
            ):
                page.click(f'[data-testid="datamap-{mode}"]')
                page.wait_for_timeout(120)

            # 2. Launch Mayor's Guided Tour -> opens Tour overlay + Building Blueprint Inspector
            page.click('[data-testid="start-tour-btn"]')
            page.wait_for_selector('[data-testid="onboarding-tour"]', timeout=10000)
            page.wait_for_selector('[data-testid="inspector-drawer"]', timeout=10000)

            # 3. Drop a collaborative Mayor Note over Quack into DuckLake
            page.fill('[data-testid="mayor-note-input"]', "E2E verified Mayor refactor note")
            page.click('[data-testid="mayor-note-submit"]')
            page.wait_for_timeout(500)
            assert "E2E verified Mayor refactor note" in page.inner_text(
                '[data-testid="inspector-drawer"]'
            )

            # 4. Scrub Time-Machine Slider back to snapshot 0
            slider = page.locator('[data-testid="time-slider"]')
            slider.fill("0")
            slider.dispatch_event("change")
            page.wait_for_timeout(350)
            assert "Snapshot 1/" in page.inner_text('[data-testid="time-scrubber"]')

            # 5. Toggle 2D <-> 3D lazy skyline view and back to 2D
            page.click('[data-testid="toggle-2d-3d"]')
            page.wait_for_selector('[data-testid="city-canvas-3d"]', timeout=15000)
            page.wait_for_timeout(350)
            page.click('[data-testid="toggle-2d-3d"]')
            page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=10000)

            # 6. Open City Report modal -> verify Quack CLI snippet & table_changes Mayor Feed
            page.click('[data-testid="open-health-btn"]')
            page.wait_for_selector('[data-testid="health-modal"]', timeout=10000)
            page.click('[data-testid="tab-quack-cli"]')
            assert "ATTACH 'quack:" in page.inner_text('[data-testid="health-modal"]')

            page.click('[data-testid="tab-table-changes"]')
            page.wait_for_timeout(400)
            assert "E2E verified Mayor refactor note" in page.inner_text(
                '[data-testid="health-modal"]'
            )

            assert page_errors == [], f"Unexpected browser page errors: {page_errors}"
            browser.close()
    finally:
        server.should_exit = True
        thread.join(timeout=5)
