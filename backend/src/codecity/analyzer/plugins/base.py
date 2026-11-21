"""LanguagePlugin protocol, shared plugin result types, and toolchain/path helpers."""

from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic

TS_EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")


@dataclass
class PluginResult:
    """Normalized imports, diagnostics, format drift, and external dependencies from a plugin."""

    imports: list[FileImport] = field(default_factory=list)
    diagnostics: list[LintDiagnostic] = field(default_factory=list)
    format_drift_files: set[str] = field(default_factory=set)
    external_deps: list[ExternalDep] = field(default_factory=list)


class LanguagePlugin(Protocol):
    """Protocol implemented by each polyglot analyzer plugin."""

    name: str
    languages: frozenset[str]

    def analyze(
        self,
        worktree_root: Path,
        snapshot_idx: int,
        ast_files: dict[str, AstFileInfo],
    ) -> PluginResult: ...

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None: ...


def safe_repo_target(repo_root: Path, rel_path: str) -> Path:
    """Validate that `rel_path` stays inside `repo_root` and outside `.git`."""
    if not rel_path or any(ch in rel_path for ch in ("\x00", "\n", "\r")):
        raise ValueError("Invalid target path")
    rel = Path(rel_path)
    if rel.is_absolute():
        raise ValueError(f"Absolute target path is not allowed: {rel_path}")
    root = repo_root.resolve()
    cand = (root / rel).resolve()
    if cand == root or not cand.is_relative_to(root):
        raise ValueError(f"Unsafe target path outside repo root: {rel_path}")
    if ".git" in cand.relative_to(root).parts:
        raise ValueError(f"Refusing path inside .git: {rel_path}")
    return cand


def ruff_cmd() -> list[str]:
    """Locate the `ruff` executable inside or outside the active Python environment."""
    venv_ruff = Path(sys.executable).parent / "ruff"
    if venv_ruff.exists():
        return [str(venv_ruff)]
    found = shutil.which("ruff")
    return [found] if found else [sys.executable, "-m", "ruff"]


def find_bun() -> str | None:
    """Locate the `bun` executable in PATH or `$HOME/.bun/bin`."""
    found = shutil.which("bun")
    if found:
        return found
    home_bun = Path.home() / ".bun" / "bin" / "bun"
    return str(home_bun) if home_bun.exists() else None


def find_local_oxlint() -> str | None:
    """Locate `oxlint` in workspace `frontend/node_modules` or PATH."""
    candidates = [
        Path.cwd() / "frontend" / "node_modules" / ".bin" / "oxlint",
        Path(__file__).resolve().parents[5] / "frontend" / "node_modules" / ".bin" / "oxlint",
    ]
    for cand in candidates:
        if cand.exists():
            return str(cand)
    return shutil.which("oxlint")


class DepCollector:
    """Bounded, deduplicating collector for ecosystem ExternalDep rows."""

    def __init__(
        self,
        snapshot_idx: int,
        ecosystem: str,
        *,
        case_insensitive: bool = False,
        limit: int = 400,
    ) -> None:
        self.snapshot_idx = snapshot_idx
        self.ecosystem = ecosystem
        self.case_insensitive = case_insensitive
        self.limit = limit
        self.direct_names: set[str] = set()
        self._seen: set[tuple[str, bool]] = set()
        self.items: list[ExternalDep] = []

    def add(self, name: str, version: str, *, is_direct: bool) -> None:
        clean = name.strip()
        if not clean or len(self.items) >= self.limit:
            return
        norm = clean.lower() if self.case_insensitive else clean
        if is_direct:
            self.direct_names.add(norm)
        key = (norm, is_direct)
        if key in self._seen:
            return
        self._seen.add(key)
        self.items.append(
            ExternalDep(
                snapshot_idx=self.snapshot_idx,
                ecosystem=self.ecosystem,
                package_name=clean,
                version=version,
                is_direct=is_direct,
            )
        )

    def is_direct(self, name: str) -> bool:
        clean = name.strip()
        return (clean.lower() if self.case_insensitive else clean) in self.direct_names


def structural_diagnostics_to_lint(
    snapshot_idx: int,
    paths: list[str],
    ast_files: dict[str, AstFileInfo],
    linter: str,
) -> list[LintDiagnostic]:
    """Convert Tree-sitter StructuralDiagnostic records into normalized LintDiagnostic models."""
    return [
        LintDiagnostic(
            snapshot_idx=snapshot_idx,
            file_path=rel,
            linter=linter,
            line=sd.line,
            col=sd.col,
            rule_code=sd.rule_code,
            category=sd.category,
            message=sd.message,
            fixable=sd.fixable,
        )
        for rel in paths
        for sd in ast_files[rel].structural_diagnostics
    ]


def edges_to_imports(snapshot_idx: int, edges: set[tuple[str, str]]) -> list[FileImport]:
    """Convert `(source, target)` edge pairs into sorted FileImport models."""
    return [
        FileImport(snapshot_idx=snapshot_idx, source_file=src, target_file=dst)
        for src, dst in sorted(edges)
    ]
