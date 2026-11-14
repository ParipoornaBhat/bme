/**
 * Mode helper for the Next.js application.
 *
 * Supports two runtime modes:
 * - local  : Default mode running on developer laptop with local data/ and Python.
 * - review : Hosted mode on Vercel with no data/ folder, no Python, no Hono.
 *
 * Selected by env:
 *   Server : APP_MODE=review or NEXT_PUBLIC_APP_MODE=review
 *   Client : NEXT_PUBLIC_APP_MODE=review
 */

export function isReviewMode(): boolean {
  if (typeof window === "undefined") {
    return process.env.APP_MODE === "review" || process.env.NEXT_PUBLIC_APP_MODE === "review";
  }
  return process.env.NEXT_PUBLIC_APP_MODE === "review";
}
