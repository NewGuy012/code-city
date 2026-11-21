"""Playwright E2E Studio verification against live FastAPI + Quack + DuckDB-Wasm."""

from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import httpx
import uvicorn
from playwright.sync_api import Page, sync_playwright

from codecity.analyzer.pipeline import analyze_repository
from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
from tests.conftest import create_polyglot_fixture_repo


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _assert_no_hud_overlap(page: Page) -> None:
    """Assert visible persistent HUD regions never overlap each other."""
    selectors = [
        '[data-testid="repo-switcher-btn"]',
        '[data-testid="datamap-bar"], [data-testid="datamap-dropdown-btn"]',
        '[data-testid="economy-bar"]',
        '[data-testid="mayor-toolbar"]',
        '[data-testid="inspector-drawer"]',
        '[data-testid="onboarding-tour"]',
        '[data-testid="time-scrubber"]',
        '[data-testid="camera-controls-hud"]',
        '[data-testid="minimap-radar"]',
    ]
    overlaps = page.evaluate(
        """(sels) => {
          const boxes = [];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            boxes.push({
              sel,
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            });
          }
          const hits = [];
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i];
              const b = boxes[j];
              const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (xOverlap > 1 && yOverlap > 1) {
                hits.push(`${a.sel} overlaps ${b.sel}`);
              }
            }
          }
          return hits;
        }""",
        selectors,
    )
    assert overlaps == [], f"HUD overlap detected: {overlaps}"


