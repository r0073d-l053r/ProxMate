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

# Default machine settings: dark by default, telemetry off, no workspace-trust
# nag, quiet startup, and a full ProxMate-brand repaint of the VS Code shell via
# workbench.colorCustomizations (layered on Default Dark Modern for syntax).
COPY settings.json /home/coder/.local/share/code-server/User/settings.json
RUN mkdir -p /home/coder/.local/share/code-server/User \
    && chown -R coder:coder /home/coder/.local 2>/dev/null || true

# Brand the browser tab + PWA icons with the ProxMate mark (the same assets the
# app ships) so the IDE tab is visually identical to ProxMate. code-server's
# pages use favicon-dark-support.svg as the primary icon and favicon.ico as the
# legacy fallback; the pwa-icon-* PNGs feed the web-app manifest / apple-touch.
COPY brand/icon.svg              /usr/lib/code-server/src/browser/media/favicon.svg
COPY brand/icon.svg              /usr/lib/code-server/src/browser/media/favicon-dark-support.svg
COPY brand/favicon.ico           /usr/lib/code-server/src/browser/media/favicon.ico
COPY brand/icon-192.png          /usr/lib/code-server/src/browser/media/pwa-icon-192.png
COPY brand/icon-192.png          /usr/lib/code-server/src/browser/media/pwa-icon-maskable-192.png
COPY brand/icon-512.png          /usr/lib/code-server/src/browser/media/pwa-icon-512.png
COPY brand/icon-maskable-512.png /usr/lib/code-server/src/browser/media/pwa-icon-maskable-512.png

# ProxMate IDE startup hook: renders OpenCode's config from the env ProxMate sets
# at provision time, so the in-guest AI agent talks only to the ProxMate LLM
# gateway. code-server runs every executable under $ENTRYPOINTD at container start
# (as `coder`, before the editor boots) — the supported extension point, so we
# don't override the base ENTRYPOINT.
COPY write-opencode-config.sh /usr/lib/proxmate/entrypointd/10-opencode.sh
RUN chmod 0755 /usr/lib/proxmate/entrypointd/10-opencode.sh

# Auto-launch: a tiny baked extension opens the OpenCode agent in an editor-area
# terminal on startup, so the IDE comes up with the agent already running.
COPY autostart /home/coder/.local/share/code-server/extensions/proxmate-ide-autostart
RUN chown -R coder:coder /home/coder/.local/share/code-server/extensions 2>/dev/null || true

USER coder
ENV PROXMATE_IDE=1
ENV ENTRYPOINTD=/usr/lib/proxmate/entrypointd

# The popular OpenCode VS Code extension (sst-dev.opencode, from Open VSX) for
# editor integration + the Ctrl+Esc keybinding, alongside the autostart above.
RUN code-server --install-extension sst-dev.opencode

# Run time (provisioning) mounts the VM's root into the container and opens it so
# the user edits their REAL VM files, running as root for full access:
#   docker run -u 0 -v /:/vmroot --entrypoint /bin/sh proxmate-ide:dev -c \
#     '/usr/lib/proxmate/entrypointd/10-opencode.sh; \
#      exec /usr/bin/code-server --app-name "ProxMate IDE" --auth none \
#        --bind-addr 0.0.0.0:8080 \
#        --user-data-dir /home/coder/.local/share/code-server \
#        --extensions-dir /home/coder/.local/share/code-server/extensions /vmroot'
