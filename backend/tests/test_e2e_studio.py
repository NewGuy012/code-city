"""Playwright E2E Studio verification against live FastAPI + Quack + DuckDB-Wasm."""

from __future__ import annotations

import threading
import time
import urllib.request
from pathlib import Path

import uvicorn
from playwright.sync_api import Page, expect, sync_playwright

from codecity.analyzer.pipeline import analyze_repository
from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
from codecity.storage.quack_server import _pick_free_port
from tests.conftest import create_polyglot_fixture_repo


def _assert_no_hud_overlap(page: Page) -> None:
    """Assert visible persistent HUD regions never overlap each other."""
    selectors = [
        '[data-testid="repo-switcher-btn"]',
        '[data-testid="datamap-bar"], [data-testid="datamap-dropdown-btn"]',
        '[data-testid="economy-bar"]',
        '[data-testid="mode-utilities-bar"]',
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


def _assert_hud_within_viewport(page: Page, selectors: list[str]) -> None:
    """Assert every targeted HUD control/overlay lies completely inside viewport bounds."""
    out_of_bounds = page.evaluate(
        """(sels) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const issues = [];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) {
              issues.push(`${sel} missing`);
              continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) {
              issues.push(`${sel} zero-sized`);
              continue;
            }
            if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
              const box = `${r.left.toFixed(1)},${r.top.toFixed(1)},` +
                `${r.right.toFixed(1)},${r.bottom.toFixed(1)}`;
              issues.push(`${sel} out of bounds (${box}) vs ${vw}x${vh}`);
            }
          }
          return issues;
        }""",
        selectors,
    )
    assert out_of_bounds == [], f"HUD cutoff detected: {out_of_bounds}"


def _assert_zero_idle_raf(page: Page, mode_label: str) -> None:
    """Assert the canvas schedules zero requestAnimationFrame callbacks while idle."""
    idle_raf = page.evaluate(
        """() => new Promise((resolve) => {
          let count = 0;
          const orig = window.requestAnimationFrame;
          window.requestAnimationFrame = (cb) => {
            count++;
            return orig.call(window, cb);
          };
          setTimeout(() => {
            window.requestAnimationFrame = orig;
            resolve(count);
          }, 300);
        })"""
    )
    assert idle_raf == 0, f"Expected 0 idle RAF calls in {mode_label}, got {idle_raf}"


def _assert_drag_rotation(
    page: Page,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    reset_key: str,
    *,
    alt: bool = False,
) -> None:
    """Drag to rotate (yaw+pitch on left-drag, yaw-only with Alt held), then reset."""
    if alt:
        page.keyboard.down("Alt")
    try:
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=6)
        page.mouse.up()
    finally:
        if alt:
            page.keyboard.up("Alt")

    page.click('[data-testid="camera-view-btn"]')
    page.wait_for_selector('[data-testid="camera-view-popover"]', timeout=5000)
    expect(page.locator('[data-testid="yaw-reset-btn"]')).not_to_have_text("45°", timeout=3000)
    if alt:
        expect(page.locator('[data-testid="pitch-reset-btn"]')).to_have_text("35°", timeout=3000)
    else:
        expect(page.locator('[data-testid="pitch-reset-btn"]')).not_to_have_text(
            "35°", timeout=3000
        )
    page.keyboard.press(reset_key)
    expect(page.locator('[data-testid="yaw-reset-btn"]')).to_have_text("45°", timeout=3000)
    expect(page.locator('[data-testid="pitch-reset-btn"]')).to_have_text("35°", timeout=3000)
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)


