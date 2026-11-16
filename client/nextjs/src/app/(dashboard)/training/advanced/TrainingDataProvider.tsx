"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isReviewMode } from "~/lib/app-mode";
import type {
  AccountCard,
  BackgroundTask,
  KaggleDatasetOption,
  RunItem,
  TargetDatasetStatus,
} from "~/lib/training-advanced/types";
import type { LocalExportData } from "./components/DatasetOverviewCard";

type Source = "accounts" | "runs" | "dataset" | "tasks";

interface TrainingData {
  cards: AccountCard[];
  cardsChecked: boolean;
  runs: RunItem[];
  datasetTargets: TargetDatasetStatus[];
  kaggleDatasets: KaggleDatasetOption[];
  localExport: LocalExportData | null;
  tasks: BackgroundTask[];
  loaded: Record<Source, boolean>;
  refreshing: boolean;
  refresh: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  setTasks: (tasks: BackgroundTask[]) => void;
}

const Ctx = createContext<TrainingData | null>(null);

// Kept outside React so going back to a page shows the last data at once.
const cache: {
  cards: AccountCard[];
  cardsChecked: boolean;
  runs: RunItem[];
  datasetTargets: TargetDatasetStatus[];
  kaggleDatasets: KaggleDatasetOption[];
  localExport: LocalExportData | null;
  tasks: BackgroundTask[];
  loaded: Record<Source, boolean>;
} = {
  cards: [],
  cardsChecked: false,
  runs: [],
  datasetTargets: [],
  kaggleDatasets: [],
  localExport: null,
  tasks: [],
  loaded: { accounts: false, runs: false, dataset: false, tasks: false },
};

const getJson = async (url: string) => {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

export function TrainingDataProvider({ children }: { children: ReactNode }) {
  const inReview = isReviewMode();
  const [cards, setCards] = useState(cache.cards);
  const [cardsChecked, setCardsChecked] = useState(cache.cardsChecked);
  const [runs, setRuns] = useState(cache.runs);
  const [datasetTargets, setDatasetTargets] = useState(cache.datasetTargets);
  const [kaggleDatasets, setKaggleDatasets] = useState(cache.kaggleDatasets);
  const [localExport, setLocalExport] = useState(cache.localExport);
  const [tasks, setTasksState] = useState(cache.tasks);
  const [loaded, setLoaded] = useState(cache.loaded);
  const [refreshing, setRefreshing] = useState(false);
  const inflight = useRef<Partial<Record<string, boolean>>>({});

  const markLoaded = useCallback((s: Source) => {
    if (cache.loaded[s]) return;
    cache.loaded = { ...cache.loaded, [s]: true };
    setLoaded(cache.loaded);
  }, []);

  const once = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (inflight.current[key]) return;
    inflight.current[key] = true;
    try {
      await fn();
    } finally {
      inflight.current[key] = false;
    }
  }, []);

  const setTasks = useCallback((t: BackgroundTask[]) => {
    cache.tasks = t;
    setTasksState(t);
  }, []);

  const refreshTasks = useCallback(
    () =>
      once("tasks", async () => {
        const d = await getJson("/api/training-advanced/tasks");
        if (d?.tasks) setTasks(d.tasks);
        markLoaded("tasks");
      }),
    [once, setTasks, markLoaded],
  );

  const loadDataset = useCallback(
    () =>
      once("dataset", async () => {
        const d = await getJson("/api/training-advanced/dataset");
        if (d?.targets) {
          cache.datasetTargets = d.targets;
          setDatasetTargets(d.targets);
        }
        if (d?.localExport) {
          cache.localExport = d.localExport;
          setLocalExport(d.localExport);
        }
        if (d?.kaggleDatasets) {
          cache.kaggleDatasets = d.kaggleDatasets;
          setKaggleDatasets(d.kaggleDatasets);
        }
        markLoaded("dataset");
      }),
    [once, markLoaded],
  );

  const loadRuns = useCallback(
    () =>
      once("runs", async () => {
        const d = await getJson("/api/training-advanced/runs");
        if (d?.runs) {
          cache.runs = d.runs;
          setRuns(d.runs);
        }
        markLoaded("runs");
      }),
    [once, markLoaded],
  );

  const applyCards = useCallback((next: AccountCard[], checked: boolean) => {
    if (!next.length) return;
    cache.cards = next;
    setCards(next);
    if (checked) {
      cache.cardsChecked = true;
      setCardsChecked(true);
    }
  }, []);

  // Cards from .env first (instant), then the real connection checks.
  const loadAccounts = useCallback(
    () =>
      once("accounts", async () => {
        if (!cache.cardsChecked) {
          const q = await getJson("/api/training-advanced/accounts?quick=1");
          if (q?.cards) applyCards(q.cards, false);
          markLoaded("accounts");
        }
        const full = await getJson("/api/training-advanced/accounts");
        if (full?.cards) applyCards(full.cards, true);
        markLoaded("accounts");
      }),
    [once, applyCards, markLoaded],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshTasks(), loadDataset(), loadRuns(), loadAccounts()]);
    setRefreshing(false);
  }, [refreshTasks, loadDataset, loadRuns, loadAccounts]);

  const syncRunning = tasks.some((t) => t.status === "running");

  useEffect(() => {
    if (inReview) return;
    void refreshTasks();
    void loadDataset();
    void loadRuns();
    void loadAccounts();
    const slow = [
      setInterval(() => void loadDataset(), 15000),
      setInterval(() => void loadRuns(), 30000),
      setInterval(() => void loadAccounts(), 60000),
    ];
    return () => slow.forEach(clearInterval);
  }, [inReview, refreshTasks, loadDataset, loadRuns, loadAccounts]);

  useEffect(() => {
    if (inReview) return;
    const t = setInterval(() => void refreshTasks(), syncRunning ? 2000 : 8000);
    return () => clearInterval(t);
  }, [inReview, syncRunning, refreshTasks]);

  return (
    <Ctx.Provider
      value={{
        cards,
        cardsChecked,
        runs,
        datasetTargets,
        kaggleDatasets,
        localExport,
        tasks,
        loaded,
        refreshing,
        refresh,
        refreshTasks,
        setTasks,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTrainingData() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTrainingData must be used inside TrainingDataProvider");
  return v;
}
