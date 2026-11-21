"""Polyglot LanguagePlugin registry."""

from __future__ import annotations

from pathlib import Path

from codecity.analyzer.plugins.base import LanguagePlugin, PluginResult, safe_repo_target
from codecity.analyzer.plugins.go import GoPlugin
from codecity.analyzer.plugins.python import PythonPlugin
from codecity.analyzer.plugins.rust import RustPlugin
from codecity.analyzer.plugins.typescript import TypeScriptPlugin
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import FixDiffResult

DEFAULT_PLUGINS: tuple[LanguagePlugin, ...] = (
    PythonPlugin(),
    TypeScriptPlugin(),
    GoPlugin(),
    RustPlugin(),
)


def run_all_plugins(
    worktree_root: Path,
    snapshot_idx: int,
    ast_files: dict[str, AstFileInfo],
    plugins: tuple[LanguagePlugin, ...] = DEFAULT_PLUGINS,
) -> PluginResult:
    """Execute all matching language plugins and merge imports, lints, drift, and deps."""
    merged = PluginResult()
    seen_edges: set[tuple[str, str]] = set()
    for plugin in plugins:
        res = plugin.analyze(worktree_root, snapshot_idx, ast_files)
        for imp in res.imports:
            key = (imp.source_file, imp.target_file)
            if key not in seen_edges:
                seen_edges.add(key)
                merged.imports.append(imp)
        merged.diagnostics.extend(res.diagnostics)
        merged.format_drift_files.update(res.format_drift_files)
        merged.external_deps.extend(res.external_deps)
    return merged


def preview_file_fix(
    repo_root: Path,
    file_path: str,
    plugins: tuple[LanguagePlugin, ...] = DEFAULT_PLUGINS,
) -> FixDiffResult:
    """Preview an auto-fix diff using the first matching LanguagePlugin."""
    safe_repo_target(repo_root, file_path)
    for plugin in plugins:
        res = plugin.preview_fix(repo_root, file_path)
        if res is not None:
            return res
    return FixDiffResult(
        file_path=file_path,
        linter="none",
        has_changes=False,
        diff="",
        message="Auto-fix diff preview is currently supported for Python (ruff) and TS/JS (bun).",
    )
