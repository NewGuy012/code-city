"""Single-command dev orchestrator, runtime PID tracking, and safe instance cleanup."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from codecity.analyzer.plugins.base import find_bun
from codecity.api.exporter import default_frontend_dist

SERVER_STATE_FILENAME = "server.json"
SUPERVISED_ENV = "CODECITY_SUPERVISED"
NO_OPEN_ENV = "CODECITY_NO_OPEN"


@dataclass
class StopResult:
    """Outcome of stopping tracked or orphaned CodeCity instances."""

    stopped_pids: list[int] = field(default_factory=list)
    foreign_ports: dict[int, list[tuple[int, str]]] = field(default_factory=dict)


def runtime_state_path(data_dir: Path) -> Path:
    """Return path to the per-catalog runtime state file (`<data_dir>/server.json`)."""
    return data_dir.resolve() / SERVER_STATE_FILENAME


def read_runtime_state(data_dir: Path) -> dict[str, Any] | None:
    """Read `<data_dir>/server.json`, returning None if absent or malformed."""
    path = runtime_state_path(data_dir)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else None
    except Exception:
        return None


def write_runtime_state(data_dir: Path, payload: dict[str, Any]) -> Path:
    """Atomically persist runtime metadata into `<data_dir>/server.json`."""
    dest = runtime_state_path(data_dir)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, dest)
    return dest


def remove_runtime_state_if_owner(data_dir: Path, owner_pid: int) -> None:
    """Remove `<data_dir>/server.json` only if it still belongs to `owner_pid`."""
    path = runtime_state_path(data_dir)
    if not path.exists():
        return
    state = read_runtime_state(data_dir)
    if state is None or state.get("pid") == owner_pid:
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    if os.name == "posix":
        try:
            proc = subprocess.run(
                ["ps", "-p", str(pid), "-o", "stat="],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            stat = proc.stdout.strip()
            if not stat or stat.startswith("Z"):
                return False
        except Exception:
            pass
    return True


def _process_command(pid: int) -> str | None:
    if pid <= 0 or os.name != "posix":
        return None
    try:
        proc = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        cmd = proc.stdout.strip()
        return cmd or None
    except Exception:
        return None


def _process_cwd(pid: int) -> Path | None:
    if pid <= 0 or os.name != "posix" or not shutil.which("lsof"):
        return None
    try:
        proc = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        for line in proc.stdout.splitlines():
            if line.startswith("n") and len(line) > 1:
                return Path(line[1:]).resolve()
    except Exception:
        pass
    return None


def _listening_pids_for_port(port: int) -> list[int]:
    if port <= 0 or os.name != "posix" or not shutil.which("lsof"):
        return []
    try:
        proc = subprocess.run(
            ["lsof", "-nP", f"-tiTCP:{port}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except Exception:
        return []
    if proc.returncode != 0:
        return []
    my_pid = os.getpid()
    pids: set[int] = set()
    for line in proc.stdout.splitlines():
        raw = line.strip()
        if raw.isdigit():
            val = int(raw)
            if val != my_pid:
                pids.add(val)
    return sorted(pids)


def _is_codecity_backend_cmd(cmd: str) -> bool:
    low = cmd.lower()
    return "codecity" in low and any(tok in low for tok in ("serve", "dev", "codecity.cli"))


def _is_repo_frontend_cmd(
    pid: int,
    cmd: str,
    frontend_dir: Path | None,
    *,
    allow_bun_wrapper: bool = False,
) -> bool:
    low = cmd.lower()
    if not ("vite" in low or (allow_bun_wrapper and "bun" in low)):
        return False
    if frontend_dir is None:
        return False
    fe_resolved = frontend_dir.resolve()
    if str(fe_resolved) in cmd:
        return True
    cwd = _process_cwd(pid)
    return cwd is not None and cwd.is_relative_to(fe_resolved)


def _is_verified_tracked_pid(pid: int, role: str, frontend_dir: Path | None) -> bool:
    if os.name != "posix":
        return _pid_alive(pid)
    cmd = _process_command(pid)
    if not cmd:
        return False
    if role == "frontend":
        return _is_repo_frontend_cmd(pid, cmd, frontend_dir, allow_bun_wrapper=True)
    return _is_codecity_backend_cmd(cmd)


def _signal_pid(pid: int, sig: int, *, use_pgroup: bool = False) -> None:
    if pid <= 0 or pid == os.getpid():
        return
    if os.name == "posix" and use_pgroup:
        try:
            pgid = os.getpgid(pid)
            if pgid != os.getpgrp():
                os.killpg(pgid, sig)
                return
        except ProcessLookupError:
            return
        except OSError:
            pass
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except OSError:
        pass


def _terminate_pid_targets(
    targets: list[tuple[int, bool]],
    *,
    force: bool = False,
    timeout: float = 5.0,
) -> list[int]:
    if not targets:
        return []
    first_sig = signal.SIGKILL if (force and hasattr(signal, "SIGKILL")) else signal.SIGTERM
    for pid, use_pgroup in targets:
        _signal_pid(pid, first_sig, use_pgroup=use_pgroup)

    deadline = time.monotonic() + max(0.2, timeout)
    while time.monotonic() < deadline:
        if all(not _pid_alive(pid) for pid, _ in targets):
            break
        time.sleep(0.05)

    still_alive = [(pid, pg) for pid, pg in targets if _pid_alive(pid)]
    if still_alive and hasattr(signal, "SIGKILL"):
        for pid, use_pgroup in still_alive:
            _signal_pid(pid, signal.SIGKILL, use_pgroup=use_pgroup)
        kill_deadline = time.monotonic() + 1.5
        while time.monotonic() < kill_deadline:
            if all(not _pid_alive(pid) for pid, _ in still_alive):
                break
            time.sleep(0.05)

    return [pid for pid, _ in targets]


def is_port_available(host: str, port: int) -> bool:
    """Return True if `host:port` is not currently accepting TCP connections and can be bound."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        if probe.connect_ex((host, port)) == 0:
            return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def _wait_ports_free(host: str, ports: list[int], timeout: float = 3.0) -> None:
    if not ports:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(is_port_available(host, p) for p in ports):
            return
        time.sleep(0.05)


