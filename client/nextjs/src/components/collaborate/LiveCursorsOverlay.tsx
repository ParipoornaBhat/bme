"use client";

import React from "react";
import type { Participant } from "~/lib/useCollaboration";

interface LiveCursorsOverlayProps {
  participants: Participant[];
  currentUserId: string;
  activePlane?: string;
  containerWidth: number;
  containerHeight: number;
}

const COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // purple
  "#06b6d4", // cyan
];

function getColorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % COLORS.length;
  return COLORS[idx];
}

export default function LiveCursorsOverlay({
  participants,
  currentUserId,
  activePlane,
  containerWidth,
  containerHeight,
}: LiveCursorsOverlayProps) {
  const otherParticipants = participants.filter(
    (p) => p.id !== currentUserId && p.connected && p.cursor
  );

  if (otherParticipants.length === 0 || containerWidth <= 0 || containerHeight <= 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {otherParticipants.map((p) => {
        if (!p.cursor) return null;
        // Filter by plane if specified
        if (activePlane && p.cursor.plane && p.cursor.plane !== activePlane) {
          return null;
        }

        // x and y are relative percentages (0 to 1) or canvas pixel offsets
        const posX = p.cursor.x <= 1 ? p.cursor.x * containerWidth : p.cursor.x;
        const posY = p.cursor.y <= 1 ? p.cursor.y * containerHeight : p.cursor.y;

        const color = getColorForUser(p.id);

        return (
          <div
            key={p.id}
            className="absolute transition-all duration-75 ease-out"
            style={{
              transform: `translate3d(${posX}px, ${posY}px, 0)`,
            }}
          >
            {/* SVG Cursor Pointer */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke={color}
              strokeWidth="2"
              className="drop-shadow-md"
            >
              <path
                d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"
                fill={color}
                fillOpacity="0.4"
              />
            </svg>

            {/* Name/Initials Tag */}
            <div
              className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-lg backdrop-blur-md"
              style={{ backgroundColor: color }}
            >
              <span>{p.role === "MASTER" ? "👑" : "🩺"}</span>
              <span>{p.name || p.initials}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
