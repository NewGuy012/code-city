"""LanguagePlugin protocol, shared plugin result types, and toolchain/path helpers."""

from __future__ import annotations

import functools
import shutil
import subprocess
import sys
import tomllib
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

    def apply_fix(self, repo_root: Path, file_path: str) -> bool: ...


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


def safe_read_text(root: Path, path: Path) -> str | None:
    """Read UTF-8 text only if `path` is a non-symlink file inside `root`."""
    try:
        if path.is_symlink():
            return None
        root_res = root.resolve()
        resolved = path.resolve()
        if not resolved.is_relative_to(root_res) or not resolved.is_file():
            return None
        return resolved.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def run_tool(
    cmd: list[str],
    cwd: Path,
    *,
    timeout: int = 20,
) -> subprocess.CompletedProcess[str]:
    """Run an external analyzer/formatter CLI with UTF-8 output capture and timeout."""
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


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


@functools.lru_cache(maxsize=4)
def bun_supports_native_lint(bun_bin: str) -> bool:
    try:
        proc = run_tool([bun_bin, "lint", "--no-script", "--help"], Path.cwd(), timeout=5)
        return proc.returncode == 0 and 'Script not found "lint"' not in (proc.stdout + proc.stderr)
    except Exception:
        return False


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


def parse_toml_lockfile(worktree_root: Path, filename: str, deps: DepCollector) -> None:
    """Extract `[[package]]` entries from `uv.lock` or `Cargo.lock` into `deps`."""
    raw = safe_read_text(worktree_root, worktree_root / filename)
    if not raw:
        return
    try:
        for pkg in tomllib.loads(raw).get("package", []):
            name = str(pkg.get("name", "")).strip()
            if name:
                deps.add(name, str(pkg.get("version", "")), is_direct=deps.is_direct(name))
    except Exception:
        pass


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
