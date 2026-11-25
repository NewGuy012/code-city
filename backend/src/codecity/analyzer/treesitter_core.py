"""Unified Tree-sitter AST, complexity, import, and structural lint extractor."""

from __future__ import annotations

import functools
import json
import os
import re
import threading
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tree_sitter_go
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

SKIP_FILENAMES = frozenset(
    {
        "uv.lock",
        "bun.lock",
        "bun.lockb",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "Cargo.lock",
        "go.sum",
        "poetry.lock",
    }
)

MAX_ANALYZED_FILE_BYTES = 512 * 1024

_LANG_LOADERS = {
    "python": tree_sitter_python.language,
    "typescript": tree_sitter_typescript.language_typescript,
    "tsx": tree_sitter_typescript.language_tsx,
    "rust": tree_sitter_rust.language,
    "go": tree_sitter_go.language,
}


_THREAD_PARSERS = threading.local()


@functools.lru_cache(maxsize=8)
def _get_language(lang_key: str) -> Language:
    return Language(_LANG_LOADERS[lang_key]())


def _get_parser(lang_key: str) -> Parser:
    cache: dict[str, Parser] | None = getattr(_THREAD_PARSERS, "parsers", None)
    if cache is None:
        cache = {}
        _THREAD_PARSERS.parsers = cache
    parser = cache.get(lang_key)
    if parser is None:
        parser = Parser(_get_language(lang_key))
        cache[lang_key] = parser
    return parser


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


@dataclass(frozen=True)
class AstSymbolInfo:
    """Extracted top-level or exported symbol summary from a source file."""

    name: str
    kind: str
    exported: bool
    doc: str = ""
    complexity: int = 1
    start_line: int = 1
    end_line: int = 1
    methods: tuple[str, ...] = ()


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
    module_doc: str = ""
    symbols: list[AstSymbolInfo] = field(default_factory=list)
    endpoints: list[str] = field(default_factory=list)
    most_complex_symbol: tuple[str, int] | None = None


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

_LOOP_NODE_TYPES = frozenset(
    {
        "for_statement",
        "for_in_statement",
        "for_expression",
        "while_statement",
        "while_expression",
        "loop_expression",
    }
)

_TYPED_NODE_TYPES = frozenset(
    {
        "type_annotation",
        "type",
        "type_identifier",
        "primitive_type",
        "generic_type",
        "field_declaration",
    }
)

_JSX_NODE_TYPES = frozenset({"jsx_element", "jsx_self_closing_element", "jsx_fragment"})

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
    r"\b(argparse|ArgumentParser|typer|click\.command|cobra\.Command|clap::Parser)\b"
)


def should_skip_path(rel_path: str) -> bool:
    """Return True if the file lives in vendor/build/binary/lock directories."""
    parts = Path(rel_path).parts
    if any(part in SKIP_DIRS or part.startswith(".git") for part in parts[:-1]):
        return True
    name = parts[-1] if parts else ""
    if name in SKIP_DIRS or name in SKIP_FILENAMES:
        return True
    suffix = Path(rel_path).suffix.lower()
    if suffix in SKIP_EXTENSIONS:
        return True
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
                if any(
                    not c.is_named and _node_text(c, source_bytes) in {"&&", "||"}
                    for c in node.children
                ):
                    complexity += 1
            else:
                complexity += 1
        stack.extend(node.children)
    return complexity


