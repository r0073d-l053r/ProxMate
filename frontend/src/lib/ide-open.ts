/**
 * Open a ready ProxMate IDE in its pop-out window.
 *
 * Browsers only allow `window.open` close to the user's click, so the (named)
 * window is opened blank FIRST, synchronously, and only then is the install
 * checked. An install from an older ProxMate has no per-VM guest credential and
 * the proxy won't open it: the blank window is closed and the caller reinstalls.
 */
export async function openReadyIde(opts: {
  /** Opens (or reuses) the IDE's named window at `url`. */
  open: (url: string) => Window | null;
  proxyUrl: string;
  /** True when the install must be reinstalled before it can open. */
  checkReinstall: () => Promise<boolean>;
}): Promise<"opened" | "reinstall"> {
  const win = opts.open("about:blank");
  const reinstall = await opts.checkReinstall().catch(() => false);
  if (reinstall) {
    win?.close();
    return "reinstall";
  }
  if (win) win.location.href = opts.proxyUrl;
  else opts.open(opts.proxyUrl);
  return "opened";
}