def stop_running_server(
    data_dir: Path,
    *,
    host: str = "127.0.0.1",
    backend_port: int | None = None,
    frontend_port: int | None = None,
    frontend_dir: Path | None = None,
    force: bool = False,
    timeout: float = 5.0,
    check_ports: bool = True,
    log: Callable[[str], None] | None = None,
) -> StopResult:
    """Cleanly stop tracked or orphaned CodeCity instances without touching foreign processes."""
    result = StopResult()
    fe_dir = (frontend_dir or default_frontend_dist().parent).resolve()
    my_pid = os.getpid()
    seen: set[int] = set()

    def _emit(msg: str) -> None:
        if log is not None:
            log(msg)

    state = read_runtime_state(data_dir)
    recorded_ports: list[int] = []
    if state is not None:
        for pkey in ("port", "frontend_port"):
            pval = state.get(pkey)
            if isinstance(pval, int) and pval > 0:
                recorded_ports.append(pval)
        raw_pid = state.get("pid")
        old_pid = int(raw_pid) if isinstance(raw_pid, int) else 0
        if (
            old_pid
            and old_pid != my_pid
            and _pid_alive(old_pid)
            and _is_verified_tracked_pid(old_pid, "orchestrator", fe_dir)
        ):
            _emit(f"Stopping previous CodeCity instance (PID {old_pid})...")
            _terminate_pid_targets([(old_pid, False)], force=force, timeout=timeout)
            result.stopped_pids.append(old_pid)
            seen.add(old_pid)

        # Clean up any recorded child PIDs left behind if an earlier orchestrator was hard-killed
        orphan_children: list[tuple[int, bool]] = []
        for key, role in (("backend_pid", "backend"), ("frontend_pid", "frontend")):
            raw_child = state.get(key)
            child_pid = int(raw_child) if isinstance(raw_child, int) else 0
            if (
                child_pid
                and child_pid != my_pid
                and child_pid not in seen
                and _pid_alive(child_pid)
                and _is_verified_tracked_pid(child_pid, role, fe_dir)
            ):
                orphan_children.append((child_pid, True))
                seen.add(child_pid)

        if orphan_children:
            pids_str = ", ".join(str(p) for p, _ in orphan_children)
            _emit(f"Cleaning up orphaned CodeCity child process(es) (PID {pids_str})...")
            result.stopped_pids.extend(
                _terminate_pid_targets(orphan_children, force=force, timeout=timeout)
            )

        if old_pid and (not _pid_alive(old_pid) or old_pid in seen):
            remove_runtime_state_if_owner(data_dir, old_pid)
    else:
        # Remove corrupted file if present
        state_path = runtime_state_path(data_dir)
        if state_path.exists():
            state_path.unlink(missing_ok=True)

    if check_ports:
        port_targets: list[tuple[int, bool]] = []
        port_specs: list[tuple[int, str]] = []
        if backend_port is not None:
            port_specs.append((backend_port, "backend"))
        if frontend_port is not None:
            port_specs.append((frontend_port, "frontend"))

        for port, role in port_specs:
            for pid in _listening_pids_for_port(port):
                if pid in seen or pid == my_pid:
                    continue
                cmd = _process_command(pid) or ""
                is_ours = (
                    _is_codecity_backend_cmd(cmd)
                    if role == "backend"
                    else _is_repo_frontend_cmd(pid, cmd, fe_dir, allow_bun_wrapper=True)
                )
                if is_ours:
                    port_targets.append((pid, True))
                    seen.add(pid)
                else:
                    result.foreign_ports.setdefault(port, []).append((pid, cmd or "<unknown>"))

        if port_targets:
            pids_str = ", ".join(str(p) for p, _ in port_targets)
            _emit(f"Stopping untracked CodeCity process(es) on target port(s) (PID {pids_str})...")
            result.stopped_pids.extend(
                _terminate_pid_targets(port_targets, force=force, timeout=timeout)
            )

    ports_to_wait = sorted(
        {p for p in (*recorded_ports, backend_port, frontend_port) if p is not None}
    )
    if result.stopped_pids and ports_to_wait:
        _wait_ports_free(host, ports_to_wait, timeout=3.0)

    return result


