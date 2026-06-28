import { useState, useEffect } from "react";

export interface AuthState {
  username: string;
  role: string;
}

let cached: AuthState | null | undefined;
let fetchPromise: Promise<AuthState | null> | null = null;

async function fetchMe(): Promise<AuthState | null> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = (async () => {
    try {
      const resp = await fetch("/ui/api/auth/me");
      if (!resp.ok) return null;
      const body = await resp.json();
      if (body?.username) {
        return { username: body.username, role: body.role ?? "user" };
      }
      return null;
    } catch {
      return null;
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

/** React hook — returns current auth state or null. */
export function useAuth(): AuthState | null {
  const [state, setState] = useState<AuthState | null>(cached ?? null);

  useEffect(() => {
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    let cancelled = false;
    fetchMe().then((result) => {
      if (!cancelled) {
        cached = result;
        setState(result);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return state;
}
