# ProxMate IDE — code-server (VS Code in the browser) rebranded, with the OpenCode
# AI coding agent baked into the integrated terminal. This image is deployed INSIDE
# a tenant VM and reverse-proxied by ProxMate (never exposed directly). The AI model
# providers OpenCode may use are wired by the ProxMate LLM gateway (Phase 4); this
# image just ships the tooling + a VS Code-style default look.
FROM codercom/code-server:latest

USER root

# OpenCode (sst/opencode) — terminal AI agent. The official installer downloads a
# self-contained binary (code-server bundles its own node, so npm isn't on PATH).
# We place the binary on the system PATH so every guest user gets `opencode`.
RUN set -eux; \
    export HOME=/root; \
    curl -fsSL https://opencode.ai/install | bash; \
    install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode; \
    rm -rf /root/.opencode; \
    opencode --version

# VS Code-style default machine settings (dark modern theme, telemetry off, no
# workspace-trust nag, quiet startup) so the editor looks like stock VS Code.
COPY settings.json /home/coder/.local/share/code-server/User/settings.json
RUN mkdir -p /home/coder/.local/share/code-server/User \
    && chown -R coder:coder /home/coder/.local 2>/dev/null || true

USER coder
ENV PROXMATE_IDE=1
# Branding (product name in the title/UI) is applied at run time:
#   code-server --app-name "ProxMate IDE" --disable-telemetry --auth none ...
