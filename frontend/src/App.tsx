import { Building2, Eye, FolderGit2, Loader2, ShieldAlert, X } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CityCanvas2D } from "./city/CityCanvas2D";
import { cameraStore, useUnifiedCameraHotkeys } from "./city/cameraStore";
import type { GhostLot } from "./city/isoRenderer2D";
import { deriveStreetLinesAndPlazas } from "./city/streetGrid";
import { AdvisorCouncilModal } from "./components/AdvisorCouncilModal";
import { CameraControlsHUD } from "./components/CameraControlsHUD";
import { DataMapBar } from "./components/DataMapBar";
import { DisastersMenu } from "./components/DisastersMenu";
import { EconomyBar } from "./components/EconomyBar";
import { HealthCardModal } from "./components/HealthCardModal";
import { InspectorDrawer } from "./components/InspectorDrawer";
import { MAYOR_TOOLS, MayorToolbar } from "./components/MayorToolbar";
import { Minimap2D } from "./components/Minimap2D";
import { type AppMode, ModeAndUtilitiesBar } from "./components/ModeAndUtilitiesBar";
import { OnboardingTour } from "./components/OnboardingTour";
import { RepoAnalyzePopover } from "./components/RepoAnalyzePopover";
import { TimeScrubber } from "./components/TimeScrubber";
import {
  type HudPopoverId,
  getHudShellStyle,
  isTypingTarget,
  usePopoverOutsideDismiss,
  useViewportHudMetrics,
} from "./components/hudPopover";
import {
  type CitySnapshotBundle,
  CityDataClient,
  type TourLandmark,
  buildHealthReport,
  buildTourLandmarks,
} from "./data/cityDataClient";
import { type AdvisorMission, evaluateAdvisorMissions } from "./game/missions";
import {
  type MayorToolId,
  type SandboxActionRecord,
  TOOL_COSTS,
  appendSandboxAction,
  applySandboxOverlay,
  redoSandboxAction,
  undoSandboxAction,
  validateToolOnFile,
} from "./game/sandboxOverlay";
import {
  CitySimulationEngine,
  type SimSpeed,
  type SimStateSnapshot,
  computeImpactedFiles,
} from "./game/simEngine";
import { soundEngine } from "./game/soundEngine";
import type {
  Annotation,
  AuthorSummary,
  BlastRadiusResult,
  DataMapMode,
  FileMetric,
  LintDiagnostic,
  RepoRef,
  Snapshot,
} from "./types/city";

const CityCanvas3D = lazy(() => import("./city/CityCanvas3D"));