_PY_SURFACE_RE = re.compile(
    r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|#[^\n]*'
)
_RUST_SURFACE_RE = re.compile(
    r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n]{1,4})\'|/\*[\s\S]*?\*/|//[^\n]*'
)
_CLIKE_SURFACE_RE = re.compile(
    r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`[^`]*`|/\*[\s\S]*?\*/|//[^\n]*'
)
_SQL_SURFACE_RE = re.compile(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|--[^\n]*|/\*[\s\S]*?\*/")


def _code_surface(text: str, language: str) -> str:
    """Strip string literals and comments in one pass while preserving line boundaries."""
    if language == "python":
        pat = _PY_SURFACE_RE
    elif language == "rust":
        pat = _RUST_SURFACE_RE
    elif language == "sql":
        pat = _SQL_SURFACE_RE
    else:
        pat = _CLIKE_SURFACE_RE
    return pat.sub(lambda m: " " + "\n" * m.group(0).count("\n"), text)


def _collect_node_imports(
    node: Node,
    source_bytes: bytes,
    grammar_key: str,
    imports: list[str],
) -> None:
    ntype = node.type
    if grammar_key == "python":
        if ntype == "import_statement":
            for child in node.children:
                if child.type in {"dotted_name", "aliased_import"}:
                    name_node = child.child_by_field_name("name") or child
                    imports.append(_node_text(name_node, source_bytes).strip())
        elif ntype == "import_from_statement":
            prefix = next(
                (
                    _node_text(c, source_bytes).strip()
                    for c in node.children
                    if c.type == "relative_import"
                ),
                "",
            )
            mod_node = node.child_by_field_name("module_name")
            if prefix:
                imports.append(prefix)
            elif mod_node is not None:
                imports.append(_node_text(mod_node, source_bytes).strip())
    elif grammar_key in {"typescript", "tsx"}:
        if ntype in {"import_statement", "export_statement"}:
            src_node = node.child_by_field_name("source")
            if src_node is not None:
                raw = _node_text(src_node, source_bytes).strip().strip("\"'")
                if raw:
                    imports.append(raw)
        elif ntype == "call_expression":
            fn_node = node.child_by_field_name("function")
            args_node = node.child_by_field_name("arguments")
            if (
                fn_node is not None
                and args_node is not None
                and _node_text(fn_node, source_bytes).strip() in {"require", "import"}
            ):
                for arg in args_node.named_children:
                    if arg.type == "string":
                        raw = _node_text(arg, source_bytes).strip().strip("\"'")
                        if raw:
                            imports.append(raw)
    elif grammar_key == "rust":
        if ntype == "use_declaration":
            txt = _node_text(node, source_bytes).removeprefix("pub ").removeprefix("use ")
            txt = txt.rstrip(";").strip()
            if txt:
                imports.append(txt)
        elif ntype == "mod_item" and not any(c.type == "declaration_list" for c in node.children):
            name_node = node.child_by_field_name("name")
            if name_node is not None:
                imports.append(f"mod::{_node_text(name_node, source_bytes).strip()}")
    elif grammar_key == "go" and ntype == "import_spec":
        path_node = node.child_by_field_name("path")
        if path_node is not None:
            raw = _node_text(path_node, source_bytes).strip().strip('"')
            if raw:
                imports.append(raw)


_BOILERPLATE_COMMENT_RE = re.compile(
    r"^(?:#!|SPDX-License-Identifier|Copyright\b|eslint-|prettier-ignore|@ts-|ruff:|type:\s*ignore|noqa\b|pylint:|fmt:\s*(?:off|on))",
    re.I,
)
_HTTP_DECORATOR_RE = re.compile(
    r"""(?:@(?:app|router|bp|api)|\b(?:app|router|api))\.(get|post|put|delete|patch|route)\(\s*["'`]([^"'`\n]{1,80})["'`]""",
    re.I,
)
_API_ROUTE_RE = re.compile(
    r"""(?:@(?:app|router|api)|\b(?:app|router|api))\.(?:api_route|HandleFunc|Handle)\(\s*["'`]([^"'`\n]{1,80})["'`]"""
)
_CLI_SUBCMD_RE = re.compile(
    r"""(?:\.add_parser\(\s*["']([A-Za-z0-9_.:-]{1,40})["']|Use:\s*"([A-Za-z0-9_.:-]{1,40})")"""
)


def _clean_doc_text(raw: str, *, max_chars: int = 320) -> str:
    """Normalize a docstring or comment block into clean plain-text sentences."""
    if not raw:
        return ""
    txt = raw.strip()
    for q in ('"""', "'''", '"', "'"):
        if txt.startswith(q) and txt.endswith(q) and len(txt) >= 2 * len(q):
            txt = txt[len(q) : -len(q)]
            break
    if txt.startswith(("/**", "/*!")):
        txt = txt[3:]
    elif txt.startswith("/*"):
        txt = txt[2:]
    if txt.endswith("*/"):
        txt = txt[:-2]

    kept_lines: list[str] = []
    for line in txt.splitlines():
        stripped = line.strip()
        for prefix in ("///", "//!", "//", "#", "--", "*"):
            if stripped.startswith(prefix):
                stripped = stripped[len(prefix) :].strip()
                break
        if not stripped or _BOILERPLATE_COMMENT_RE.match(stripped):
            continue
        if stripped.startswith("@param") or stripped.startswith("@returns"):
            break
        kept_lines.append(stripped)

    collapsed = re.sub(r"\s+", " ", " ".join(kept_lines)).strip()
    if len(collapsed) <= max_chars:
        return collapsed
    cut = collapsed[:max_chars].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}..." if cut else collapsed[:max_chars]


