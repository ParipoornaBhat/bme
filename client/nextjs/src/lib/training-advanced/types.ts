export type PlatformType = "h200" | "kaggle" | "local";

export interface StartedBy {
  usn: string;
  name: string;
}

export interface MetricSummary {
  mean: number;
  std?: number;
}

export interface RunMetrics {
  boneDice?: MetricSummary | null;
  bmeDicePos?: MetricSummary | null;
  lesionSensitivityPos?: MetricSummary | null;
  cleanScanSpecificity?: MetricSummary | null;
  fpPerCase?: MetricSummary | null;
}

export interface RunItem {
  id: string;
  methodId: string;
  methodLabel: string;
  datasetVersion: string;
  nCases: number | string;
  bmeCount?: number;
  nonBmeCount?: number;
  folds: number | string;
  foldMode?: string;
  iteration: string;
  status: "running" | "finished" | "stopped" | "incomplete" | "failed";
  startedBy: StartedBy;
  platform: PlatformType;
  platformLabel: string;
  account: string;
  host?: string;
  startedAt: string | null;
  metrics?: RunMetrics | null;
}

export interface JobProgress {
  doneEpochs: number;
  totalEpochs: number;
  doneFolds: number;
  totalFolds: number;
  currentFold?: number;
  currentEpoch?: number;
  percent: number;
  secPerEpoch?: number;
  etaSeconds?: number | null;
}

export interface CurrentJob {
  methodId?: string;
  methodLabel?: string;
  iteration?: string;
  startedBy?: StartedBy;
  startedAt?: string | null;
  partStartedAt?: string | null;
  partCount?: number;
  /** The dataset snapshot this run trains on, fixed when it started. */
  dataset?: string;
  partLog?: Array<{
    part: number;
    startedAt: string;
    endedAt?: string | null;
    slurmJobId?: string;
    logFile?: string;
    results?: string;
  }>;
  intermediateResults?: {
    foldsDone?: number;
    totalFolds?: number;
    currentFold?: number;
    currentEpoch?: number;
    trainLoss?: string | number | null;
    pseudoDice?: string | number | null;
    summaryText?: string;
  };
  elapsedSeconds?: number | null;
  status: "idle" | "queued" | "running" | "stopped" | "finished" | "incomplete" | "failed";
  partsDone?: number;
  resumePending: boolean;
  resumeAutomatic: boolean; // Always false today
  kernelSlug?: string;
  slurmJobId?: string;
  pid?: number;
  logTail?: string[];
  progress?: JobProgress | null;
  isCached?: boolean;
  cachedAt?: string | null;
}

export interface AutoRun {
  target: string;
  methodId: string;
  startedBy?: string;
  startedAt?: string;
  continues: number;
  state: "active" | "finished" | "failed" | "limit";
  note?: string;
}

export interface AccountCard {
  runStates?: Record<string, "finished" | "stopped">;
  autoRuns?: AutoRun[];
  id: string;
  envReady?: boolean | null;
  nnunetReady?: boolean | null;
  checking?: boolean;
  platform: PlatformType;
  label: string;
  accountName: string;
  usn?: string;
  roll?: string;
  slot?: number;
  connected: boolean;
  connectionDetails: string;
  isRemoteRoute?: boolean;
  jumpHost?: string;
  deviceInfo?: string;
  currentJob: CurrentJob | null;
}

export interface KaggleDatasetOption {
  roll: string;
  slot?: number;
  user: string;
  label: string;
  uploadedAt: string | null;
  uploadedHash: string | null;
  caseCount: number;
  fileCount: number;
  isDefault?: boolean;
}

export interface TargetDatasetStatus {
  targetId: string;
  platform: PlatformType;
  label: string;
  datasetVersion: string;
  datasetSlug?: string;
  localExportVersion: string;
  isUpToDate: boolean;
  reason?: string;
  bytesToSync?: number;
  casesCount?: number;
  filesCount?: number;
  filesSame?: number | null;
  checkedAt?: string | null;
  isRemoteRoute?: boolean;
  routeLabel?: string;
  lastUpdated?: string | null;
  hasUploaded?: boolean;
  isEmpty?: boolean;
  needsUpload?: boolean;
  runningJobBlocking: {
    method: string;
    status: string;
    account: string;
    jobId?: string;
  } | null;
}

export interface MethodSpec {
  n: number;
  id: string;
  where: PlatformType;
  label: string;
  tests: string;
  arch?: string;
  localSupported?: boolean;
  needsMib?: number;
}

export interface BackgroundTask {
  id: string;
  type: "start" | "resume" | "cancel" | "sync" | "setup";
  target: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string | null;
  message?: string;
  error?: string | null;
  log?: string[];
}

export interface MetricSummary {
  mean: number;
  std?: number;
}

export interface H200RunPart {
  part: number;
  jobId: string;
  slurmJobId?: string;
  state: string;
  start: string | null;
  end: string | null;
  elapsed: string | null;
  exit: string | null;
  logFile?: string;
  foldEpoch?: string;
}

export interface H200RunDataset {
  used?: number | null;
  annotated?: number | null;
  left_out?: number | null;
  counts?: {
    used?: number | null;
    annotated?: number | null;
    left_out?: number | null;
  };
}

export interface H200RunResult {
  summary?: Record<string, MetricSummary> | null;
  bmeDice?: MetricSummary | null;
  boneDice?: MetricSummary | null;
  fpPerCase?: MetricSummary | null;
  nCases?: number | null;
  folds?: number | null;
  epochs?: number | null;
  foldMode?: string | null;
  trainedAt?: string | null;
  hoursTaken?: number | null;
  [key: string]: any;
}

export interface H200Run {
  id: string;
  roll: string;
  accountLabel: string;
  methodId: string;
  label: string;
  startedAt: string | null;
  startedBy: StartedBy | { name?: string; usn?: string } | null;
  epochsPerFold?: number | null;
  dataset?: H200RunDataset | null;
  status: "running" | "queued" | "finished" | "part ended";
  result?: H200RunResult | null;
  partial?: any;
  parts: H200RunPart[];
  folder?: string;
  hasLocalMetrics?: boolean;
}

export interface H200RunsResponse {
  runs: H200Run[];
  errors?: Array<{ roll: string; error: string }>;
}

export interface JobLogResponse {
  targetId?: string;
  platform?: PlatformType;
  file?: string;
  lines: string[];
  err?: string[];
}
