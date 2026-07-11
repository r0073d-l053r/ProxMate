#!/usr/bin/env sh
# ProxMate IDE — startup hook. code-server runs every executable in $ENTRYPOINTD
# at container start (as the `coder` user, before the editor boots). This renders
# OpenCode's config so the in-guest AI agent talks ONLY to the ProxMate LLM
# gateway — the tenant never sees the upstream endpoint, keys, or real model names.
#
# Provisioning (ProxMate) sets the environment:
#   PROXMATE_IDE_GATEWAY_URL   the OpenAI-compatible base, e.g.
#                              https://proxmate.example.com/api/ide/<vmId>/llm/v1
#   PROXMATE_IDE_TOKEN         the per-VM gateway token (referenced via {env:…},
#                              so it is NEVER written to the config file in clear)
#   PROXMATE_IDE_MODELS_JSON   OpenCode `models` map, e.g. {"shared:llama":{"name":"Llama 3.1"}}
#   PROXMATE_IDE_DEFAULT_MODEL optional default, e.g. shared:llama
#
# With no gateway env set this is a no-op (OpenCode keeps its own built-in models).
set -eu

[ -n "${PROXMATE_IDE_GATEWAY_URL:-}" ] || exit 0

CONFIG_DIR="${HOME:-/home/coder}/.config/opencode"
mkdir -p "$CONFIG_DIR"

# NB: don't use `${VAR:-{}}` — POSIX sh treats the first `}` as the end of the
# expansion and leaks the second as a literal, corrupting the JSON. Default plainly.
MODELS="${PROXMATE_IDE_MODELS_JSON:-}"
[ -n "$MODELS" ] || MODELS='{}'
DEFAULT_LINE=""
if [ -n "${PROXMATE_IDE_DEFAULT_MODEL:-}" ]; then
  DEFAULT_LINE="  \"model\": \"proxmate/${PROXMATE_IDE_DEFAULT_MODEL}\","
fi

cat > "$CONFIG_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
$DEFAULT_LINE
  "provider": {
    "proxmate": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ProxMate",
      "options": {
        "baseURL": "${PROXMATE_IDE_GATEWAY_URL}",
        "apiKey": "{env:PROXMATE_IDE_TOKEN}"
      },
      "models": ${MODELS}
    }
  }
}
EOF

echo "[proxmate-ide] wrote OpenCode gateway config -> $CONFIG_DIR/opencode.json"