def _extract_endpoints(text: str) -> list[str]:
    """Extract bounded HTTP route paths and CLI subcommands from source text."""
    found: list[str] = []
    seen: set[str] = set()

    def _add(item: str) -> None:
        if item not in seen and len(found) < 20:
            seen.add(item)
            found.append(item)

    for m in _HTTP_DECORATOR_RE.finditer(text):
        method = m.group(1).upper()
        path = m.group(2).strip()
        label = f"{method} {path}" if method != "ROUTE" else f"ROUTE {path}"
        _add(label)
    for m in _API_ROUTE_RE.finditer(text):
        _add(f"ROUTE {m.group(1).strip()}")
    for m in _CLI_SUBCMD_RE.finditer(text):
        cmd = (m.group(1) or m.group(2) or "").strip()
        if cmd:
            _add(f"cli {cmd}")
    return found


def _has_jsx_descendant(node: Node) -> bool:
    stack = [node]
    while stack:
        cur = stack.pop()
        if cur.type in _JSX_NODE_TYPES:
            return True
        stack.extend(cur.children)
    return False


def _py_block_docstring(body_node: Node | None, source_bytes: bytes) -> str:
    if body_node is None:
        return ""
    for child in body_node.named_children:
        if child.type in _COMMENT_NODE_TYPES:
            continue
        if child.type == "expression_statement" and child.named_children:
            first = child.named_children[0]
            if first.type == "string":
                return _clean_doc_text(_node_text(first, source_bytes), max_chars=200)
        break
    return ""


def _py_class_methods(body_node: Node | None, source_bytes: bytes) -> tuple[str, ...]:
    if body_node is None:
        return ()
    methods: list[str] = []
    for child in body_node.named_children:
        fn = child
        if child.type == "decorated_definition":
            fn = next((c for c in child.children if c.type == "function_definition"), child)
        if fn.type == "function_definition":
            n = fn.child_by_field_name("name")
            if n is not None:
                mname = _node_text(n, source_bytes).strip()
                if not mname.startswith("_"):
                    methods.append(mname)
                    if len(methods) >= 8:
                        break
    return tuple(methods)


def _ts_class_methods(body_node: Node | None, source_bytes: bytes) -> tuple[str, ...]:
    if body_node is None:
        return ()
    methods: list[str] = []
    for child in body_node.named_children:
        if child.type == "method_definition":
            n = child.child_by_field_name("name")
            if n is not None:
                mname = _node_text(n, source_bytes).strip()
                if not mname.startswith("_") and mname != "constructor":
                    methods.append(mname)
                    if len(methods) >= 8:
                        break
    return tuple(methods)


