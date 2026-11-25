"""Rust LanguagePlugin: Cargo.toml/Cargo.lock dependencies, crate/mod graph, AST lints."""

from __future__ import annotations

import tomllib
from pathlib import Path

from codecity.analyzer.plugins.base import (
    DepCollector,
    NoFixPlugin,
    PluginResult,
    edges_to_imports,
    iter_repo_files,
    parse_toml_lockfile,
    safe_read_text,
    structural_diagnostics_to_lint,
)
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep


def _parse_cargo_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps = DepCollector(snapshot_idx, "rust")

    for cargo_toml in iter_repo_files(worktree_root, names=frozenset({"Cargo.toml"})):
        raw = safe_read_text(worktree_root, cargo_toml)
        if not raw:
            continue
        try:
            data = tomllib.loads(raw)
        except Exception:
            continue
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            tbl = data.get(section)
            if isinstance(tbl, dict):
                for name, spec in tbl.items():
                    ver = str(spec.get("version", "*")) if isinstance(spec, dict) else str(spec)
                    deps.add(str(name), ver, is_direct=True)

    parse_toml_lockfile(worktree_root, "Cargo.lock", deps)
    return deps.items


def _build_rust_module_map(rs_paths: list[str]) -> dict[str, str]:
    mod_map: dict[str, str] = {}
    for rel in rs_paths:
        parts = list(Path(rel).with_suffix("").parts)
        mod_parts = parts[parts.index("src") + 1 :] if "src" in parts else parts
        if mod_parts and mod_parts[-1] == "mod":
            mod_parts = mod_parts[:-1]
        if mod_parts:
            mod_map["::".join(mod_parts)] = rel
            mod_map.setdefault(mod_parts[-1], rel)
    return mod_map


class RustPlugin(NoFixPlugin):
    """Analyzes Rust crates using `Cargo.toml`/`Cargo.lock` and Tree-sitter AST heuristics."""

    name = "rust"
    languages = frozenset({"rust"})

    def analyze(
        self,
        worktree_root: Path,
        snapshot_idx: int,
        ast_files: dict[str, AstFileInfo],
    ) -> PluginResult:
        rs_paths = sorted(p for p, info in ast_files.items() if info.language == "rust")
        deps = _parse_cargo_deps(worktree_root, snapshot_idx)
        if not rs_paths:
            return PluginResult(external_deps=deps)

        mod_map = _build_rust_module_map(rs_paths)
        edges: set[tuple[str, str]] = set()

        for rel in rs_paths:
            cur_dir = Path(rel).parent
            for imp in ast_files[rel].raw_imports:
                target: str | None = None
                if imp.startswith("mod::"):
                    mod_name = imp.removeprefix("mod::")
                    for cand in (
                        (cur_dir / f"{mod_name}.rs").as_posix(),
                        (cur_dir / mod_name / "mod.rs").as_posix(),
                    ):
                        if cand in ast_files:
                            target = cand
                            break
                elif imp.startswith(("crate::", "self::", "super::")):
                    cleaned = (
                        imp.removeprefix("crate::").removeprefix("self::").removeprefix("super::")
                    )
                    seg = cleaned.split("{", 1)[0].strip(":")
                    parts = [s for s in seg.split("::") if s and s != "*"]
                    for end in range(len(parts), 0, -1):
                        key = "::".join(parts[:end])
                        if key in mod_map:
                            target = mod_map[key]
                            break
                if target and target != rel:
                    edges.add((rel, target))

        return PluginResult(
            imports=edges_to_imports(snapshot_idx, edges),
            diagnostics=structural_diagnostics_to_lint(
                snapshot_idx, rs_paths, ast_files, "tree-sitter-rust"
            ),
            external_deps=deps,
        )
