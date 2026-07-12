#!/usr/bin/env bash
# Wrapper used by .vscode/tasks.json.
# Uses docker-compose.private.yml + .env.private/.env.global instead of
# docker-compose.yml + .env when the private files exist.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.yml"
ENV_FILE_ARGS=()

if [ -f "docker-compose.private.yml" ]; then
    COMPOSE_FILE="docker-compose.private.yml"
    [ -f ".env.private" ] && ENV_FILE_ARGS+=(--env-file .env.private)
    [ -f ".env.global" ] && ENV_FILE_ARGS+=(--env-file .env.global)
fi

if [ -f ".env.global" ]; then
    set -a
    # shellcheck disable=SC1091
    source ".env.global"
    set +a
fi

exec docker compose -f "$COMPOSE_FILE" "${ENV_FILE_ARGS[@]}" "$@"
