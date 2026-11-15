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
  elapsedSeconds?: number | null;
  status: "idle" | "running" | "stopped" | "finished" | "incomplete" | "failed";
  resumePending: boolean;
  resumeAutomatic: boolean; // Always false today
  kernelSlug?: string;
  slurmJobId?: string;
  pid?: number;
  logTail?: string[];
  progress?: JobProgress | null;
}

export interface AccountCard {
  id: string;
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
  localExportVersion: string;
  isUpToDate: boolean;
  reason?: string;
  bytesToSync?: number;
  casesCount?: number;
  filesCount?: number;
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
  type: "start" | "resume" | "cancel" | "sync";
  target: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string | null;
  message?: string;
  error?: string | null;
  log?: string[];
}