def _spawn_managed(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "env": env,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
    }
    if os.name == "posix":
        kwargs["start_new_session"] = True
    elif hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(cmd, **kwargs)


def _terminate_child_group(proc: subprocess.Popen[str], *, force: bool = False) -> None:
    if proc.poll() is not None:
        return
    if os.name == "posix":
        sig = signal.SIGKILL if force else signal.SIGTERM
        try:
            os.killpg(proc.pid, sig)
            return
        except ProcessLookupError:
            return
        except OSError:
            pass
    try:
        if force:
            proc.kill()
        else:
            proc.terminate()
    except OSError:
        pass


def _shutdown_children(
    procs: list[subprocess.Popen[str]],
    *,
    grace_timeout: float = 5.0,
    force_event: threading.Event | None = None,
) -> None:
    active = [p for p in procs if p.poll() is None]
    if not active:
        return
    force_now = bool(force_event and force_event.is_set())
    for proc in active:
        _terminate_child_group(proc, force=force_now)

    if not force_now:
        deadline = time.monotonic() + max(0.2, grace_timeout)
        while time.monotonic() < deadline:
            if all(p.poll() is not None for p in active):
                return
            if force_event is not None and force_event.is_set():
                break
            time.sleep(0.05)

    for proc in active:
        if proc.poll() is None:
            _terminate_child_group(proc, force=True)
    for proc in active:
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=2.0)


def _stream_child_output(
    proc: subprocess.Popen[str],
    prefix: str,
    write_lock: threading.Lock,
) -> None:
    stream = proc.stdout
    if stream is None:
        return
    try:
        for line in stream:
            with write_lock:
                sys.stdout.write(f"{prefix}{line}")
                sys.stdout.flush()
    except Exception:
        pass
    finally:
        with contextlib.suppress(Exception):
            stream.close()


def _wait_for_http_health(
    url: str,
    proc: subprocess.Popen[str],
    stop_event: threading.Event,
    *,
    timeout: float = 20.0,
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if stop_event.is_set() or proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=0.5) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, OSError, TimeoutError):
            pass
        time.sleep(0.1)
    return False


def _wait_for_tcp_port(
    host: str,
    port: int,
    proc: subprocess.Popen[str],
    stop_event: threading.Event,
    *,
    timeout: float = 20.0,
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if stop_event.is_set() or proc.poll() is not None:
            return False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.3)
            if sock.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.1)
    return False


def _should_open_browser(open_browser: bool) -> bool:
    if not open_browser:
        return False
    return os.environ.get(NO_OPEN_ENV, "").strip().lower() not in {"1", "true", "yes"}