def _extract_non_ast_summary(
    rel_path: str, language: str, text: str
) -> tuple[str, list[AstSymbolInfo], list[str]]:
    """Extract module overview and key entries from Markdown, SQL, CSS, and config files."""
    symbols: list[AstSymbolInfo] = []
    module_doc = ""
    fname = Path(rel_path).name.lower()

    if language == "markdown":
        title = ""
        para_lines: list[str] = []
        para_done = False
        in_code = False
        for idx, raw in enumerate(text.splitlines(), start=1):
            s = raw.strip()
            if s.startswith("```"):
                in_code = not in_code
                continue
            if in_code:
                continue
            if s.startswith("# ") and not title:
                title = s[2:].strip()
            elif s.startswith("## "):
                sec = s[3:].strip()
                if sec and len(symbols) < 12:
                    symbols.append(
                        AstSymbolInfo(
                            name=sec, kind="section", exported=True, start_line=idx, end_line=idx
                        )
                    )
            elif (
                not para_done
                and s
                and not s.startswith(("<", "!", "[", "|", "-", "*", "#"))
                and len(para_lines) < 3
            ):
                para_lines.append(re.sub(r"[`*_]+", "", s))
            elif para_lines and not s:
                para_done = True
        combined = (
            f"{title}: {' '.join(para_lines)}"
            if title and para_lines
            else (title or " ".join(para_lines))
        )
        module_doc = _clean_doc_text(combined, max_chars=260)
        return module_doc, symbols, []

    if language == "sql":
        comments: list[str] = []
        for idx, raw in enumerate(text.splitlines(), start=1):
            s = raw.strip()
            if idx <= 10 and s.startswith("--"):
                comments.append(s)
            m = re.match(
                r"(?i)CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_.]+)",
                s,
            )
            if m and len(symbols) < 12:
                symbols.append(
                    AstSymbolInfo(
                        name=m.group(2),
                        kind=m.group(1).lower(),
                        exported=True,
                        start_line=idx,
                        end_line=idx,
                    )
                )
        module_doc = _clean_doc_text("\n".join(comments), max_chars=240)
        return module_doc, symbols, []

    if language == "config":
        if fname.endswith(".json"):
            try:
                data = json.loads(text)
            except Exception:
                data = None
            if isinstance(data, dict):
                desc = str(data.get("description") or "").strip()
                name = str(data.get("name") or "").strip()
                if desc:
                    module_doc = f"{name}: {desc}" if name else desc
                elif name:
                    module_doc = f"JSON configuration for `{name}`."
                scripts = data.get("scripts")
                if isinstance(scripts, dict):
                    for sk in list(scripts.keys())[:10]:
                        symbols.append(AstSymbolInfo(name=str(sk), kind="script", exported=True))
                else:
                    for key in list(data.keys())[:10]:
                        symbols.append(AstSymbolInfo(name=str(key), kind="config", exported=True))
                return module_doc[:260], symbols, []
        if fname.endswith(".toml"):
            try:
                data = tomllib.loads(text)
            except Exception:
                data = None
            if isinstance(data, dict):
                proj = (
                    data.get("project")
                    if isinstance(data.get("project"), dict)
                    else data.get("package")
                )
                if isinstance(proj, dict):
                    desc = str(proj.get("description") or "").strip()
                    name = str(proj.get("name") or "").strip()
                    if desc:
                        module_doc = f"{name}: {desc}" if name else desc
                for key in list(data.keys())[:10]:
                    symbols.append(AstSymbolInfo(name=str(key), kind="config", exported=True))
                if module_doc:
                    return module_doc[:260], symbols, []

        lead = [ln for ln in text.splitlines()[:10] if ln.strip().startswith("#")]
        module_doc = _clean_doc_text("\n".join(lead), max_chars=220)
        return module_doc, symbols, []

    if language == "css":
        lead = []
        for ln in text.splitlines()[:10]:
            s = ln.strip()
            if s.startswith(("/*", "*", "//")):
                lead.append(s)
            elif s:
                break
        module_doc = _clean_doc_text("\n".join(lead), max_chars=220)
        classes = re.findall(r"^\.([A-Za-z0-9_-]+)\s*\{", text, re.M)
        for cls in list(dict.fromkeys(classes))[:10]:
            symbols.append(AstSymbolInfo(name=f".{cls}", kind="style", exported=True))
        return module_doc, symbols, []

    return "", [], []


