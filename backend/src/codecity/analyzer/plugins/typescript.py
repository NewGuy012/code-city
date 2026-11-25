"""TypeScript / JavaScript LanguagePlugin powered by the Bun toolchain."""

from __future__ import annotations

import difflib
import json
import re
import tempfile
from pathlib import Path
from typing import Any

from codecity.analyzer.plugins.base import (
    TS_EXTS,
    DepCollector,
    PluginResult,
    edges_to_imports,
    extract_bun_fmt_config,
    find_bun,
    iter_repo_files,
    resolve_rel_path,
    run_batched_tool,
    run_tool,
    safe_bun_lint_prefix,
    safe_read_text,
    safe_repo_target,
    structural_diagnostics_to_lint,
)
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import ExternalDep, FileImport, FixDiffResult, LintDiagnostic


def _strip_jsonc(raw: str) -> str:
    no_block = re.sub(r"/\*[\s\S]*?\*/", "", raw)
    lines = [re.sub(r"(^|[\s,{[\]])//.*$", r"\1", line) for line in no_block.splitlines()]
    return re.sub(r",(\s*[}\]])", r"\1", "\n".join(lines))


def _find_nearest_bun_cfg_dir(root: Path, target: Path) -> Path:
    root_res = root.resolve()
    cur = target.resolve().parent
    while cur != root_res.parent:
        if (cur / "bunfig.toml").exists() or (cur / "package.json").exists():
            return cur
        if cur == root_res:
            break
        cur = cur.parent
    return root_res


def _run_ts_fixes(target: Path, cwd: Path, bun_bin: str) -> str:
    with safe_bun_lint_prefix(bun_bin) as prefix:
        run_tool([*prefix, "--fix", "--", str(target)], cwd, timeout=15)
    run_tool([bun_bin, "fmt", "--no-script", "--", str(target)], cwd, timeout=15)
    return "bun lint --fix + bun fmt"


def _parse_npm_deps(worktree_root: Path, snapshot_idx: int) -> list[ExternalDep]:
    deps = DepCollector(snapshot_idx, "npm")
    by_name: dict[str, list[Path]] = {"package.json": [], "bun.lock": [], "package-lock.json": []}
    for path in iter_repo_files(worktree_root, names=frozenset(by_name)):
        by_name[path.name].append(path)

    for pkg_json in by_name["package.json"]:
        raw = safe_read_text(worktree_root, pkg_json)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            entries = data.get(section)
            if isinstance(entries, dict):
                for name, ver in entries.items():
                    deps.add(str(name), str(ver), is_direct=True)

    for bun_lock in by_name["bun.lock"]:
        raw = safe_read_text(worktree_root, bun_lock)
        if not raw:
            continue
        try:
            packages = json.loads(_strip_jsonc(raw)).get("packages", {})
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

    for pkg_lock in by_name["package-lock.json"]:
        raw = safe_read_text(worktree_root, pkg_lock)
        if not raw:
            continue
        try:
            packages = json.loads(raw).get("packages", {})
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
    for cfg in iter_repo_files(worktree_root, prefixes=("tsconfig",), suffixes=(".json",)):
        raw = safe_read_text(worktree_root, cfg)
        if not raw:
            continue
        try:
            data = json.loads(_strip_jsonc(raw))
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
        items = []
        for entry in parsed:
            if isinstance(entry, dict) and isinstance(entry.get("messages"), list):
                fp = str(entry.get("filePath") or entry.get("filename") or "")
                items.extend(
                    {"filename": fp, **m} for m in entry["messages"] if isinstance(m, dict)
                )
            elif isinstance(entry, dict):
                items.append(entry)
    else:
        return diagnostics

    for item in items:
        raw_file = str(item.get("filename") or item.get("filePath") or "")
        if not raw_file:
            continue
        rel_path = resolve_rel_path(worktree_root, raw_file)
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
        raw_sev = item.get("severity")
        severity = "error" if raw_sev == 2 else str(raw_sev or "warning").lower()
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
    """Analyzes TypeScript / JS repos with native Bun tools (`bun lint`, `bun fmt`)."""

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
            try:
                with safe_bun_lint_prefix(bun_bin) as prefix:
                    procs = run_batched_tool(
                        [*prefix, "--format", "json", "--"],
                        ts_paths,
                        worktree_root,
                        timeout=30,
                    )
                for proc in procs:
                    diagnostics.extend(
                        _parse_lint_json(
                            proc.stdout, worktree_root, snapshot_idx, ast_files, "bun-lint"
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
            for rel in ts_paths:
                cfg_dir = _find_nearest_bun_cfg_dir(wt_res, wt_res / rel)
                by_cfg_dir.setdefault(cfg_dir, []).append(
                    (wt_res / rel).relative_to(cfg_dir).as_posix()
                )

            for cfg_dir, sub_paths in by_cfg_dir.items():
                try:
                    for fmt_proc in run_batched_tool(
                        [bun_bin, "fmt", "--no-script", "--check", "--"],
                        sub_paths,
                        cfg_dir,
                        timeout=20,
                    ):
                        if fmt_proc.returncode == 0:
                            continue
                        for raw_line in fmt_proc.stdout.splitlines():
                            cleaned = resolve_rel_path(wt_res, raw_line.strip(), base_dir=cfg_dir)
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
        cfg_dir = _find_nearest_bun_cfg_dir(repo_root, target)
        bunfig_raw = safe_read_text(repo_root, cfg_dir / "bunfig.toml")
        safe_fmt = extract_bun_fmt_config(bunfig_raw) if bunfig_raw is not None else None
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            if safe_fmt is not None:
                (td_path / "bunfig.toml").write_text(safe_fmt, encoding="utf-8")
            tmp_file = td_path / target.name
            tmp_file.write_text(original, encoding="utf-8")
            linter_label = _run_ts_fixes(tmp_file, td_path, bun_bin)
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

    def apply_fix(self, repo_root: Path, file_path: str) -> bool:
        if not file_path.endswith(TS_EXTS):
            return False
        target = safe_repo_target(repo_root, file_path)
        if not target.is_file():
            return False
        bun_bin = find_bun()
        if not bun_bin:
            return False
        _run_ts_fixes(target, _find_nearest_bun_cfg_dir(repo_root, target), bun_bin)
        return True
