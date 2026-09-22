import { createAuthClient } from "better-auth/react";

const getBaseURL = () => {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/auth`;
  }
  const serverUrl =
    process.env.EXPO_PUBLIC_SERVER_URL ||
    process.env.NEXT_PUBLIC_SERVER_URL ||
    "http://localhost:4000";
  return `${serverUrl}/api/auth`;
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  fetchOptions: {
    headers: {
      "ngrok-skip-browser-warning": "true",
    },
  },
});

export const { signIn, signOut, signUp, useSession } = authClient;
export type Session = typeof authClient.$Infer.Session;
export type User = typeof authClient.$Infer.Session.user;
