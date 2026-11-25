"""Go LanguagePlugin: go.mod dependencies, module-prefix graph, AST lint heuristics."""

from __future__ import annotations

import re
from pathlib import Path

from codecity.analyzer.plugins.base import (
    DepCollector,
    NoFixPlugin,
    PluginResult,
    edges_to_imports,
    safe_read_text,
    structural_diagnostics_to_lint,
)
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep

_MOD_LINE_RE = re.compile(r"^module\s+(\S+)")
_REQ_LINE_RE = re.compile(r"^([^\s/]+(?:\.[^\s/]+)+/\S+)\s+(v[^\s]+)")


def _parse_go_mod(worktree_root: Path, snapshot_idx: int) -> tuple[str | None, list[ExternalDep]]:
    module_prefix: str | None = None
    deps = DepCollector(snapshot_idx, "go")

    raw = safe_read_text(worktree_root, worktree_root / "go.mod")
    if raw:
        in_require = False
        for raw_line in raw.splitlines():
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
            if in_require or line.startswith("require "):
                target = line.removeprefix("require ").strip()
                m_req = _REQ_LINE_RE.match(target)
                if m_req:
                    deps.add(
                        m_req.group(1), m_req.group(2), is_direct="// indirect" not in raw_line
                    )

    return module_prefix, deps.items


class GoPlugin(NoFixPlugin):
    """Analyzes Go repositories using `go.mod` and Tree-sitter AST graphs."""

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

        pkg_dir_files: dict[str, list[str]] = {}
        for rel in go_paths:
            if not rel.endswith("_test.go"):
                pkg_dir_files.setdefault(Path(rel).parent.as_posix(), []).append(rel)

        edges: set[tuple[str, str]] = set()
        if module_prefix:
            for rel in go_paths:
                for imp in ast_files[rel].raw_imports:
                    if imp != module_prefix and not imp.startswith(f"{module_prefix}/"):
                        continue
                    sub_pkg = imp[len(module_prefix) :].lstrip("/") or "."
                    for target_file in pkg_dir_files.get(sub_pkg, []):
                        if target_file != rel:
                            edges.add((rel, target_file))

        return PluginResult(
            imports=edges_to_imports(snapshot_idx, edges),
            diagnostics=structural_diagnostics_to_lint(
                snapshot_idx, go_paths, ast_files, "tree-sitter-go"
            ),
            external_deps=deps,
        )