def _extract_ast_metadata(
    root: Node,
    source_bytes: bytes,
    grammar_key: str,
    func_complexities: dict[int, int],
) -> tuple[str, list[AstSymbolInfo]]:
    """Extract leading module doc and top-level/exported symbols in source order."""
    children = root.children
    module_doc = ""
    symbols: list[AstSymbolInfo] = []
    rust_impl_methods: dict[str, list[str]] = {}
    go_receiver_methods: dict[str, list[str]] = {}

    if grammar_key == "python":
        lead_comments: list[str] = []
        for child in children:
            if child.type in _COMMENT_NODE_TYPES:
                lead_comments.append(_node_text(child, source_bytes))
                continue
            if child.type == "expression_statement" and child.named_children:
                first = child.named_children[0]
                if first.type == "string":
                    module_doc = _clean_doc_text(_node_text(first, source_bytes), max_chars=320)
                    break
            break
        if not module_doc and lead_comments:
            module_doc = _clean_doc_text("\n".join(lead_comments), max_chars=280)

        for child in children:
            target = child
            if child.type == "decorated_definition":
                target = next(
                    (
                        c
                        for c in child.children
                        if c.type in {"function_definition", "class_definition"}
                    ),
                    child,
                )
            if target.type == "function_definition":
                name_node = target.child_by_field_name("name")
                if name_node is None:
                    continue
                name = _node_text(name_node, source_bytes).strip()
                doc = _py_block_docstring(target.child_by_field_name("body"), source_bytes)
                symbols.append(
                    AstSymbolInfo(
                        name=name,
                        kind="fn",
                        exported=not name.startswith("_"),
                        doc=doc,
                        complexity=func_complexities.get(target.id, 1),
                        start_line=child.start_point[0] + 1,
                        end_line=child.end_point[0] + 1,
                    )
                )
            elif target.type == "class_definition":
                name_node = target.child_by_field_name("name")
                if name_node is None:
                    continue
                name = _node_text(name_node, source_bytes).strip()
                body = target.child_by_field_name("body")
                doc = _py_block_docstring(body, source_bytes)
                symbols.append(
                    AstSymbolInfo(
                        name=name,
                        kind="class",
                        exported=not name.startswith("_"),
                        doc=doc,
                        complexity=1,
                        start_line=child.start_point[0] + 1,
                        end_line=child.end_point[0] + 1,
                        methods=_py_class_methods(body, source_bytes),
                    )
                )

    elif grammar_key in {"typescript", "tsx"}:
        # Leading comment block before imports/code serves as module doc
        lead_comments: list[str] = []
        for child in children:
            if child.type in _COMMENT_NODE_TYPES:
                lead_comments.append(_node_text(child, source_bytes))
                continue
            if child.type == "expression_statement":
                txt = _node_text(child, source_bytes).strip().strip("\"'`;")
                if txt in {"use client", "use strict"}:
                    continue
            if child.type in {"import_statement", "import_alias"} and lead_comments:
                module_doc = _clean_doc_text("\n".join(lead_comments), max_chars=320)
            break
        if not module_doc and len(lead_comments) > 1:
            module_doc = _clean_doc_text("\n".join(lead_comments), max_chars=320)

        pending_comments: list[str] = []
        last_comment_end_row = -10
        for child in children:
            if child.type in _COMMENT_NODE_TYPES:
                if child.start_point[0] - last_comment_end_row > 2:
                    pending_comments = []
                pending_comments.append(_node_text(child, source_bytes))
                last_comment_end_row = child.end_point[0]
                continue

            doc = (
                _clean_doc_text("\n".join(pending_comments), max_chars=200)
                if pending_comments and (child.start_point[0] - last_comment_end_row <= 2)
                else ""
            )
            pending_comments = []

            exported = False
            decl = child
            if child.type == "export_statement":
                exported = True
                decl = next(
                    (
                        c
                        for c in child.children
                        if c.type
                        in {
                            "function_declaration",
                            "class_declaration",
                            "interface_declaration",
                            "type_alias_declaration",
                            "enum_declaration",
                            "lexical_declaration",
                            "variable_declaration",
                        }
                    ),
                    child,
                )

            dtype = decl.type
            sline = child.start_point[0] + 1
            eline = child.end_point[0] + 1
            if dtype == "function_declaration":
                n = decl.child_by_field_name("name")
                if n is not None:
                    name = _node_text(n, source_bytes).strip()
                    kind = (
                        "component"
                        if (name[:1].isupper() and _has_jsx_descendant(decl))
                        else "hook"
                        if re.match(r"use[A-Z]", name)
                        else "fn"
                    )
                    symbols.append(
                        AstSymbolInfo(
                            name=name,
                            kind=kind,
                            exported=exported,
                            doc=doc,
                            complexity=func_complexities.get(decl.id, 1),
                            start_line=sline,
                            end_line=eline,
                        )
                    )
            elif dtype == "class_declaration":
                n = decl.child_by_field_name("name")
                if n is not None:
                    name = _node_text(n, source_bytes).strip()
                    symbols.append(
                        AstSymbolInfo(
                            name=name,
                            kind="class",
                            exported=exported,
                            doc=doc,
                            start_line=sline,
                            end_line=eline,
                            methods=_ts_class_methods(
                                decl.child_by_field_name("body"), source_bytes
                            ),
                        )
                    )
            elif dtype in {"interface_declaration", "type_alias_declaration", "enum_declaration"}:
                n = decl.child_by_field_name("name")
                if n is not None:
                    kind = (
                        "interface"
                        if dtype == "interface_declaration"
                        else "enum"
                        if dtype == "enum_declaration"
                        else "type"
                    )
                    symbols.append(
                        AstSymbolInfo(
                            name=_node_text(n, source_bytes).strip(),
                            kind=kind,
                            exported=exported,
                            doc=doc,
                            start_line=sline,
                            end_line=eline,
                        )
                    )
            elif dtype in {"lexical_declaration", "variable_declaration"}:
                for sub in decl.named_children:
                    if sub.type != "variable_declarator":
                        continue
                    n = sub.child_by_field_name("name")
                    val = sub.child_by_field_name("value")
                    if n is None:
                        continue
                    name = _node_text(n, source_bytes).strip()
                    if not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", name):
                        continue
                    if val is not None and val.type in {"arrow_function", "function_expression"}:
                        kind = (
                            "component"
                            if (name[:1].isupper() and _has_jsx_descendant(val))
                            else "hook"
                            if re.match(r"use[A-Z]", name)
                            else "fn"
                        )
                        comp = func_complexities.get(val.id, 1)
                    elif exported:
                        kind = "const"
                        comp = 1
                    else:
                        continue
                    symbols.append(
                        AstSymbolInfo(
                            name=name,
                            kind=kind,
                            exported=exported,
                            doc=doc,
                            complexity=comp,
                            start_line=sline,
                            end_line=eline,
                        )
                    )

    elif grammar_key == "rust":
        inner_docs: list[str] = []
        pending_docs: list[str] = []
        last_doc_row = -10
        for child in children:
            if child.type in _COMMENT_NODE_TYPES:
                txt = _node_text(child, source_bytes)
                if txt.lstrip().startswith(("//! ", "//!", "/*!")):
                    inner_docs.append(txt)
                else:
                    if child.start_point[0] - last_doc_row > 2:
                        pending_docs = []
                    pending_docs.append(txt)
                    last_doc_row = child.end_point[0]
                continue
            if child.type == "attribute_item":
                continue

            doc = (
                _clean_doc_text("\n".join(pending_docs), max_chars=200)
                if pending_docs and (child.start_point[0] - last_doc_row <= 2)
                else ""
            )
            pending_docs = []
            is_pub = any(c.type == "visibility_modifier" for c in child.children)
            sline, eline = child.start_point[0] + 1, child.end_point[0] + 1

            if child.type == "function_item":
                n = child.child_by_field_name("name")
                if n is not None:
                    symbols.append(
                        AstSymbolInfo(
                            name=_node_text(n, source_bytes).strip(),
                            kind="fn",
                            exported=is_pub,
                            doc=doc,
                            complexity=func_complexities.get(child.id, 1),
                            start_line=sline,
                            end_line=eline,
                        )
                    )
            elif child.type in {"struct_item", "enum_item", "trait_item", "type_item"}:
                n = child.child_by_field_name("name")
                if n is not None:
                    kind = child.type.removesuffix("_item")
                    symbols.append(
                        AstSymbolInfo(
                            name=_node_text(n, source_bytes).strip(),
                            kind=kind,
                            exported=is_pub,
                            doc=doc,
                            start_line=sline,
                            end_line=eline,
                        )
                    )
            elif child.type == "impl_item":
                t_node = child.child_by_field_name("type")
                body = child.child_by_field_name("body")
                if t_node is not None and body is not None:
                    tname = _node_text(t_node, source_bytes).split("<", 1)[0].strip()
                    for item in body.named_children:
                        if item.type == "function_item":
                            mn = item.child_by_field_name("name")
                            if mn is not None and (
                                any(c.type == "visibility_modifier" for c in item.children)
                                or not rust_impl_methods.get(tname)
                            ):
                                rust_impl_methods.setdefault(tname, []).append(
                                    _node_text(mn, source_bytes).strip()
                                )
        module_doc = _clean_doc_text("\n".join(inner_docs), max_chars=320)
        if rust_impl_methods:
            symbols = [
                AstSymbolInfo(
                    name=s.name,
                    kind=s.kind,
                    exported=s.exported,
                    doc=s.doc,
                    complexity=s.complexity,
                    start_line=s.start_line,
                    end_line=s.end_line,
                    methods=tuple(rust_impl_methods.get(s.name, [])[:8]),
                )
                if s.kind in {"struct", "enum", "trait"} and s.name in rust_impl_methods
                else s
                for s in symbols
            ]

    elif grammar_key == "go":
        pending_comments: list[str] = []
        last_comment_row = -10
        for child in children:
            if child.type in _COMMENT_NODE_TYPES:
                if child.start_point[0] - last_comment_row > 2:
                    pending_comments = []
                pending_comments.append(_node_text(child, source_bytes))
                last_comment_row = child.end_point[0]
                continue
            if child.type == "package_clause":
                if pending_comments and (child.start_point[0] - last_comment_row <= 2):
                    module_doc = _clean_doc_text("\n".join(pending_comments), max_chars=320)
                pending_comments = []
                continue

            doc = (
                _clean_doc_text("\n".join(pending_comments), max_chars=200)
                if pending_comments and (child.start_point[0] - last_comment_row <= 2)
                else ""
            )
            pending_comments = []
            sline, eline = child.start_point[0] + 1, child.end_point[0] + 1

            if child.type == "function_declaration":
                n = child.child_by_field_name("name")
                if n is not None:
                    name = _node_text(n, source_bytes).strip()
                    symbols.append(
                        AstSymbolInfo(
                            name=name,
                            kind="fn",
                            exported=name[:1].isupper(),
                            doc=doc,
                            complexity=func_complexities.get(child.id, 1),
                            start_line=sline,
                            end_line=eline,
                        )
                    )
            elif child.type == "type_declaration":
                for spec in child.named_children:
                    if spec.type != "type_spec":
                        continue
                    n = spec.child_by_field_name("name")
                    t = spec.child_by_field_name("type")
                    if n is None:
                        continue
                    name = _node_text(n, source_bytes).strip()
                    ttype = t.type if t is not None else ""
                    kind = (
                        "struct"
                        if ttype == "struct_type"
                        else "interface"
                        if ttype == "interface_type"
                        else "type"
                    )
                    symbols.append(
                        AstSymbolInfo(
                            name=name,
                            kind=kind,
                            exported=name[:1].isupper(),
                            doc=doc,
                            start_line=sline,
                            end_line=eline,
                        )
                    )
            elif child.type == "method_declaration":
                recv = child.child_by_field_name("receiver")
                mn = child.child_by_field_name("name")
                if recv is not None and mn is not None:
                    recv_txt = _node_text(recv, source_bytes)
                    m = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*\)*$", recv_txt.strip())
                    if m:
                        go_receiver_methods.setdefault(m.group(1), []).append(
                            _node_text(mn, source_bytes).strip()
                        )
        if go_receiver_methods:
            symbols = [
                AstSymbolInfo(
                    name=s.name,
                    kind=s.kind,
                    exported=s.exported,
                    doc=s.doc,
                    complexity=s.complexity,
                    start_line=s.start_line,
                    end_line=s.end_line,
                    methods=tuple(go_receiver_methods.get(s.name, [])[:8]),
                )
                if s.kind in {"struct", "type"} and s.name in go_receiver_methods
                else s
                for s in symbols
            ]

    return module_doc, symbols[:32]


