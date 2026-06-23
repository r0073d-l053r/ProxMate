"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SetupState {
  adminEmail: string;
  adminName: string;
  proxmoxHost: string;
  proxmoxTokenId: string;
  proxmoxVersion: string;
  nodeCount: number;
  defaultStorage: string;
  defaultBridge: string;
  isoStorage: string;
  set: (patch: Partial<SetupState>) => void;
  reset: () => void;
}

const initial = {
  adminEmail: "",
  adminName: "",
  proxmoxHost: "",
  proxmoxTokenId: "",
  proxmoxVersion: "",
  nodeCount: 0,
  defaultStorage: "",
  defaultBridge: "",
  isoStorage: "",
};

export const useSetupStore = create<SetupState>()(
  persist(
    (set) => ({
      ...initial,
      set: (patch) => set(patch),
      reset: () => set(initial),
    }),
    {
      name: "proxmate-setup",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
