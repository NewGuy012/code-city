"""LanguagePlugin protocol and shared plugin result types."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic


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
    ) -> PluginResult:
        """Analyze files in `worktree_root` for imports, lints, format drift, and dependencies."""
        ...

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None:
        """Generate a non-destructive auto-fix diff for a single file on HEAD."""
        ...