function parquetBaseUrl(owner: string, repo: string): string {
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/parquet`;
}

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
  const hudSimVersionRef = useRef(sim.getHudVersion());
  const syncSimHud = useCallback(
    (force = false, snapshot?: SimStateSnapshot) => {
      const ver = sim.getHudVersion();
      if (force || ver !== hudSimVersionRef.current) {
        hudSimVersionRef.current = ver;
        setSimState(snapshot ?? sim.getSnapshot());
      }
    },
    [sim],
  );
  const analyzeEsRef = useRef<EventSource | null>(null);
  const loadSeqRef = useRef(0);

  const [isStaticMode, setIsStaticMode] = useState(false);
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [activeRepo, setActiveRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotIdx, setSnapshotIdx] = useState(0);
  const [bundle, setBundle] = useState<CitySnapshotBundle | null>(null);
  const [prevBundle, setPrevBundle] = useState<CitySnapshotBundle | null>(null);
  const bundleCtxRef = useRef<{
    snapshots: Snapshot[];
    snapshotIdx: number;
    bundle: CitySnapshotBundle;
  } | null>(null);

  const [dataMap, setDataMap] = useState<DataMapMode>("living");
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [appMode, setAppMode] = useState<AppMode>("explore");
  const [showTraffic, setShowTraffic] = useState(false);
  const showTrafficRef = useRef(showTraffic);
  showTrafficRef.current = showTraffic;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const [activeTool, setActiveTool] = useState<MayorToolId>("inspect");
  const [sandboxActions, setSandboxActions] = useState<SandboxActionRecord[]>([]);
  const sandboxActionsRef = useRef(sandboxActions);
  sandboxActionsRef.current = sandboxActions;
  const [pendingTransitStart, setPendingTransitStart] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [liveBranchName, setLiveBranchName] = useState<string | null>(null);
  const [coopSyncEnabled, setCoopSyncEnabled] = useState(false);

  const overlayResult = useMemo(
    () => (bundle ? applySandboxOverlay(bundle, sandboxActions) : null),
    [bundle, sandboxActions],
  );
  const effectiveBundle = appMode === "play" ? (overlayResult?.bundle ?? null) : bundle;

  useUnifiedCameraHotkeys(viewMode);
  const hudMetrics = useViewportHudMetrics();
  const hudShellStyle = useMemo(() => getHudShellStyle(hudMetrics), [hudMetrics]);

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
      if (st.followVehicleId && !showTrafficRef.current) {
        setShowTraffic(true);
      }
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

  // 10Hz traffic & city-health simulation loop (zero React re-renders in Explore mode)
  useEffect(() => {
    if (!effectiveBundle) return;
    const ambientOnly = appMode === "explore";
    if (ambientOnly && !showTraffic) return;
    if (ambientOnly) {
      sim.stepAmbient(effectiveBundle);
    } else {
      syncSimHud(false, sim.step(effectiveBundle));
    }
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (ambientOnly) {
        sim.stepAmbient(effectiveBundle);
        return;
      }
      const spd = sim.getSpeed();
      if (spd === 0) return;
      let next = sim.step(effectiveBundle);
      for (let extra = 1; extra < spd; extra++) {
        next = sim.step(effectiveBundle);
      }
      syncSimHud(false, next);
    }, 100);
    return () => clearInterval(timer);
  }, [appMode, effectiveBundle, showTraffic, sim, syncSimHud]);

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

  const [openPopover, setOpenPopover] = useState<HudPopoverId>(null);
  const [radarOpen, setRadarOpen] = useState(false);
  const [zenMode, setZenMode] = useState(false);

  const togglePopover = useCallback((id: Exclude<HudPopoverId, null>) => {
    setOpenPopover((cur) => (cur === id ? null : id));
  }, []);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  usePopoverOutsideDismiss(openPopover, closePopover);

  const handleChangeAppMode = useCallback(
    (nextMode: AppMode) => {
      if (nextMode === appMode) return;
      if (nextMode === "explore") {
        setActiveTool("inspect");
        setPendingTransitStart(null);
        setAdvisorsOpen(false);
        setDisastersOpen(false);
        setOpenPopover((cur) => (cur === "advisors" || cur === "mayorMode" ? null : cur));
        sim.clearDisaster();
        sim.clearMilestoneEvent();
        sim.clearFloatingPopups();
        syncSimHud(true);
      }
      setAppMode(nextMode);
    },
    [appMode, sim, syncSimHud],
  );

  const handleCanvasSelectFile = useCallback((filePath: string | null) => {
    setTourAutoPlay(false);
    setSelectedFile(filePath);
  }, []);

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

  // Re-evaluate SQL-driven Advisor Quests when effectiveBundle changes in Play mode
  useEffect(() => {
    if (!effectiveBundle || appMode !== "play") {
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
  }, [appMode, client, effectiveBundle]);

  useEffect(() => {
    if (appMode !== "play" || !simState.milestoneEvent) return;
    soundEngine.playMilestone();
    setToastMsg(`🎉 Milestone Unlocked: ${simState.milestoneEvent}!`);
    sim.spawnFloatingPopup(70, 52, `★ ${simState.milestoneEvent}!`, "#fde047");
    sim.clearMilestoneEvent();
  }, [appMode, sim, simState.milestoneEvent]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3200);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (openPopover !== null) {
          setOpenPopover(null);
          return;
        }
        if (activeTool !== "inspect") {
          setActiveTool("inspect");
          setPendingTransitStart(null);
          return;
        }
        if (selectedFile !== null) {
          setSelectedFile(null);
          return;
        }
        if (zenMode) {
          setZenMode(false);
        }
        return;
      }

      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "h" && !e.repeat) {
        setZenMode((v) => !v);
        setOpenPopover(null);
      } else if (key === "m" && !e.repeat) {
        setRadarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, openPopover, selectedFile, zenMode]);

  const loadRepoData = useCallback(
    async (owner: string, repo: string, baseUrl: string, force = false) => {
      const seq = ++loadSeqRef.current;
      setLoadingMsg(`Loading ${owner}/${repo} into DuckDB-Wasm...`);
      setErrorMsg(null);
      try {
        await client.loadParquetTables(baseUrl, `${owner}/${repo}:${baseUrl}`, force);
        const [snaps, notes] = await Promise.all([
          client.querySnapshots(),
          client.queryAnnotations(),
        ]);
        if (seq !== loadSeqRef.current) return;
        const latest = snaps[snaps.length - 1]?.snapshot_idx ?? 0;
        sim.reset();
        syncSimHud(true);
        setSnapshots(snaps);
        setSnapshotIdx(latest);
        setAnnotations(notes);
        setSandboxActions([]);
        setClaimedMissions(new Set());
        setLiveMode(false);
        setLiveBranchName(null);
        setPendingTransitStart(null);
        setSelectedFile(null);
        setBlastRadius(null);
        setTourActive(false);
      } catch (err) {
        if (seq === loadSeqRef.current) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (seq === loadSeqRef.current) {
          setLoadingMsg(null);
        }
      }
    },
    [client, sim, syncSimHud],
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
          await loadRepoData(first.owner, first.repo, parquetBaseUrl(first.owner, first.repo));
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
    const cachedPrev =
      prevSnap &&
      bundleCtxRef.current?.snapshots === snapshots &&
      bundleCtxRef.current.snapshotIdx === prevSnap.snapshot_idx
        ? bundleCtxRef.current.bundle
        : null;
    Promise.all([
      client.querySnapshotBundle(snapshotIdx, snapshots),
      cachedPrev
        ? Promise.resolve(cachedPrev)
        : prevSnap
          ? client.querySnapshotBundle(prevSnap.snapshot_idx, snapshots)
          : Promise.resolve(null),
    ])
      .then(([cur, prev]) => {
        if (!cancelled) {
          bundleCtxRef.current = { snapshots, snapshotIdx, bundle: cur };
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
      if (typeof document !== "undefined" && document.hidden) return;
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
    const added = new Set<string>(appMode === "play" ? (overlayResult?.addedFiles ?? []) : []);
    const removed: GhostLot[] = [
      ...(appMode === "play" ? (overlayResult?.demolishedLots ?? []) : []),
    ];
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
  }, [appMode, bundle, overlayResult, prevBundle]);

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
    if (appMode !== "play" || !coopSyncEnabled || isStaticMode || !activeRepo) return;
    let cancelled = false;
    let inFlight = false;
    const syncOnce = async () => {
      if (inFlight || (typeof document !== "undefined" && document.hidden)) return;
      inFlight = true;
      try {
        const remote = await client.fetchRemoteSandboxActions(activeRepo.owner, activeRepo.repo);
        if (!cancelled) setSandboxActions(remote);
      } finally {
        inFlight = false;
      }
    };
    void syncOnce();
    const timer = setInterval(() => void syncOnce(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRepo, appMode, client, coopSyncEnabled, isStaticMode]);

  const handleToolAction = useCallback(
    async (file: FileMetric) => {
      if (appMode !== "play" || !effectiveBundle || activeTool === "inspect") return;
      const tool = activeTool;

      if (tool === "transit_hub" && !pendingTransitStart) {
        const check = validateToolOnFile(tool, file, effectiveBundle, null);
        if (!check.ok) {
          setPendingTransitStart(file.file_path);
          setToastMsg(
            `Selected ${file.file_path} — click a 2nd building to bridge with Interface Hub`,
          );
          return;
        }
      }

      const validation = validateToolOnFile(tool, file, effectiveBundle, pendingTransitStart);
      if (!validation.ok) {
        setToastMsg(validation.reason ?? "Action cannot be applied to this building.");
        return;
      }

      if (liveMode && !isStaticMode && activeRepo) {
        let confirmed = true;
        if (tool === "bulldozer") {
          confirmed = window.confirm(
            `Live Mayor Mode: stage and commit \`git rm ${file.file_path}\` on safe branch ${liveBranchName ?? "codecity/mayor-session"}?`,
          );
          if (!confirmed) {
            setToastMsg("Cancelled live git rm.");
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
          setToastMsg(
            liveRes.committed && liveRes.commit_sha
              ? `${liveRes.message} [${liveRes.commit_sha}]`
              : liveRes.message,
          );
        } catch (err) {
          setToastMsg(err instanceof Error ? err.message : String(err));
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

      const nextList = appendSandboxAction(sandboxActionsRef.current, {
        tool,
        target_path: file.file_path,
        secondary_path: validation.secondaryPath ?? null,
        district_path: file.district_path,
        summary: summaryMap[tool],
        velocity_cost: validation.cost,
      });
      sandboxActionsRef.current = nextList;
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
      syncSimHud(true);
      if (!liveMode) {
        setToastMsg(`${summaryMap[tool]} (Sandbox)`);
      }
    },
    [
      activeRepo,
      activeTool,
      appMode,
      client,
      coopSyncEnabled,
      effectiveBundle,
      isStaticMode,
      liveBranchName,
      liveMode,
      pendingTransitStart,
      sim,
      syncSimHud,
    ],
  );

  const onCanvasToolAction = useCallback(
    (f: FileMetric) => {
      void handleToolAction(f);
    },
    [handleToolAction],
  );

  const handleUndo = useCallback(() => {
    const prevActive = [...sandboxActions].reverse().find((a) => a.active);
    setSandboxActions(undoSandboxAction(sandboxActions));
    if (coopSyncEnabled && !isStaticMode && activeRepo && prevActive) {
      void client
        .toggleRemoteSandboxAction(activeRepo.owner, activeRepo.repo, prevActive.action_id, false)
        .catch(() => {});
    }
    setToastMsg("Undid last Mayor intervention");
  }, [activeRepo, client, coopSyncEnabled, isStaticMode, sandboxActions]);

  const handleRedo = useCallback(() => {
    const nextInactive = sandboxActions.find((a) => !a.active);
    setSandboxActions(redoSandboxAction(sandboxActions));
    if (coopSyncEnabled && !isStaticMode && activeRepo && nextInactive) {
      void client
        .toggleRemoteSandboxAction(activeRepo.owner, activeRepo.repo, nextInactive.action_id, true)
        .catch(() => {});
    }
    setToastMsg("Redid Mayor intervention");
  }, [activeRepo, client, coopSyncEnabled, isStaticMode, sandboxActions]);

  const handleResetSandbox = useCallback(() => {
    setSandboxActions([]);
    setPendingTransitStart(null);
    if (coopSyncEnabled && !isStaticMode && activeRepo) {
      void client.clearRemoteSandboxActions(activeRepo.owner, activeRepo.repo).catch(() => {});
    }
    setToastMsg("Sandbox reset to HEAD");
  }, [activeRepo, client, coopSyncEnabled, isStaticMode]);

  const healthReport = useMemo(() => {
    const targetBundle = effectiveBundle ?? bundle;
    if (!healthModalOpen || !targetBundle || !activeRepo) return null;
    return buildHealthReport(activeRepo.owner, activeRepo.repo, targetBundle);
  }, [activeRepo, bundle, effectiveBundle, healthModalOpen]);

  const handleOpenHealthModal = useCallback(() => {
    if (!(effectiveBundle ?? bundle) || !activeRepo) return;
    setHealthModalOpen((open) => !open);
  }, [activeRepo, bundle, effectiveBundle]);

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
      if (typeof document !== "undefined" && document.hidden) return;
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
        let payload: {
          stage: string;
          message: string;
          percent: number;
          owner?: string;
          repo?: string;
        };
        try {
          payload = JSON.parse((evt as MessageEvent).data);
        } catch {
          return;
        }
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
          void loadRepoData(o, r, parquetBaseUrl(o, r), true);
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
        if (analyzeEsRef.current === es) {
          analyzeEsRef.current = null;
          setAnalyzePct(null);
          setLoadingMsg(null);
          setErrorMsg("Analysis event stream disconnected.");
        }
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

  const runDisaster = useCallback(
    (action: () => void) => {
      if (appMode !== "play") return;
      action();
      soundEngine.playDisaster();
      syncSimHud(true);
    },
    [appMode, syncSimHud],
  );

  const activeToolMeta =
    appMode !== "play" || activeTool === "inspect"
      ? null
      : (MAYOR_TOOLS.find((t) => t.id === activeTool) ?? null);
  const ActiveToolIcon = activeToolMeta?.icon ?? null;
  const sharedCanvasProps = effectiveBundle
    ? {
        districts: effectiveBundle.districts,
        files: effectiveBundle.files,
        cochanges: effectiveBundle.cochanges,
        deps: effectiveBundle.deps,
        dataMap,
        selectedFile,
        blastRadius,
        showTraffic,
        sim,
        plazas: streetGrid.plazas,
        streetLines: streetGrid,
        activeTool,
        onSelectFile: handleCanvasSelectFile,
        onToolAction: onCanvasToolAction,
      }
    : null;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      {effectiveBundle && sharedCanvasProps ? (
        viewMode === "2d" ? (
          <CityCanvas2D
            {...sharedCanvasProps}
            imports={effectiveBundle.imports}
            addedFiles={addedFiles}
            removedLots={removedLots}
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
            <CityCanvas3D {...sharedCanvasProps} />
          </Suspense>
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center p-4">
          <div className="sim-panel flex max-h-full max-w-md flex-col items-center gap-3 overflow-y-auto rounded-2xl p-6 text-center sm:p-8">
            <Building2 className="h-10 w-10 text-amber-400" />
            <h2 className="text-lg font-bold">Welcome to CodeCity</h2>
            <p className="text-sm text-slate-300">
              {loadingMsg ??
                "Analyze a local repository or GitHub URL to transform its Git history into a living city."}
            </p>
            {!loadingMsg && !isStaticMode && (
              <button
                type="button"
                onClick={() => setOpenPopover("repo")}
                className="mt-1 flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400"
              >
                <FolderGit2 className="h-3.5 w-3.5" />
                <span>Analyze Repository</span>
              </button>
            )}
            {errorMsg && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {errorMsg}
              </div>
            )}
          </div>
        </div>
      )}

      {zenMode && (
        <button
          type="button"
          data-testid="exit-zen-btn"
          onClick={() => setZenMode(false)}
          style={
            hudMetrics.scale < 1
              ? { transform: `scale(${hudMetrics.scale})`, transformOrigin: "top right" }
              : undefined
          }
          className="sim-panel fixed top-3 right-3 z-30 flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-medium text-slate-300 opacity-45 transition hover:text-white hover:opacity-100"
          title="Restore UI (H or Esc)"
        >
          <Eye className="h-3.5 w-3.5" />
          <span>Show UI (H)</span>
        </button>
      )}

      {!zenMode && (
        <div
          data-testid="hud-shell"
          style={hudShellStyle}
          className="pointer-events-none fixed top-0 left-0 z-20 grid h-full w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] gap-2.5 p-3"
        >
          <header className="relative z-30 flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <RepoAnalyzePopover
                repos={repos}
                activeRepo={activeRepo}
                isStaticMode={isStaticMode}
                snapshot={effectiveBundle?.snapshot ?? null}
                simCityLevel={appMode === "play" ? simState.cityLevel : undefined}
                repoInput={repoInput}
                analyzePct={analyzePct}
                isOpen={openPopover === "repo"}
                onToggleOpen={() => togglePopover("repo")}
                onClose={closePopover}
                onSelectRepo={(o, r) => {
                  setActiveRepo({ owner: o, repo: r });
                  void loadRepoData(o, r, parquetBaseUrl(o, r));
                }}
                onChangeRepoInput={setRepoInput}
                onAnalyzeSubmit={(e) => void handleAnalyzeSubmit(e)}
                onOpenHealthModal={handleOpenHealthModal}
              />

              <DataMapBar
                dataMap={dataMap}
                onChangeDataMap={setDataMap}
                isPopoverOpen={openPopover === "datamap"}
                onTogglePopover={() => togglePopover("datamap")}
                onClosePopover={closePopover}
              />

              {effectiveBundle && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {appMode === "play" && (
                    <EconomyBar
                      simState={simState}
                      alerts={bundle?.snapshot.advisor_alerts ?? []}
                      activeQuestCount={missions.filter((m) => !m.completed).length}
                      openPopover={openPopover}
                      onTogglePopover={togglePopover}
                      onClosePopover={closePopover}
                      onChangeSpeed={(spd: SimSpeed) => {
                        sim.setSpeed(spd);
                        syncSimHud(true);
                      }}
                      onOpenAdvisors={() => setAdvisorsOpen(true)}
                      onOpenDisasters={() => {
                        if (!isStaticMode && activeRepo) {
                          void client
                            .fetchAuthors(activeRepo.owner, activeRepo.repo)
                            .then(setRepoAuthors);
                        }
                        setDisastersOpen(true);
                      }}
                      onFocusFile={handleFocusFile}
                    />
                  )}
                  <ModeAndUtilitiesBar
                    appMode={appMode}
                    onChangeAppMode={handleChangeAppMode}
                    grade={effectiveBundle.snapshot.health_grade}
                    soundEnabled={soundEnabled}
                    tourActive={tourActive}
                    radarOpen={radarOpen}
                    openPopover={openPopover}
                    onTogglePopover={togglePopover}
                    onClosePopover={closePopover}
                    onOpenHealthModal={handleOpenHealthModal}
                    onStartTour={handleStartTour}
                    onToggleSound={() => {
                      const next = !soundEnabled;
                      setSoundEnabled(next);
                      soundEngine.setEnabled(next);
                    }}
                    onToggleRadar={() => setRadarOpen((v) => !v)}
                    onToggleZenMode={() => {
                      setZenMode(true);
                      closePopover();
                    }}
                  />
                </div>
              )}
            </div>

            {(activeToolMeta ||
              (appMode === "play" &&
                simState.activeDisaster &&
                !simState.activeDisaster.resolved) ||
              loadingMsg ||
              toastMsg) && (
              <div className="flex flex-col items-center gap-1.5">
                {activeToolMeta && ActiveToolIcon && activeTool !== "inspect" && (
                  <div
                    data-testid="active-tool-chip"
                    className="sim-panel pointer-events-auto flex items-center gap-2 rounded-xl px-3 py-1 text-xs"
                  >
                    <ActiveToolIcon className={`h-3.5 w-3.5 ${activeToolMeta.accent}`} />
                    <span className="font-semibold text-white">{activeToolMeta.label}</span>
                    <span className="font-mono text-[11px] text-amber-300">
                      -{TOOL_COSTS[activeTool]} ⚡
                    </span>
                    <span className="text-slate-400">
                      {activeTool === "transit_hub" && pendingTransitStart
                        ? `· Link ${pendingTransitStart.split("/").pop()} → Click 2nd building`
                        : "· Click a building"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTool("inspect");
                        setPendingTransitStart(null);
                      }}
                      title="Return to Inspect (Esc)"
                      className="ml-1 rounded p-0.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}

                {appMode === "play" &&
                  simState.activeDisaster &&
                  !simState.activeDisaster.resolved && (
                    <div
                      data-testid="active-disaster-banner"
                      className="sim-panel pointer-events-auto flex items-center justify-between gap-3 rounded-xl border-rose-500/45 bg-rose-950/75 px-3.5 py-1.5 text-xs text-rose-100"
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
                          syncSimHud(true);
                        }}
                        className="rounded-lg bg-rose-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-rose-500/50"
                      >
                        Resolve
                      </button>
                    </div>
                  )}

                {loadingMsg && (
                  <div className="sim-panel pointer-events-auto flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs text-sky-200">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
                    <span>{loadingMsg}</span>
                    {analyzePct !== null && (
                      <span className="font-mono text-amber-300">{analyzePct.toFixed(0)}%</span>
                    )}
                  </div>
                )}

                {toastMsg && (
                  <div
                    data-testid="mayor-toast"
                    className="sim-popover pointer-events-none rounded-xl border-amber-400/35 px-3.5 py-1.5 text-xs font-medium text-amber-200"
                  >
                    {toastMsg}
                  </div>
                )}
              </div>
            )}
          </header>

          <div className="relative z-20 flex min-h-0 min-w-0 items-center justify-between gap-3">
            <div className="flex h-full min-h-0 min-w-0 items-center gap-3">
              {effectiveBundle && appMode === "play" && (
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
                  isModePopoverOpen={openPopover === "mayorMode"}
                  onToggleModePopover={() => togglePopover("mayorMode")}
                  onClosePopover={closePopover}
                  onUndo={handleUndo}
                  onRedo={handleRedo}
                  onReset={handleResetSandbox}
                  onToggleLiveMode={() => {
                    if (!liveMode && activeRepo && !isStaticMode) {
                      void client
                        .startLiveMayorSession(activeRepo.owner, activeRepo.repo)
                        .then((res) => {
                          setLiveMode(true);
                          setLiveBranchName(res.branch);
                          setToastMsg(`Live Mayor Mode active on branch ${res.branch}`);
                        })
                        .catch((err) => {
                          setToastMsg(err instanceof Error ? err.message : String(err));
                        });
                    } else {
                      setLiveMode(false);
                      setToastMsg("Switched back to safe Refactor Sandbox Mode");
                    }
                  }}
                  onToggleCoopSync={() => setCoopSyncEnabled((v) => !v)}
                  className="relative z-30 self-center"
                />
              )}

              {tourActive && (
                <OnboardingTour
                  stops={tourStops}
                  stepIndex={tourStep}
                  autoPlaying={tourAutoPlay}
                  onSelectStep={handleSelectTourStep}
                  onToggleAuto={() => setTourAutoPlay((a) => !a)}
                  onClose={() => setTourActive(false)}
                  className="relative z-20 self-end"
                />
              )}
            </div>

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
                const created = await client.postAnnotation(
                  activeRepo.owner,
                  activeRepo.repo,
                  payload,
                );
                setAnnotations((prev) => [created, ...prev]);
              }}
              onSelectFile={handleFocusFile}
              onClose={() => {
                setTourAutoPlay(false);
                setSelectedFile(null);
              }}
              className="max-h-full shrink-0 self-start"
            />
          </div>

          {bundle && snapshots.length > 0 ? (
            <footer className="relative z-30 flex min-w-0 flex-wrap items-end justify-between gap-2 sm:gap-3">
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

              <div className="ml-auto flex max-w-full flex-col items-end gap-2">
                {radarOpen && (
                  <Minimap2D
                    districts={effectiveBundle?.districts ?? bundle.districts}
                    files={effectiveBundle?.files ?? bundle.files}
                    sim={sim}
                    showTraffic={showTraffic}
                    onClose={() => setRadarOpen(false)}
                  />
                )}
                <CameraControlsHUD
                  viewMode={viewMode}
                  onToggleViewMode={() => setViewMode((m) => (m === "2d" ? "3d" : "2d"))}
                  repoKey={activeRepo ? `${activeRepo.owner}/${activeRepo.repo}` : "default"}
                  showTraffic={showTraffic}
                  onToggleTraffic={() => setShowTraffic((v) => !v)}
                  radarOpen={radarOpen}
                  onToggleRadar={() => setRadarOpen((v) => !v)}
                  hasRadarAlert={simState.fireFiles.size > 0 || simState.blackoutFiles.size > 0}
                  isViewPopoverOpen={openPopover === "view"}
                  onToggleViewPopover={() => togglePopover("view")}
                />
              </div>
            </footer>
          ) : (
            <div />
          )}
        </div>
      )}

      <div
        id="codecity-modal-root"
        className="pointer-events-none fixed top-0 left-0 z-50 h-full w-full"
        style={hudShellStyle}
      >
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
          open={appMode === "play" && advisorsOpen}
          missions={missions}
          claimedMissionIds={claimedMissions}
          onClaimReward={(m) => {
            setClaimedMissions((prev) => new Set([...prev, m.id]));
            sim.addVelocity(m.rewardVelocity);
            sim.spawnFloatingPopup(70, 52, `+${m.rewardVelocity} Velocity!`, "#fde047");
            soundEngine.playMilestone();
            syncSimHud(true);
            setToastMsg(`Quest Completed: ${m.title} (+${m.rewardVelocity} Velocity)`);
          }}
          onFocusFile={handleFocusFile}
          onClose={closeAdvisorsModal}
        />

        <DisastersMenu
          open={appMode === "play" && disastersOpen}
          bundle={effectiveBundle}
          authors={repoAuthors}
          onTriggerPowerOutage={(targetFile) => {
            if (!effectiveBundle) return;
            runDisaster(() => {
              const impacted = computeImpactedFiles(targetFile, effectiveBundle.imports);
              const protectedSet = new Set(
                effectiveBundle.files
                  .filter((f) => overlayResult?.protectedDistricts.has(f.district_path))
                  .map((f) => f.file_path),
              );
              sim.triggerPowerOutage(targetFile, impacted, protectedSet);
            });
            handleFocusFile(targetFile);
          }}
          onTriggerBusFactorVacation={(authorLabel, filesList) =>
            runDisaster(() => sim.triggerBusFactorVacation(authorLabel, filesList))
          }
          onTriggerCrunchStorm={() => {
            if (effectiveBundle) runDisaster(() => sim.triggerCrunchStorm(effectiveBundle));
          }}
          onTriggerSupplyDockStorm={(depName) => {
            if (effectiveBundle)
              runDisaster(() => sim.triggerSupplyDockStorm(depName, effectiveBundle));
          }}
          onClearDisasters={() => {
            sim.clearDisaster();
            syncSimHud(true);
          }}
          onClose={closeDisastersModal}
        />
      </div>
    </div>
  );
}

export default App;