def test_live_studio_e2e_2d_datamaps_tour_notes_3d_timescrub_and_quack(tmp_path: Path) -> None:
    repo_dir = create_polyglot_fixture_repo(tmp_path / "poly-city")

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
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base_url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            if httpx.get(f"{base_url}/api/health", timeout=1.0).status_code == 200:
                break
        except Exception:
            time.sleep(0.1)

    try:
        assert httpx.get(f"{base_url}/sprites/buildings_atlas.png", timeout=2.0).status_code == 200
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
            _assert_no_hud_overlap(page)

            # Repo & Analyze popover works cleanly
            page.click('[data-testid="repo-switcher-btn"]')
            page.wait_for_selector('[data-testid="repo-analyze-popover"]', timeout=5000)
            page.keyboard.press("Escape")

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

            # Start Tour via Utilities menu and inspect building tabs + notes
            page.click('[data-testid="utilities-menu-btn"]')
            page.click('[data-testid="start-tour-btn"]')
            page.wait_for_selector('[data-testid="onboarding-tour"]', timeout=10000)
            page.wait_for_selector('[data-testid="inspector-drawer"]', timeout=10000)
            _assert_no_hud_overlap(page)

            page.click('[data-testid="inspector-tab-coupling"]')
            page.click('[data-testid="inspector-tab-notes"]')
            page.fill('[data-testid="mayor-note-input"]', "E2E verified Mayor refactor note")
            page.click('[data-testid="mayor-note-submit"]')
            page.wait_for_timeout(500)
            assert "E2E verified Mayor refactor note" in page.inner_text(
                '[data-testid="inspector-drawer"]'
            )

            # Expand collapsible TimeScrubber pill & scrub to Snapshot 1
            page.click('[data-testid="time-expand-btn"]')
            slider = page.locator('[data-testid="time-slider"]')
            slider.fill("0")
            slider.dispatch_event("change")
            page.wait_for_timeout(350)
            assert "Snapshot 1/" in page.inner_text('[data-testid="time-scrubber"]')
            _assert_no_hud_overlap(page)
            page.click('[data-testid="time-collapse-btn"]')

            # Toggle 2D <-> 3D in bottom-right viewport cluster
            page.click('[data-testid="toggle-2d-3d"]')
            page.wait_for_selector('[data-testid="city-canvas-3d"]', timeout=15000)
            page.wait_for_timeout(350)
            page.click('[data-testid="toggle-2d-3d"]')
            page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=10000)

            # Open Health Report via clickable Grade badge
            page.click('[data-testid="city-grade-badge"]')
            page.wait_for_selector('[data-testid="health-modal"]', timeout=10000)
            page.click('[data-testid="tab-quack-cli"]')
            assert "ATTACH 'quack:" in page.inner_text('[data-testid="health-modal"]')

            page.click('[data-testid="tab-table-changes"]')
            page.wait_for_timeout(400)
            assert "E2E verified Mayor refactor note" in page.inner_text(
                '[data-testid="health-modal"]'
            )
            page.click('[data-testid="health-modal"] button[title="Close report"]')

            # Camera View popover + collapsible Radar minimap
            page.wait_for_selector('[data-testid="camera-controls-hud"]', timeout=5000)
            assert page.locator('[data-testid="minimap-radar"]').count() == 0
            page.click('[data-testid="toggle-radar-btn"]')
            page.wait_for_selector('[data-testid="minimap-radar"]', timeout=5000)
            _assert_no_hud_overlap(page)

            # Verify zero overlap on tighter 1024x700 viewport with Tour + Inspector + Radar
            page.set_viewport_size({"width": 1024, "height": 700})
            page.wait_for_timeout(150)
            _assert_no_hud_overlap(page)
            page.set_viewport_size({"width": 1360, "height": 840})

            page.click('[data-testid="camera-view-btn"]')
            page.wait_for_selector('[data-testid="camera-view-popover"]', timeout=5000)
            page.click('[data-testid="rotate-cw-btn"]')
            page.wait_for_timeout(450)
            assert page.inner_text('[data-testid="compass-rose-btn"]').strip() == "E"
            page.click('[data-testid="time-of-day-golden"]')
            page.click('[data-testid="cam-preset-4"]')
            page.keyboard.press("Escape")

            # Economy bar, Advisors Quick-Peek popover -> SQL Quests modal, Disasters
            page.wait_for_selector('[data-testid="economy-bar"]', timeout=5000)
            page.click('[data-testid="sim-speed-2"]')
            page.click('[data-testid="advisors-menu-btn"]')
            page.wait_for_selector('[data-testid="advisors-popover"]', timeout=5000)
            page.click('[data-testid="open-advisors-btn"]')
            page.wait_for_selector('[data-testid="advisor-council-modal"]', timeout=5000)
            assert "Clear Air Act" in page.inner_text('[data-testid="advisor-council-modal"]')
            page.click('[data-testid="advisor-council-modal"] button[title="Close advisors"]')

            page.click('[data-testid="open-disasters-btn"]')
            page.wait_for_selector('[data-testid="disasters-modal"]', timeout=5000)
            page.click('[data-testid="disaster-crunch-storm"]')
            page.wait_for_selector('[data-testid="active-disaster-banner"]', timeout=5000)

            # Active tool chip & Escape reset + Zen Mode toggle
            page.click('[data-testid="tool-sweeper"]')
            page.wait_for_selector('[data-testid="active-tool-chip"]', timeout=5000)
            page.keyboard.press("Escape")
            assert page.locator('[data-testid="active-tool-chip"]').count() == 0

            page.keyboard.press("h")
            page.wait_for_selector('[data-testid="exit-zen-btn"]', timeout=5000)
            assert page.locator('[data-testid="mayor-toolbar"]').count() == 0
            page.click('[data-testid="exit-zen-btn"]')
            page.wait_for_selector('[data-testid="mayor-toolbar"]', timeout=5000)

            page.click('[data-testid="export-blueprint-btn"]')
            page.wait_for_selector('[data-testid="blueprint-modal"]', timeout=5000)
            assert "Mayor's Refactor Blueprint" in page.inner_text(
                '[data-testid="blueprint-modal"]'
            )

            assert page_errors == [], f"Unexpected browser page errors: {page_errors}"
            browser.close()
    finally:
        server.should_exit = True
        thread.join(timeout=5)
