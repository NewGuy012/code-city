import { Building2, FolderGit2, Loader2, Search } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CityCanvas2D, type FocusTarget } from "./city/CityCanvas2D";
import type { GhostLot } from "./city/isoRenderer2D";
import { AdvisorTicker } from "./components/AdvisorTicker";
import { DataMapBar } from "./components/DataMapBar";
import { InspectorDrawer } from "./components/InspectorDrawer";
import { OnboardingTour } from "./components/OnboardingTour";
import { TimeScrubber } from "./components/TimeScrubber";
import { type CitySnapshotBundle, CityDataClient, type TourLandmark } from "./data/cityDataClient";
import type {
  Annotation,
  BlastRadiusResult,
  DataMapMode,
  LintDiagnostic,
  RepoRef,
  Snapshot,
} from "./types/city";

const CityCanvas3D = lazy(() => import("./city/CityCanvas3D"));

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
  const [prevBundle, setPrevBundle] = useState<CitySnapshotBundle | null>(null);

  const [dataMap, setDataMap] = useState<DataMapMode>("living");
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [blastRadius, setBlastRadius] = useState<BlastRadiusResult | null>(null);
  const [fileDiagnostics, setFileDiagnostics] = useState<LintDiagnostic[]>([]);
  const [fileHistory, setFileHistory] = useState<
    Array<{
      snapshot_idx: number;
      sloc: number;
      hotspot_score: number;
      lint_issue_count: number;
    }>
  >([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);

  const [isPlayingTime, setIsPlayingTime] = useState(false);
  const [tourStops, setTourStops] = useState<TourLandmark[]>([]);
  const [tourStep, setTourStep] = useState(0);
  const [tourActive, setTourActive] = useState(false);
  const [tourAutoPlay, setTourAutoPlay] = useState(true);
  const [healthModalOpen, setHealthModalOpen] = useState(false);

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
        if (snaps.length > 1) {
          const prevIdx = snaps[snaps.length - 2].snapshot_idx;
          setPrevBundle(await client.querySnapshotBundle(prevIdx));
        } else {
          setPrevBundle(null);
        }
        setAnnotations(await client.queryAnnotations());
        setSelectedFile(null);
        setBlastRadius(null);
        setTourActive(false);
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

  // Reload current & previous snapshot bundles when scrubbing time
  useEffect(() => {
    if (!activeRepo || snapshots.length === 0) return;
    let cancelled = false;
    const pos = snapshots.findIndex((s) => s.snapshot_idx === snapshotIdx);
    const prevSnap = pos > 0 ? snapshots[pos - 1] : null;
    Promise.all([
      client.querySnapshotBundle(snapshotIdx),
      prevSnap ? client.querySnapshotBundle(prevSnap.snapshot_idx) : Promise.resolve(null),
    ])
      .then(([cur, prev]) => {
        if (!cancelled) {
          setBundle(cur);
          setPrevBundle(prev);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeRepo, client, snapshotIdx, snapshots]);

  // Time-lapse playback loop
  useEffect(() => {
    if (!isPlayingTime || snapshots.length <= 1) return;
    const timer = setInterval(() => {
      setSnapshotIdx((cur) => {
        const pos = snapshots.findIndex((s) => s.snapshot_idx === cur);
        const nextPos = (pos + 1) % snapshots.length;
        return snapshots[nextPos].snapshot_idx;
      });
    }, 1150);
    return () => clearInterval(timer);
  }, [isPlayingTime, snapshots]);

  // Inspector data: Blast Radius + Diagnostics + Historical Sparklines via DuckDB-Wasm
  useEffect(() => {
    if (!selectedFile || !bundle) {
      setBlastRadius(null);
      setFileDiagnostics([]);
      setFileHistory([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      client.queryBlastRadius(bundle.snapshot.snapshot_idx, selectedFile),
      client.queryFileDiagnostics(bundle.snapshot.snapshot_idx, selectedFile),
      client.queryFileHistory(selectedFile),
    ])
      .then(([blast, diags, hist]) => {
        if (!cancelled) {
          setBlastRadius(blast);
          setFileDiagnostics(diags);
          setFileHistory(hist);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bundle, client, selectedFile]);

  // Ghost diff sets comparing current snapshot vs previous snapshot
  const { addedFiles, removedLots } = useMemo(() => {
    if (!bundle || !prevBundle) {
      return { addedFiles: new Set<string>(), removedLots: [] as GhostLot[] };
    }
    const curPaths = new Set(bundle.files.map((f) => f.file_path));
    const prevPaths = new Set(prevBundle.files.map((f) => f.file_path));
    const added = new Set<string>();
    for (const p of curPaths) {
      if (!prevPaths.has(p)) added.add(p);
    }
    const removed: GhostLot[] = prevBundle.files
      .filter((f) => !curPaths.has(f.file_path))
      .map((f) => ({
        file_path: f.file_path,
        layout_x: f.layout_x,
        layout_z: f.layout_z,
        layout_w: f.layout_w,
        layout_d: f.layout_d,
      }));
    return { addedFiles: added, removedLots: removed };
  }, [bundle, prevBundle]);

  const selectedFileMetric = useMemo(() => {
    if (!bundle || !selectedFile) return null;
    return bundle.files.find((f) => f.file_path === selectedFile) ?? null;
  }, [bundle, selectedFile]);

  const handleFocusFile = useCallback(
    (filePath: string) => {
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
    },
    [bundle],
  );

  // Mayor's Guided Tour control & auto-advance
  async function handleStartTour() {
    if (!bundle) return;
    if (tourActive) {
      setTourActive(false);
      return;
    }
    const stops = await client.queryTourLandmarks(bundle.snapshot.snapshot_idx);
    if (stops.length === 0) return;
    setTourStops(stops);
    setTourStep(0);
    setTourActive(true);
    setTourAutoPlay(true);
    const first = stops[0];
    setSelectedFile(first.file_path);
    setFocusTarget({
      x: first.layout_x + first.layout_w * 0.5,
      z: first.layout_z + first.layout_d * 0.5,
      zoom: 1.45,
      nonce: Date.now(),
    });
  }

  function handleSelectTourStep(idx: number) {
    setTourStep(idx);
    const stop = tourStops[idx];
    if (stop) {
      setSelectedFile(stop.file_path);
      setFocusTarget({
        x: stop.layout_x + stop.layout_w * 0.5,
        z: stop.layout_z + stop.layout_d * 0.5,
        zoom: 1.45,
        nonce: Date.now(),
      });
    }
  }

  useEffect(() => {
    if (!tourActive || !tourAutoPlay || tourStops.length <= 1) return;
    const timer = setInterval(() => {
      setTourStep((prev) => {
        const next = (prev + 1) % tourStops.length;
        const stop = tourStops[next];
        if (stop) {
          setSelectedFile(stop.file_path);
          setFocusTarget({
            x: stop.layout_x + stop.layout_w * 0.5,
            z: stop.layout_z + stop.layout_d * 0.5,
            zoom: 1.45,
            nonce: Date.now(),
          });
        }
        return next;
      });
    }, 6500);
    return () => clearInterval(timer);
  }, [tourActive, tourAutoPlay, tourStops]);

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

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Main 2D Isometric or Lazy 3D Skyline Canvas */}
      {bundle ? (
        viewMode === "2d" ? (
          <CityCanvas2D
            districts={bundle.districts}
            files={bundle.files}
            imports={bundle.imports}
            cochanges={bundle.cochanges}
            deps={bundle.deps}
            dataMap={dataMap}
            selectedFile={selectedFile}
            blastRadius={blastRadius}
            addedFiles={addedFiles}
            removedLots={removedLots}
            focusTarget={focusTarget}
            onSelectFile={setSelectedFile}
          />
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center text-sm text-sky-300">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading 3D Skyline...
              </div>
            }
          >
            <CityCanvas3D
              districts={bundle.districts}
              files={bundle.files}
              cochanges={bundle.cochanges}
              dataMap={dataMap}
              selectedFile={selectedFile}
              blastRadius={blastRadius}
              onSelectFile={setSelectedFile}
            />
          </Suspense>
        )
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
          <div className="sim-panel pointer-events-auto flex items-center gap-3 rounded-2xl px-3.5 py-2">
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-amber-400" />
              <span className="font-bold tracking-tight text-white">CodeCity</span>
            </div>

            {!isStaticMode && repos.length > 0 && (
              <select
                data-testid="repo-selector"
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
                <span
                  data-testid="city-grade-badge"
                  className="rounded-lg bg-amber-400/20 px-2 py-0.5 font-extrabold text-amber-300 ring-1 ring-amber-400/40"
                >
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

          {!isStaticMode && (
            <form
              onSubmit={(e) => void handleAnalyzeSubmit(e)}
              className="sim-panel pointer-events-auto flex items-center gap-2 rounded-2xl px-3 py-1.5"
            >
              <FolderGit2 className="h-4 w-4 text-sky-400" />
              <input
                type="text"
                data-testid="analyze-source-input"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder="Path or GitHub URL (e.g. . or https://...)"
                className="w-52 bg-transparent text-xs text-slate-100 placeholder-slate-500 focus:outline-none sm:w-64"
              />
              <button
                type="submit"
                data-testid="analyze-submit-btn"
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

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="pointer-events-auto">
            <DataMapBar
              dataMap={dataMap}
              onChangeDataMap={setDataMap}
              viewMode={viewMode}
              onToggleViewMode={() => setViewMode((m) => (m === "2d" ? "3d" : "2d"))}
              onStartTour={() => void handleStartTour()}
              onOpenHealthModal={() => setHealthModalOpen((o) => !o)}
              tourActive={tourActive}
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

      {/* Guided Onboarding Tour Overlay */}
      {tourActive && (
        <OnboardingTour
          stops={tourStops}
          stepIndex={tourStep}
          autoPlaying={tourAutoPlay}
          onSelectStep={handleSelectTourStep}
          onToggleAuto={() => setTourAutoPlay((a) => !a)}
          onClose={() => setTourActive(false)}
        />
      )}

      {/* Building Blueprint Inspector Drawer */}
      <InspectorDrawer
        file={selectedFileMetric}
        blastRadius={blastRadius}
        diagnostics={fileDiagnostics}
        history={fileHistory}
        annotations={annotations}
        isStaticMode={isStaticMode}
        onRequestFixDiff={async (fpath) => {
          if (!activeRepo) {
            return {
              file_path: fpath,
              linter: "none",
              has_changes: false,
              diff: "",
              message: "No repository active",
            };
          }
          return client.fetchFixDiff(activeRepo.owner, activeRepo.repo, fpath);
        }}
        onAddAnnotation={async (payload) => {
          if (!activeRepo) return;
          const created = await client.postAnnotation(activeRepo.owner, activeRepo.repo, payload);
          setAnnotations((prev) => [created, ...prev]);
        }}
        onSelectFile={handleFocusFile}
        onClose={() => setSelectedFile(null)}
      />

      {/* Bottom Time-Machine Scrubber */}
      {bundle && snapshots.length > 0 && (
        <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
          <div className="w-full max-w-4xl">
            <TimeScrubber
              snapshots={snapshots}
              snapshotIdx={snapshotIdx}
              isPlaying={isPlayingTime}
              addedCount={addedFiles.size}
              removedCount={removedLots.length}
              onSelectSnapshot={(idx) => {
                setIsPlayingTime(false);
                setSnapshotIdx(idx);
              }}
              onTogglePlay={() => setIsPlayingTime((p) => !p)}
            />
          </div>
        </footer>
      )}

      {/* Placeholder toggle indicator for Phase 5 HealthCardModal */}
      {healthModalOpen && bundle && (
        <div className="pointer-events-auto absolute top-28 left-4 z-40 rounded-xl bg-slate-900 p-3 text-xs">
          Grade {bundle.snapshot.health_grade} ({bundle.snapshot.health_score}) — opening full
          report in Phase 5!
        </div>
      )}
    </div>
  );
}

export default App;
