#!/usr/bin/env bash
# Wrapper used by .vscode/tasks.json.
# Uses the compose file found in .private/ (any name) + .private/.global.env
# instead of docker-compose.yml + .env, when such a file exists.
#
# The compose file(s) under .private/ are NOT managed by this script and
# must stay standard, portable compose files - their own relative paths
# (e.g. "env_file: - my-env-file.env") resolve relative to their own
# directory, which is Compose's default behavior when no --project-directory
# is passed. So this script deliberately does NOT set --project-directory,
# and always puts the private compose file first in the -f list, so Compose
# keeps deriving the project directory from it.
#
# docker-compose.override.yml (repo root) gets merged in on top for the
# debug tasks. Since the project directory is the private file's own
# directory (not the repo root) in that case, docker-compose.override.yml
# can't use plain relative paths for its own "./":/app" volume or
# "env_file: .env" - so this script exports ROOT_DIR (absolute path to the
# repo root) and docker-compose.override.yml references ${ROOT_DIR} instead.
#
# Any values used for ${VAR} interpolation inside a compose file (ports,
# volumes, build context, etc.) have to be in the shell environment or
# passed via --env-file - values loaded purely through a service's own
# env_file: entry aren't guaranteed to feed back into interpolation on
# every Compose version. So every *.env file directly under .private/
# (aside from .global.env, handled separately below) is also sourced into
# this shell before invoking Compose, so those values are always available
# for interpolation regardless of Compose version.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export ROOT_DIR="$ROOT"
PRIVATE_DIR="$ROOT/.private"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE_ARGS=()
GLOBAL_ENV="$PRIVATE_DIR/.global.env"

if [ -d "$PRIVATE_DIR" ]; then
    for f in "$PRIVATE_DIR"/*.yml "$PRIVATE_DIR"/*.yaml; do
        [ -f "$f" ] || continue
        COMPOSE_FILE="$f"
        break
    done
fi

if [ "$COMPOSE_FILE" != "docker-compose.yml" ] && [ -f "$GLOBAL_ENV" ]; then
    ENV_FILE_ARGS+=(--env-file "$GLOBAL_ENV")
fi

if [ -d "$PRIVATE_DIR" ]; then
    set -a
    [ -f "$GLOBAL_ENV" ] && source "$GLOBAL_ENV"
    for f in "$PRIVATE_DIR"/*.env; do
        [ -f "$f" ] || continue
        # shellcheck disable=SC1090
        source "$f"
    done
    set +a
fi

exec docker compose -f "$COMPOSE_FILE" "${ENV_FILE_ARGS[@]}" "$@"