def _format_foreign_port_error(port: int, owners: list[tuple[int, str]], flag: str) -> str:
    details = ", ".join(f"PID {pid} ({cmd})" for pid, cmd in owners)
    return (
        f"Error: Port {port} is already in use by a non-CodeCity process: {details}. "
        f"Stop it or pass `{flag} <other-port>`."
    )


def run_dev_orchestrator(
    *,
    data_dir: Path,
    host: str = "127.0.0.1",
    port: int = 8787,
    frontend_port: int = 5173,
    open_browser: bool = True,
    auto_exit: bool = True,
    auto_exit_grace: float = 15.0,
    replace: bool = True,
    frontend_dir: Path | None = None,
    grace_timeout: float = 5.0,
    ready_timeout: float = 20.0,
    backend_cmd: list[str] | None = None,
    frontend_cmd: list[str] | None = None,
    browser_opener: Callable[[str], Any] = webbrowser.open,
) -> int:
    """Supervise FastAPI backend + Vite HMR frontend with auto-cleanup, auto-open, and auto-exit."""
    fe_dir = (frontend_dir or default_frontend_dist().parent).resolve()

    if frontend_cmd is None:
        bun_bin = find_bun()
        if not bun_bin:
            print(
                "Error: `bun` executable not found. Install Bun (https://bun.sh/) and try again.",
                file=sys.stderr,
            )
            return 1
        if not (fe_dir / "package.json").is_file():
            print(f"Error: Frontend directory not found at {fe_dir}.", file=sys.stderr)
            return 1
        if not (fe_dir / "node_modules").is_dir():
            print(
                f"Error: Frontend dependencies are not installed in {fe_dir}. "
                "Run `(cd frontend && bun install)` first.",
                file=sys.stderr,
            )
            return 1
        resolved_frontend_cmd = [
            bun_bin,
            "run",
            "dev",
            "--",
            "--host",
            host,
            "--port",
            str(frontend_port),
            "--strictPort",
        ]
    else:
        resolved_frontend_cmd = list(frontend_cmd)

    if replace:
        stop_res = stop_running_server(
            data_dir,
            host=host,
            backend_port=port,
            frontend_port=frontend_port,
            frontend_dir=fe_dir,
            timeout=grace_timeout,
            log=lambda m: print(m, flush=True),
        )
        if port in stop_res.foreign_ports:
            print(
                _format_foreign_port_error(port, stop_res.foreign_ports[port], "--port"),
                file=sys.stderr,
            )
            return 1
        if frontend_port in stop_res.foreign_ports:
            print(
                _format_foreign_port_error(
                    frontend_port, stop_res.foreign_ports[frontend_port], "--frontend-port"
                ),
                file=sys.stderr,
            )
            return 1

    for check_port, flag in ((port, "--port"), (frontend_port, "--frontend-port")):
        if not is_port_available(host, check_port):
            hint = "Run `codecity stop` or omit `--no-replace`." if not replace else ""
            print(
                f"Error: Port {check_port} on {host} is already in use. "
                f"{hint} Or pass `{flag} <other-port>`.".strip(),
                file=sys.stderr,
            )
            return 1

    if backend_cmd is None:
        resolved_backend_cmd = [
            sys.executable,
            "-m",
            "codecity.cli",
            "--data-dir",
            str(data_dir.resolve()),
            "serve",
            "--host",
            host,
            "--port",
            str(port),
            "--no-replace",
            "--auto-exit" if auto_exit else "--no-auto-exit",
            "--auto-exit-grace",
            str(auto_exit_grace),
        ]
    else:
        resolved_backend_cmd = list(backend_cmd)

    use_color = sys.stdout.isatty()
    api_prefix = "\033[36m[api]\033[0m " if use_color else "[api] "
    web_prefix = "\033[35m[web]\033[0m " if use_color else "[web] "
    write_lock = threading.Lock()

    stop_requested = threading.Event()
    force_requested = threading.Event()
    prev_handlers: dict[int, Any] = {}

    def _handle_signal(_signum: int, _frame: object) -> None:
        if stop_requested.is_set():
            force_requested.set()
        else:
            stop_requested.set()

    handled_sigs = [signal.SIGINT, signal.SIGTERM]
    if hasattr(signal, "SIGHUP"):
        handled_sigs.append(signal.SIGHUP)
    for sig in handled_sigs:
        try:
            prev_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, _handle_signal)
        except (OSError, ValueError):
            pass

    my_pid = os.getpid()
    state_payload: dict[str, Any] = {
        "pid": my_pid,
        "backend_pid": None,
        "frontend_pid": None,
        "mode": "dev",
        "host": host,
        "port": port,
        "frontend_port": frontend_port,
        "started_at": datetime.now(UTC).isoformat(),
    }
    write_runtime_state(data_dir, state_payload)

    backend: subprocess.Popen[str] | None = None
    frontend: subprocess.Popen[str] | None = None
    children: list[subprocess.Popen[str]] = []

    try:
        api_env = {**os.environ, "PYTHONUNBUFFERED": "1", SUPERVISED_ENV: "1"}
        backend = _spawn_managed(resolved_backend_cmd, env=api_env)
        children.append(backend)
        state_payload["backend_pid"] = backend.pid
        write_runtime_state(data_dir, state_payload)
        threading.Thread(
            target=_stream_child_output,
            args=(backend, api_prefix, write_lock),
            daemon=True,
        ).start()

        health_url = f"http://{host}:{port}/api/health"
        if not _wait_for_http_health(health_url, backend, stop_requested, timeout=ready_timeout):
            if stop_requested.is_set():
                return 0
            rc = backend.poll()
            print(
                f"Error: CodeCity backend failed to become healthy at {health_url}"
                + (f" (exit code {rc})." if rc is not None else " (timed out)."),
                file=sys.stderr,
            )
            return rc if (rc is not None and rc != 0) else 1

        web_env = {**os.environ, "CODECITY_API_URL": f"http://{host}:{port}"}
        frontend = _spawn_managed(resolved_frontend_cmd, cwd=fe_dir, env=web_env)
        children.append(frontend)
        state_payload["frontend_pid"] = frontend.pid
        write_runtime_state(data_dir, state_payload)
        threading.Thread(
            target=_stream_child_output,
            args=(frontend, web_prefix, write_lock),
            daemon=True,
        ).start()

        if not _wait_for_tcp_port(
            host, frontend_port, frontend, stop_requested, timeout=ready_timeout
        ):
            if stop_requested.is_set():
                return 0
            rc = frontend.poll()
            print(
                f"Error: Frontend dev server failed to listen on http://{host}:{frontend_port}"
                + (f" (exit code {rc})." if rc is not None else " (timed out)."),
                file=sys.stderr,
            )
            return rc if (rc is not None and rc != 0) else 1

        studio_url = f"http://{host}:{frontend_port}"
        api_url = f"http://{host}:{port}"
        auto_exit_note = (
            f"enabled ({auto_exit_grace:g}s grace after last tab closes)"
            if auto_exit
            else "disabled"
        )
        with write_lock:
            print(
                f"\nCodeCity Dev Ready\n"
                f"  Studio UI (HMR): {studio_url}\n"
                f"  Control Plane:   {api_url}\n"
                f"  Auto-exit:       {auto_exit_note}\n"
                f"  Press Ctrl+C to stop both servers (or run `bun run stop` / `codecity stop`).\n",
                flush=True,
            )

        if _should_open_browser(open_browser):
            try:
                browser_opener(studio_url)
            except Exception as exc:
                with write_lock:
                    print(
                        f"Note: Could not auto-open browser ({exc}); open {studio_url}", flush=True
                    )

        while not stop_requested.is_set():
            api_rc = backend.poll()
            if api_rc is not None:
                if api_rc == 0:
                    with write_lock:
                        print(
                            "CodeCity backend exited cleanly — stopping frontend dev server...",
                            flush=True,
                        )
                    return 0
                with write_lock:
                    print(
                        f"CodeCity backend exited unexpectedly (code {api_rc}) "
                        "— stopping frontend...",
                        file=sys.stderr,
                        flush=True,
                    )
                return api_rc

            web_rc = frontend.poll()
            if web_rc is not None:
                with write_lock:
                    msg = f"Frontend dev server exited (code {web_rc}) — stopping backend..."
                    print(msg, file=sys.stderr if web_rc != 0 else sys.stdout, flush=True)
                return web_rc

            time.sleep(0.1)

        with write_lock:
            print("\nShutting down CodeCity dev servers...", flush=True)
        return 0
    finally:
        _shutdown_children(children, grace_timeout=grace_timeout, force_event=force_requested)
        for sig, handler in prev_handlers.items():
            with contextlib.suppress(OSError, ValueError):
                signal.signal(sig, handler)
        remove_runtime_state_if_owner(data_dir, my_pid)
