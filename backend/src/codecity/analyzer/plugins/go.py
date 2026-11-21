"""Go LanguagePlugin: go.mod/go.sum dependencies, module-prefix graph, AST lint heuristics."""

from __future__ import annotations

import re
from pathlib import Path

from codecity.analyzer.plugins.base import PluginResult
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic

_MOD_LINE_RE = re.compile(r"^module\s+(\S+)")
_REQ_LINE_RE = re.compile(r"^([^\s/]+(?:\.[^\s/]+)+/\S+)\s+(v[^\s]+)")


def _parse_go_mod(worktree_root: Path, snapshot_idx: int) -> tuple[str | None, list[ExternalDep]]:
    module_prefix: str | None = None
    deps: list[ExternalDep] = []
    seen: set[str] = set()

    go_mod = worktree_root / "go.mod"
    if go_mod.exists():
        in_require = False
        for raw_line in go_mod.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.split("//", 1)[0].strip()
            if not line:
                continue
            m_mod = _MOD_LINE_RE.match(line)
            if m_mod:
                module_prefix = m_mod.group(1)
                continue
            if line.startswith("require ("):
                in_require = True
                continue
            if line == ")":
                in_require = False
                continue
            target = line.removeprefix("require ").strip() if line.startswith("require ") else line
            if in_require or line.startswith("require "):
                m_req = _REQ_LINE_RE.match(target)
                if m_req:
                    pkg, ver = m_req.group(1), m_req.group(2)
                    if pkg not in seen:
                        seen.add(pkg)
                        is_direct = "// indirect" not in raw_line
                        deps.append(
                            ExternalDep(
                                snapshot_idx=snapshot_idx,
                                ecosystem="go",
                                package_name=pkg,
                                version=ver,
                                is_direct=is_direct,
                            )
                        )

    return module_prefix, deps[:400]


class GoPlugin:
    """Analyzes Go repositories using `go.mod`/`go.sum` and Tree-sitter AST graphs."""

    name = "go"
    languages = frozenset({"go"})

    def analyze(
        self,
        worktree_root: Path,
        snapshot_idx: int,
        ast_files: dict[str, AstFileInfo],
    ) -> PluginResult:
        go_paths = sorted(p for p, info in ast_files.items() if info.language == "go")
        module_prefix, deps = _parse_go_mod(worktree_root, snapshot_idx)
        if not go_paths:
            return PluginResult(external_deps=deps)

        # Map package directories -> non-test Go files in that directory
        pkg_dir_files: dict[str, list[str]] = {}
        for rel in go_paths:
            if rel.endswith("_test.go"):
                continue
            pkg_dir = Path(rel).parent.as_posix()
            pkg_dir_files.setdefault(pkg_dir, []).append(rel)

        edges: set[tuple[str, str]] = set()
        diagnostics: list[LintDiagnostic] = []

        for rel in go_paths:
            info = ast_files[rel]
            for sdiag in info.structural_diagnostics:
                diagnostics.append(
                    LintDiagnostic(
                        snapshot_idx=snapshot_idx,
                        file_path=rel,
                        linter="tree-sitter-go",
                        line=sdiag.line,
                        col=sdiag.col,
                        rule_code=sdiag.rule_code,
                        category=sdiag.category,
                        message=sdiag.message,
                        fixable=sdiag.fixable,
                    )
                )

            if not module_prefix:
                continue
            for imp in info.raw_imports:
                if not imp.startswith(module_prefix):
                    continue
                sub_pkg = imp[len(module_prefix) :].lstrip("/") or "."
                for target_file in pkg_dir_files.get(sub_pkg, []):
                    if target_file != rel:
                        edges.add((rel, target_file))

        imports = [
            FileImport(snapshot_idx=snapshot_idx, source_file=s, target_file=t)
            for s, t in sorted(edges)
        ]
        return PluginResult(imports=imports, diagnostics=diagnostics, external_deps=deps)

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None:
        return None
