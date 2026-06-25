/**
 * Copy text to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost), so
 * when ProxMate is opened over plain HTTP via an IP/hostname it's `undefined` and
 * a naive `navigator.clipboard.writeText()` silently does nothing. We fall back to
 * the legacy `execCommand("copy")` via a hidden textarea in that case.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
