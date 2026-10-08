'use client';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import type { AuthUser } from './types';
import { ApiError, loginUser, fetchCurrentUser } from './api';
interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email?: string) => Promise<void>;
  logout: () => void;
}
const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const TOKEN_KEY = 'careerlift_auth_token';
const USER_KEY = 'careerlift_auth_user';
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const logout = useCallback(() => {
    generation.current++;
    setToken(null);
    setUser(null);
    setIsLoading(false);
    setError(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }, []);
  const login = useCallback(async (email?: string) => {
    const current = ++generation.current;
    setIsLoading(true);
    setError(null);
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    try {
      const data = await loginUser(email);
      if (current !== generation.current) return;
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
    } catch (e) {
      if (current === generation.current)
        setError(
          e instanceof ApiError ? e.message : 'Unable to log in. Try again.',
        );
      throw e;
    } finally {
      if (current === generation.current) setIsLoading(false);
    }
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) {
      setIsLoading(false);
      return;
    }
    void fetchCurrentUser(saved)
      .then(({ user }) => {
        if (current !== generation.current) return;
        setToken(saved);
        setUser(user);
      })
      .catch((e) => {
        if (current !== generation.current) return;
        setToken(null);
        setUser(null);
        if (e instanceof ApiError && [401, 404].includes(e.status)) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          setError(
            'Your session has expired. Log in again with your account email.',
          );
        } else
          setError(
            'Unable to verify your account. Check the local API and log in again.',
          );
      })
      .finally(() => {
        if (current === generation.current) setIsLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const expire = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== token) return;
      logout();
      setError(
        'Your session has expired. Log in again with your account email.',
      );
    };
    const changed = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY) {
        generation.current++;
        setToken(null);
        setUser(null);
        setIsLoading(false);
        setError(
          'The local account changed in another tab. Log in to use this tab.',
        );
      }
    };
    window.addEventListener('careerlift-session-expired', expire);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener('careerlift-session-expired', expire);
      window.removeEventListener('storage', changed);
    };
  }, [token, logout]);
  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, error, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
