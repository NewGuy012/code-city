"""TypeScript / JavaScript LanguagePlugin powered by the Bun toolchain."""

from __future__ import annotations

import difflib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from codecity.analyzer.plugins.base import (
    TS_EXTS,
    DepCollector,
    PluginResult,
    edges_to_imports,
    find_bun,
    find_local_oxlint,
    safe_repo_target,
    structural_diagnostics_to_lint,
)
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic

_BUN_LINT_SUPPORTED: bool | None = None


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


def _strip_jsonc(raw: str) -> str:
    no_block = re.sub(r"/\*[\s\S]*?\*/", "", raw)
    lines = [re.sub(r"(^|[\s,{[\]])//.*$", r"\1", line) for line in no_block.splitlines()]
    return re.sub(r",(\s*[}\]])", r"\1", "\n".join(lines))


def _parse_npm_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps = DepCollector(snapshot_idx, "npm")

    for pkg_json in sorted(worktree_root.glob("**/package.json")):
        if "node_modules" in pkg_json.parts:
            continue
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            entries = data.get(section)
            if isinstance(entries, dict):
                for name, ver in entries.items():
                    deps.add(str(name), str(ver), is_direct=True)

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
                    deps.add(str(pkg_name), version, is_direct=deps.is_direct(str(pkg_name)))
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
                    deps.add(pkg_name, version, is_direct=deps.is_direct(pkg_name))
        except Exception:
            pass

    return deps.items


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
        base_dir = (cfg.parent / str(co.get("baseUrl", "."))).resolve()
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
        for ext in TS_EXTS:
            candidates.append(Path(f"{cand_base}{ext}"))
            candidates.append(cand_base / f"index{ext}")
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
                        mapped = repl.replace("*", imp[len(prefix) :])
                        target = try_candidates(base_dir / mapped)
                        if target:
                            break
            if target and target != rel:
                edges.add((rel, target))

    return edges_to_imports(snapshot_idx, edges)


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

        line, col = 1, 1
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
        if "typescript" in code:
            cat = "types"
        elif "no-unused" in code:
            cat = "correctness"
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
        bun_bin = find_bun()

        ran_external_linter = False
        if bun_bin:
            lint_cmd: list[str] | None = None
            linter_name = "bun-lint"
            if _bun_supports_native_lint(bun_bin):
                lint_cmd = [bun_bin, "lint", "--no-script", "-f", "json", "--", *ts_paths[:200]]
            else:
                oxlint_bin = find_local_oxlint()
                if oxlint_bin:
                    linter_name = "bun-oxlint"
                    lint_cmd = [bun_bin, "run", oxlint_bin, "-f", "json", "--", *ts_paths[:200]]

            if lint_cmd is not None:
                try:
                    proc = subprocess.run(
                        lint_cmd,
                        cwd=worktree_root,
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        timeout=30,
                    )
                    diagnostics.extend(
                        _parse_lint_json(
                            proc.stdout, worktree_root, snapshot_idx, ast_files, linter_name
                        )
                    )
                    ran_external_linter = True
                except Exception:
                    pass

        diagnostics.extend(
            structural_diagnostics_to_lint(
                snapshot_idx,
                ts_paths,
                ast_files,
                "tree-sitter" if not ran_external_linter else "codecity-ast",
            )
        )

        if bun_bin:
            by_cfg_dir: dict[Path, list[str]] = {}
            wt_res = worktree_root.resolve()
            for rel in ts_paths[:200]:
                cur = (wt_res / rel).parent
                cfg_dir = wt_res
                while cur != wt_res.parent:
                    if (cur / "bunfig.toml").exists() or (cur / "package.json").exists():
                        cfg_dir = cur
                        break
                    if cur == wt_res:
                        break
                    cur = cur.parent
                by_cfg_dir.setdefault(cfg_dir, []).append(
                    (wt_res / rel).relative_to(cfg_dir).as_posix()
                )

            for cfg_dir, sub_paths in by_cfg_dir.items():
                try:
                    fmt_proc = subprocess.run(
                        [bun_bin, "fmt", "--no-script", "--check", "--", *sub_paths],
                        cwd=cfg_dir,
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        timeout=20,
                    )
                    if fmt_proc.returncode != 0:
                        for raw_line in fmt_proc.stdout.splitlines():
                            cand = (cfg_dir / raw_line.strip()).resolve()
                            try:
                                cleaned = cand.relative_to(wt_res).as_posix()
                            except ValueError:
                                continue
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
        if not file_path.endswith(TS_EXTS):
            return None
        target = safe_repo_target(repo_root, file_path)
        if not target.is_file():
            return None
        bun_bin = find_bun()
        if not bun_bin:
            return FixDiffResult(
                file_path=file_path,
                linter="bun",
                has_changes=False,
                diff="",
                message="Bun binary not found in PATH.",
            )

        rel = target.relative_to(repo_root.resolve()).as_posix()
        original = target.read_text(encoding="utf-8", errors="replace")
        with tempfile.TemporaryDirectory() as td:
            tmp_file = Path(td) / target.name
            tmp_file.write_text(original, encoding="utf-8")
            linter_label = "bun lint --fix"
            if _bun_supports_native_lint(bun_bin):
                subprocess.run(
                    [bun_bin, "lint", "--no-script", "--fix", "--", str(tmp_file)],
                    cwd=td,
                    capture_output=True,
                    timeout=15,
                )
            else:
                oxlint_bin = find_local_oxlint()
                if oxlint_bin:
                    linter_label = "oxlint --fix + bun fmt"
                    subprocess.run(
                        [bun_bin, "run", oxlint_bin, "--fix", "--", str(tmp_file)],
                        cwd=td,
                        capture_output=True,
                        timeout=15,
                    )
            subprocess.run(
                [bun_bin, "fmt", "--no-script", "--", str(tmp_file)],
                cwd=td,
                capture_output=True,
                timeout=15,
            )
            fixed = tmp_file.read_text(encoding="utf-8", errors="replace")

        diff_txt = "".join(
            difflib.unified_diff(
                original.splitlines(keepends=True),
                fixed.splitlines(keepends=True),
                fromfile=f"a/{rel}",
                tofile=f"b/{rel}",
            )
        )
        return FixDiffResult(
            file_path=rel,
            linter=linter_label,
            has_changes=bool(diff_txt.strip()),
            diff=diff_txt,
            message="Bun auto-fix preview ready" if diff_txt.strip() else "File already clean.",
        )
