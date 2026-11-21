import { Building2, FolderGit2, Loader2, Search, ShieldAlert } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CityCanvas2D, type FocusTarget } from "./city/CityCanvas2D";
import { cameraStore, useUnifiedCameraHotkeys } from "./city/cameraStore";
import type { GhostLot } from "./city/isoRenderer2D";
import { deriveStreetLinesAndPlazas } from "./city/streetGrid";
import { AdvisorCouncilModal } from "./components/AdvisorCouncilModal";
import { AdvisorTicker } from "./components/AdvisorTicker";
import { CameraControlsHUD } from "./components/CameraControlsHUD";
import { DataMapBar } from "./components/DataMapBar";
import { type AuthorSummary, DisastersMenu } from "./components/DisastersMenu";
import { EconomyBar } from "./components/EconomyBar";
import { HealthCardModal } from "./components/HealthCardModal";
import { InspectorDrawer } from "./components/InspectorDrawer";
import { MayorToolbar } from "./components/MayorToolbar";
import { Minimap2D } from "./components/Minimap2D";
import { OnboardingTour } from "./components/OnboardingTour";
import { TimeScrubber } from "./components/TimeScrubber";
import {
  type CitySnapshotBundle,
  CityDataClient,
  type HealthReportData,
  type TourLandmark,
} from "./data/cityDataClient";
import { type AdvisorMission, evaluateAdvisorMissions } from "./game/missions";
import {
  type MayorToolId,
  type SandboxActionRecord,
  applySandboxOverlay,
  validateToolOnFile,
} from "./game/sandboxOverlay";
import { CitySimulationEngine, type SimSpeed, type SimStateSnapshot } from "./game/simEngine";
import { soundEngine } from "./game/soundEngine";
import type {
  Annotation,
  BlastRadiusResult,
  DataMapMode,
  FileMetric,
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

  const simRef = useRef<CitySimulationEngine | null>(null);
  if (!simRef.current) {
    simRef.current = new CitySimulationEngine();
  }
  const sim = simRef.current;
  const [simState, setSimState] = useState<SimStateSnapshot>(() => sim.getSnapshot());

  const [isStaticMode, setIsStaticMode] = useState(false);
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [activeRepo, setActiveRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotIdx, setSnapshotIdx] = useState(0);
  const [bundle, setBundle] = useState<CitySnapshotBundle | null>(null);
  const [prevBundle, setPrevBundle] = useState<CitySnapshotBundle | null>(null);

  const [dataMap, setDataMap] = useState<DataMapMode>("living");
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [showTraffic, setShowTraffic] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const [activeTool, setActiveTool] = useState<MayorToolId>("inspect");
  const [sandboxActions, setSandboxActions] = useState<SandboxActionRecord[]>([]);
  const [pendingTransitStart, setPendingTransitStart] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [liveBranchName, setLiveBranchName] = useState<string | null>(null);
  const [coopSyncEnabled, setCoopSyncEnabled] = useState(false);

  const overlayResult = useMemo(
    () => (bundle ? applySandboxOverlay(bundle, sandboxActions) : null),
    [bundle, sandboxActions],
  );
  const effectiveBundle = overlayResult?.bundle ?? null;

  useUnifiedCameraHotkeys(viewMode);

  // Cinematic turntable orbit (Preset 5) + Follow Vehicle Cam (Preset 4)
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = cameraStore.getState();
      if (st.cinematicOrbit) {
        cameraStore.setState({ yaw: st.yaw + 0.18 * dt }, { cancelTween: false });
      } else if (st.followVehicleId) {
        const veh = sim.getFollowedVehicle(st.followVehicleId);
        if (veh) {
          cameraStore.setState(
            {
              targetX: st.targetX + (veh.x - st.targetX) * 0.22,
              targetZ: st.targetZ + (veh.z - st.targetZ) * 0.22,
            },
            { cancelTween: false },
          );
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  // Decoupled 10Hz traffic & city-health simulation loop
  useEffect(() => {
    if (!effectiveBundle) return;
    setSimState(sim.step(effectiveBundle));
    const timer = setInterval(() => {
      const spd = sim.getSpeed();
      if (spd === 0) {
        setSimState(sim.getSnapshot());
        return;
      }
      let next = sim.step(effectiveBundle);
      for (let extra = 1; extra < spd; extra++) {
        next = sim.step(effectiveBundle);
      }
      setSimState(next);
    }, 100);
    return () => clearInterval(timer);
  }, [effectiveBundle, sim]);

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
  const [healthReport, setHealthReport] = useState<HealthReportData | null>(null);

  const [repoInput, setRepoInput] = useState(".");
  const [loadingMsg, setLoadingMsg] = useState<string | null>("Booting DuckDB-Wasm...");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [analyzePct, setAnalyzePct] = useState<number | null>(null);

  const [advisorsOpen, setAdvisorsOpen] = useState(false);
  const [disastersOpen, setDisastersOpen] = useState(false);
  const [missions, setMissions] = useState<AdvisorMission[]>([]);
  const [claimedMissions, setClaimedMissions] = useState<Set<string>>(() => new Set());
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [repoAuthors, setRepoAuthors] = useState<AuthorSummary[]>([]);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  // Re-evaluate SQL-driven Advisor Quests when effectiveBundle changes
  useEffect(() => {
    if (!effectiveBundle) {
      setMissions([]);
      return;
    }
    let cancelled = false;
    void evaluateAdvisorMissions(client, effectiveBundle).then((list) => {
      if (!cancelled) setMissions(list);
    });
    return () => {
      cancelled = true;
    };
  }, [client, effectiveBundle]);

  // Play milestone fanfare + celebratory popups when city levels up
  useEffect(() => {
    if (!simState.milestoneEvent) return;
    soundEngine.playMilestone();
    showToast(`🎉 Milestone Unlocked: ${simState.milestoneEvent}!`);
    sim.spawnFloatingPopup(70, 52, `★ ${simState.milestoneEvent}!`, "#fde047");
    sim.clearMilestoneEvent();
  }, [showToast, sim, simState.milestoneEvent]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3200);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveTool("inspect");
        setPendingTransitStart(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        setSandboxActions(await client.querySandboxActions());
        setPendingTransitStart(null);
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

  // Ghost diff sets comparing current snapshot vs previous snapshot + sandbox overlay
  const { addedFiles, removedLots } = useMemo(() => {
    const added = new Set<string>(overlayResult?.addedFiles ?? []);
    const removed: GhostLot[] = [...(overlayResult?.demolishedLots ?? [])];
    if (!bundle || !prevBundle) {
      return { addedFiles: added, removedLots: removed };
    }
    const curPaths = new Set(bundle.files.map((f) => f.file_path));
    const prevPaths = new Set(prevBundle.files.map((f) => f.file_path));
    for (const p of curPaths) {
      if (!prevPaths.has(p)) added.add(p);
    }
    for (const f of prevBundle.files) {
      if (!curPaths.has(f.file_path)) {
        removed.push({
          file_path: f.file_path,
          layout_x: f.layout_x,
          layout_z: f.layout_z,
          layout_w: f.layout_w,
          layout_d: f.layout_d,
        });
      }
    }
    return { addedFiles: added, removedLots: removed };
  }, [bundle, overlayResult, prevBundle]);

  const selectedFileMetric = useMemo(() => {
    if (!effectiveBundle || !selectedFile) return null;
    return effectiveBundle.files.find((f) => f.file_path === selectedFile) ?? null;
  }, [effectiveBundle, selectedFile]);

  const streetGrid = useMemo(() => {
    if (!effectiveBundle) return { xLines: [], zLines: [], plazas: [] };
    return deriveStreetLinesAndPlazas(effectiveBundle.districts, effectiveBundle.files);
  }, [effectiveBundle]);

  const handleFocusFile = useCallback(
    (filePath: string) => {
      if (!effectiveBundle) return;
      const f = effectiveBundle.files.find((item) => item.file_path === filePath);
      if (!f) return;
      setSelectedFile(f.file_path);
      setFocusTarget({
        x: f.layout_x + f.layout_w * 0.5,
        z: f.layout_z + f.layout_d * 0.5,
        zoom: 1.45,
        nonce: Date.now(),
      });
    },
    [effectiveBundle],
  );

  const handleToolAction = useCallback(
    async (file: FileMetric) => {
      if (!effectiveBundle || activeTool === "inspect") return;
      const tool = activeTool;

      if (tool === "transit_hub" && !pendingTransitStart) {
        const check = validateToolOnFile(tool, file, effectiveBundle, null);
        if (!check.ok) {
          setPendingTransitStart(file.file_path);
          showToast(`Selected ${file.file_path} — click a 2nd building to bridge with Interface Hub`);
          return;
        }
      }

      const validation = validateToolOnFile(tool, file, effectiveBundle, pendingTransitStart);
      if (!validation.ok) {
        showToast(validation.reason ?? "Action cannot be applied to this building.");
        return;
      }

      const summaryMap: Record<Exclude<MayorToolId, "inspect">, string> = {
        sweeper: `Cleaned ${file.lint_issue_count} lint issues & format drift`,
        splitter: `Split ${file.sloc} SLOC monolith into balanced modules`,
        transit_hub: `Inserted Interface Hub between ${file.file_path} and ${validation.secondaryPath ?? "coupled partner"}`,
        proving_park: `Planted Proving Park shielding ${file.district_path}/`,
        co_maintainer: `Assigned co-maintainer (Bus Factor -> 2)`,
        bulldozer: `Demolished unimported dead module (fan-in == 0)`,
      };

      const nextList = await client.appendSandboxAction({
        tool,
        target_path: file.file_path,
        secondary_path: validation.secondaryPath ?? null,
        district_path: file.district_path,
        summary: summaryMap[tool],
        velocity_cost: validation.cost,
      });
      setSandboxActions(nextList);
      setPendingTransitStart(null);

      // Dispatch service vehicle & floating feedback popup
      const cx = file.layout_x + file.layout_w * 0.5;
      const cz = file.layout_z + file.layout_d * 0.5;
      sim.dispatchServiceUnit(tool === "sweeper" ? "sweeper" : "crew", file, effectiveBundle);
      sim.addVelocity(-validation.cost);
      const badge =
        tool === "sweeper"
          ? "-Smog +Health"
          : tool === "proving_park"
            ? "+Park +Happiness"
            : tool === "splitter"
              ? "Split -Congestion"
              : tool === "transit_hub"
                ? "+Interface -Cycle"
                : tool === "co_maintainer"
                  ? "+Co-Maintainer"
                  : "-Upkeep";
      sim.spawnFloatingPopup(cx, cz, badge, tool === "bulldozer" ? "#fda4af" : "#4ade80");
      soundEngine.playTool(tool);
      setSimState(sim.getSnapshot());
      showToast(`${summaryMap[tool]} (Sandbox)`);
    },
    [activeTool, client, effectiveBundle, pendingTransitStart, showToast, sim],
  );

  const handleUndo = useCallback(async () => {
    setSandboxActions(await client.undoSandboxAction());
    showToast("Undid last Mayor intervention");
  }, [client, showToast]);

  const handleRedo = useCallback(async () => {
    setSandboxActions(await client.redoSandboxAction());
    showToast("Redid Mayor intervention");
  }, [client, showToast]);

  const handleResetSandbox = useCallback(async () => {
    setSandboxActions(await client.resetSandboxActions());
    setPendingTransitStart(null);
    showToast("Sandbox reset to HEAD");
  }, [client, showToast]);

  async function handleOpenHealthModal() {
    if (!bundle || !activeRepo) return;
    if (healthModalOpen) {
      setHealthModalOpen(false);
      return;
    }
    const rep = await client.queryHealthReport(
      activeRepo.owner,
      activeRepo.repo,
      bundle.snapshot.snapshot_idx,
    );
    setHealthReport(rep);
    setHealthModalOpen(true);
  }
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
      {effectiveBundle ? (
        viewMode === "2d" ? (
          <CityCanvas2D
            districts={effectiveBundle.districts}
            files={effectiveBundle.files}
            imports={effectiveBundle.imports}
            cochanges={effectiveBundle.cochanges}
            deps={effectiveBundle.deps}
            dataMap={dataMap}
            selectedFile={selectedFile}
            blastRadius={blastRadius}
            addedFiles={addedFiles}
            removedLots={removedLots}
            focusTarget={focusTarget}
            showTraffic={showTraffic}
            vehicles={simState.vehicles}
            fireFiles={simState.fireFiles}
            blackoutFiles={simState.blackoutFiles}
            floatingPopups={simState.floatingPopups}
            plazas={streetGrid.plazas}
            streetLines={{ xLines: streetGrid.xLines, zLines: streetGrid.zLines }}
            activeTool={activeTool}
            onSelectFile={setSelectedFile}
            onToolAction={(f) => void handleToolAction(f)}
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
              districts={effectiveBundle.districts}
              files={effectiveBundle.files}
              cochanges={effectiveBundle.cochanges}
              deps={effectiveBundle.deps}
              dataMap={dataMap}
              selectedFile={selectedFile}
              blastRadius={blastRadius}
              focusTarget={focusTarget}
              vehicles={simState.vehicles}
              fireFiles={simState.fireFiles}
              blackoutFiles={simState.blackoutFiles}
              plazas={streetGrid.plazas}
              streetLines={{ xLines: streetGrid.xLines, zLines: streetGrid.zLines }}
              activeTool={activeTool}
              onSelectFile={setSelectedFile}
              onToolAction={(f) => void handleToolAction(f)}
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

            {effectiveBundle && (
              <div className="flex items-center gap-2 border-l border-slate-700 pl-3 text-xs">
                <span
                  data-testid="city-grade-badge"
                  className="rounded-lg bg-amber-400/20 px-2 py-0.5 font-extrabold text-amber-300 ring-1 ring-amber-400/40"
                >
                  {effectiveBundle.snapshot.health_grade}
                </span>
                <span className="hidden font-medium text-slate-200 md:inline">
                  {effectiveBundle.snapshot.city_archetype_title}
                </span>
                <span className="text-slate-400">
                  {effectiveBundle.snapshot.total_files} files ·{" "}
                  {effectiveBundle.snapshot.total_sloc.toLocaleString()} SLOC
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
              onOpenHealthModal={() => void handleOpenHealthModal()}
              tourActive={tourActive}
            />
          </div>

          {effectiveBundle && (
            <EconomyBar
              simState={simState}
              activeQuestCount={missions.filter((m) => !m.completed).length}
              soundEnabled={soundEnabled}
              onChangeSpeed={(spd: SimSpeed) => {
                sim.setSpeed(spd);
                setSimState(sim.getSnapshot());
              }}
              onOpenAdvisors={() => setAdvisorsOpen(true)}
              onOpenDisasters={() => {
                if (!isStaticMode && activeRepo) {
                  void fetch(`/api/repos/${activeRepo.owner}/${activeRepo.repo}/authors`)
                    .then((r) => (r.ok ? r.json() : []))
                    .then((rows: AuthorSummary[]) => {
                      if (Array.isArray(rows)) setRepoAuthors(rows);
                    })
                    .catch(() => {});
                }
                setDisastersOpen(true);
              }}
              onToggleSound={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                soundEngine.setEnabled(next);
              }}
            />
          )}

          {bundle && (
            <div className="pointer-events-auto">
              <AdvisorTicker
                alerts={bundle.snapshot.advisor_alerts}
                onFocusFile={handleFocusFile}
              />
            </div>
          )}
        </div>

        {/* Active Chaos Disaster Alert Banner */}
        {simState.activeDisaster && !simState.activeDisaster.resolved && (
          <div
            data-testid="active-disaster-banner"
            className="sim-panel pointer-events-auto flex items-center justify-between gap-3 self-center rounded-xl border-rose-500/50 bg-rose-950/75 px-4 py-1.5 text-xs text-rose-100"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 animate-pulse text-rose-400" />
              <span className="font-bold">{simState.activeDisaster.title}:</span>
              <span className="text-rose-200">{simState.activeDisaster.detail}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                sim.clearDisaster();
                setSimState(sim.getSnapshot());
              }}
              className="rounded-lg bg-rose-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-rose-500/50"
            >
              Resolve
            </button>
          </div>
        )}

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

      {/* Interactive Mayor Toolbar (Left Dock) */}
      {effectiveBundle && (
        <MayorToolbar
          activeTool={activeTool}
          onSelectTool={(t) => {
            setActiveTool(t);
            setPendingTransitStart(null);
          }}
          actions={sandboxActions}
          isStaticMode={isStaticMode}
          liveMode={liveMode}
          liveBranchName={liveBranchName}
          coopSyncEnabled={coopSyncEnabled}
          repoLabel={activeRepo ? `${activeRepo.owner}/${activeRepo.repo}` : "codecity"}
          baseBundle={bundle}
          effectiveBundle={effectiveBundle}
          pendingTransitStart={pendingTransitStart}
          onUndo={() => void handleUndo()}
          onRedo={() => void handleRedo()}
          onReset={() => void handleResetSandbox()}
          onToggleLiveMode={() => {
            setLiveMode((v) => !v);
            setLiveBranchName("codecity/mayor-session");
          }}
          onToggleCoopSync={() => setCoopSyncEnabled((v) => !v)}
        />
      )}

      {/* Toast Notification Banner */}
      {toastMsg && (
        <div
          data-testid="mayor-toast"
          className="sim-panel pointer-events-none fixed top-28 left-1/2 z-40 -translate-x-1/2 rounded-xl border-amber-400/40 px-4 py-2 text-xs font-medium text-amber-200 shadow-2xl"
        >
          {toastMsg}
        </div>
      )}

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

      {/* Bottom HUD: Camera Controls + Time-Machine Scrubber + Radar Minimap */}
      {bundle && snapshots.length > 0 && (
        <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-3 p-3">
          <CameraControlsHUD
            viewMode={viewMode}
            repoKey={activeRepo ? `${activeRepo.owner}/${activeRepo.repo}` : "default"}
            showTraffic={showTraffic}
            onToggleTraffic={() => setShowTraffic((v) => !v)}
          />
          <div className="min-w-0 flex-1 max-w-3xl">
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
          <Minimap2D
            districts={effectiveBundle?.districts ?? bundle.districts}
            files={effectiveBundle?.files ?? bundle.files}
            vehicles={simState.vehicles}
            fireFiles={simState.fireFiles}
            blackoutFiles={simState.blackoutFiles}
          />
        </footer>
      )}

      {/* Shareable Health Report, Quack CLI Snippet & Static Postcard Export Modal */}
      <HealthCardModal
        open={healthModalOpen}
        report={healthReport}
        annotations={annotations}
        isStaticMode={isStaticMode}
        onFetchQuackSnippet={() => {
          if (!activeRepo) {
            return Promise.resolve({
              quack_uri: null,
              token: null,
              proxy_url: "",
              snippet: "",
            });
          }
          return client.fetchQuackSnippet(activeRepo.owner, activeRepo.repo);
        }}
        onFetchAnnotationChanges={() => {
          if (!activeRepo) return Promise.resolve([]);
          return client.fetchAnnotationChanges(activeRepo.owner, activeRepo.repo);
        }}
        onTriggerExport={async () => {
          if (!activeRepo) {
            throw new Error("No repository active");
          }
          const resp = await fetch(`/api/repos/${activeRepo.owner}/${activeRepo.repo}/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ with_postcard: true }),
          });
          if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
          return (await resp.json()) as {
            output_dir: string;
            badge_url: string;
            postcard_url: string | null;
          };
        }}
        onFocusFile={handleFocusFile}
        onClose={() => setHealthModalOpen(false)}
      />

      {/* 4 Interactive City Advisors & SQL Quests Modal */}
      <AdvisorCouncilModal
        open={advisorsOpen}
        missions={missions}
        claimedMissionIds={claimedMissions}
        onClaimReward={(m) => {
          setClaimedMissions((prev) => new Set([...prev, m.id]));
          sim.addVelocity(m.rewardVelocity);
          sim.spawnFloatingPopup(70, 52, `+${m.rewardVelocity} Velocity!`, "#fde047");
          soundEngine.playMilestone();
          setSimState(sim.getSnapshot());
          showToast(`Quest Completed: ${m.title} (+${m.rewardVelocity} Velocity)`);
        }}
        onFocusFile={handleFocusFile}
        onClose={() => setAdvisorsOpen(false)}
      />

      {/* 4 Playable Chaos Disasters Modal */}
      <DisastersMenu
        open={disastersOpen}
        bundle={effectiveBundle}
        authors={repoAuthors}
        onTriggerPowerOutage={(targetFile) => {
          if (!effectiveBundle) return;
          // BFS downstream transitive dependents along effective imports
          const visited = new Set<string>();
          const queue = [targetFile];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            for (const imp of effectiveBundle.imports) {
              if (imp.target_file === cur && !visited.has(imp.source_file)) {
                visited.add(imp.source_file);
                queue.push(imp.source_file);
              }
            }
          }
          const protectedSet = new Set(
            effectiveBundle.files
              .filter((f) => overlayResult?.protectedDistricts.has(f.district_path))
              .map((f) => f.file_path),
          );
          sim.triggerPowerOutage(targetFile, [...visited], protectedSet);
          soundEngine.playDisaster();
          setSimState(sim.getSnapshot());
          handleFocusFile(targetFile);
        }}
        onTriggerBusFactorVacation={(authorLabel, filesList) => {
          sim.triggerBusFactorVacation(authorLabel, filesList);
          soundEngine.playDisaster();
          setSimState(sim.getSnapshot());
        }}
        onTriggerCrunchStorm={() => {
          if (!effectiveBundle) return;
          sim.triggerCrunchStorm(effectiveBundle);
          soundEngine.playDisaster();
          setSimState(sim.getSnapshot());
        }}
        onTriggerSupplyDockStorm={(depName) => {
          if (!effectiveBundle) return;
          sim.triggerSupplyDockStorm(depName, effectiveBundle);
          soundEngine.playDisaster();
          setSimState(sim.getSnapshot());
        }}
        onClearDisasters={() => {
          sim.clearDisaster();
          setSimState(sim.getSnapshot());
        }}
        onClose={() => setDisastersOpen(false)}
      />
    </div>
  );
}

export default App;
