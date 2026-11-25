"""CLI entrypoint (`codecity analyze`, `codecity list`, `codecity serve`, `codecity export`)."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
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
        "--semantic", action="store_true", help="Enable optional README/doc enrichment"
    )

    sub.add_parser("list", help="List analyzed repositories in the DuckLake catalog")

    p_serve = sub.add_parser("serve", help="Start FastAPI Control Plane + Quack CORS proxy")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8787)

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

        app = create_app(lakehouse=lake)
        uvicorn.run(app, host=args.host, port=args.port)
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
