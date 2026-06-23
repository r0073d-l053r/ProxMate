"use client";

import axios, { AxiosError } from "axios";
import { getToken, useAuthStore } from "./auth-store";

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api",
});

// Attach the bearer token to every request.
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
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
