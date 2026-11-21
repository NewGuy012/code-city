import { Building2, FolderGit2, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CityCanvas2D, type FocusTarget } from "./city/CityCanvas2D";
import { AdvisorTicker } from "./components/AdvisorTicker";
import { DataMapBar } from "./components/DataMapBar";
import { type CitySnapshotBundle, CityDataClient } from "./data/cityDataClient";
import type { BlastRadiusResult, DataMapMode, RepoRef, Snapshot } from "./types/city";

export function App() {
  const clientRef = useRef<CityDataClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new CityDataClient();
  }
  const client = clientRef.current;

  const [isStaticMode, setIsStaticMode] = useState(false);
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [activeRepo, setActiveRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotIdx, setSnapshotIdx] = useState(0);
  const [bundle, setBundle] = useState<CitySnapshotBundle | null>(null);

  const [dataMap, setDataMap] = useState<DataMapMode>("living");
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [blastRadius, setBlastRadius] = useState<BlastRadiusResult | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);

  const [repoInput, setRepoInput] = useState(".");
  const [loadingMsg, setLoadingMsg] = useState<string | null>("Booting DuckDB-Wasm...");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [analyzePct, setAnalyzePct] = useState<number | null>(null);

  const loadRepoData = useCallback(
    async (owner: string, repo: string, baseUrl: string, force = false) => {
      setLoadingMsg(`Loading ${owner}/${repo} into DuckDB-Wasm...`);
      setErrorMsg(null);
      try {
        await client.loadParquetTables(baseUrl, `${owner}/${repo}:${baseUrl}`, force);
        const snaps = await client.querySnapshots();
        setSnapshots(snaps);
        const latest = snaps[snaps.length - 1]?.snapshot_idx ?? 0;
        setSnapshotIdx(latest);
        const nextBundle = await client.querySnapshotBundle(latest);
        setBundle(nextBundle);
        setSelectedFile(null);
        setBlastRadius(null);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingMsg(null);
      }
    },
    [client],
  );

  // Boot: detect Static Export vs Live Studio
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const manifest = await client.detectStaticManifest();
      if (cancelled) return;
      if (manifest) {
        setIsStaticMode(true);
        setActiveRepo({ owner: manifest.owner, repo: manifest.repo });
        await loadRepoData(manifest.owner, manifest.repo, "./data");
        return;
      }
      try {
        const list = await client.fetchRepos();
        if (cancelled) return;
        setRepos(list);
        if (list.length > 0) {
          const first = list[0];
          setActiveRepo({ owner: first.owner, repo: first.repo });
          await loadRepoData(
            first.owner,
            first.repo,
            `/api/repos/${first.owner}/${first.repo}/parquet`,
          );
        } else {
          setLoadingMsg(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadingMsg(null);
          setErrorMsg(
            err instanceof Error ? err.message : "Could not reach CodeCity API or static manifest.",
          );
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [client, loadRepoData]);

  // Reload snapshot bundle when scrubbing snapshots
  useEffect(() => {
    if (!activeRepo || snapshots.length === 0) return;
    let cancelled = false;
    client
      .querySnapshotBundle(snapshotIdx)
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeRepo, client, snapshotIdx, snapshots.length]);

  // Compute Power-Outage Blast Radius via DuckDB-Wasm recursive CTE on selection
  useEffect(() => {
    if (!selectedFile || !bundle) {
      setBlastRadius(null);
      return;
    }
    let cancelled = false;
    client
      .queryBlastRadius(bundle.snapshot.snapshot_idx, selectedFile)
      .then((res) => {
        if (!cancelled) setBlastRadius(res);
      })
      .catch(() => {
        if (!cancelled) setBlastRadius(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bundle, client, selectedFile]);

  async function handleAnalyzeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoInput.trim() || isStaticMode) return;
    setErrorMsg(null);
    setAnalyzePct(2);
    setLoadingMsg(`Starting analysis for ${repoInput.trim()}...`);
    try {
      const { job_id, owner, repo } = await client.startAnalyze(repoInput.trim(), 16);
      const es = new EventSource(`/api/jobs/${job_id}/events`);
      es.addEventListener("progress", (evt) => {
        const payload = JSON.parse((evt as MessageEvent).data) as {
          stage: string;
          message: string;
          percent: number;
          owner?: string;
          repo?: string;
        };
        setLoadingMsg(payload.message);
        setAnalyzePct(payload.percent);
        if (payload.stage === "completed") {
          es.close();
          setAnalyzePct(null);
          void client.fetchRepos().then(setRepos);
          const o = payload.owner ?? owner;
          const r = payload.repo ?? repo;
          setActiveRepo({ owner: o, repo: r });
          void loadRepoData(o, r, `/api/repos/${o}/${r}/parquet`, true);
        } else if (payload.stage === "error") {
          es.close();
          setAnalyzePct(null);
          setLoadingMsg(null);
          setErrorMsg(payload.message);
        }
      });
      es.onerror = () => {
        es.close();
      };
    } catch (err) {
      setAnalyzePct(null);
      setLoadingMsg(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  function handleFocusFile(filePath: string) {
    if (!bundle) return;
    const f = bundle.files.find((item) => item.file_path === filePath);
    if (!f) return;
    setSelectedFile(f.file_path);
    setFocusTarget({
      x: f.layout_x + f.layout_w * 0.5,
      z: f.layout_z + f.layout_d * 0.5,
      zoom: 1.45,
      nonce: Date.now(),
    });
  }

  const emptySet = useMemo(() => new Set<string>(), []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Main Viewport */}
      {bundle ? (
        <CityCanvas2D
          districts={bundle.districts}
          files={bundle.files}
          imports={bundle.imports}
          cochanges={bundle.cochanges}
          deps={bundle.deps}
          dataMap={dataMap}
          selectedFile={selectedFile}
          blastRadius={blastRadius}
          addedFiles={emptySet}
          removedLots={[]}
          focusTarget={focusTarget}
          onSelectFile={setSelectedFile}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div className="sim-panel flex max-w-md flex-col items-center gap-3 rounded-2xl p-8 text-center">
            <Building2 className="h-10 w-10 text-amber-400" />
            <h2 className="text-lg font-bold">Welcome to CodeCity</h2>
            <p className="text-sm text-slate-300">
              {loadingMsg ??
                "Analyze any local repository or GitHub URL above to transform its Git history into a living city."}
            </p>
            {errorMsg && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {errorMsg}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top HUD Header */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Brand + Repo Picker + Grade */}
          <div className="sim-panel pointer-events-auto flex items-center gap-3 rounded-2xl px-3.5 py-2">
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-amber-400" />
              <span className="font-bold tracking-tight text-white">CodeCity</span>
            </div>

            {!isStaticMode && repos.length > 0 && (
              <select
                value={activeRepo ? `${activeRepo.owner}/${activeRepo.repo}` : ""}
                onChange={(e) => {
                  const [o, r] = e.target.value.split("/");
                  if (o && r) {
                    setActiveRepo({ owner: o, repo: r });
                    void loadRepoData(o, r, `/api/repos/${o}/${r}/parquet`);
                  }
                }}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200"
              >
                {repos.map((r) => (
                  <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>
                    {r.owner}/{r.repo} ({r.latest_grade})
                  </option>
                ))}
              </select>
            )}

            {bundle && (
              <div className="flex items-center gap-2 border-l border-slate-700 pl-3 text-xs">
                <span className="rounded-lg bg-amber-400/20 px-2 py-0.5 font-extrabold text-amber-300 ring-1 ring-amber-400/40">
                  {bundle.snapshot.health_grade}
                </span>
                <span className="hidden font-medium text-slate-200 md:inline">
                  {bundle.snapshot.city_archetype_title}
                </span>
                <span className="text-slate-400">
                  {bundle.snapshot.total_files} files ·{" "}
                  {bundle.snapshot.total_sloc.toLocaleString()} SLOC
                </span>
              </div>
            )}
          </div>

          {/* Live Repo Analyzer Input */}
          {!isStaticMode && (
            <form
              onSubmit={handleAnalyzeSubmit}
              className="sim-panel pointer-events-auto flex items-center gap-2 rounded-2xl px-3 py-1.5"
            >
              <FolderGit2 className="h-4 w-4 text-sky-400" />
              <input
                type="text"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder="Path or GitHub URL (e.g. . or https://...)"
                className="w-52 bg-transparent text-xs text-slate-100 placeholder-slate-500 focus:outline-none sm:w-64"
              />
              <button
                type="submit"
                disabled={analyzePct !== null}
                className="flex items-center gap-1 rounded-xl bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-60"
              >
                {analyzePct !== null ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                <span>Analyze</span>
              </button>
            </form>
          )}
        </div>

        {/* Data Maps + Advisor Ticker */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="pointer-events-auto">
            <DataMapBar
              dataMap={dataMap}
              onChangeDataMap={setDataMap}
              viewMode={viewMode}
              onToggleViewMode={() => setViewMode((m) => (m === "2d" ? "3d" : "2d"))}
              onStartTour={() => {}}
              onOpenHealthModal={() => {}}
              tourActive={false}
            />
          </div>

          {bundle && (
            <div className="pointer-events-auto">
              <AdvisorTicker
                alerts={bundle.snapshot.advisor_alerts}
                onFocusFile={handleFocusFile}
              />
            </div>
          )}
        </div>

        {loadingMsg && (
          <div className="sim-panel pointer-events-auto flex items-center gap-2 self-start rounded-xl px-3 py-1.5 text-xs text-sky-200">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
            <span>{loadingMsg}</span>
            {analyzePct !== null && (
              <span className="font-mono text-amber-300">{analyzePct.toFixed(0)}%</span>
            )}
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
