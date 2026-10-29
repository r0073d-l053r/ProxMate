#!/bin/bash
# Run a command as alex inside the live desktop session's environment (same D-Bus session bus as GNOME Shell).
# usage: asalex.sh <command> [args...]     e.g. asalex.sh gsettings get org.gnome.desktop.interface cursor-size
#        (as root; env PMV_DISPLAY, default :1)
GS=$(pgrep -x gnome-shell | head -1)
BUS=$(tr '\0' '\n' < /proc/$GS/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
exec nsenter -t $GS -u -m -- runuser -u alex -- env -i HOME=/home/alex USER=alex LOGNAME=alex PATH=/usr/local/bin:/usr/bin:/bin DISPLAY=${PMV_DISPLAY:-:1} XDG_RUNTIME_DIR=/run/user/$(id -u alex) DBUS_SESSION_BUS_ADDRESS="$BUS" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 "$@"
