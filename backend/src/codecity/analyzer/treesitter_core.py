"""Unified Tree-sitter AST, complexity, import, and structural lint extractor."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tree_sitter_go
import tree_sitter_javascript
import tree_sitter_python
import tree_sitter_rust
import tree_sitter_typescript
from tree_sitter import Language, Node, Parser

SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "target",
        "dist",
        "build",
        "__pycache__",
        ".next",
        ".turbo",
        ".codecity",
        ".pytest_cache",
        ".ruff_cache",
        "coverage",
    }
)

SKIP_EXTENSIONS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".ico",
        ".svg",
        ".woff",
        ".woff2",
        ".ttf",
        ".eot",
        ".wasm",
        ".pdf",
        ".zip",
        ".tar",
        ".gz",
        ".parquet",
        ".ducklake",
        ".duckdb",
        ".pyc",
        ".so",
        ".dylib",
        ".dll",
        ".exe",
        ".bin",
    }
)

MAX_ANALYZED_FILE_BYTES = 512 * 1024

_LANG_CACHE: dict[str, Language] = {}


def _get_language(lang_key: str) -> Language:
    if lang_key not in _LANG_CACHE:
        loaders = {
            "python": tree_sitter_python.language,
            "typescript": tree_sitter_typescript.language_typescript,
            "tsx": tree_sitter_typescript.language_tsx,
            "javascript": tree_sitter_javascript.language,
            "rust": tree_sitter_rust.language,
            "go": tree_sitter_go.language,
        }
        _LANG_CACHE[lang_key] = Language(loaders[lang_key]())
    return _LANG_CACHE[lang_key]


EXT_TO_LANG: dict[str, tuple[str, str | None]] = {
    ".py": ("python", "python"),
    ".pyi": ("python", "python"),
    ".ts": ("typescript", "typescript"),
    ".mts": ("typescript", "typescript"),
    ".cts": ("typescript", "typescript"),
    ".tsx": ("typescript", "tsx"),
    ".js": ("javascript", "tsx"),
    ".mjs": ("javascript", "tsx"),
    ".cjs": ("javascript", "tsx"),
    ".jsx": ("javascript", "tsx"),
    ".rs": ("rust", "rust"),
    ".go": ("go", "go"),
    ".sql": ("sql", None),
    ".css": ("css", None),
    ".scss": ("css", None),
    ".html": ("html", None),
    ".md": ("markdown", None),
    ".toml": ("config", None),
    ".yaml": ("config", None),
    ".yml": ("config", None),
    ".json": ("config", None),
}


@dataclass(frozen=True)
class StructuralDiagnostic:
    """Language-agnostic AST structural lint finding (used especially for Go/Rust/TS fallback)."""

    line: int
    col: int
    rule_code: str
    category: str
    message: str
    fixable: bool = False


@dataclass
class AstFileInfo:
    """Extracted polyglot structural metrics and hints for one repository file."""

    file_path: str
    language: str
    sloc: int
    symbol_count: int
    max_complexity: int
    type_or_doc_ratio: float
    raw_imports: list[str] = field(default_factory=list)
    signals: dict[str, Any] = field(default_factory=dict)
    structural_diagnostics: list[StructuralDiagnostic] = field(default_factory=list)


_FUNC_NODE_TYPES = frozenset(
    {
        "function_definition",
        "function_declaration",
        "arrow_function",
        "function_expression",
        "method_definition",
        "function_item",
        "method_declaration",
    }
)

_TYPE_NODE_TYPES = frozenset(
    {
        "class_definition",
        "class_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
        "struct_item",
        "enum_item",
        "trait_item",
        "impl_item",
        "type_item",
        "type_declaration",
        "struct_type",
        "interface_type",
    }
)

_BRANCH_NODE_TYPES = frozenset(
    {
        "if_statement",
        "elif_clause",
        "if_expression",
        "for_statement",
        "for_in_statement",
        "for_expression",
        "while_statement",
        "while_expression",
        "loop_expression",
        "match_statement",
        "match_expression",
        "match_arm",
        "switch_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
        "case_clause",
        "switch_case",
        "expression_case",
        "except_clause",
        "catch_clause",
        "conditional_expression",
        "ternary_expression",
        "boolean_operator",
        "binary_expression",
    }
)

_COMMENT_NODE_TYPES = frozenset({"comment", "line_comment", "block_comment"})

_ROUTE_RE = re.compile(
    r"@(app|router|bp|api)\.(get|post|put|delete|patch|route)\b|"
    r"\.(get|post|put|delete|patch|use|route|HandleFunc|Handle)\(|"
    r"APIRouter|FastAPI|axum::Router|actix_web|http\.Handler",
    re.I,
)
_DB_RE = re.compile(
    r"\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|CREATE\s+TABLE|ducklake|duckdb|"
    r"sqlalchemy|prisma|drizzle|sqlx|gorm|pgx|sqlite|migrations?)\b",
    re.I,
)
_AUTH_RE = re.compile(
    r"\b(jwt|oauth|bearer|password|bcrypt|argon2|middleware|cors|permission|"
    r"rbac|auth_guard|verify_token|getenv|os\.environ|BaseSettings)\b",
    re.I,
)
_CLI_RE = re.compile(
    r"\b(argparse|ArgumentParser|typer|click\.command|cobra\.Command|clap::Parser)\b|"
    r"if __name__ == [\"']__main__[\"']"
)
_TEST_RE = re.compile(
    r"\b(def test_|describe\(|it\(|test\(|expect\(|#\[test\]|func Test[A-Z]|pytest\.|bun:test)\b"
)


def should_skip_path(rel_path: str) -> bool:
    """Return True if the file lives in vendor/build/binary/lock directories."""
    parts = Path(rel_path).parts
    if any(part in SKIP_DIRS or part.startswith(".git") for part in parts[:-1]):
        return True
    suffix = Path(rel_path).suffix.lower()
    if suffix in SKIP_EXTENSIONS:
        return True
    name = parts[-1] if parts else ""
    return name.endswith(".min.js") or name.endswith(".min.css")


def detect_language(rel_path: str) -> tuple[str, str | None]:
    """Map a relative file path to `(display_language, treesitter_grammar_key)`."""
    suffix = Path(rel_path).suffix.lower()
    return EXT_TO_LANG.get(suffix, ("other", None))


def _count_sloc_and_comments(text: str, lang: str) -> tuple[int, int]:
    """Return `(sloc, comment_lines)` via fast line inspection."""
    sloc = 0
    comments = 0
    in_block = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if lang in {"typescript", "javascript", "rust", "go", "css"}:
            if in_block:
                comments += 1
                if "*/" in line:
                    in_block = False
                continue
            if line.startswith("/*"):
                comments += 1
                if "*/" not in line[2:]:
                    in_block = True
                continue
            if line.startswith("//"):
                comments += 1
                continue
        elif lang == "python":
            if line.startswith("#"):
                comments += 1
                continue
        elif lang == "sql" and line.startswith("--"):
            comments += 1
            continue
        sloc += 1
    return sloc, comments


def _node_text(node: Node, source_bytes: bytes) -> str:
    return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _compute_function_complexity(func_node: Node, source_bytes: bytes) -> int:
    """Compute McCabe-inspired complexity inside a function AST subtree."""
    complexity = 1
    stack = list(func_node.children)
    while stack:
        node = stack.pop()
        ntype = node.type
        if ntype in _FUNC_NODE_TYPES and node is not func_node:
            # Don't double-count nested closures into outer complexity
            continue
        if ntype in _BRANCH_NODE_TYPES:
            if ntype == "binary_expression":
                txt = _node_text(node, source_bytes)
                if "&&" in txt or "||" in txt:
                    complexity += 1
            else:
                complexity += 1
        stack.extend(node.children)
    return complexity


def _extract_imports(
    root: Node,
    source_bytes: bytes,
    grammar_key: str,
) -> list[str]:
    """Extract raw import targets directly from the Tree-sitter AST."""
    imports: list[str] = []
    stack = [root]
    while stack:
        node = stack.pop()
        ntype = node.type

        if grammar_key == "python":
            if ntype == "import_statement":
                for child in node.children:
                    if child.type in {"dotted_name", "aliased_import"}:
                        name_node = child.child_by_field_name("name") or child
                        imports.append(_node_text(name_node, source_bytes).strip())
            elif ntype == "import_from_statement":
                mod_node = node.child_by_field_name("module_name")
                prefix = ""
                for child in node.children:
                    if child.type == "relative_import":
                        prefix = _node_text(child, source_bytes).strip()
                        break
                if prefix:
                    imports.append(prefix)
                elif mod_node is not None:
                    imports.append(_node_text(mod_node, source_bytes).strip())

        elif grammar_key in {"typescript", "tsx", "javascript"}:
            if ntype in {"import_statement", "export_statement"}:
                src_node = node.child_by_field_name("source")
                if src_node is not None:
                    raw = _node_text(src_node, source_bytes).strip().strip("\"'")
                    if raw:
                        imports.append(raw)
            elif ntype == "call_expression":
                fn_node = node.child_by_field_name("function")
                args_node = node.child_by_field_name("arguments")
                if fn_node is not None and args_node is not None:
                    fn_txt = _node_text(fn_node, source_bytes).strip()
                    if fn_txt in {"require", "import"}:
                        for arg in args_node.named_children:
                            if arg.type == "string":
                                raw = _node_text(arg, source_bytes).strip().strip("\"'")
                                if raw:
                                    imports.append(raw)

        elif grammar_key == "rust":
            if ntype == "use_declaration":
                txt = _node_text(node, source_bytes)
                txt = txt.removeprefix("pub ").removeprefix("use ").rstrip(";").strip()
                if txt:
                    imports.append(txt)
            elif ntype == "mod_item":
                # External module declaration `mod foo;` (no block body)
                has_body = any(c.type == "declaration_list" for c in node.children)
                if not has_body:
                    name_node = node.child_by_field_name("name")
                    if name_node is not None:
                        imports.append(f"mod::{_node_text(name_node, source_bytes).strip()}")

        elif grammar_key == "go" and ntype == "import_spec":
            path_node = node.child_by_field_name("path")
            if path_node is not None:
                raw = _node_text(path_node, source_bytes).strip().strip('"')
                if raw:
                    imports.append(raw)

        stack.extend(node.children)

    # Deduplicate preserving order
    seen: set[str] = set()
    uniq: list[str] = []
    for imp in imports:
        if imp and imp not in seen:
            seen.add(imp)
            uniq.append(imp)
    return uniq


def analyze_file_ast(rel_path: str, text: str) -> AstFileInfo:
    """Parse one source file with Tree-sitter (or line fallback) and return structural metrics."""
    language, grammar_key = detect_language(rel_path)
    sloc, comment_lines = _count_sloc_and_comments(text, language)

    if grammar_key is None:
        return AstFileInfo(
            file_path=rel_path,
            language=language,
            sloc=sloc,
            symbol_count=0,
            max_complexity=1,
            type_or_doc_ratio=round(comment_lines / max(1, sloc + comment_lines), 3),
            raw_imports=[],
            signals={
                "func_count": 0,
                "type_def_count": 0,
                "loop_count": 0,
                "has_main": False,
                "is_test": _is_test_path(rel_path),
                "route_hints": False,
                "db_hints": bool(_DB_RE.search(text)) or language == "sql",
                "auth_hints": bool(_AUTH_RE.search(text)),
                "cli_hints": False,
                "ui_hints": language in {"css", "html"},
            },
        )

    source_bytes = text.encode("utf-8", errors="replace")
    parser = Parser(_get_language(grammar_key))
    tree = parser.parse(source_bytes)
    root = tree.root_node

    func_count = 0
    type_def_count = 0
    loop_count = 0
    typed_nodes = 0
    docstring_nodes = 0
    jsx_nodes = 0
    max_complexity = 1
    structural_diags: list[StructuralDiagnostic] = []

    stack = [root]
    while stack:
        node = stack.pop()
        ntype = node.type

        if ntype in _FUNC_NODE_TYPES:
            func_count += 1
            comp = _compute_function_complexity(node, source_bytes)
            if comp > max_complexity:
                max_complexity = comp
            if comp > 15 and grammar_key in {"go", "rust", "typescript", "tsx", "javascript"}:
                row, col = node.start_point
                structural_diags.append(
                    StructuralDiagnostic(
                        line=row + 1,
                        col=col + 1,
                        rule_code="CC001",
                        category="complexity",
                        message=f"High cyclomatic complexity ({comp} branches) — split function.",
                    )
                )

        if ntype in _TYPE_NODE_TYPES:
            type_def_count += 1

        if ntype in {
            "for_statement",
            "for_in_statement",
            "for_expression",
            "while_statement",
            "while_expression",
            "loop_expression",
        }:
            loop_count += 1

        if ntype in {
            "type_annotation",
            "type",
            "type_identifier",
            "primitive_type",
            "generic_type",
            "field_declaration",
        }:
            typed_nodes += 1

        if ntype in _COMMENT_NODE_TYPES:
            docstring_nodes += 1

        if ntype in {"jsx_element", "jsx_self_closing_element", "jsx_fragment"}:
            jsx_nodes += 1

        # Empty error handler detection across languages
        if ntype in {"except_clause", "catch_clause"}:
            body = node.child_by_field_name("body") or node
            body_txt = _node_text(body, source_bytes).strip()
            if body_txt in {"{}", "pass"} or body_txt.endswith(":\n    pass"):
                row, col = node.start_point
                structural_diags.append(
                    StructuralDiagnostic(
                        line=row + 1,
                        col=col + 1,
                        rule_code="CC002",
                        category="correctness",
                        message="Silent empty exception/error handler detected.",
                    )
                )

        stack.extend(node.children)

    if sloc > 600 and grammar_key in {"go", "rust", "typescript", "tsx", "javascript"}:
        structural_diags.append(
            StructuralDiagnostic(
                line=1,
                col=1,
                rule_code="CC003",
                category="maintainability",
                message=f"Large module ({sloc} SLOC) — candidate for modularization.",
            )
        )

    is_test = _is_test_path(rel_path) or bool(_TEST_RE.search(text))
    if grammar_key == "rust" and not is_test:
        for idx, line_txt in enumerate(text.splitlines(), start=1):
            if ".unwrap()" in line_txt or "panic!(" in line_txt:
                structural_diags.append(
                    StructuralDiagnostic(
                        line=idx,
                        col=max(1, line_txt.find(".unwrap()") + 1),
                        rule_code="RS001",
                        category="safety",
                        message="Unchecked `.unwrap()` / `panic!` in non-test Rust code.",
                    )
                )
                if len(structural_diags) >= 12:
                    break

    raw_imports = _extract_imports(root, source_bytes, grammar_key)
    symbol_count = func_count + type_def_count
    denom = max(1, func_count + type_def_count + 2)
    doc_signal = min(
        1.0, (typed_nodes * 0.25 + comment_lines * 0.4 + docstring_nodes * 0.4) / denom
    )

    signals = {
        "func_count": func_count,
        "type_def_count": type_def_count,
        "loop_count": loop_count,
        "has_main": "fn main(" in text or "func main(" in text or "__main__" in text,
        "is_test": is_test,
        "route_hints": bool(_ROUTE_RE.search(text)),
        "db_hints": bool(_DB_RE.search(text)),
        "auth_hints": bool(_AUTH_RE.search(text)),
        "cli_hints": bool(_CLI_RE.search(text)),
        "ui_hints": jsx_nodes > 0 or rel_path.endswith((".tsx", ".jsx", ".vue", ".svelte")),
        "jsx_nodes": jsx_nodes,
    }

    return AstFileInfo(
        file_path=rel_path,
        language=language,
        sloc=sloc,
        symbol_count=symbol_count,
        max_complexity=max_complexity,
        type_or_doc_ratio=round(doc_signal, 3),
        raw_imports=raw_imports,
        signals=signals,
        structural_diagnostics=structural_diags,
    )


def _is_test_path(rel_path: str) -> bool:
    low = rel_path.lower()
    parts = Path(low).parts
    name = parts[-1] if parts else ""
    return (
        any(
            p in {"test", "tests", "__tests__", "spec", "specs", "benches", "fixtures"}
            for p in parts[:-1]
        )
        or name.startswith("test_")
        or name.endswith(
            ("_test.go", "_test.py", ".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx")
        )
    )


def scan_worktree_ast(worktree_root: Path) -> dict[str, AstFileInfo]:
    """Walk a checked-out worktree and analyze all source files via Tree-sitter."""
    results: dict[str, AstFileInfo] = {}
    for path in sorted(worktree_root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(worktree_root).as_posix()
        if should_skip_path(rel):
            continue
        try:
            if path.stat().st_size > MAX_ANALYZED_FILE_BYTES:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if "\x00" in text[:1024]:
            continue
        results[rel] = analyze_file_ast(rel, text)
    return results
