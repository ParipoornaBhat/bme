"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { isReviewMode } from "~/lib/app-mode";
import { Clock, ClipboardCheck, Archive, Users } from "lucide-react";
import { LogTab } from "./LogTab";
import { ReviewsTab } from "./ReviewsTab";
import { DeletedTab } from "./DeletedTab";
import { OwnersTab } from "./OwnersTab";

type TabId = "log" | "reviews" | "deleted" | "owners";

export default function ActivitiesPage() {
  if (isReviewMode()) {
    notFound();
  }

  const [activeTab, setActiveTab] = useState<TabId>("log");

  const tabs: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "log", label: "Log", icon: Clock },
    { id: "reviews", label: "Reviews", icon: ClipboardCheck },
    { id: "deleted", label: "Deleted", icon: Archive },
    { id: "owners", label: "Owners", icon: Users },
  ];

  return (
    <div className="flex flex-col gap-6 py-2">
      {/* Page Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
          Activities
        </h1>
        <p className="text-xs text-muted-foreground">
          Audit logs, review submissions, tombstoned annotations, and case ownership assignments.
        </p>
      </div>

      {/* Sub-tabs Header */}
      <div className="flex items-center gap-1.5 border-b border-border/60 pb-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition cursor-pointer ${
                isActive
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="min-h-0 flex-1">
        {activeTab === "log" && <LogTab />}
        {activeTab === "reviews" && <ReviewsTab />}
        {activeTab === "deleted" && <DeletedTab />}
        {activeTab === "owners" && <OwnersTab />}
      </div>
    </div>
  );
}
