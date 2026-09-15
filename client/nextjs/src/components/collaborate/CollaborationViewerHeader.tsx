"use client";

import React from "react";
import { Eye, Lock, Shield, Stethoscope, Unlock } from "lucide-react";
import type { ParticipantPermission } from "~/lib/useCollaboration";

interface CollaborationViewerHeaderProps {
  caseId: string;
  masterConnected: boolean;
  followingMaster: boolean;
  permissions: ParticipantPermission;
}

export default function CollaborationViewerHeader({
  caseId,
  masterConnected,
  followingMaster,
  permissions,
}: CollaborationViewerHeaderProps) {
  return (
    <header className="flex w-full items-center justify-between border-b border-slate-800 bg-slate-950/90 px-5 py-3 text-slate-100 shadow-md backdrop-blur-md">
      {/* Title & Role */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg bg-blue-500/20 px-3 py-1 border border-blue-500/30 text-blue-400 font-bold text-xs">
          <Stethoscope className="h-4 w-4" /> VIEWER MODE
        </div>

        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm text-white tracking-wide">
            MRI Collaboration — {caseId || "Volume Review"}
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">
            <span
              className={`h-2 w-2 rounded-full ${
                masterConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
              }`}
            />
            {masterConnected ? "Master Connected" : "Master Offline"}
          </span>
        </div>
      </div>

      {/* Sync Status Badge */}
      <div className="flex items-center gap-4">
        {followingMaster ? (
          <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 text-xs font-semibold text-emerald-400">
            <Eye className="h-3.5 w-3.5 animate-pulse" /> Following Master's View
          </div>
        ) : (
          <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-1 text-xs font-semibold text-amber-400">
            Independent View
          </div>
        )}

        {/* Permission Badges */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-medium border ${
              permissions.SLICE_CONTROL
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`}
          >
            {permissions.SLICE_CONTROL ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            Slice
          </span>

          <span
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-medium border ${
              permissions.ZOOM_PAN
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`}
          >
            {permissions.ZOOM_PAN ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            Zoom
          </span>

          <span
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-medium border ${
              permissions.ANNOTATE
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`}
          >
            {permissions.ANNOTATE ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            Annotate
          </span>
        </div>
      </div>
    </header>
  );
}
