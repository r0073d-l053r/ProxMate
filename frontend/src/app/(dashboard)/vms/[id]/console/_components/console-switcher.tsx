"use client";

import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { VncConsole } from "./vnc-console";
import { SerialConsole } from "./serial-console";
import type { ConsoleMode } from "./console-top-bar";

/**
 * Hosts both consoles and the Graphical | Text toggle. Graphical (noVNC) is the
 * default; `?mode=text` deep-links straight to the text console. Switching modes
 * unmounts the inactive console, which tears down its session cleanly.
 */
export function ConsoleSwitcher() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const [mode, setMode] = useState<ConsoleMode>(search.get("mode") === "text" ? "text" : "graphical");

  return mode === "text" ? (
    <SerialConsole id={id} mode={mode} onModeChange={setMode} />
  ) : (
    <VncConsole id={id} mode={mode} onModeChange={setMode} />
  );
}
