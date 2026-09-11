#!/bin/sh
set -e

# Runs the server as an ordinary user, but one the operator chooses.
#
# Only the notification store touches the filesystem, and it lands on a volume
# the host already owns. Unraid's appdata is 99:100, this image's built-in user
# is 1000, and a container that cannot write its own data directory disables
# notifications with no obvious cause. PUID and PGID let the two agree, which is
# the convention most Unraid images already follow.
#
# Defaults reproduce the previous behaviour exactly: the `node` user, uid 1000.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ -n "${NOTIFY_DIR:-}" ]; then
  # Created here rather than by the app, because only root can hand it over.
  mkdir -p "$NOTIFY_DIR" 2>/dev/null || true
  chown -R "$PUID:$PGID" "$NOTIFY_DIR" 2>/dev/null ||
    echo "[entrypoint] could not take ownership of $NOTIFY_DIR; alerts may stay disabled"
fi

# Drop privileges for the actual process. Nothing after this point runs as root.
exec su-exec "$PUID:$PGID" "$@"
