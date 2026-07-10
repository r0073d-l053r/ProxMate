// ProxMate IDE — autostart. Opens the OpenCode AI agent in a terminal (in the
// editor area) as soon as the workbench is ready, so the IDE comes up with the
// agent already running and pointed at the ProxMate gateway. Best-effort: any
// failure is swallowed so it can never block the editor from opening.
const vscode = require("vscode");

function activate() {
  try {
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
