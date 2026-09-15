"use client";

import React, { useState } from "react";
import {
  Check,
  Copy,
  Crown,
  Eye,
  Lock,
  LogOut,
  Shield,
  Stethoscope,
  Trash2,
  UserX,
  Users,
  X,
} from "lucide-react";
import type { Participant, ParticipantPermission } from "~/lib/useCollaboration";

interface CollaborationMasterPanelProps {
  shareUrl: string;
  participants: Participant[];
  currentUserId: string;
  onUpdatePermission: (targetUserId: string, permissions: Partial<ParticipantPermission>) => void;
  onRemoveUser: (targetUserId: string) => void;
  onEndSession: () => void;
  onClose?: () => void;
}

const PERMISSION_KEYS: Array<{ key: keyof ParticipantPermission; label: string; desc: string }> = [
  { key: "VIEW", label: "View MRI", desc: "Allows viewing MRI scan" },
  { key: "ZOOM_PAN", label: "Zoom / Pan", desc: "Allows independent zoom and pan" },
  { key: "SLICE_CONTROL", label: "Slice Control", desc: "Allows navigating MRI slices" },
  { key: "WINDOW_LEVEL", label: "Window / Level", desc: "Allows contrast/brightness adjustment" },
  { key: "ANNOTATE", label: "Annotate", desc: "Allows painting segmentations" },
  { key: "EDIT_ANNOTATION", label: "Edit Annotations", desc: "Allows modifying existing masks" },
  { key: "DELETE_ANNOTATION", label: "Delete Annotations", desc: "Allows erasing masks" },
  { key: "AI_ANALYSIS", label: "Run AI Analysis", desc: "Allows triggering AI detection" },
  { key: "DOWNLOAD", label: "Download MRI", desc: "Allows downloading NIfTI file" },
];

export default function CollaborationMasterPanel({
  shareUrl,
  participants,
  currentUserId,
  onUpdatePermission,
  onRemoveUser,
  onEndSession,
  onClose,
}: CollaborationMasterPanelProps) {
  const [copied, setCopied] = useState(false);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeViewers = participants.filter((p) => p.role !== "MASTER");

  return (
    <div className="flex w-full max-w-xl flex-col rounded-xl border border-slate-800 bg-slate-900/95 p-5 text-slate-100 shadow-2xl backdrop-blur-xl">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Crown className="h-5 w-5 text-amber-400" />
          <h2 className="text-base font-semibold tracking-wide text-white">
            MRI Collaboration Master Panel
          </h2>
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/30">
            ● LIVE MASTER
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Share Link Section */}
      <div className="mt-4 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/80 p-3">
        <div className="flex flex-col truncate pr-2">
          <span className="text-xs text-slate-400 font-medium">Shareable Radiologist Link</span>
          <span className="truncate font-mono text-xs text-emerald-400">{shareUrl}</span>
        </div>
        <button
          onClick={handleCopyLink}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 transition-all"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied!" : "Copy Link"}
        </button>
      </div>

      {/* Participants List */}
      <div className="mt-5 flex flex-col">
        <div className="flex items-center justify-between text-xs font-semibold tracking-wider text-slate-400 uppercase">
          <span>Connected Participants ({participants.length})</span>
          <span>Role & Permissions</span>
        </div>

        <div className="mt-2 space-y-2 max-h-60 overflow-y-auto pr-1">
          {participants.map((p) => {
            const isSelf = p.id === currentUserId;
            const isMaster = p.role === "MASTER";

            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/40 p-2.5 transition-all hover:border-slate-700"
              >
                <div className="flex items-center gap-2.5">
                  <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 font-bold text-xs text-slate-200 border border-slate-700">
                    {p.initials}
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900 ${
                        p.connected ? "bg-emerald-500" : "bg-amber-500"
                      }`}
                    />
                  </div>

                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-100">
                        {p.name} {isSelf && "(You)"}
                      </span>
                      {isMaster ? (
                        <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-400 border border-amber-500/30">
                          <Crown className="h-3 w-3" /> MASTER
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-bold text-blue-400 border border-blue-500/30">
                          <Stethoscope className="h-3 w-3" /> VIEWER
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-slate-400">
                      {p.connected ? "Online" : "Disconnected"}
                    </span>
                  </div>
                </div>

                {!isMaster && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedUser(selectedUser === p.id ? null : p.id)}
                      className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
                    >
                      <Shield className="h-3.5 w-3.5 text-blue-400" />
                      Permissions
                    </button>

                    <button
                      onClick={() => onRemoveUser(p.id)}
                      title="Remove participant"
                      className="rounded p-1.5 text-red-400 hover:bg-red-500/20 hover:text-red-300"
                    >
                      <UserX className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Permissions Modal/Drawer for Selected Viewer */}
      {selectedUser && (
        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950 p-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-blue-400">
              Granular Permission Matrix: {participants.find((p) => p.id === selectedUser)?.name}
            </h3>
            <button
              onClick={() => setSelectedUser(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Close
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            {PERMISSION_KEYS.map(({ key, label, desc }) => {
              const viewer = participants.find((p) => p.id === selectedUser);
              const isChecked = viewer?.permissions?.[key] ?? false;

              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-center justify-between rounded-md border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 hover:border-slate-700"
                >
                  <div className="flex flex-col">
                    <span className="font-semibold text-slate-200">{label}</span>
                    <span className="text-[10px] text-slate-400">{desc}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                      onUpdatePermission(selectedUser, {
                        [key]: e.target.checked,
                      });
                    }}
                    className="h-4 w-4 accent-blue-600 rounded border-slate-700 bg-slate-800 focus:ring-0"
                  />
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom Footer Actions */}
      <div className="mt-6 flex items-center justify-between border-t border-slate-800 pt-4">
        <button
          onClick={onEndSession}
          className="flex items-center gap-2 rounded-lg bg-red-600/20 border border-red-500/40 px-4 py-2 text-xs font-semibold text-red-400 hover:bg-red-600/30 transition-all"
        >
          <LogOut className="h-4 w-4" /> End Session for All
        </button>

        <span className="text-[11px] text-slate-500">
          Server-enforced role security active
        </span>
      </div>
    </div>
  );
}
