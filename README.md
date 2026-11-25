<div align="center">

  <img src="assets/logo.png" alt="CodeCity logo" width="112" height="112" />

  <h1>CodeCity</h1>

  <p><strong>Turn any Git repository into a living isometric &amp; 3D codebase city.</strong></p>

  <p>
    Explore architectural structure, commit history, blast radius, and code health across Python, TypeScript/JS, Rust, and Go — powered by Tree-sitter, DuckLake, and in-browser DuckDB-Wasm.
  </p>

  <p>
    <a href="#quickstart">Quickstart</a> &nbsp;&bull;&nbsp;
    <a href="#features">Features</a> &nbsp;&bull;&nbsp;
    <a href="#cli">CLI</a> &nbsp;&bull;&nbsp;
    <a href="#architecture">Architecture</a> &nbsp;&bull;&nbsp;
    <a href="#development">Development</a>
  </p>

</div>

---

## Quickstart

Requires [`uv`](https://docs.astral.sh/uv/) (`>= 0.5`, Python `3.12+`) and [`bun`](https://bun.sh/) (`>= 1.4`).

```bash
# 1. Install backend dependencies & build the studio UI
uv sync --extra dev
(cd frontend && bun install && bun run build)

# 2. Analyze a local repository or public Git URL
uv run codecity analyze . --max-keyframes 16 --workers 4

# 3. Launch the Studio UI on http://127.0.0.1:8787
uv run codecity serve
```

Export a self-contained static report (with an optional Playwright PNG postcard):

```bash
uv run codecity list
uv run codecity export <owner>/<repo> --out ./export-dist --postcard
```

---

## Features

- **Polyglot AST & Toolchain Analysis** — Parses Python (`Tree-sitter` + `ruff`), TypeScript/JS (`Tree-sitter` + `bun` / `oxlint`), Go (`go.mod`), and Rust (`Cargo.toml` / `Cargo.lock`) across parallel `git worktree` historical keyframes.
- **2D Isometric Canvas & Lazy 3D City** — Toggle smoothly between a crisp SimCity-style 2D isometric view and a hardware-accelerated Three.js 3D skyline with zoned districts, Waterfront Supply Docks for external packages, building archetypes, and live traffic pulses.
- **Six Live Data Maps** — Switch perspectives between `Living City`, `Construction`, `Smog & Lint`, `Bus Factor`, `Languages`, and `Format Drift`.
- **Time Travel & Blast Radius** — Scrub historical keyframes, inspect transitive import cascades directly in-browser via recursive SQL, preview `--fix` diffs, and run chaos disaster simulations (Cascading Power Outage, Bus Factor Vacation, Release Crunch Storm, Supply Dock Storm).
- **Safe Mayor Mode & Co-Op Notes** — Test architectural refactors in sandbox mode, collaborate via persistent Mayor Notes, or apply real automated changes on an isolated `codecity/mayor-session` branch.
- **Zero-Backend Static Reports** — Share an entire navigable city backed solely by static Parquet files, `DuckDB-Wasm`, an SVG health badge, and a City Postcard PNG.

---

## CLI

Catalog data defaults to `.codecity/` (override with `codecity --data-dir <path> ...`).

| Command | Purpose |
| :--- | :--- |
| `codecity analyze <source>` | Analyze a local repo or Git URL (`--max-keyframes`, `--workers`, `--semantic`, `--owner`, `--repo`) |
| `codecity list` | List analyzed repositories, snapshot counts, file counts, and health grades |
| `codecity serve` | Start the FastAPI control plane, Quack CORS proxy, and Studio UI (`--host`, `--port`) |
| `codecity export <owner/repo>` | Export a static DuckDB-Wasm bundle (`--out <dir>`, `--postcard`) |

---

## Architecture

| Layer | Stack | Role |
| :--- | :--- | :--- |
| **Analyzer** | `Tree-sitter`, `ruff`, `bun` / `oxlint`, `git worktree` | Multi-worker keyframe AST, complexity, lint, churn, and dependency extraction with symlink/SSRF validation, isolated `bun lint`/`oxlint` execution, and hook-disabled Git execution |
| **Lakehouse** | `DuckDB 2.0`, `DuckLake 1.1`, `Quack` | Concurrent nested schemas (`repos.<owner>.<repo>`), `VARIANT` metrics, Parquet export, and audit feeds |
| **Control Plane** | `FastAPI`, `uvicorn`, stdlib HTTP, SSE | Thin local server with bounded per-repo jobs, CSRF origin checks, validated payloads, SSE progress, Parquet serving, localhost Quack proxy, sandboxed SVG badges, and Mayor Git actions |
| **Studio UI** | `React`, `DuckDB-Wasm`, `Canvas 2D`, bare `Three.js` | Client-side Parquet SQL analytics (snapshots, blast radius, city tours, health reports) and instanced 2D/3D rendering across Live and Static modes |

---

## Development

Run the full verification suite across backend and frontend:

```bash
# Backend formatting, lint, unit/API tests, and Playwright E2E
uv run ruff format --check backend/src backend/tests
uv run ruff check backend/src backend/tests
uv run --extra dev pytest -v

# Frontend formatting, typecheck, lint, unit tests, and production bundle
cd frontend && bun fmt --no-script --check && bun check && bun run lint && bun test && bun run build
```
