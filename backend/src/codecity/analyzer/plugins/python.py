"""Python LanguagePlugin: ruff linting, ruff import graph + AST resolution, uv/pyproject deps."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

from codecity.analyzer.plugins.base import PluginResult
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic


def _ruff_cmd() -> list[str]:
    """Locate the `ruff` CLI executable reliably inside or outside the active venv."""
    venv_ruff = Path(sys.executable).parent / "ruff"
    if venv_ruff.exists():
        return [str(venv_ruff)]
    found = shutil.which("ruff")
    if found:
        return [found]
    return [sys.executable, "-m", "ruff"]


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


def _parse_python_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps: list[ExternalDep] = []
    seen: set[tuple[str, bool]] = set()
    direct_names: set[str] = set()

    pyproject = worktree_root / "pyproject.toml"
    if pyproject.exists():
        try:
            data = tomllib.loads(pyproject.read_text(encoding="utf-8", errors="ignore"))
            raw_deps = list(data.get("project", {}).get("dependencies", []))
            for item in raw_deps:
                name = _extract_pkg_name(str(item))
                if name:
                    direct_names.add(name.lower())
                    if (name.lower(), True) not in seen:
                        seen.add((name.lower(), True))
                        deps.append(
                            ExternalDep(
                                snapshot_idx=snapshot_idx,
                                ecosystem="python",
                                package_name=name,
                                version=str(item).removeprefix(name).strip() or "*",
                                is_direct=True,
                            )
                        )
            poetry_deps = data.get("tool", {}).get("poetry", {}).get("dependencies", {})
            for name, spec in poetry_deps.items():
                if name.lower() == "python":
                    continue
                direct_names.add(name.lower())
                if (name.lower(), True) not in seen:
                    seen.add((name.lower(), True))
                    deps.append(
                        ExternalDep(
                            snapshot_idx=snapshot_idx,
                            ecosystem="python",
                            package_name=name,
                            version=str(spec),
                            is_direct=True,
                        )
                    )
        except Exception:
            pass

    for req_file in sorted(worktree_root.glob("requirements*.txt")):
        try:
            for line in req_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                stripped = line.split("#", 1)[0].strip()
                if not stripped or stripped.startswith("-"):
                    continue
                name = _extract_pkg_name(stripped)
                if name and (name.lower(), True) not in seen:
                    direct_names.add(name.lower())
                    seen.add((name.lower(), True))
                    deps.append(
                        ExternalDep(
                            snapshot_idx=snapshot_idx,
                            ecosystem="python",
                            package_name=name,
                            version=stripped.removeprefix(name).strip() or "*",
                            is_direct=True,
                        )
                    )
        except OSError:
            pass

    uv_lock = worktree_root / "uv.lock"
    if uv_lock.exists():
        try:
            lock_data = tomllib.loads(uv_lock.read_text(encoding="utf-8", errors="ignore"))
            for pkg in lock_data.get("package", []):
                name = str(pkg.get("name", "")).strip()
                if not name:
                    continue
                version = str(pkg.get("version", ""))
                is_direct = name.lower() in direct_names
                if (name.lower(), is_direct) in seen:
                    continue
                seen.add((name.lower(), is_direct))
                deps.append(
                    ExternalDep(
                        snapshot_idx=snapshot_idx,
                        ecosystem="python",
                        package_name=name,
                        version=version,
                        is_direct=is_direct,
                    )
                )
        except Exception:
            pass

    return deps[:400]


def _extract_pkg_name(spec: str) -> str:
    spec = spec.strip().split(";")[0].strip()
    for sep in ("[", "=", ">", "<", "~", "!", "@", " "):
        if sep in spec:
            spec = spec.split(sep, 1)[0]
    return spec.strip()


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
            # Strip common src/ or backend/src/ roots so `from pkg.mod import ...` resolves
            mod = ".".join(parts[start:])
            if mod and mod not in module_to_file:
                module_to_file[mod] = rel

    edges: set[tuple[str, str]] = set()
    for rel in py_files:
        info = ast_files[rel]
        cur_parts = list(Path(rel).parent.parts)
        for imp in info.raw_imports:
            target: str | None = None
            if imp.startswith("."):
                dots = len(imp) - len(imp.lstrip("."))
                rem = imp.lstrip(".")
                base_parts = cur_parts[: max(0, len(cur_parts) - (dots - 1))]
                if rem:
                    base_parts.extend(rem.split("."))
                cand_mod = ".".join(base_parts)
                target = module_to_file.get(cand_mod)
            else:
                target = module_to_file.get(imp)
                if not target and "." in imp:
                    target = module_to_file.get(imp.rsplit(".", 1)[0])
            if target and target != rel:
                edges.add((rel, target))

    return [
        FileImport(snapshot_idx=snapshot_idx, source_file=src, target_file=dst)
        for src, dst in sorted(edges)
    ]


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

        ruff = _ruff_cmd()
        diagnostics: list[LintDiagnostic] = []
        edge_set: set[tuple[str, str]] = set()

        # 1. Run `ruff check --output-format=json` across Python files
        try:
            proc = subprocess.run(
                [*ruff, "check", "--no-cache", "--output-format=json", *py_paths],
                cwd=worktree_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
            if proc.stdout.strip().startswith("["):
                items = json.loads(proc.stdout)
                for item in items:
                    raw_fname = str(item.get("filename", ""))
                    try:
                        rel_path = (
                            Path(raw_fname)
                            .resolve()
                            .relative_to(worktree_root.resolve())
                            .as_posix()
                        )
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

        # 2. Run `ruff analyze graph` and merge with AST resolution
        try:
            gproc = subprocess.run(
                [*ruff, "analyze", "graph", "--direction", "dependencies", *py_paths],
                cwd=worktree_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            )
            if gproc.returncode == 0 and gproc.stdout.strip().startswith("{"):
                graph_data: dict[str, list[str]] = json.loads(gproc.stdout)
                for src, targets in graph_data.items():
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

        imports = [
            FileImport(snapshot_idx=snapshot_idx, source_file=s, target_file=t)
            for s, t in sorted(edge_set)
        ]

        return PluginResult(
            imports=imports,
            diagnostics=diagnostics,
            external_deps=deps,
        )

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None:
        if not file_path.endswith((".py", ".pyi")):
            return None
        target = repo_root / file_path
        if not target.exists():
            return None
        ruff = _ruff_cmd()
        diff_proc = subprocess.run(
            [*ruff, "check", "--no-cache", "--fix", "--diff", file_path],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        diff_txt = diff_proc.stdout
        return FixDiffResult(
            file_path=file_path,
            linter="ruff",
            has_changes=bool(diff_txt.strip()),
            diff=diff_txt,
            message="Ruff auto-fix preview ready"
            if diff_txt.strip()
            else "No auto-fixable ruff issues.",
        )