_EXPLORE_HUD_SELECTORS = [
    '[data-testid="repo-switcher-btn"]',
    '[data-testid="datamap-dropdown-btn"]',
    '[data-testid="mode-toggle"]',
    '[data-testid="utilities-menu-btn"]',
    '[data-testid="time-scrubber"]',
    '[data-testid="camera-controls-hud"]',
    '[data-testid="camera-view-btn"]',
    '[data-testid="toggle-radar-btn"]',
]


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

    port = _pick_free_port()
    app = create_app(lakehouse=lake, enable_quack=True)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base_url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            with urllib.request.urlopen(f"{base_url}/api/health", timeout=1.0) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.1)

    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=2.0) as r:
            assert r.status == 200
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--use-angle=swiftshader"],
            )
            try:
                page = browser.new_page(viewport={"width": 1360, "height": 840})
                page_errors: list[str] = []
                page.on("pageerror", lambda err: page_errors.append(str(err)))

                page.goto(base_url, wait_until="domcontentloaded")
                page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=25000)
                page.wait_for_selector('[data-testid="city-grade-badge"]', timeout=15000)

                # Mayor's Welcome Briefing auto-opens on initial visit and dismisses cleanly
                page.wait_for_selector('[data-testid="mayor-welcome-modal"]', timeout=10000)
                welcome_txt = page.inner_text('[data-testid="mayor-welcome-modal"]')
                assert "A QUICK HELLO FROM THE MAYOR" in welcome_txt.upper()
                assert page.locator('[data-testid="welcome-start-card"]').count() >= 1
                page.click('[data-testid="welcome-explore-btn"]')
                expect(page.locator('[data-testid="mayor-welcome-modal"]')).to_have_count(0)

                # Dismissal persists across page reload
                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=25000)
                page.wait_for_selector('[data-testid="city-grade-badge"]', timeout=15000)
                page.wait_for_timeout(200)
                expect(page.locator('[data-testid="mayor-welcome-modal"]')).to_have_count(0)

                # Default boot is Explore Mode (economy & mayor tools hidden; utilities accessible)
                expect(page.locator('[data-testid="mode-toggle-explore"]')).to_have_attribute(
                    "aria-pressed", "true"
                )
                expect(page.locator('[data-testid="economy-bar"]')).to_have_count(0)
                expect(page.locator('[data-testid="mayor-toolbar"]')).to_have_count(0)
                expect(page.locator('[data-testid="utilities-menu-btn"]')).to_be_visible()
                _assert_no_hud_overlap(page)

                # Verify 2D canvas settles to 0 FPS when idle (demand-driven rendering)
                page.wait_for_timeout(250)
                _assert_zero_idle_raf(page, "2D")

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

                # Reopen Mayor's Welcome Briefing from Utilities menu and pick a starting building
                page.click('[data-testid="utilities-menu-btn"]')
                page.click('[data-testid="open-welcome-btn"]')
                page.wait_for_selector('[data-testid="mayor-welcome-modal"]', timeout=5000)
                page.locator('[data-testid="welcome-start-card"]').nth(1).click()
                expect(page.locator('[data-testid="mayor-welcome-modal"]')).to_have_count(0)
                page.wait_for_selector('[data-testid="inspector-drawer"]', timeout=10000)

                # Collapsible Detailed Description & Explore Code both start collapsed by default
                page.wait_for_selector('[data-testid="building-summary-card"]', timeout=5000)
                expect(page.locator('[data-testid="building-details-toggle"]')).to_have_attribute(
                    "aria-expanded", "false"
                )
                expect(page.locator('[data-testid="building-code-toggle"]')).to_have_attribute(
                    "aria-expanded", "false"
                )
                page.click('[data-testid="building-details-toggle"]')
                expect(page.locator('[data-testid="building-details-toggle"]')).to_have_attribute(
                    "aria-expanded", "true"
                )
                page.wait_for_selector('[data-testid="building-details-content"]', timeout=5000)

                sym_btns = page.locator('[data-testid^="symbol-jump-"]')
                if sym_btns.count() > 0:
                    sym_btns.first.click()
                else:
                    page.click('[data-testid="building-code-toggle"]')
                expect(page.locator('[data-testid="building-code-toggle"]')).to_have_attribute(
                    "aria-expanded", "true"
                )
                page.wait_for_selector('[data-testid="building-code-content"]', timeout=5000)
                page.wait_for_selector('[data-testid="code-fullscreen-btn"]', timeout=8000)
                _assert_no_hud_overlap(page)

                page.click('[data-testid="code-fullscreen-btn"]')
                page.wait_for_selector('[data-testid="code-fullscreen-modal"]', timeout=5000)
                page.click('[data-testid="code-fullscreen-modal-close"]')
                expect(page.locator('[data-testid="code-fullscreen-modal"]')).to_have_count(0)

                # Start Tour via Utilities menu and inspect building tabs + notes (collapses reset)
                page.click('[data-testid="utilities-menu-btn"]')
                page.click('[data-testid="start-tour-btn"]')
                page.wait_for_selector('[data-testid="onboarding-tour"]', timeout=10000)
                page.wait_for_selector('[data-testid="inspector-drawer"]', timeout=10000)
                expect(page.locator('[data-testid="building-details-toggle"]')).to_have_attribute(
                    "aria-expanded", "false"
                )
                expect(page.locator('[data-testid="building-code-toggle"]')).to_have_attribute(
                    "aria-expanded", "false"
                )
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

                # Toggle 2D <-> 3D in bottom-right viewport cluster and verify 3D hover + selection
                page.click('[data-testid="inspector-drawer"] button[title="Close inspector"]')
                page.click('[data-testid="toggle-2d-3d"]')
                page.wait_for_selector('[data-testid="city-canvas-3d"]', timeout=15000)
                page.wait_for_timeout(600)
                _assert_zero_idle_raf(page, "3D")

                hit_pt = None
                for gx in (480, 560, 640, 720, 800):
                    for gy in (340, 420, 500):
                        page.mouse.move(gx, gy)
                        page.wait_for_timeout(60)
                        if page.locator('[data-testid="building-tooltip"]').count() > 0:
                            hit_pt = (gx, gy)
                            break
                    if hit_pt is not None:
                        break
                assert hit_pt is not None, "Expected 3D hover tooltip on city buildings"
                tooltip_txt = page.inner_text('[data-testid="building-tooltip"]')
                assert "SLOC" in tooltip_txt
                hovered_file = tooltip_txt.splitlines()[0].strip()

                page.mouse.click(*hit_pt)
                page.wait_for_selector('[data-testid="inspector-drawer"]', timeout=5000)
                assert hovered_file in page.inner_text('[data-testid="inspector-drawer"]')

                # Clicking empty harbor water deselects the building
                page.mouse.click(200, 200)
                page.wait_for_timeout(150)
                assert page.locator('[data-testid="inspector-drawer"]').count() == 0

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

                # Verify HUD auto-scales cleanly at zoomed 640x380 viewport in Explore & Play modes
                page.set_viewport_size({"width": 640, "height": 380})
                page.wait_for_timeout(150)
                _assert_no_hud_overlap(page)
                _assert_hud_within_viewport(page, _EXPLORE_HUD_SELECTORS)
                page.click('[data-testid="mode-toggle-play"]')
                page.wait_for_selector('[data-testid="economy-bar"]', timeout=5000)
                _assert_no_hud_overlap(page)
                _assert_hud_within_viewport(
                    page,
                    [
                        *_EXPLORE_HUD_SELECTORS[:6],
                        '[data-testid="economy-bar"]',
                        '[data-testid="open-disasters-btn"]',
                        '[data-testid="mayor-toolbar"]',
                        '[data-testid="export-blueprint-btn"]',
                    ],
                )
                page.click('[data-testid="camera-view-btn"]')
                page.wait_for_selector('[data-testid="camera-view-popover"]', timeout=5000)
                _assert_hud_within_viewport(page, ['[data-testid="camera-view-popover"]'])
                page.keyboard.press("Escape")
                page.click('[data-testid="mode-toggle-explore"]')
                expect(page.locator('[data-testid="economy-bar"]')).to_have_count(0)

                page.set_viewport_size({"width": 1360, "height": 840})

                page.click('[data-testid="camera-view-btn"]')
                page.wait_for_selector('[data-testid="camera-view-popover"]', timeout=5000)
                expect(page.locator('[data-testid="toggle-traffic-btn"]')).to_have_attribute(
                    "aria-pressed", "false"
                )
                page.click('[data-testid="rotate-cw-btn"]')
                expect(page.locator('[data-testid="compass-rose-btn"]')).to_have_text(
                    "E", timeout=3000
                )

                # Orientation Yaw & Pitch sliders (Roll removed) + quick axis options + shortcuts
                expect(page.locator('[data-testid="roll-slider"]')).to_have_count(0)
                expect(page.locator('[data-testid="roll-reset-btn"]')).to_have_count(0)
                expect(page.locator('[data-testid="orient-opt-level"]')).to_have_count(0)
                expect(page.locator('[data-testid="yaw-drag-hint"]')).to_have_text(
                    "Alt / Opt + Drag"
                )

                page.locator('[data-testid="yaw-slider"]').fill("225")
                page.locator('[data-testid="yaw-slider"]').dispatch_event("change")
                expect(page.locator('[data-testid="compass-rose-btn"]')).to_have_text(
                    "S", timeout=3000
                )

                page.click('[data-testid="orient-opt-top"]')
                expect(page.locator('[data-testid="pitch-reset-btn"]')).to_have_text(
                    "85°", timeout=3000
                )

                page.keyboard.press("n")
                expect(page.locator('[data-testid="compass-rose-btn"]')).to_have_text(
                    "N", timeout=3000
                )

                page.keyboard.press("t")
                expect(page.locator('[data-testid="pitch-reset-btn"]')).to_have_text(
                    "35°", timeout=3000
                )

                page.click('[data-testid="orient-opt-low"]')
                expect(page.locator('[data-testid="pitch-reset-btn"]')).to_have_text(
                    "15°", timeout=3000
                )

                page.keyboard.press("x")
                expect(page.locator('[data-testid="yaw-reset-btn"]')).to_have_text(
                    "45°", timeout=3000
                )
                expect(page.locator('[data-testid="pitch-reset-btn"]')).to_have_text(
                    "35°", timeout=3000
                )

                # Left-drag rotates yaw+pitch and Alt + Left-drag rotates yaw only in both 2D and 3D
                page.keyboard.press("Escape")
                page.wait_for_timeout(120)
                _assert_drag_rotation(page, 680, 420, 840, 500, "x", alt=False)
                _assert_drag_rotation(page, 680, 420, 840, 460, "x", alt=True)

                page.click('[data-testid="toggle-2d-3d"]')
                page.wait_for_selector('[data-testid="city-canvas-3d"]', timeout=10000)
                _assert_drag_rotation(page, 680, 420, 520, 500, "Shift+X", alt=False)
                _assert_drag_rotation(page, 680, 420, 520, 500, "Shift+X", alt=True)

                page.click('[data-testid="toggle-2d-3d"]')
                page.wait_for_selector('[data-testid="city-canvas-2d"]', timeout=5000)

                page.click('[data-testid="camera-view-btn"]')
                page.wait_for_selector('[data-testid="camera-view-popover"]', timeout=5000)
                page.click('[data-testid="time-of-day-golden"]')
                page.click('[data-testid="cam-preset-4"]')
                page.keyboard.press("Escape")

                # Toggle into Game Play Mode and verify Economy bar, Quests, Disasters & Mayor tools
                page.click('[data-testid="mode-toggle-play"]')
                expect(page.locator('[data-testid="mode-toggle-play"]')).to_have_attribute(
                    "aria-pressed", "true"
                )
                page.wait_for_selector('[data-testid="economy-bar"]', timeout=5000)
                page.wait_for_selector('[data-testid="mayor-toolbar"]', timeout=5000)
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
                page.click('[data-testid="blueprint-modal-close"]')
                expect(page.locator('[data-testid="blueprint-modal"]')).to_have_count(0)

                # Toggling back to Explore Mode clears active gameplay overlays and hides HUD
                page.click('[data-testid="tool-sweeper"]')
                page.wait_for_selector('[data-testid="active-tool-chip"]', timeout=5000)
                page.click('[data-testid="mode-toggle-explore"]')
                expect(page.locator('[data-testid="mode-toggle-explore"]')).to_have_attribute(
                    "aria-pressed", "true"
                )
                expect(page.locator('[data-testid="economy-bar"]')).to_have_count(0)
                expect(page.locator('[data-testid="mayor-toolbar"]')).to_have_count(0)
                expect(page.locator('[data-testid="active-tool-chip"]')).to_have_count(0)
                expect(page.locator('[data-testid="active-disaster-banner"]')).to_have_count(0)

                assert page_errors == [], f"Unexpected browser page errors: {page_errors}"
            finally:
                browser.close()
    finally:
        server.should_exit = True
        thread.join(timeout=5)
