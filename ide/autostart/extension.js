// ProxMate IDE — autostart. Opens the OpenCode AI agent in a terminal (in the
// editor area) as soon as the workbench is ready, so the IDE comes up with the
// agent already running and pointed at the ProxMate gateway. Best-effort: any
// failure is swallowed so it can never block the editor from opening.
const vscode = require("vscode");

function activate() {
  try {
    // Make sure VS Code's built-in "Build with Agent" chat (secondary sidebar)
    // isn't showing — OpenCode is the focus agent, not the native chat.
    vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});

    // Reuse a restored OpenCode terminal from a previous session instead of
    // stacking a second tab (persistent sessions restore editor terminals).
    const existing = vscode.window.terminals.find((t) => t.name === "OpenCode");
    if (existing) {
      existing.show(false);
      return;
    }
    const term = vscode.window.createTerminal({
      name: "OpenCode",
      location: vscode.TerminalLocation.Editor,
    });
    term.show(false);
    term.sendText("opencode");
  } catch (err) {
    console.error("[proxmate-ide-autostart]", err && err.message ? err.message : err);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
