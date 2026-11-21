import { Building2, FolderGit2, Loader2, Search, ShieldAlert } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CityCanvas2D } from "./city/CityCanvas2D";
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
  buildHealthReport,
  buildTourLandmarks,
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
  const analyzeEsRef = useRef<EventSource | null>(null);

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

  // Close SSE streams and DuckDB-Wasm worker on unmount
  useEffect(() => {
    return () => {
      analyzeEsRef.current?.close();
      void client.close();
    };
  }, [client]);

  // Demand-driven RAF for Cinematic Turntable Orbit (Preset 5) & Follow Vehicle Cam (Preset 4)
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = cameraStore.getState();
      if (!st.cinematicOrbit && !st.followVehicleId) {
        raf = 0;
        return;
      }
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

    const syncLoop = () => {
      const st = cameraStore.getState();
      if ((st.cinematicOrbit || st.followVehicleId) && raf === 0) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    syncLoop();
    const unsub = cameraStore.subscribe(syncLoop);
    return () => {
      unsub();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [sim]);

  // 10Hz traffic & city-health simulation loop (skips React state updates when paused)
  useEffect(() => {
    if (!effectiveBundle) return;
    setSimState(sim.step(effectiveBundle));
    const timer = setInterval(() => {
      const spd = sim.getSpeed();
      if (spd === 0) return;
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

  const showToast = useCallback((msg: string) => setToastMsg(msg), []);

  const flyToLot = useCallback(
    (lot: {
      file_path: string;
      layout_x: number;
      layout_z: number;
      layout_w: number;
      layout_d: number;
    }) => {
      setSelectedFile(lot.file_path);
      cameraStore.flyTo({
        targetX: lot.layout_x + lot.layout_w * 0.5,
        targetZ: lot.layout_z + lot.layout_d * 0.5,
        zoom: Math.max(1.45, cameraStore.getState().zoom),
        durationMs: 480,
      });
    },
    [],
  );

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
        const [snaps, notes, sbx] = await Promise.all([
          client.querySnapshots(),
          client.queryAnnotations(),
          client.querySandboxActions(),
        ]);
        const latest = snaps[snaps.length - 1]?.snapshot_idx ?? 0;
        setSnapshots(snaps);
        setSnapshotIdx(latest);
        setAnnotations(notes);
        setSandboxActions(sbx);
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
            `/api/repos/${encodeURIComponent(first.owner)}/${encodeURIComponent(first.repo)}/parquet`,
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

  // Load current & previous snapshot bundles whenever active snapshot changes
  useEffect(() => {
    if (!activeRepo || snapshots.length === 0) return;
    let cancelled = false;
    const pos = snapshots.findIndex((s) => s.snapshot_idx === snapshotIdx);
    const prevSnap = pos > 0 ? snapshots[pos - 1] : null;
    Promise.all([
      client.querySnapshotBundle(snapshotIdx, snapshots),
      prevSnap
        ? client.querySnapshotBundle(prevSnap.snapshot_idx, snapshots)
        : Promise.resolve(null),
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

  useEffect(() => {
    if (!isPlayingTime || snapshots.length <= 1) return;
    const timer = setInterval(() => {
      setSnapshotIdx((cur) => {
        const pos = snapshots.findIndex((s) => s.snapshot_idx === cur);
        return snapshots[(pos + 1) % snapshots.length].snapshot_idx;
      });
    }, 1150);
    return () => clearInterval(timer);
  }, [isPlayingTime, snapshots]);

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
      const f = effectiveBundle?.files.find((item) => item.file_path === filePath);
      if (f) flyToLot(f);
    },
    [effectiveBundle, flyToLot],
  );

  useEffect(() => {
    if (!coopSyncEnabled || isStaticMode || !activeRepo) return;
    let cancelled = false;
    const syncOnce = async () => {
      const remote = await client.fetchRemoteSandboxActions(activeRepo.owner, activeRepo.repo);
      if (!cancelled) setSandboxActions(remote);
    };
    void syncOnce();
    const timer = setInterval(() => void syncOnce(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRepo, client, coopSyncEnabled, isStaticMode]);

  const handleToolAction = useCallback(
    async (file: FileMetric) => {
      if (!effectiveBundle || activeTool === "inspect") return;
      const tool = activeTool;

      if (tool === "transit_hub" && !pendingTransitStart) {
        const check = validateToolOnFile(tool, file, effectiveBundle, null);
        if (!check.ok) {
          setPendingTransitStart(file.file_path);
          showToast(
            `Selected ${file.file_path} — click a 2nd building to bridge with Interface Hub`,
          );
          return;
        }
      }

      const validation = validateToolOnFile(tool, file, effectiveBundle, pendingTransitStart);
      if (!validation.ok) {
        showToast(validation.reason ?? "Action cannot be applied to this building.");
        return;
      }

      if (liveMode && !isStaticMode && activeRepo) {
        let confirmed = true;
        if (tool === "bulldozer") {
          confirmed = window.confirm(
            `Live Mayor Mode: stage and commit \`git rm ${file.file_path}\` on safe branch ${liveBranchName ?? "codecity/mayor-session"}?`,
          );
          if (!confirmed) {
            showToast("Cancelled live git rm.");
            return;
          }
        }
        try {
          const liveRes = await client.executeLiveMayorAction(activeRepo.owner, activeRepo.repo, {
            tool,
            target_path: file.file_path,
            secondary_path: validation.secondaryPath ?? null,
            district_path: file.district_path,
            confirm: confirmed,
          });
          showToast(
            liveRes.committed && liveRes.commit_sha
              ? `${liveRes.message} [${liveRes.commit_sha}]`
              : liveRes.message,
          );
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
          return;
        }
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

      if (coopSyncEnabled && !isStaticMode && activeRepo) {
        const latestAct = nextList[nextList.length - 1];
        if (latestAct) {
          void client
            .pushRemoteSandboxAction(activeRepo.owner, activeRepo.repo, latestAct)
            .catch(() => {});
        }
      }

      const cx = file.layout_x + file.layout_w * 0.5;
      const cz = file.layout_z + file.layout_d * 0.5;
      sim.dispatchServiceUnit(tool === "sweeper" ? "sweeper" : "crew", file, effectiveBundle);
      sim.addVelocity(-validation.cost);
      const badgeMap: Record<Exclude<MayorToolId, "inspect">, string> = {
        sweeper: "-Smog +Health",
        proving_park: "+Park +Happiness",
        splitter: "Split -Congestion",
        transit_hub: "+Interface -Cycle",
        co_maintainer: "+Co-Maintainer",
        bulldozer: "-Upkeep",
      };
      sim.spawnFloatingPopup(cx, cz, badgeMap[tool], tool === "bulldozer" ? "#fda4af" : "#4ade80");
      soundEngine.playTool(tool);
      setSimState(sim.getSnapshot());
      if (!liveMode) {
        showToast(`${summaryMap[tool]} (Sandbox)`);
      }
    },
    [
      activeRepo,
      activeTool,
      client,
      coopSyncEnabled,
      effectiveBundle,
      isStaticMode,
      liveBranchName,
      liveMode,
      pendingTransitStart,
      showToast,
      sim,
    ],
  );

  const handleUndo = useCallback(async () => {
    const prevActive = [...sandboxActions].reverse().find((a) => a.active);
    const updated = await client.undoSandboxAction();
    setSandboxActions(updated);
    if (coopSyncEnabled && !isStaticMode && activeRepo && prevActive) {
      void client
        .toggleRemoteSandboxAction(activeRepo.owner, activeRepo.repo, prevActive.action_id, false)
        .catch(() => {});
    }
    showToast("Undid last Mayor intervention");
  }, [activeRepo, client, coopSyncEnabled, isStaticMode, sandboxActions, showToast]);

  const handleRedo = useCallback(async () => {
    const nextInactive = sandboxActions.find((a) => !a.active);
    const updated = await client.redoSandboxAction();
    setSandboxActions(updated);
    if (coopSyncEnabled && !isStaticMode && activeRepo && nextInactive) {
      void client
        .toggleRemoteSandboxAction(activeRepo.owner, activeRepo.repo, nextInactive.action_id, true)
        .catch(() => {});
    }
    showToast("Redid Mayor intervention");
  }, [activeRepo, client, coopSyncEnabled, isStaticMode, sandboxActions, showToast]);

  const handleResetSandbox = useCallback(async () => {
    setSandboxActions(await client.resetSandboxActions());
    setPendingTransitStart(null);
    if (coopSyncEnabled && !isStaticMode && activeRepo) {
      void client.clearRemoteSandboxActions(activeRepo.owner, activeRepo.repo).catch(() => {});
    }
    showToast("Sandbox reset to HEAD");
  }, [activeRepo, client, coopSyncEnabled, isStaticMode, showToast]);

  const handleOpenHealthModal = useCallback(() => {
    const targetBundle = effectiveBundle ?? bundle;
    if (!targetBundle || !activeRepo) return;
    if (healthModalOpen) {
      setHealthModalOpen(false);
      return;
    }
    setHealthReport(buildHealthReport(activeRepo.owner, activeRepo.repo, targetBundle));
    setHealthModalOpen(true);
  }, [activeRepo, bundle, effectiveBundle, healthModalOpen]);

  const handleStartTour = useCallback(() => {
    const targetBundle = effectiveBundle ?? bundle;
    if (!targetBundle) return;
    if (tourActive) {
      setTourActive(false);
      return;
    }
    const stops = buildTourLandmarks(targetBundle);
    if (stops.length === 0) return;
    setTourStops(stops);
    setTourStep(0);
    setTourActive(true);
    setTourAutoPlay(true);
    flyToLot(stops[0]);
  }, [bundle, effectiveBundle, flyToLot, tourActive]);

  const handleSelectTourStep = useCallback(
    (idx: number) => {
      setTourStep(idx);
      const stop = tourStops[idx];
      if (stop) flyToLot(stop);
    },
    [flyToLot, tourStops],
  );

  useEffect(() => {
    if (
      !tourActive ||
      !tourAutoPlay ||
      tourStops.length <= 1 ||
      healthModalOpen ||
      advisorsOpen ||
      disastersOpen
    ) {
      return;
    }
    const timer = setInterval(() => {
      setTourStep((prev) => {
        const next = (prev + 1) % tourStops.length;
        const stop = tourStops[next];
        if (stop) flyToLot(stop);
        return next;
      });
    }, 6500);
    return () => clearInterval(timer);
  }, [advisorsOpen, disastersOpen, flyToLot, healthModalOpen, tourActive, tourAutoPlay, tourStops]);

  async function handleAnalyzeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoInput.trim() || isStaticMode) return;
    analyzeEsRef.current?.close();
    setErrorMsg(null);
    setAnalyzePct(2);
    setLoadingMsg(`Starting analysis for ${repoInput.trim()}...`);
    try {
      const { job_id, owner, repo } = await client.startAnalyze(repoInput.trim(), 16);
      const es = new EventSource(`/api/jobs/${encodeURIComponent(job_id)}/events`);
      analyzeEsRef.current = es;
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
          if (analyzeEsRef.current === es) analyzeEsRef.current = null;
          setAnalyzePct(null);
          void client.fetchRepos().then(setRepos);
          const o = payload.owner ?? owner;
          const r = payload.repo ?? repo;
          setActiveRepo({ owner: o, repo: r });
          void loadRepoData(
            o,
            r,
            `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/parquet`,
            true,
          );
        } else if (payload.stage === "error") {
          es.close();
          if (analyzeEsRef.current === es) analyzeEsRef.current = null;
          setAnalyzePct(null);
          setLoadingMsg(null);
          setErrorMsg(payload.message);
        }
      });
      es.onerror = () => {
        es.close();
        if (analyzeEsRef.current === es) analyzeEsRef.current = null;
      };
    } catch (err) {
      setAnalyzePct(null);
      setLoadingMsg(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const fetchQuackSnippetCb = useCallback(() => {
    if (!activeRepo) {
      return Promise.resolve({ quack_uri: null, token: null, proxy_url: "", snippet: "" });
    }
    return client.fetchQuackSnippet(activeRepo.owner, activeRepo.repo);
  }, [activeRepo, client]);

  const fetchAnnotationChangesCb = useCallback(() => {
    if (!activeRepo) return Promise.resolve([]);
    return client.fetchAnnotationChanges(activeRepo.owner, activeRepo.repo);
  }, [activeRepo, client]);

  const triggerExportCb = useCallback(() => {
    if (!activeRepo) return Promise.reject(new Error("No repository active"));
    return client.triggerExport(activeRepo.owner, activeRepo.repo);
  }, [activeRepo, client]);

  const closeHealthModal = useCallback(() => setHealthModalOpen(false), []);
  const closeAdvisorsModal = useCallback(() => setAdvisorsOpen(false), []);
  const closeDisastersModal = useCallback(() => setDisastersOpen(false), []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
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

      {/* Top HUD */}
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
                    void loadRepoData(
                      o,
                      r,
                      `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/parquet`,
                    );
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
              onStartTour={handleStartTour}
              onOpenHealthModal={handleOpenHealthModal}
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
                  void client.fetchAuthors(activeRepo.owner, activeRepo.repo).then(setRepoAuthors);
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
            if (!liveMode && activeRepo && !isStaticMode) {
              void client
                .startLiveMayorSession(activeRepo.owner, activeRepo.repo)
                .then((res) => {
                  setLiveMode(true);
                  setLiveBranchName(res.branch);
                  showToast(`Live Mayor Mode active on branch ${res.branch}`);
                })
                .catch((err) => {
                  showToast(err instanceof Error ? err.message : String(err));
                });
            } else {
              setLiveMode(false);
              showToast("Switched back to safe Refactor Sandbox Mode");
            }
          }}
          onToggleCoopSync={() => setCoopSyncEnabled((v) => !v)}
        />
      )}

      {toastMsg && (
        <div
          data-testid="mayor-toast"
          className="sim-panel pointer-events-none fixed top-28 left-1/2 z-40 -translate-x-1/2 rounded-xl border-amber-400/40 px-4 py-2 text-xs font-medium text-amber-200 shadow-2xl"
        >
          {toastMsg}
        </div>
      )}

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

      <HealthCardModal
        open={healthModalOpen}
        report={healthReport}
        annotations={annotations}
        isStaticMode={isStaticMode}
        onFetchQuackSnippet={fetchQuackSnippetCb}
        onFetchAnnotationChanges={fetchAnnotationChangesCb}
        onTriggerExport={triggerExportCb}
        onFocusFile={handleFocusFile}
        onClose={closeHealthModal}
      />

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
        onClose={closeAdvisorsModal}
      />

      <DisastersMenu
        open={disastersOpen}
        bundle={effectiveBundle}
        authors={repoAuthors}
        onTriggerPowerOutage={(targetFile) => {
          if (!effectiveBundle) return;
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
        onClose={closeDisastersModal}
      />
    </div>
  );
}

export default App;
