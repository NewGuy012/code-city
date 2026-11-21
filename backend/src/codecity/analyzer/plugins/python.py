"""Python LanguagePlugin: ruff linting, ruff import graph + AST resolution, uv/pyproject deps."""

from __future__ import annotations

import json
import subprocess
import tomllib
from pathlib import Path

from codecity.analyzer.plugins.base import (
    DepCollector,
    PluginResult,
    edges_to_imports,
    ruff_cmd,
    safe_repo_target,
)
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic


def _categorize_ruff_code(code: str) -> str:
    if not code:
        return "style"
    prefix = code[0].upper()
    if prefix in {"F", "E"} and code.startswith(("F8", "F4", "E9")):
        return "correctness"
    if prefix in {"B", "S"}:
        return "safety"
    if prefix in {"P", "N", "I", "UP", "D"}:
        return "style"
    if prefix in {"C", "R"}:
        return "complexity"
    return "lint"


def _extract_pkg_name(spec: str) -> str:
    spec = spec.strip().split(";")[0].strip()
    for sep in ("[", "=", ">", "<", "~", "!", "@", " "):
        if sep in spec:
            spec = spec.split(sep, 1)[0]
    return spec.strip()


def _parse_python_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps = DepCollector(snapshot_idx, "python", case_insensitive=True)

    pyproject = worktree_root / "pyproject.toml"
    if pyproject.exists():
        try:
            data = tomllib.loads(pyproject.read_text(encoding="utf-8", errors="ignore"))
            for item in data.get("project", {}).get("dependencies", []):
                name = _extract_pkg_name(str(item))
                if name:
                    deps.add(name, str(item).removeprefix(name).strip() or "*", is_direct=True)
            for name, spec in (
                data.get("tool", {}).get("poetry", {}).get("dependencies", {}).items()
            ):
                if name.lower() != "python":
                    deps.add(str(name), str(spec), is_direct=True)
        except Exception:
            pass

    for req_file in sorted(worktree_root.glob("requirements*.txt")):
        try:
            for line in req_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                stripped = line.split("#", 1)[0].strip()
                if stripped and not stripped.startswith("-"):
                    name = _extract_pkg_name(stripped)
                    if name:
                        deps.add(name, stripped.removeprefix(name).strip() or "*", is_direct=True)
        except OSError:
            pass

    uv_lock = worktree_root / "uv.lock"
    if uv_lock.exists():
        try:
            lock_data = tomllib.loads(uv_lock.read_text(encoding="utf-8", errors="ignore"))
            for pkg in lock_data.get("package", []):
                name = str(pkg.get("name", "")).strip()
                if name:
                    deps.add(name, str(pkg.get("version", "")), is_direct=deps.is_direct(name))
        except Exception:
            pass

    return deps.items


def _resolve_python_imports_fallback(
    ast_files: dict[str, AstFileInfo],
    snapshot_idx: int,
) -> list[FileImport]:
    py_files = {p for p, info in ast_files.items() if info.language == "python"}
    if not py_files:
        return []

    module_to_file: dict[str, str] = {}
    for rel in py_files:
        parts = list(Path(rel).with_suffix("").parts)
        if parts and parts[-1] == "__init__":
            parts = parts[:-1]
        for start in range(len(parts)):
            mod = ".".join(parts[start:])
            if mod and mod not in module_to_file:
                module_to_file[mod] = rel

    edges: set[tuple[str, str]] = set()
    for rel in py_files:
        cur_parts = list(Path(rel).parent.parts)
        for imp in ast_files[rel].raw_imports:
            if imp.startswith("."):
                dots = len(imp) - len(imp.lstrip("."))
                rem = imp.lstrip(".")
                base_parts = cur_parts[: max(0, len(cur_parts) - (dots - 1))]
                if rem:
                    base_parts.extend(rem.split("."))
                target = module_to_file.get(".".join(base_parts))
            else:
                target = module_to_file.get(imp)
                if not target and "." in imp:
                    target = module_to_file.get(imp.rsplit(".", 1)[0])
            if target and target != rel:
                edges.add((rel, target))

    return edges_to_imports(snapshot_idx, edges)


class PythonPlugin:
    """Analyzes Python modules using `ruff`, `ruff analyze graph`, and `uv`/`pyproject.toml`."""

    name = "python"
    languages = frozenset({"python"})

    def analyze(
        self,
        worktree_root: Path,
        snapshot_idx: int,
        ast_files: dict[str, AstFileInfo],
    ) -> PluginResult:
        py_paths = sorted(p for p, info in ast_files.items() if info.language == "python")
        deps = _parse_python_deps(worktree_root, snapshot_idx)
        if not py_paths:
            return PluginResult(external_deps=deps)

        ruff = ruff_cmd()
        diagnostics: list[LintDiagnostic] = []
        edge_set: set[tuple[str, str]] = set()
        wt_root = worktree_root.resolve()

        try:
            proc = subprocess.run(
                [*ruff, "check", "--no-cache", "--output-format=json", "--", *py_paths],
                cwd=worktree_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
            if proc.stdout.strip().startswith("["):
                for item in json.loads(proc.stdout):
                    raw_fname = str(item.get("filename", ""))
                    try:
                        rel_path = Path(raw_fname).resolve().relative_to(wt_root).as_posix()
                    except ValueError:
                        rel_path = raw_fname
                    if rel_path not in ast_files:
                        continue
                    loc = item.get("location") or {}
                    code = str(item.get("code") or "RUFF")
                    diagnostics.append(
                        LintDiagnostic(
                            snapshot_idx=snapshot_idx,
                            file_path=rel_path,
                            linter="ruff",
                            line=int(loc.get("row") or 1),
                            col=int(loc.get("column") or 1),
                            rule_code=code,
                            category=_categorize_ruff_code(code),
                            message=str(item.get("message") or ""),
                            fixable=item.get("fix") is not None,
                            metadata={"url": item.get("url")},
                        )
                    )
        except Exception:
            pass

        try:
            gproc = subprocess.run(
                [*ruff, "analyze", "graph", "--direction", "dependencies", "--", *py_paths],
                cwd=worktree_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            )
            if gproc.returncode == 0 and gproc.stdout.strip().startswith("{"):
                for src, targets in json.loads(gproc.stdout).items():
                    src_norm = Path(src).as_posix()
                    if src_norm not in ast_files:
                        continue
                    for dst in targets:
                        dst_norm = Path(dst).as_posix()
                        if dst_norm in ast_files and dst_norm != src_norm:
                            edge_set.add((src_norm, dst_norm))
        except Exception:
            pass

        for imp in _resolve_python_imports_fallback(ast_files, snapshot_idx):
            edge_set.add((imp.source_file, imp.target_file))

        return PluginResult(
            imports=edges_to_imports(snapshot_idx, edge_set),
            diagnostics=diagnostics,
            external_deps=deps,
        )

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None:
        if not file_path.endswith((".py", ".pyi")):
            return None
        target = safe_repo_target(repo_root, file_path)
        if not target.is_file():
            return None
        rel = target.relative_to(repo_root.resolve()).as_posix()
        diff_proc = subprocess.run(
            [*ruff_cmd(), "check", "--no-cache", "--fix", "--diff", "--", rel],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        diff_txt = diff_proc.stdout
        return FixDiffResult(
            file_path=rel,
            linter="ruff",
            has_changes=bool(diff_txt.strip()),
            diff=diff_txt,
            message="Ruff auto-fix preview ready"
            if diff_txt.strip()
            else "No auto-fixable ruff issues.",
        )
