"use client";

import { Loader2, Lock, LogOut, RefreshCw, XCircle } from "lucide-react";
import type { useCollaboration } from "~/lib/useCollaboration";

type Collab = ReturnType<typeof useCollaboration>;

/**
 * What a guest sees instead of the study while they are not in the review:
 * waiting to be let in, turned away, left, removed, or paused because the host
 * stepped out. Null once they are in and the host is present. Shared by the 2D
 * painter and the 3D viewer.
 */
export function guestSessionScreen(collab: Collab) {
  // 1. Viewer voluntarily left the review
  if (collab.admission === "left") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <LogOut className="h-10 w-10 text-slate-400" />
        <h1 className="text-lg font-semibold">You left the review</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          You have exited the collaborative review session.
        </p>
        <button
          type="button"
          onClick={() => collab.rejoinLobby()}
          className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-blue-500 transition-all cursor-pointer active:scale-95"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Rejoin</span>
        </button>
      </div>
    );
  }

  // 2. Viewer was denied by host
  if (collab.admission === "denied") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <XCircle className="h-10 w-10 text-red-500" />
        <h1 className="text-lg font-semibold">The host declined your request</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The host did not admit you to this review session.
        </p>
      </div>
    );
  }

  // 2b. Viewer replaced by newer tab
  if (collab.admission === "replaced") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <XCircle className="h-10 w-10 text-amber-500" />
        <h1 className="text-lg font-semibold">This review was opened in another tab</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This session was opened in another tab or window. It has been disconnected here.
        </p>
      </div>
    );
  }

  // Ending the session or revoking this participant closes their socket, but the
  // study was still rendered - with working tools - until a reload. Take it off
  // the screen the moment either happens. Both are final, so unlike the paused
  // state below there is nothing to wait for.
  if (collab.sessionEnded || collab.removed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <XCircle className="h-10 w-10 text-red-500" />
        <h1 className="text-lg font-semibold">
          {collab.removed ? "You were removed from this review" : "Review session ended"}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {collab.removed
            ? "The host revoked your access. This link no longer works for you."
            : "The host ended this session. This link no longer works."}
        </p>
      </div>
    );
  }

  // 3. Viewer waiting for host admission in lobby
  if (collab.admission === "waiting") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Loader2 className="h-10 w-10 animate-spin text-blue-500" />
        <h1 className="text-lg font-semibold">
          {collab.waitingHostConnected
            ? "Asking the host to let you in…"
            : "Waiting for the host to start"}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {collab.waitingHostConnected
            ? "Your request has been sent to the host. You will enter automatically when admitted."
            : "The host is not connected yet. The review session will begin when the host joins."}
        </p>
      </div>
    );
  }

  // A shared link is only live while the host is in the room. Render nothing of
  // the study when they are not: the scan should not sit unattended on someone
  // else's screen. The session reconnects on its own when the host returns.
  if (collab.hostOffline) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Lock className="h-10 w-10 text-amber-500" />
        <h1 className="text-lg font-semibold">Review session paused</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The host is not connected. This link stays inactive until they rejoin,
          at which point this page reconnects on its own.
        </p>
        <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Waiting for the host
        </span>
      </div>
    );
  }

  return null;
}
