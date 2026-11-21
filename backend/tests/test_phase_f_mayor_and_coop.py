"""Phase F tests: Live Mayor safe Git branch execution & Quack multiplayer sandbox sync."""

from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from codecity.analyzer.pipeline import analyze_repository
from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
from tests.test_phase1_polyglot_analyzer import _create_polyglot_fixture_repo


def test_live_mayor_safe_branch_execution_and_quack_sandbox_coop(tmp_path: Path) -> None:
    repo_dir = tmp_path / "poly-city"
    _create_polyglot_fixture_repo(repo_dir)
    # Add an unused dead Python module so bulldozer test can safely remove it
    (repo_dir / "core" / "dead_module.py").write_text("def unused_helper() -> int:\n    return 0\n")
    subprocess.run(["git", "-C", str(repo_dir), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repo_dir),
            "-c",
            "user.name=Dev1",
            "-c",
            "user.email=dev1@example.com",
            "commit",
            "-m",
            "chore: add dead module",
        ],
        check=True,
    )

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    analyze_repository(
        str(repo_dir),
        lakehouse=lake,
        owner="acme",
        repo="poly-city",
        max_keyframes=4,
        workers=2,
    )

    app = create_app(lakehouse=lake, enable_quack=True)
    with TestClient(app) as client:
        # 1. Authors endpoint for Bus Factor Vacation disaster
        authors_resp = client.get("/api/repos/acme/poly_city/authors")
        assert authors_resp.status_code == 200
        authors = authors_resp.json()
        assert len(authors) >= 1
        assert any("api/routes.py" in a["sole_files"] or len(a["sole_files"]) >= 1 for a in authors)

        # 2. Start Live Mayor session -> switches cleanly onto `codecity/mayor-session`
        sess = client.post("/api/repos/acme/poly_city/mayor/session")
        assert sess.status_code == 200
        assert sess.json()["branch"] == "codecity/mayor-session"

        # 3. Sweeper executes ruff --fix + format and commits on `codecity/mayor-session`
        sweep = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "sweeper", "target_path": "api/routes.py"},
        )
        assert sweep.status_code == 200
        sdata = sweep.json()
        assert sdata["branch"] == "codecity/mayor-session"
        assert sdata["committed"] is True

        # 4. Proving Park scaffolds starter test file
        park = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "proving_park", "target_path": "core/engine.py"},
        )
        assert park.status_code == 200
        assert (repo_dir / park.json()["target_path"]).exists()

        # 5. Co-Maintainer updates .github/CODEOWNERS
        owners = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "co_maintainer", "target_path": "api/routes.py"},
        )
        assert owners.status_code == 200
        assert (repo_dir / ".github" / "CODEOWNERS").exists()

        # 6. Bulldozer dead-code safety guard rejects fan_in > 0 or confirm=False
        bad_doze = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={
                "tool": "bulldozer",
                "target_path": "core/engine.py",
                "fan_in": 2,
                "confirm": True,
            },
        )
        assert bad_doze.status_code == 400

        good_doze = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={
                "tool": "bulldozer",
                "target_path": "core/dead_module.py",
                "fan_in": 0,
                "confirm": True,
            },
        )
        assert good_doze.status_code == 200
        assert not (repo_dir / "core" / "dead_module.py").exists()

        status = client.get("/api/repos/acme/poly_city/mayor/status").json()
        assert status["is_mayor_branch"] is True
        assert len(status["recent_commits"]) >= 4

        # 7. Multiplayer Sandbox Co-Op sync via Quack + DuckLake Data Inlining + table_changes()
        sbx_post = client.post(
            "/api/repos/acme/poly_city/sandbox-actions",
            json={
                "author": "teammate-ada",
                "tool": "sweeper",
                "target_path": "api/routes.py",
                "district_path": "api",
                "summary": "Cleaned unused import",
                "velocity_cost": 10,
            },
        )
        assert sbx_post.status_code == 200
        action_id = sbx_post.json()["action_id"]

        sbx_list = client.get("/api/repos/acme/poly_city/sandbox-actions").json()
        assert len(sbx_list) == 1
        assert sbx_list[0]["author"] == "teammate-ada"

        tog = client.post(
            f"/api/repos/acme/poly_city/sandbox-actions/{action_id}/toggle",
            json={"active": False},
        )
        assert tog.status_code == 200

        changes = client.get("/api/repos/acme/poly_city/sandbox-actions/changes").json()
        assert len(changes) >= 1
        assert any(c["action_id"] == action_id for c in changes)