def analyze_file_ast(rel_path: str, text: str) -> AstFileInfo:
    """Parse one source file with Tree-sitter (or line fallback) and return structural metrics."""
    language, grammar_key = detect_language(rel_path)
    sloc, comment_lines = _count_sloc_and_comments(text, language)
    code_surface = _code_surface(text, language)

    if grammar_key is None:
        module_doc, non_ast_symbols, non_ast_endpoints = _extract_non_ast_summary(
            rel_path, language, text
        )
        return AstFileInfo(
            file_path=rel_path,
            language=language,
            sloc=sloc,
            symbol_count=len(non_ast_symbols),
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
                "db_hints": language == "sql" or bool(_DB_RE.search(code_surface)),
                "auth_hints": bool(_AUTH_RE.search(code_surface)),
                "cli_hints": False,
                "ui_hints": language in {"css", "html"},
            },
            module_doc=module_doc,
            symbols=non_ast_symbols,
            endpoints=non_ast_endpoints,
        )

    source_bytes = text.encode("utf-8", errors="replace")
    root = _get_parser(grammar_key).parse(source_bytes).root_node

    func_count = 0
    type_def_count = 0
    loop_count = 0
    typed_nodes = 0
    docstring_nodes = 0
    jsx_nodes = 0
    max_complexity = 1
    most_complex_symbol: tuple[str, int] | None = None
    func_complexities: dict[int, int] = {}
    ast_test_symbol = False
    ast_main_symbol = False
    structural_diags: list[StructuralDiagnostic] = []
    raw_imports_all: list[str] = []

    stack = [root]
    while stack:
        node = stack.pop()
        ntype = node.type
        _collect_node_imports(node, source_bytes, grammar_key, raw_imports_all)

        if ntype in _FUNC_NODE_TYPES:
            func_count += 1
            fname = ""
            name_node = node.child_by_field_name("name")
            if name_node is not None:
                fname = _node_text(name_node, source_bytes).strip()
            elif node.parent is not None and node.parent.type == "variable_declarator":
                var_name = node.parent.child_by_field_name("name")
                if var_name is not None:
                    fname = _node_text(var_name, source_bytes).strip()

            if fname:
                if fname.startswith("test_") or (grammar_key == "go" and fname.startswith("Test")):
                    ast_test_symbol = True
                if fname == "main" and grammar_key in {"go", "rust"}:
                    ast_main_symbol = True

            comp = _compute_function_complexity(node, source_bytes)
            func_complexities[node.id] = comp
            if comp > max_complexity:
                max_complexity = comp
            if fname and (most_complex_symbol is None or comp > most_complex_symbol[1]):
                most_complex_symbol = (fname, comp)
            if comp > 22 and grammar_key in {"go", "rust", "typescript", "tsx"}:
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

        if (
            ntype == "attribute_item"
            and grammar_key == "rust"
            and "#[test]" in _node_text(node, source_bytes)
        ):
            ast_test_symbol = True

        if ntype in _TYPE_NODE_TYPES:
            type_def_count += 1

        if ntype in _LOOP_NODE_TYPES:
            loop_count += 1

        if ntype in _TYPED_NODE_TYPES:
            typed_nodes += 1

        if ntype in _COMMENT_NODE_TYPES:
            docstring_nodes += 1

        if ntype in _JSX_NODE_TYPES:
            jsx_nodes += 1

        if ntype in {"except_clause", "catch_clause"}:
            block = (
                next((c for c in node.children if c.type == "block"), None)
                if ntype == "except_clause"
                else node.child_by_field_name("body")
            )
            stmts = (
                [c for c in block.named_children if c.type not in _COMMENT_NODE_TYPES]
                if block is not None
                else []
            )
            is_empty = block is not None and (
                not stmts
                or (
                    len(stmts) == 1
                    and (
                        stmts[0].type == "pass_statement"
                        or _node_text(stmts[0], source_bytes).strip() == "..."
                    )
                )
            )
            if is_empty:
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

    if sloc > 750 and grammar_key in {"go", "rust", "typescript", "tsx"}:
        structural_diags.append(
            StructuralDiagnostic(
                line=1,
                col=1,
                rule_code="CC003",
                category="maintainability",
                message=f"Large module ({sloc} SLOC) — candidate for modularization.",
            )
        )

    is_test = _is_test_path(rel_path) or ast_test_symbol
    if grammar_key == "rust" and not is_test:
        for idx, line_txt in enumerate(code_surface.splitlines(), start=1):
            positions = [p for tok in (".unwrap()", "panic!(") if (p := line_txt.find(tok)) >= 0]
            if positions:
                structural_diags.append(
                    StructuralDiagnostic(
                        line=idx,
                        col=min(positions) + 1,
                        rule_code="RS001",
                        category="safety",
                        message="Unchecked `.unwrap()` / `panic!` in non-test Rust code.",
                    )
                )
                if len(structural_diags) >= 12:
                    break

    raw_imports = list(dict.fromkeys(imp for imp in raw_imports_all if imp))
    symbol_count = func_count + type_def_count
    denom = max(1, symbol_count + 2)
    doc_signal = min(1.0, (typed_nodes * 0.25 + max(comment_lines, docstring_nodes) * 0.4) / denom)
    module_doc, ast_symbols = _extract_ast_metadata(
        root, source_bytes, grammar_key, func_complexities
    )
    endpoints = _extract_endpoints(text)

    has_py_main = 'if __name__ == "__main__"' in text or "if __name__ == '__main__'" in text
    signals = {
        "func_count": func_count,
        "type_def_count": type_def_count,
        "loop_count": loop_count,
        "has_main": ast_main_symbol or has_py_main,
        "is_test": is_test,
        "route_hints": bool(_ROUTE_RE.search(code_surface))
        or any(
            ep.startswith(("GET ", "POST ", "PUT ", "DELETE ", "PATCH ", "ROUTE "))
            for ep in endpoints
        ),
        "db_hints": bool(_DB_RE.search(code_surface)),
        "auth_hints": bool(_AUTH_RE.search(code_surface)),
        "cli_hints": bool(_CLI_RE.search(code_surface)),
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
        module_doc=module_doc,
        symbols=ast_symbols,
        endpoints=endpoints,
        most_complex_symbol=most_complex_symbol,
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
    """Walk a checked-out worktree (without following symlinks) and analyze all source files."""
    root = worktree_root.resolve()
    results: dict[str, AstFileInfo] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".git"))
        base = Path(dirpath)
        for fname in sorted(filenames):
            path = base / fname
            if path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
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
