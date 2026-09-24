"use client";

import React, { useState } from "react";
import {
  Check,
  Copy,
  Crown,
  Eye,
  Layers,
  Lock,
  LogOut,
  Paintbrush,
  Shield,
  Stethoscope,
  UserX,
  Users,
  X,
  ZoomIn,
} from "lucide-react";
import type { JoinRequest, LeftParticipant, Participant, ParticipantPermission } from "~/lib/useCollaboration";

interface CollaborationMasterPanelProps {
  shareUrl: string;
  followUserId?: string | null;
  onFollowUser?: (userId: string | null) => void;
  participants: Participant[];
  currentUserId: string;
  onUpdatePermission: (targetUserId: string, permissions: Partial<ParticipantPermission>) => void;
  onRemoveUser: (targetUserId: string) => void;
  onEndSession: () => void;
  onClose?: () => void;
  joinRequests?: JoinRequest[];
  leftList?: LeftParticipant[];
  onAdmit?: (userId: string) => void;
  onDeny?: (userId: string) => void;
}

function formatWaitingTime(since: string): string {
  const sec = Math.max(1, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  if (sec < 60) return `waiting ${sec} s`;
  const min = Math.floor(sec / 60);
  return `waiting ${min}m ${sec % 60}s`;
}

export default function CollaborationMasterPanel({
  shareUrl,
  followUserId = null,
  onFollowUser,
  participants,
  currentUserId,
  onUpdatePermission,
  onRemoveUser,
  onEndSession,
  onClose,
  joinRequests = [],
  leftList = [],
  onAdmit,
  onDeny,
}: CollaborationMasterPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex w-full max-w-lg max-h-[88vh] overflow-y-auto flex-col rounded-2xl border border-slate-800 bg-slate-900/95 p-6 text-slate-100 shadow-2xl backdrop-blur-xl">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-4 sticky top-0 bg-slate-900/95 z-10 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <Crown className="h-5 w-5 text-amber-400" />
          <h2 className="text-base font-bold tracking-wide text-white">
            MRI Master Review Panel
          </h2>
          <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400 border border-emerald-500/30">
            ● LIVE MASTER
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white transition-colors cursor-pointer border border-slate-700"
          >
            <X className="h-4 w-4" />
            <span>Close</span>
          </button>
        )}
      </div>

      {/* Share Link Section */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 shadow-inner">
        <div className="flex flex-col truncate pr-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Shareable Radiologist Review Link
          </span>
          <span className="truncate font-mono text-xs text-emerald-400 font-medium mt-0.5">
            {shareUrl}
          </span>
        </div>
        <button
          onClick={handleCopyLink}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 transition-all shadow-md active:scale-95 cursor-pointer"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied!" : "Copy Link"}
        </button>
      </div>

      {/* Waiting Section (Lobby requests) */}
      {joinRequests && joinRequests.length > 0 && (
        <div className="mt-5 flex flex-col">
          <div className="flex items-center justify-between text-xs font-semibold tracking-wider text-amber-400 uppercase">
            <span>Waiting for Admission ({joinRequests.length})</span>
            <span className="text-[11px] text-amber-500/80 lowercase">pending host approval</span>
          </div>

          <div className="mt-2.5 space-y-2 max-h-48 overflow-y-auto pr-1">
            {joinRequests.map((req) => (
              <div
                key={req.userId}
                className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 p-3"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-slate-100">{req.name}</span>
                  <span className="text-[11px] text-amber-300/80">{formatWaitingTime(req.since)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {onAdmit && (
                    <button
                      type="button"
                      onClick={() => onAdmit(req.userId)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-all shadow active:scale-95 cursor-pointer"
                    >
                      Admit
                    </button>
                  )}
                  {onDeny && (
                    <button
                      type="button"
                      onClick={() => onDeny(req.userId)}
                      className="rounded-lg bg-red-600/20 border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-600/30 transition-all cursor-pointer"
                    >
                      Deny
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Participants Section */}
      <div className="mt-5 flex flex-col">
        <div className="flex items-center justify-between text-xs font-semibold tracking-wider text-slate-400 uppercase">
          <span>Connected Participants ({participants.length})</span>
          <span>Security & Access</span>
        </div>

        <div className="mt-2.5 space-y-3 max-h-72 overflow-y-auto pr-1">
          {participants.map((p) => {
            const isSelf = p.id === currentUserId;
            const isMaster = p.role === "MASTER";

            return (
              <div
                key={p.id}
                className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/50 p-3.5 transition-all hover:border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="relative flex h-9 w-9 items-center justify-center rounded-full bg-slate-800 font-bold text-xs text-slate-200 border border-slate-700">
                      {p.initials}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900 ${
                          p.connected ? "bg-emerald-500" : "bg-amber-500"
                        }`}
                      />
                    </div>

                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {p.name} {isSelf && "(You)"}
                        </span>
                      </div>

                      <div className="mt-0.5 flex items-center gap-1.5">
                        {isMaster ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-extrabold text-amber-400 border border-amber-500/30">
                            <Crown className="h-3 w-3" /> MASTER HOST
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-2 py-0.5 text-[10px] font-extrabold text-blue-400 border border-blue-500/30">
                            <Eye className="h-3 w-3" /> RADIOLOGIST VIEWER
                          </span>
                        )}
                        <span className="text-[11px] text-slate-500">
                          • {p.connected ? "Active" : "Offline"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                  {!isSelf && onFollowUser && p.connected && (
                    <button
                      onClick={() => onFollowUser(followUserId === p.id ? null : p.id)}
                      title={followUserId === p.id ? `Stop mirroring ${p.name}` : `Mirror ${p.name}'s view`}
                      className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                        followUserId === p.id
                          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                          : "border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {followUserId === p.id ? "Following" : "Follow"}
                    </button>
                  )}
                  {!isMaster && (
                    <button
                      onClick={() => onRemoveUser(p.id)}
                      title="Revoke access and disconnect participant"
                      className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 transition-all cursor-pointer"
                    >
                      <UserX className="h-3.5 w-3.5" />
                      Revoke
                    </button>
                  )}
                  </div>
                </div>

                {/* Granular Permission Toggles (For Viewers Only) */}
                {!isMaster && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-slate-800/80 pt-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-slate-400">Interaction Permissions:</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onUpdatePermission(p.id, {
                              SLICE_CONTROL: true,
                              ZOOM_PAN: true,
                              ANNOTATE: true,
                              WINDOW_LEVEL: true,
                              AI_ANALYSIS: true,
                              DOWNLOAD: true,
                            })
                          }
                          className="text-[10px] text-emerald-400 hover:underline cursor-pointer"
                        >
                          Grant All
                        </button>
                        <span className="text-slate-600">•</span>
                        <button
                          type="button"
                          onClick={() =>
                            onUpdatePermission(p.id, {
                              SLICE_CONTROL: false,
                              ZOOM_PAN: false,
                              ANNOTATE: false,
                              WINDOW_LEVEL: false,
                              AI_ANALYSIS: false,
                              DOWNLOAD: false,
                            })
                          }
                          className="text-[10px] text-red-400 hover:underline cursor-pointer"
                        >
                          Lock All
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 mt-1">
                      {/* Slice Control Toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePermission(p.id, {
                            SLICE_CONTROL: !p.permissions.SLICE_CONTROL,
                          })
                        }
                        title="Allow/Lock Slice Navigation"
                        className={`flex items-center justify-center gap-1 rounded-md py-1.5 px-2 text-[10px] font-semibold transition-all cursor-pointer ${
                          p.permissions.SLICE_CONTROL
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : "bg-slate-800/80 text-slate-400 border border-slate-700/60 hover:bg-slate-800"
                        }`}
                      >
                        <Layers className="h-3 w-3" />
                        {p.permissions.SLICE_CONTROL ? "Slice: Unlocked" : "Slice: Locked"}
                      </button>

                      {/* Zoom/Pan Toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePermission(p.id, {
                            ZOOM_PAN: !p.permissions.ZOOM_PAN,
                          })
                        }
                        title="Allow/Lock Zoom & Pan"
                        className={`flex items-center justify-center gap-1 rounded-md py-1.5 px-2 text-[10px] font-semibold transition-all cursor-pointer ${
                          p.permissions.ZOOM_PAN
                            ? "bg-blue-500/20 text-blue-300 border border-blue-500/40"
                            : "bg-slate-800/80 text-slate-400 border border-slate-700/60 hover:bg-slate-800"
                        }`}
                      >
                        <ZoomIn className="h-3 w-3" />
                        {p.permissions.ZOOM_PAN ? "Zoom: Allowed" : "Zoom: Locked"}
                      </button>

                      {/* Annotate Toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePermission(p.id, {
                            ANNOTATE: !p.permissions.ANNOTATE,
                          })
                        }
                        title="Allow/Lock Drawing & Mask Tools"
                        className={`flex items-center justify-center gap-1 rounded-md py-1.5 px-2 text-[10px] font-semibold transition-all cursor-pointer ${
                          p.permissions.ANNOTATE
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                            : "bg-slate-800/80 text-slate-400 border border-slate-700/60 hover:bg-slate-800"
                        }`}
                      >
                        <Paintbrush className="h-3 w-3" />
                        {p.permissions.ANNOTATE ? "Draw: Allowed" : "Draw: Locked"}
                      </button>

                      {/* Window / Contrast Toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePermission(p.id, {
                            WINDOW_LEVEL: !p.permissions.WINDOW_LEVEL,
                          })
                        }
                        title="Allow/Lock Contrast & Window Leveling"
                        className={`flex items-center justify-center gap-1 rounded-md py-1.5 px-2 text-[10px] font-semibold transition-all cursor-pointer ${
                          p.permissions.WINDOW_LEVEL
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                            : "bg-slate-800/80 text-slate-400 border border-slate-700/60 hover:bg-slate-800"
                        }`}
                      >
                        <Shield className="h-3 w-3" />
                        {p.permissions.WINDOW_LEVEL ? "Contrast: On" : "Contrast: Off"}
                      </button>

                      {/* AI Analysis Toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePermission(p.id, {
                            AI_ANALYSIS: !p.permissions.AI_ANALYSIS,
                          })
                        }
                        title="Allow/Lock AI Model Inferences & Heatmaps"
                        className={`flex items-center justify-center gap-1 rounded-md py-1.5 px-2 text-[10px] font-semibold transition-all cursor-pointer ${
                          p.permissions.AI_ANALYSIS
                            ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                            : "bg-slate-800/80 text-slate-400 border border-slate-700/60 hover:bg-slate-800"
                        }`}
                      >
                        <Check className="h-3 w-3" />
                        {p.permissions.AI_ANALYSIS ? "AI: Enabled" : "AI: Locked"}
                      </button>

                      {/* Export / Download Toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdatePermission(p.id, {
                            DOWNLOAD: !p.permissions.DOWNLOAD,
                          })
                        }
                        title="Allow/Lock Exporting Slice Images & Masks"
                        className={`flex items-center justify-center gap-1 rounded-md py-1.5 px-2 text-[10px] font-semibold transition-all cursor-pointer ${
                          p.permissions.DOWNLOAD
                            ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                            : "bg-slate-800/80 text-slate-400 border border-slate-700/60 hover:bg-slate-800"
                        }`}
                      >
                        <Copy className="h-3 w-3" />
                        {p.permissions.DOWNLOAD ? "Export: Allowed" : "Export: Locked"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Left List Section */}
      {leftList && leftList.length > 0 && (
        <div className="mt-4 flex flex-col rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <span className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
            Left the Review ({leftList.length})
          </span>
          <div className="mt-1.5 space-y-1 max-h-24 overflow-y-auto pr-1">
            {leftList.map((entry, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs text-slate-400">
                <span className="truncate">{entry.name}</span>
                <span className="text-[10px] text-slate-600 font-mono">
                  {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Security Note */}
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5 text-slate-400 text-xs">
        <Lock className="h-4 w-4 text-emerald-400 shrink-0" />
        <span>
          Master controls all radiologist permissions in real time. Live cursor tracking is always active.
        </span>
      </div>

      {/* Bottom Footer Actions */}
      <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-4 gap-3">
        <button
          onClick={onEndSession}
          className="flex items-center gap-1.5 rounded-lg bg-red-600/20 border border-red-500/40 px-3.5 py-2 text-xs font-semibold text-red-400 hover:bg-red-600/30 transition-all cursor-pointer"
        >
          <LogOut className="h-4 w-4" /> End Session
        </button>

        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-5 py-2 text-xs font-bold text-white transition-all cursor-pointer shadow-lg active:scale-95"
          >
            <Check className="h-4 w-4 text-emerald-300" /> Done / Back to Annotating
          </button>
        )}
      </div>
    </div>
  );
}
