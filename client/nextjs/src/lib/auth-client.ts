import { createAuthClient } from "better-auth/react";
import { isReviewMode } from "~/lib/app-mode";

const getBaseURL = () => {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.CLIENT_URL ||
    "http://localhost:3000"
  );
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  fetchOptions: {
    headers: {
      "ngrok-skip-browser-warning": "true",
    },
  },
});

const rawUseSession = authClient.useSession;
const rawGetSession = authClient.getSession.bind(authClient);

const reviewSessionFallback = {
  data: null,
  isPending: false,
  error: null,
  refetch: async () => {},
};

export const useSession: typeof rawUseSession = ((...args: Parameters<typeof rawUseSession>) => {
  if (isReviewMode()) {
    return reviewSessionFallback as any;
  }
  return rawUseSession(...args);
}) as typeof rawUseSession;

authClient.useSession = useSession;

authClient.getSession = (async (...args: Parameters<typeof rawGetSession>) => {
  if (isReviewMode()) {
    return { data: null, error: null } as any;
  }
  return rawGetSession(...args);
}) as typeof rawGetSession;

export const { signIn, signOut, signUp } = authClient;
export type Session = typeof authClient.$Infer.Session;
export type User = typeof authClient.$Infer.Session.user;


