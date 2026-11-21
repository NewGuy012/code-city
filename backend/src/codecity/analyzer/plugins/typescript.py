"""TypeScript / JavaScript LanguagePlugin powered by the Bun toolchain."""

from __future__ import annotations

import difflib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from codecity.analyzer.plugins.base import PluginResult
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic

_TS_EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
_BUN_LINT_SUPPORTED: bool | None = None


def _find_bun() -> str | None:
    found = shutil.which("bun")
    if found:
        return found
    home_bun = Path.home() / ".bun" / "bin" / "bun"
    if home_bun.exists():
        return str(home_bun)
    return None


def _bun_supports_native_lint(bun_bin: str) -> bool:
    global _BUN_LINT_SUPPORTED
    if _BUN_LINT_SUPPORTED is not None:
        return _BUN_LINT_SUPPORTED
    try:
        proc = subprocess.run(
            [bun_bin, "lint", "--no-script", "--help"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        combined = proc.stdout + proc.stderr
        _BUN_LINT_SUPPORTED = proc.returncode == 0 and 'Script not found "lint"' not in combined
    except Exception:
        _BUN_LINT_SUPPORTED = False
    return _BUN_LINT_SUPPORTED


def _find_local_oxlint() -> str | None:
    # Check workspace frontend node_modules first, then PATH
    candidates = [
        Path.cwd() / "frontend" / "node_modules" / ".bin" / "oxlint",
        Path(__file__).resolve().parents[5] / "frontend" / "node_modules" / ".bin" / "oxlint",
    ]
    for cand in candidates:
        if cand.exists():
            return str(cand)
    return shutil.which("oxlint")


def _strip_jsonc(raw: str) -> str:
    # Remove // comments outside strings, /* ... */ comments, and trailing commas
    no_block = re.sub(r"/\*[\s\S]*?\*/", "", raw)
    lines = []
    for line in no_block.splitlines():
        # Conservative line-comment stripping when // isn't preceded by http(s):
        cleaned = re.sub(r"(^|[\s,{[\]])//.*$", r"\1", line)
        lines.append(cleaned)
    joined = "\n".join(lines)
    return re.sub(r",(\s*[}\]])", r"\1", joined)


def _parse_npm_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps: list[ExternalDep] = []
    seen: set[tuple[str, bool]] = set()
    direct_names: set[str] = set()

    for pkg_json in sorted(worktree_root.glob("**/package.json")):
        if "node_modules" in pkg_json.parts:
            continue
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            entries = data.get(section)
            if not isinstance(entries, dict):
                continue
            for name, ver in entries.items():
                direct_names.add(str(name))
                key = (str(name), True)
                if key not in seen:
                    seen.add(key)
                    deps.append(
                        ExternalDep(
                            snapshot_idx=snapshot_idx,
                            ecosystem="npm",
                            package_name=str(name),
                            version=str(ver),
                            is_direct=True,
                        )
                    )

    for bun_lock in sorted(worktree_root.glob("**/bun.lock")):
        if "node_modules" in bun_lock.parts:
            continue
        try:
            data = json.loads(_strip_jsonc(bun_lock.read_text(encoding="utf-8", errors="ignore")))
            packages = data.get("packages", {})
            if isinstance(packages, dict):
                for pkg_name, tuple_val in packages.items():
                    version = ""
                    if isinstance(tuple_val, list) and tuple_val:
                        spec = str(tuple_val[0])
                        if "@" in spec:
                            version = spec.rsplit("@", 1)[-1]
                    is_direct = str(pkg_name) in direct_names
                    key = (str(pkg_name), is_direct)
                    if key not in seen:
                        seen.add(key)
                        deps.append(
                            ExternalDep(
                                snapshot_idx=snapshot_idx,
                                ecosystem="npm",
                                package_name=str(pkg_name),
                                version=version,
                                is_direct=is_direct,
                            )
                        )
        except Exception:
            pass

    for pkg_lock in sorted(worktree_root.glob("**/package-lock.json")):
        if "node_modules" in pkg_lock.parts:
            continue
        try:
            data = json.loads(pkg_lock.read_text(encoding="utf-8", errors="ignore"))
            packages = data.get("packages", {})
            if isinstance(packages, dict):
                for key_path, meta in packages.items():
                    if not key_path.startswith("node_modules/"):
                        continue
                    pkg_name = key_path.split("node_modules/")[-1]
                    version = str(meta.get("version", "")) if isinstance(meta, dict) else ""
                    is_direct = pkg_name in direct_names
                    key = (pkg_name, is_direct)
                    if key not in seen:
                        seen.add(key)
                        deps.append(
                            ExternalDep(
                                snapshot_idx=snapshot_idx,
                                ecosystem="npm",
                                package_name=pkg_name,
                                version=version,
                                is_direct=is_direct,
                            )
                        )
        except Exception:
            pass

    return deps[:400]


def _load_tsconfig_aliases(worktree_root: Path) -> list[tuple[str, str, Path]]:
    aliases: list[tuple[str, str, Path]] = []
    for cfg in sorted(worktree_root.glob("**/tsconfig*.json")):
        if "node_modules" in cfg.parts:
            continue
        try:
            data = json.loads(_strip_jsonc(cfg.read_text(encoding="utf-8", errors="ignore")))
        except Exception:
            continue
        co = data.get("compilerOptions", {})
        if not isinstance(co, dict):
            continue
        base_url = co.get("baseUrl", ".")
        base_dir = (cfg.parent / str(base_url)).resolve()
        paths = co.get("paths", {})
        if isinstance(paths, dict):
            for pat, targets in paths.items():
                if isinstance(targets, list) and targets:
                    aliases.append((str(pat), str(targets[0]), base_dir))
    return aliases


def _resolve_ts_imports(
    worktree_root: Path,
    snapshot_idx: int,
    ast_files: dict[str, AstFileInfo],
) -> list[FileImport]:
    ts_files = {p for p, info in ast_files.items() if info.language in {"typescript", "javascript"}}
    if not ts_files:
        return []

    aliases = _load_tsconfig_aliases(worktree_root)
    root_res = worktree_root.resolve()
    edges: set[tuple[str, str]] = set()

    def try_candidates(cand_base: Path) -> str | None:
        candidates = [cand_base]
        for ext in _TS_EXTS:
            candidates.append(Path(f"{cand_base}{ext}"))
            candidates.append(cand_base / f"index{ext}")
        # Handle ESM TypeScript imports ending in .js pointing to .ts/.tsx
        if cand_base.suffix in {".js", ".jsx", ".mjs"}:
            stem = cand_base.with_suffix("")
            for ext in (".ts", ".tsx", ".mts", ".js", ".jsx"):
                candidates.append(Path(f"{stem}{ext}"))
        for c in candidates:
            try:
                rel = c.resolve().relative_to(root_res).as_posix()
            except ValueError:
                continue
            if rel in ts_files:
                return rel
        return None

    for rel in ts_files:
        src_dir = (worktree_root / rel).parent
        for imp in ast_files[rel].raw_imports:
            target: str | None = None
            if imp.startswith("."):
                target = try_candidates(src_dir / imp)
            else:
                for pat, repl, base_dir in aliases:
                    prefix = pat.rstrip("*")
                    if imp.startswith(prefix):
                        suffix = imp[len(prefix) :]
                        mapped = repl.replace("*", suffix)
                        target = try_candidates(base_dir / mapped)
                        if target:
                            break
            if target and target != rel:
                edges.add((rel, target))

    return [
        FileImport(snapshot_idx=snapshot_idx, source_file=s, target_file=t)
        for s, t in sorted(edges)
    ]


def _parse_lint_json(
    stdout: str,
    worktree_root: Path,
    snapshot_idx: int,
    ast_files: dict[str, AstFileInfo],
    linter_name: str,
) -> list[LintDiagnostic]:
    diagnostics: list[LintDiagnostic] = []
    txt = stdout.strip()
    if not txt:
        return diagnostics
    try:
        parsed: Any = json.loads(txt)
    except Exception:
        return diagnostics

    items: list[dict[str, Any]]
    if isinstance(parsed, dict) and isinstance(parsed.get("diagnostics"), list):
        items = parsed["diagnostics"]
    elif isinstance(parsed, list):
        items = parsed
    else:
        return diagnostics

    root_res = worktree_root.resolve()
    for item in items:
        raw_file = str(item.get("filename") or item.get("filePath") or "")
        if not raw_file:
            continue
        p = Path(raw_file)
        if not p.is_absolute():
            p = worktree_root / p
        try:
            rel_path = p.resolve().relative_to(root_res).as_posix()
        except ValueError:
            rel_path = raw_file
        if rel_path not in ast_files:
            continue

        line = 1
        col = 1
        labels = item.get("labels")
        if isinstance(labels, list) and labels:
            span = labels[0].get("span", {}) if isinstance(labels[0], dict) else {}
            line = int(span.get("line") or 1)
            col = int(span.get("column") or 1)
        elif "line" in item:
            line = int(item.get("line") or 1)
            col = int(item.get("column") or item.get("col") or 1)

        code = str(item.get("code") or item.get("ruleId") or "TS")
        severity = str(item.get("severity") or "warning").lower()
        cat = "correctness" if severity == "error" else "style"
        if "typescript" in code or "no-unused" in code:
            cat = "types" if "typescript" in code else "correctness"
        diagnostics.append(
            LintDiagnostic(
                snapshot_idx=snapshot_idx,
                file_path=rel_path,
                linter=linter_name,
                line=line,
                col=col,
                rule_code=code,
                category=cat,
                message=str(item.get("message") or ""),
                fixable=bool(item.get("fix") or item.get("fixable")),
                metadata={"url": item.get("url"), "help": item.get("help")},
            )
        )
    return diagnostics


class TypeScriptPlugin:
    """Analyzes TypeScript / JS repos with the Bun toolchain (`bun lint`/`oxlint`, `bun fmt`)."""

    name = "typescript"
    languages = frozenset({"typescript", "javascript"})

    def analyze(
        self,
        worktree_root: Path,
        snapshot_idx: int,
        ast_files: dict[str, AstFileInfo],
    ) -> PluginResult:
        ts_paths = sorted(
            p for p, info in ast_files.items() if info.language in {"typescript", "javascript"}
        )
        deps = _parse_npm_deps(worktree_root, snapshot_idx)
        if not ts_paths:
            return PluginResult(external_deps=deps)

        imports = _resolve_ts_imports(worktree_root, snapshot_idx, ast_files)
        diagnostics: list[LintDiagnostic] = []
        format_drift: set[str] = set()
        bun_bin = _find_bun()

        # 1. Lint: prefer native `bun lint --no-script -f json`, else `bun run oxlint -f json`
        ran_external_linter = False
        if bun_bin and _bun_supports_native_lint(bun_bin):
            try:
                proc = subprocess.run(
                    [bun_bin, "lint", "--no-script", "-f", "json", *ts_paths[:200]],
                    cwd=worktree_root,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=30,
                )
                diagnostics.extend(
                    _parse_lint_json(
                        proc.stdout, worktree_root, snapshot_idx, ast_files, "bun-lint"
                    )
                )
                ran_external_linter = True
            except Exception:
                pass
        elif bun_bin:
            oxlint_bin = _find_local_oxlint()
            if oxlint_bin:
                try:
                    proc = subprocess.run(
                        [bun_bin, "run", oxlint_bin, "-f", "json", *ts_paths[:200]],
                        cwd=worktree_root,
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        timeout=30,
                    )
                    diagnostics.extend(
                        _parse_lint_json(
                            proc.stdout, worktree_root, snapshot_idx, ast_files, "bun-oxlint"
                        )
                    )
                    ran_external_linter = True
                except Exception:
                    pass

        # Include Tree-sitter structural diagnostics (complexity, empty catch, oversized module)
        for rel in ts_paths:
            for sdiag in ast_files[rel].structural_diagnostics:
                diagnostics.append(
                    LintDiagnostic(
                        snapshot_idx=snapshot_idx,
                        file_path=rel,
                        linter="tree-sitter" if not ran_external_linter else "codecity-ast",
                        line=sdiag.line,
                        col=sdiag.col,
                        rule_code=sdiag.rule_code,
                        category=sdiag.category,
                        message=sdiag.message,
                        fixable=sdiag.fixable,
                    )
                )

        # 2. Format drift via `bun fmt --no-script --check`
        if bun_bin:
            try:
                fmt_proc = subprocess.run(
                    [bun_bin, "fmt", "--no-script", "--check", *ts_paths[:200]],
                    cwd=worktree_root,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=20,
                )
                if fmt_proc.returncode != 0:
                    for raw_line in fmt_proc.stdout.splitlines():
                        cleaned = Path(raw_line.strip()).as_posix().lstrip("./")
                        if cleaned in ast_files:
                            format_drift.add(cleaned)
            except Exception:
                pass

        return PluginResult(
            imports=imports,
            diagnostics=diagnostics,
            format_drift_files=format_drift,
            external_deps=deps,
        )

    def preview_fix(self, repo_root: Path, file_path: str) -> FixDiffResult | None:
        if not file_path.endswith(_TS_EXTS):
            return None
        target = repo_root / file_path
        if not target.exists():
            return None
        bun_bin = _find_bun()
        if not bun_bin:
            return FixDiffResult(
                file_path=file_path,
                linter="bun",
                has_changes=False,
                diff="",
                message="Bun binary not found in PATH.",
            )

        original = target.read_text(encoding="utf-8", errors="replace")
        with tempfile.TemporaryDirectory() as td:
            tmp_file = Path(td) / Path(file_path).name
            tmp_file.write_text(original, encoding="utf-8")
            linter_label = "bun lint --fix"
            if _bun_supports_native_lint(bun_bin):
                subprocess.run(
                    [bun_bin, "lint", "--no-script", "--fix", str(tmp_file)],
                    cwd=td,
                    capture_output=True,
                    timeout=15,
                )
            else:
                oxlint_bin = _find_local_oxlint()
                if oxlint_bin:
                    linter_label = "oxlint --fix + bun fmt"
                    subprocess.run(
                        [bun_bin, "run", oxlint_bin, "--fix", str(tmp_file)],
                        cwd=td,
                        capture_output=True,
                        timeout=15,
                    )
            subprocess.run(
                [bun_bin, "fmt", "--no-script", str(tmp_file)],
                cwd=td,
                capture_output=True,
                timeout=15,
            )
            fixed = tmp_file.read_text(encoding="utf-8", errors="replace")

        diff_lines = list(
            difflib.unified_diff(
                original.splitlines(keepends=True),
                fixed.splitlines(keepends=True),
                fromfile=f"a/{file_path}",
                tofile=f"b/{file_path}",
            )
        )
        diff_txt = "".join(diff_lines)
        return FixDiffResult(
            file_path=file_path,
            linter=linter_label,
            has_changes=bool(diff_txt.strip()),
            diff=diff_txt,
            fixed_content=fixed if diff_txt.strip() else None,
            message="Bun auto-fix preview ready" if diff_txt.strip() else "File already clean.",
        )
