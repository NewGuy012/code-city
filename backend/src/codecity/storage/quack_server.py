"""Managed DuckDB Quack server lifecycle for multi-writer ingestion and CLI ATTACH."""

from __future__ import annotations

import secrets
import socket
import threading
from dataclasses import dataclass

import duckdb

from codecity.storage.lakehouse import LakehouseManager, sanitize_identifier


def _pick_free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


@dataclass
class QuackEndpoint:
    """Connection metadata for a running Quack RPC endpoint."""

    quack_uri: str
    http_url: str
    token: str


class QuackServerManager:
    """Runs `quack_serve()` over the attached DuckLake catalog for concurrent clients."""

    def __init__(
        self,
        lakehouse: LakehouseManager,
        *,
        host: str = "127.0.0.1",
        port: int = 0,
        token: str | None = None,
    ) -> None:
        self.lakehouse = lakehouse
        self.host = host
        self.port = port
        self.token = token or secrets.token_urlsafe(18)
        self._lock = threading.Lock()
        self._con: duckdb.DuckDBPyConnection | None = None
        self._endpoint: QuackEndpoint | None = None

    @property
    def endpoint(self) -> QuackEndpoint | None:
        return self._endpoint

    def start(self) -> QuackEndpoint:
        """Start `quack_serve()` on the attached DuckLake connection if not already running."""
        with self._lock:
            if self._endpoint is not None:
                return self._endpoint
            actual_port = self.port if self.port > 0 else _pick_free_port(self.host)
            quack_uri = f"quack:{self.host}:{actual_port}"
            con = self.lakehouse.connect()
            try:
                tok = self.token.replace("'", "''")
                con.execute(f"CALL quack_serve('{quack_uri}', disable_ssl=true, token='{tok}');")
            except Exception:
                con.close()
                raise
            self._con = con
            self._endpoint = QuackEndpoint(
                quack_uri=quack_uri,
                http_url=f"http://{self.host}:{actual_port}",
                token=self.token,
            )
            return self._endpoint

    def stop(self) -> None:
        """Stop `quack_serve()` and close the host DuckDB connection."""
        with self._lock:
            if self._con is not None and self._endpoint is not None:
                try:
                    self._con.execute(f"CALL quack_stop('{self._endpoint.quack_uri}');")
                finally:
                    self._con.close()
                    self._con = None
                    self._endpoint = None

    def connect_client(self, *, alias: str = "remote") -> duckdb.DuckDBPyConnection:
        """Open a remote DuckDB connection attached to this Quack server."""
        ep = self.start()
        client = duckdb.connect()
        for ext in ("quack", "ducklake"):
            try:
                client.execute(f"LOAD {ext};")
            except duckdb.Error:
                client.execute(f"INSTALL {ext}; LOAD {ext};")
        tok = ep.token.replace("'", "''")
        client.execute(
            f"CREATE SECRET IF NOT EXISTS (TYPE quack, TOKEN '{tok}', SCOPE '{ep.quack_uri}');"
        )
        client.execute(f"ATTACH '{ep.quack_uri}' AS {alias} (DISABLE_SSL true);")
        return client

    def attach_snippet(self, owner: str, repo: str, *, proxy_url: str | None = None) -> str:
        """Render a copy-paste DuckDB CLI snippet to query or annotate the live DuckLake."""
        ep = self._endpoint
        target_uri = ep.quack_uri if ep else "quack:127.0.0.1:8080"
        token = ep.token if ep else "<token>"
        o = sanitize_identifier(owner)
        r = sanitize_identifier(repo)
        extra_note = f"-- Browser/HTTP CORS Proxy: {proxy_url}\n" if proxy_url else ""
        return (
            f"{extra_note}"
            "INSTALL quack; LOAD quack;\n"
            f"CREATE SECRET (TYPE quack, TOKEN '{token}', SCOPE '{target_uri}');\n"
            f"ATTACH '{target_uri}' AS codecity (DISABLE_SSL true);\n"
            f"SELECT file_path, building_archetype, hotspot_score\n"
            f"FROM codecity.{self.lakehouse.catalog_name}.repos.{o}.{r}.file_metrics\n"
            "ORDER BY hotspot_score DESC LIMIT 20;"
        )

    def __enter__(self) -> QuackServerManager:
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()
