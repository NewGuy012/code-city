"""Tests for single-command dev orchestrator, auto-cleanup, browser open, and `codecity stop`."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from codecity import dev_runner
from codecity.cli import _build_parser
from codecity.cli import main as cli_main
from codecity.storage.quack_server import _pick_free_port


def _health_stub_code(
    port: int,
    *,
    exit_after: float | None = None,
    exit_code: int = 0,
    ignore_sigterm: bool = False,
) -> str:
    return f"""
import http.server, signal, socketserver, sys, threading, time
if {ignore_sigterm!r}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{{"status":"ok"}}')
    def log_message(self, *a):
        pass
class S(socketserver.TCPServer):
    allow_reuse_address = True
srv = S(("127.0.0.1", {port}), H)
if not {ignore_sigterm!r}:
    def _stop(*_a):
        threading.Thread(target=srv.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
if {exit_after!r} is not None:
    def _auto():
        time.sleep({exit_after!r})
        srv.shutdown()
    threading.Thread(target=_auto, daemon=True).start()
srv.serve_forever()
srv.server_close()
sys.exit({exit_code})
"""


def _tcp_stub_code(
    port: int,
    *,
    pid_file: Path | None = None,
    grandchild_pid_file: Path | None = None,
    ignore_sigterm: bool = False,
) -> str:
    return f"""
import os, signal, socket, subprocess, sys, time
from pathlib import Path
if {ignore_sigterm!r}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    def _stop(*_a):
        sys.exit(0)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
if {str(pid_file) if pid_file else None!r}:
    Path({str(pid_file) if pid_file else ""!r}).write_text(str(os.getpid()))
if {str(grandchild_pid_file) if grandchild_pid_file else None!r}:
    gc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    Path({str(grandchild_pid_file) if grandchild_pid_file else ""!r}).write_text(str(gc.pid))
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", {port}))
sock.listen(5)
while True:
    time.sleep(0.1)
"""


def _wait_health(port: int, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.05)
    return False


def test_cli_parser_dev_serve_stop_defaults() -> None:
    parser = _build_parser()

    dev_args = parser.parse_args(["dev"])
    assert dev_args.host == "127.0.0.1"
    assert dev_args.port == 8787
    assert dev_args.frontend_port == 5173
    assert dev_args.open is True
    assert dev_args.auto_exit is True
    assert dev_args.auto_exit_grace == 15.0
    assert dev_args.replace is True

    dev_custom = parser.parse_args(
        ["dev", "--no-open", "--no-auto-exit", "--no-replace", "--port", "8899"]
    )
    assert dev_custom.open is False
    assert dev_custom.auto_exit is False
    assert dev_custom.replace is False
    assert dev_custom.port == 8899

    serve_args = parser.parse_args(["serve"])
    assert serve_args.open is False
    assert serve_args.auto_exit is False
    assert serve_args.replace is True

    stop_args = parser.parse_args(["stop", "--force"])
    assert stop_args.force is True


def test_preflight_errors_missing_bun_node_modules_and_foreign_port(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fe_dir = tmp_path / "frontend"
    fe_dir.mkdir()
    (fe_dir / "package.json").write_text('{"name":"test"}\n', encoding="utf-8")

    monkeypatch.setattr(dev_runner, "find_bun", lambda: None)
    rc = dev_runner.run_dev_orchestrator(data_dir=tmp_path / "data", frontend_dir=fe_dir)
    assert rc == 1
    assert "bun" in capsys.readouterr().err.lower()

    monkeypatch.setattr(dev_runner, "find_bun", lambda: "/usr/bin/env")
    rc = dev_runner.run_dev_orchestrator(data_dir=tmp_path / "data", frontend_dir=fe_dir)
    assert rc == 1
    assert "bun install" in capsys.readouterr().err

    # Foreign non-CodeCity listener on target port must NOT be killed
    foreign_port = _pick_free_port()
    free_fe_port = _pick_free_port()
    foreign_proc = subprocess.Popen(
        [sys.executable, "-c", _tcp_stub_code(foreign_port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and dev_runner.is_port_available(
            "127.0.0.1", foreign_port
        ):
            time.sleep(0.05)

        rc = dev_runner.run_dev_orchestrator(
            data_dir=tmp_path / "data",
            port=foreign_port,
            frontend_port=free_fe_port,
            open_browser=False,
            replace=True,
            frontend_dir=fe_dir,
            backend_cmd=[sys.executable, "-c", "import time; time.sleep(10)"],
            frontend_cmd=[sys.executable, "-c", "import time; time.sleep(10)"],
        )
        assert rc == 1
        assert foreign_proc.poll() is None  # Foreign process left untouched
    finally:
        foreign_proc.terminate()
        foreign_proc.wait(timeout=3)


def test_dev_orchestrator_auto_open_and_clean_backend_auto_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api_port = _pick_free_port()
    fe_port = _pick_free_port()
    fe_pid_file = tmp_path / "fe.pid"
    opened_urls: list[str] = []
    monkeypatch.delenv(dev_runner.NO_OPEN_ENV, raising=False)

    rc = dev_runner.run_dev_orchestrator(
        data_dir=tmp_path / "data",
        port=api_port,
        frontend_port=fe_port,
        open_browser=True,
        auto_exit=True,
        replace=False,
        frontend_dir=tmp_path,
        backend_cmd=[sys.executable, "-c", _health_stub_code(api_port, exit_after=0.35)],
        frontend_cmd=[sys.executable, "-c", _tcp_stub_code(fe_port, pid_file=fe_pid_file)],
        browser_opener=opened_urls.append,
    )
    assert rc == 0
    assert opened_urls == [f"http://127.0.0.1:{fe_port}"]
    assert not dev_runner.runtime_state_path(tmp_path / "data").exists()
    fe_pid = int(fe_pid_file.read_text())
    assert not dev_runner._pid_alive(fe_pid)

    # CODECITY_NO_OPEN=1 suppresses browser auto-open
    opened_urls.clear()
    monkeypatch.setenv(dev_runner.NO_OPEN_ENV, "1")
    api_port2 = _pick_free_port()
    fe_port2 = _pick_free_port()
    rc2 = dev_runner.run_dev_orchestrator(
        data_dir=tmp_path / "data2",
        port=api_port2,
        frontend_port=fe_port2,
        open_browser=True,
        replace=False,
        frontend_dir=tmp_path,
        backend_cmd=[sys.executable, "-c", _health_stub_code(api_port2, exit_after=0.25)],
        frontend_cmd=[sys.executable, "-c", _tcp_stub_code(fe_port2)],
        browser_opener=opened_urls.append,
    )
    assert rc2 == 0
    assert opened_urls == []


def test_dev_orchestrator_fail_fast_and_sigkill_escalation(tmp_path: Path) -> None:
    api_port = _pick_free_port()
    fe_port = _pick_free_port()
    fe_pid_file = tmp_path / "stubborn_fe.pid"

    # Backend exits with code 2 after 0.3s; frontend ignores SIGTERM -> escalated to SIGKILL
    rc = dev_runner.run_dev_orchestrator(
        data_dir=tmp_path / "data",
        port=api_port,
        frontend_port=fe_port,
        open_browser=False,
        replace=False,
        grace_timeout=0.4,
        frontend_dir=tmp_path,
        backend_cmd=[
            sys.executable,
            "-c",
            _health_stub_code(api_port, exit_after=0.3, exit_code=2),
        ],
        frontend_cmd=[
            sys.executable,
            "-c",
            _tcp_stub_code(fe_port, pid_file=fe_pid_file, ignore_sigterm=True),
        ],
    )
    assert rc == 2
    assert not dev_runner.runtime_state_path(tmp_path / "data").exists()
    fe_pid = int(fe_pid_file.read_text())
    assert not dev_runner._pid_alive(fe_pid)


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM])
def test_dev_orchestrator_signal_tears_down_process_groups_including_grandchildren(
    tmp_path: Path,
    sig: signal.Signals,
) -> None:
    api_port = _pick_free_port()
    fe_port = _pick_free_port()
    data_dir = tmp_path / "data"
    fe_pid_file = tmp_path / "fe.pid"
    gc_pid_file = tmp_path / "gc.pid"

    fe_stub = _tcp_stub_code(
        fe_port,
        pid_file=fe_pid_file,
        grandchild_pid_file=gc_pid_file,
    )
    runner_script = f"""
from pathlib import Path
import sys
from codecity.dev_runner import run_dev_orchestrator
rc = run_dev_orchestrator(
    data_dir=Path({str(data_dir)!r}),
    port={api_port},
    frontend_port={fe_port},
    open_browser=False,
    replace=False,
    frontend_dir=Path({str(tmp_path)!r}),
    backend_cmd=[sys.executable, "-c", {_health_stub_code(api_port)!r}],
    frontend_cmd=[sys.executable, "-c", {fe_stub!r}],
)
sys.exit(rc)
"""
    proc = subprocess.Popen(
        [sys.executable, "-c", runner_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and not gc_pid_file.exists():
            assert proc.poll() is None, proc.stdout.read() if proc.stdout else ""
            time.sleep(0.05)
        assert gc_pid_file.exists()

        fe_pid = int(fe_pid_file.read_text())
        gc_pid = int(gc_pid_file.read_text())
        assert dev_runner._pid_alive(fe_pid)
        assert dev_runner._pid_alive(gc_pid)

        proc.send_signal(sig)
        rc = proc.wait(timeout=6.0)
        assert rc == 0
        time.sleep(0.1)
        assert not dev_runner._pid_alive(fe_pid)
        assert not dev_runner._pid_alive(gc_pid)
        assert not dev_runner.runtime_state_path(data_dir).exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_auto_replace_older_instance_orphan_cleanup_and_cli_stop(tmp_path: Path) -> None:
    data_dir = tmp_path / "lake"
    port = _pick_free_port()

    # 1. Start Instance 1 (`codecity serve`)
    env = {**os.environ, dev_runner.NO_OPEN_ENV: "1"}
    srv1 = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "codecity.cli",
            "--data-dir",
            str(data_dir),
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    srv2: subprocess.Popen[str] | None = None
    srv3: subprocess.Popen[str] | None = None
    srv4: subprocess.Popen[str] | None = None
    try:
        assert _wait_health(port, timeout=15.0)
        state1 = dev_runner.read_runtime_state(data_dir)
        assert state1 is not None and state1["pid"] == srv1.pid

        # 2. `--no-replace` fails fast and keeps Instance 1 alive
        rc_noreplace = cli_main(
            [
                "--data-dir",
                str(data_dir),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-replace",
            ]
        )
        assert rc_noreplace == 1
        assert srv1.poll() is None

        # 3. Starting Instance 2 with default `--replace` automatically stops Instance 1
        srv2 = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "codecity.cli",
                "--data-dir",
                str(data_dir),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        assert srv1.wait(timeout=8.0) in (0, -signal.SIGTERM)
        assert _wait_health(port, timeout=15.0)
        state2 = dev_runner.read_runtime_state(data_dir)
        assert state2 is not None and state2["pid"] == srv2.pid

        # 4. `codecity stop` cleanly stops Instance 2 and removes server.json
        assert (
            cli_main(
                [
                    "--data-dir",
                    str(data_dir),
                    "stop",
                    "--port",
                    str(port),
                    "--frontend-port",
                    str(_pick_free_port()),
                ]
            )
            == 0
        )
        assert srv2.wait(timeout=6.0) in (0, -signal.SIGTERM)
        assert not dev_runner.runtime_state_path(data_dir).exists()

        # 5. Untracked orphaned `codecity serve` (no server.json) is still cleaned up via port check
        srv3 = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "codecity.cli",
                "--data-dir",
                str(data_dir),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        assert _wait_health(port, timeout=15.0)
        # Simulate stale/missing server.json (e.g. dead orchestrator pid or deleted state file)
        dev_runner.write_runtime_state(
            data_dir,
            {
                "pid": 99999999,
                "backend_pid": srv3.pid,
                "frontend_pid": None,
                "mode": "dev",
                "host": "127.0.0.1",
                "port": port,
            },
        )
        res = dev_runner.stop_running_server(
            data_dir,
            host="127.0.0.1",
            backend_port=port,
        )
        assert srv3.pid in res.stopped_pids
        assert srv3.wait(timeout=6.0) in (0, -signal.SIGTERM)
        assert not dev_runner.runtime_state_path(data_dir).exists()
        assert dev_runner.is_port_available("127.0.0.1", port)

        # 6. Completely untracked `codecity serve` (server.json deleted) cleaned via port inspection
        srv4 = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "codecity.cli",
                "--data-dir",
                str(data_dir),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        assert _wait_health(port, timeout=15.0)
        dev_runner.runtime_state_path(data_dir).unlink(missing_ok=True)
        res_untracked = dev_runner.stop_running_server(
            data_dir,
            host="127.0.0.1",
            backend_port=port,
        )
        assert srv4.pid in res_untracked.stopped_pids
        assert srv4.wait(timeout=6.0) in (0, -signal.SIGTERM)
        assert dev_runner.is_port_available("127.0.0.1", port)
    finally:
        for p in (srv1, srv2, srv3, srv4):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait()
