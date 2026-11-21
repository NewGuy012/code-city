"""Rust LanguagePlugin: Cargo.toml/Cargo.lock dependencies, crate/mod graph, AST lints."""

from __future__ import annotations

import tomllib
from pathlib import Path

from codecity.analyzer.plugins.base import PluginResult
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic


def _parse_cargo_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps: list[ExternalDep] = []
    seen: set[tuple[str, bool]] = set()
    direct_names: set[str] = set()

    for cargo_toml in sorted(worktree_root.glob("**/Cargo.toml")):
        if "target" in cargo_toml.parts:
            continue
        try:
            data = tomllib.loads(cargo_toml.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            tbl = data.get(section)
            if not isinstance(tbl, dict):
                continue
            for name, spec in tbl.items():
                direct_names.add(str(name))
                ver = str(spec.get("version", "*")) if isinstance(spec, dict) else str(spec)
                key = (str(name), True)
                if key not in seen:
                    seen.add(key)
                    deps.append(
                        ExternalDep(
                            snapshot_idx=snapshot_idx,
                            ecosystem="rust",
                            package_name=str(name),
                            version=ver,
                            is_direct=True,
                        )
                    )

    cargo_lock = worktree_root / "Cargo.lock"
    if cargo_lock.exists():
        try:
            lock_data = tomllib.loads(cargo_lock.read_text(encoding="utf-8", errors="ignore"))
            for pkg in lock_data.get("package", []):
                name = str(pkg.get("name", "")).strip()
                if not name:
                    continue
                ver = str(pkg.get("version", ""))
                is_direct = name in direct_names
                key = (name, is_direct)
                if key not in seen:
                    seen.add(key)
                    deps.append(
                        ExternalDep(
                            snapshot_idx=snapshot_idx,
                            ecosystem="rust",
                            package_name=name,
                            version=ver,
                            is_direct=is_direct,
                        )
                    )
        except Exception:
            pass

    return deps[:400]


def _build_rust_module_map(rs_paths: list[str]) -> dict[str, str]:
    mod_map: dict[str, str] = {}
    for rel in rs_paths:
        p = Path(rel)
        parts = list(p.with_suffix("").parts)
        # Strip leading src/ or crates/<name>/src/
        if "src" in parts:
            src_idx = parts.index("src")
            mod_parts = parts[src_idx + 1 :]
        else:
            mod_parts = parts
        if mod_parts and mod_parts[-1] == "mod":
            mod_parts = mod_parts[:-1]
        if mod_parts:
            mod_map["::".join(mod_parts)] = rel
            mod_map[mod_parts[-1]] = mod_map.get(mod_parts[-1], rel)
    return mod_map


class RustPlugin:
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
        diagnostics: list[LintDiagnostic] = []

        for rel in rs_paths:
            info = ast_files[rel]
            for sdiag in info.structural_diagnostics:
                diagnostics.append(
                    LintDiagnostic(
                        snapshot_idx=snapshot_idx,
                        file_path=rel,
                        linter="tree-sitter-rust",
                        line=sdiag.line,
                        col=sdiag.col,
                        rule_code=sdiag.rule_code,
                        category=sdiag.category,
                        message=sdiag.message,
                        fixable=sdiag.fixable,
                    )
                )

            cur_dir = Path(rel).parent
            for imp in info.raw_imports:
                target: str | None = None
                if imp.startswith("mod::"):
                    mod_name = imp.removeprefix("mod::")
                    cand_a = (cur_dir / f"{mod_name}.rs").as_posix()
                    cand_b = (cur_dir / mod_name / "mod.rs").as_posix()
                    if cand_a in ast_files:
                        target = cand_a
                    elif cand_b in ast_files:
                        target = cand_b
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

        imports = [
            FileImport(snapshot_idx=snapshot_idx, source_file=s, target_file=t)
            for s, t in sorted(edges)
        ]
        return PluginResult(imports=imports, diagnostics=diagnostics, external_deps=deps)

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None:
        return None
