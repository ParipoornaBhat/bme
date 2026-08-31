"use client";

import { createContext, useContext } from "react";

/**
 * Dashboard context, kept out of layout.tsx deliberately.
 *
 * Next.js only permits a specific set of exports from a layout file (`default`,
 * `metadata`, `dynamic`, and so on). The template shipped `DashboardContext`
 * and `useDashboard` exported straight from the layout, which type-checks fine
 * in isolation but fails `next build` once .next/types is regenerated:
 *
 *   Type 'OmitWithTag<typeof import(".../layout"), ...>' does not satisfy
 *   the constraint '{ [x: string]: never; }'
 *
 * Moving them here keeps the same API for every consumer while leaving the
 * layout with only the exports Next allows.
 */

export interface ProfileData {
  user: unknown;
  activeRole: { id: string; name: string; displayName: string } | null;
  permissions: string[];
  roles: Array<{ id: string; name: string; displayName: string; isActive: boolean }>;
}

export interface DashboardContextType {
  profile: ProfileData | null;
  loadingProfile: boolean;
  refreshProfile: () => Promise<void>;
}

export const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (context === undefined) {
    throw new Error("useDashboard must be used within a DashboardLayout/Provider");
  }
  return context;
}
