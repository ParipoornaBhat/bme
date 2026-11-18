"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, Flame, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { useTrainingData } from "../TrainingDataProvider";

interface TrainingTabsProps {
  right?: ReactNode;
}

export function TrainingTabs({ right }: TrainingTabsProps) {
  const pathname = usePathname();
  const { datasetTargets, tasks, cards, runs } = useTrainingData();

  const isAnySyncRunning = tasks.some((t) => t.type === "sync" && t.status === "running");
  const isAnyRunRunning =
    cards.some((c) => c.currentJob?.status === "running" || c.currentJob?.status === "queued") ||
    runs.some((r) => r.status === "running");

  const h200Route = datasetTargets.find((t) => t.platform === "h200") || null;

  const tabs = [
    {
      href: "/training/advanced",
      label: "Compute & Controls",
      icon: Radio,
      active: pathname === "/training/advanced",
      dot: null,
    },
    {
      href: "/training/advanced/data",
      label: "Datasets & Sync",
      icon: Database,
      active: pathname === "/training/advanced/data",
      dot: isAnySyncRunning ? "emerald" : null,
    },
    {
      href: "/training/advanced/run-history",
      label: "Runs",
      icon: Flame,
      active: pathname === "/training/advanced/run-history",
      dot: isAnyRunRunning ? "amber" : null,
    },
  ];

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-border bg-card/60 p-2.5 backdrop-blur-xs shadow-xs">
      <div className="flex items-center gap-1.5 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all whitespace-nowrap ${
                tab.active
                  ? "bg-primary font-bold text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
              {tab.dot === "emerald" && (
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
              )}
              {tab.dot === "amber" && (
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-2 flex-wrap">
        {h200Route && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold ${
              h200Route.isRemoteRoute
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            }`}
            title={h200Route.routeLabel || ""}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${h200Route.isRemoteRoute ? "bg-amber-500" : "bg-emerald-500"}`}
            />
            {h200Route.isRemoteRoute ? "H200: remote route (uses internet data)" : "H200: college network, direct"}
          </span>
        )}
        {right}
      </div>
    </div>
  );
}
