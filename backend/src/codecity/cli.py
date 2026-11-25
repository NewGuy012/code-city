"""CLI entrypoint (`analyze`, `list`, `serve`, `dev`, `stop`, `export`)."""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from codecity.analyzer.pipeline import analyze_repository
from codecity.storage.lakehouse import LakehouseManager


def _bounded_int(lo: int, hi: int) -> Callable[[str], int]:
    def _parse(raw: str) -> int:
        val = int(raw)
        if not (lo <= val <= hi):
            raise argparse.ArgumentTypeError(f"must be between {lo} and {hi}")
        return val

    return _parse


def _bounded_float(lo: float, hi: float) -> Callable[[str], float]:
    def _parse(raw: str) -> float:
        val = float(raw)
        if not (lo <= val <= hi):
            raise argparse.ArgumentTypeError(f"must be between {lo:g} and {hi:g}")
        return val

    return _parse


def _open_browser_when_healthy(url: str, shutdown_event: threading.Event) -> None:
    health_url = f"{url.rstrip('/')}/api/health"
    for _ in range(150):
        if shutdown_event.is_set():
            return
        try:
            with urllib.request.urlopen(health_url, timeout=0.5) as resp:
                if resp.status == 200:
                    with contextlib.suppress(Exception):
                        webbrowser.open(url)
                    return
        except (urllib.error.URLError, OSError, TimeoutError):
            pass
        shutdown_event.wait(0.1)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codecity",
        description="CodeCity — SimCity-inspired polyglot visual time-machine",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="Path to DuckLake catalog directory (default: .codecity/)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_analyze = sub.add_parser("analyze", help="Analyze a local Git repo or public Git URL")
    p_analyze.add_argument("source", help="Local directory path or Git repository URL")
    p_analyze.add_argument("--owner", default=None, help="Override repository owner slug")
    p_analyze.add_argument("--repo", default=None, help="Override repository name slug")
    p_analyze.add_argument(
        "--max-keyframes", type=_bounded_int(1, 120), default=16, help="Max historical snapshots"
    )
    p_analyze.add_argument(
        "--workers", type=_bounded_int(1, 16), default=4, help="Parallel worktree workers"
    )
    p_analyze.add_argument(
        "--semantic",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable README/doc enrichment (default: enabled)",
    )
    p_analyze.add_argument(
        "--llm",
        choices=("auto", "head", "lazy", "off"),
        default="auto",
        help="LLM summary mode (local llama.cpp -> Gemini fallback): auto, head, lazy, or off",
    )

    sub.add_parser("list", help="List analyzed repositories in the DuckLake catalog")

    p_serve = sub.add_parser("serve", help="Start FastAPI Control Plane + Quack CORS proxy")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=_bounded_int(1, 65535), default=8787)
    p_serve.add_argument(
        "--open",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Open Studio UI in default browser once healthy (default: disabled)",
    )
    p_serve.add_argument(
        "--auto-exit",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Auto-exit after the last browser tab closes (default: disabled)",
    )
    p_serve.add_argument(
        "--auto-exit-grace",
        type=_bounded_float(0.1, 3600.0),
        default=15.0,
        help="Seconds to wait after last browser tab closes before auto-exiting (default: 15)",
    )
    p_serve.add_argument(
        "--replace",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Automatically stop an older CodeCity instance before starting (default: enabled)",
    )

    p_dev = sub.add_parser(
        "dev",
        help="Start FastAPI backend + Vite HMR frontend together (single-command dev mode)",
    )
    p_dev.add_argument("--host", default="127.0.0.1")
    p_dev.add_argument("--port", type=_bounded_int(1, 65535), default=8787)
    p_dev.add_argument("--frontend-port", type=_bounded_int(1, 65535), default=5173)
    p_dev.add_argument(
        "--open",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Open Studio UI in default browser automatically (default: enabled)",
    )
    p_dev.add_argument(
        "--auto-exit",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Auto-exit both servers after the last browser tab closes (default: enabled)",
    )
    p_dev.add_argument(
        "--auto-exit-grace",
        type=_bounded_float(0.1, 3600.0),
        default=15.0,
        help="Seconds to wait after last browser tab closes before auto-exiting (default: 15)",
    )
    p_dev.add_argument(
        "--replace",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Automatically stop older CodeCity instances before starting (default: enabled)",
    )

    p_stop = sub.add_parser("stop", help="Stop a running local CodeCity server/dev session")
    p_stop.add_argument("--host", default="127.0.0.1")
    p_stop.add_argument("--port", type=_bounded_int(1, 65535), default=8787)
    p_stop.add_argument("--frontend-port", type=_bounded_int(1, 65535), default=5173)
    p_stop.add_argument(
        "--force",
        action="store_true",
        help="Immediately SIGKILL verified CodeCity processes instead of waiting for SIGTERM",
    )

    p_export = sub.add_parser("export", help="Export zero-backend static OSS report bundle")
    p_export.add_argument("target", help="Repository in `owner/repo` format")
    p_export.add_argument("--out", type=Path, required=True, help="Output bundle directory")
    p_export.add_argument("--postcard", action="store_true", help="Capture Playwright PNG postcard")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    lake = LakehouseManager(data_dir=args.data_dir)

    if args.command == "analyze":

        def on_prog(evt: dict[str, object]) -> None:
            print(f"[{evt.get('percent', 0):5.1f}%] {evt.get('message', '')}", flush=True)

        summary = analyze_repository(
            args.source,
            lakehouse=lake,
            owner=args.owner,
            repo=args.repo,
            max_keyframes=args.max_keyframes,
            workers=args.workers,
            semantic=args.semantic,
            llm_mode=args.llm,
            on_progress=on_prog,
        )
        print(
            f"Done: {summary.repo.owner}/{summary.repo.repo} "
            f"({summary.snapshots_written} snapshots, grade {summary.repo.latest_grade} — "
            f"{summary.repo.latest_title})"
        )
        return 0

    if args.command == "list":
        with lake.session() as con:
            repos = lake.list_repos(con)
        if not repos:
            print("No repositories analyzed yet. Run `codecity analyze <path-or-url>`.")
            return 0
        for r in repos:
            print(
                f"{r.owner}/{r.repo:24}  {r.latest_grade:3}  "
                f"{r.total_snapshots:2d} snapshots  {r.total_files:4d} files  {r.latest_title}"
            )
        return 0

    if args.command == "serve":
        import uvicorn

        from codecity.api.app import create_app
        from codecity.dev_runner import (
            SUPERVISED_ENV,
            _format_foreign_port_error,
            _should_open_browser,
            is_port_available,
            remove_runtime_state_if_owner,
            stop_running_server,
            write_runtime_state,
        )

        supervised = os.environ.get(SUPERVISED_ENV) == "1"
        if not supervised and args.replace:
            stop_res = stop_running_server(
                lake.data_dir,
                host=args.host,
                backend_port=args.port,
                log=lambda m: print(m, flush=True),
            )
            if args.port in stop_res.foreign_ports:
                print(
                    _format_foreign_port_error(
                        args.port, stop_res.foreign_ports[args.port], "--port"
                    ),
                    file=sys.stderr,
                )
                return 1

        if not supervised and not is_port_available(args.host, args.port):
            hint = "Run `codecity stop` or omit `--no-replace`." if not args.replace else ""
            print(
                f"Error: Port {args.port} on {args.host} is already in use. "
                f"{hint} Or pass `--port <other-port>`.".strip(),
                file=sys.stderr,
            )
            return 1

        shutdown_event = threading.Event()
        server_box: list[uvicorn.Server] = []

        def _request_shutdown() -> None:
            shutdown_event.set()
            if server_box:
                server_box[0].should_exit = True

        my_pid = os.getpid()

        class _ManagedUvicornServer(uvicorn.Server):
            def handle_exit(self, sig: int, frame: object) -> None:
                shutdown_event.set()
                super().handle_exit(sig, frame)

            async def shutdown(self, sockets: list[object] | None = None) -> None:
                try:
                    await super().shutdown(sockets=sockets)  # type: ignore[arg-type]
                finally:
                    if not supervised:
                        remove_runtime_state_if_owner(lake.data_dir, my_pid)

        app = create_app(
            lakehouse=lake,
            shutdown_event=shutdown_event,
            on_shutdown_request=_request_shutdown,
            auto_exit=args.auto_exit,
            auto_exit_grace=args.auto_exit_grace,
        )
        config = uvicorn.Config(
            app,
            host=args.host,
            port=args.port,
            timeout_graceful_shutdown=3,
        )
        server = _ManagedUvicornServer(config)
        server_box.append(server)

        if not supervised:
            write_runtime_state(
                lake.data_dir,
                {
                    "pid": my_pid,
                    "backend_pid": my_pid,
                    "frontend_pid": None,
                    "mode": "serve",
                    "host": args.host,
                    "port": args.port,
                    "frontend_port": None,
                    "started_at": datetime.now(UTC).isoformat(),
                },
            )
            if _should_open_browser(args.open):
                threading.Thread(
                    target=_open_browser_when_healthy,
                    args=(f"http://{args.host}:{args.port}", shutdown_event),
                    daemon=True,
                ).start()

        try:
            server.run()
        finally:
            shutdown_event.set()
            if not supervised:
                remove_runtime_state_if_owner(lake.data_dir, my_pid)
        return 0

    if args.command == "dev":
        from codecity.dev_runner import run_dev_orchestrator

        return run_dev_orchestrator(
            data_dir=lake.data_dir,
            host=args.host,
            port=args.port,
            frontend_port=args.frontend_port,
            open_browser=args.open,
            auto_exit=args.auto_exit,
            auto_exit_grace=args.auto_exit_grace,
            replace=args.replace,
        )

    if args.command == "stop":
        from codecity.dev_runner import stop_running_server

        res = stop_running_server(
            lake.data_dir,
            host=args.host,
            backend_port=args.port,
            frontend_port=args.frontend_port,
            force=args.force,
            log=lambda m: print(m, flush=True),
        )
        if res.stopped_pids:
            pids_str = ", ".join(str(p) for p in res.stopped_pids)
            print(f"Stopped CodeCity process(es): {pids_str}")
        elif not res.foreign_ports:
            print("CodeCity is not running.")
        for port, owners in sorted(res.foreign_ports.items()):
            desc = ", ".join(f"PID {pid} ({cmd})" for pid, cmd in owners)
            print(f"Note: Port {port} is held by a non-CodeCity process (left untouched): {desc}")
        return 0

    if args.command == "export":
        from codecity.api.exporter import export_static_site

        if "/" not in args.target:
            print("Error: target must be in `owner/repo` format", file=sys.stderr)
            return 2
        owner, repo = args.target.split("/", 1)
        res = export_static_site(lake, owner, repo, args.out, with_postcard=args.postcard)
        print(f"Exported static CodeCity report to {res.output_dir}")
        if res.postcard_path:
            print(f"City Postcard saved at {res.postcard_path}")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
