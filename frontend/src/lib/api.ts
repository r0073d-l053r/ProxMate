"use client";

import axios, { AxiosError } from "axios";
import { getCsrfToken, useAuthStore } from "./auth-store";

/** Base URL of the ProxMate API (also used for full-page redirects like SSO). */
export const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export const api = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true, // send the httpOnly session cookie on every request
});

// Echo the CSRF token (double-submit) on state-changing requests.
api.interceptors.request.use((config) => {
  const method = (config.method ?? "get").toUpperCase();
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    const csrf = getCsrfToken();
    if (csrf) config.headers["X-CSRF-Token"] = csrf;
  }
  return config;
});

// On 401, clear auth so guards bounce the user to /login.
api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clear();
    }
    return Promise.reject(error);
  },
);

/** Extract a human-readable message from an API error. */
export function apiError(err: unknown): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { error?: string; details?: unknown } | undefined;
    if (data?.error) return data.error;
    if (err.code === "ERR_NETWORK") return "Cannot reach the ProxMate API. Is the backend running?";
    return err.message;
  }
  return err instanceof Error ? err.message : "Unexpected error";
}
