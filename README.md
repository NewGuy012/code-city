# CodeCity

**CodeCity** is an interactive, SimCity-inspired polyglot visual time-machine that turns any **Python, TypeScript/JS, Rust, or Go** Git repository into a living isometric city.

## Highlights

- **2D Isometric SimCity Canvas (Default) + Lazy 3D Skyline Toggle (`2D ↔ 3D`):** Zoned neighborhoods, paved streets with animated traffic pulses, Waterfront Supply Docks for external dependencies, 10 architectural building archetypes, animated construction cranes, lint smog, and solitary lighthouse beacons for Bus Factor = 1.
- **Polyglot AST & Toolchain Plugins:** Unified **Tree-sitter** core (`Python`, `TypeScript/JS`, `Rust`, `Go`) + `ruff` (`ruff check`, `ruff analyze graph`, `--fix --diff`) + `Bun` toolchain (`bun lint` / `oxlint`, `bun fmt --check`) + `go.mod` & `Cargo.toml`/`Cargo.lock` dependency graphs.
- **DuckDB 2.0 + DuckLake 1.1 + Quack Lakehouse:** Parallel `git worktree` workers ingest concurrently over **Quack** into nested DuckLake schemas (`repos.<owner>.<repo>`) with `VARIANT` metadata, Data Inlining for live collaborative Mayor Notes, `ducklake_table_changes()` audit feed, and client-side `DuckDB-Wasm` recursive CTE Blast Radius queries over Parquet.
- **Two Modes from One Studio:** Live Studio mode (lean FastAPI control plane with SSE progress, Parquet export, Live Mayor Git branch actions, live `--fix` diff previews, Co-Op sandbox sync, and localhost-restricted Quack CORS proxy) and zero-backend **Static OSS Report Mode** (`DuckDB-Wasm` + Parquet + SVG grade badge + Playwright PNG City Postcard).

## Quickstart

### Prerequisites
- `uv` (`>=0.5`) with Python `3.12+`
- `bun` (`>=1.4`)

### Setup
```bash
uv sync --extra dev
(cd frontend && bun install && bun run build)
```

### Analyze & Launch Studio
```bash
# Analyze any local repository or public GitHub URL
uv run codecity analyze . --max-keyframes 16 --workers 4

# Launch FastAPI Control Plane + Quack CORS Proxy + Studio UI on http://127.0.0.1:8787
uv run codecity serve

# Export a zero-backend static OSS report + Playwright PNG postcard
uv run codecity export repo/code_city --out ./export-dist --postcard
```

## Verification
```bash
uv run ruff format --check backend/src backend/tests
uv run ruff check backend/src backend/tests
uv run --extra dev pytest -v
cd frontend && bun fmt --no-script --check && bun check && bun run lint && bun test && bun run build
```
