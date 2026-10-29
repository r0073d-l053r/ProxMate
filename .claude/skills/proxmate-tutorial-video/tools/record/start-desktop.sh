#!/bin/bash
# Start Xvfb and a GNOME Shell Ubuntu session for alex, in its own UTS namespace (hostname alex-desktop).
# usage: start-desktop.sh     (as root; env PMV_DISPLAY, default :1; logs go to $PMV_WORK/logs, default ~/pmv/work/logs)
# Needs session.sh installed as /home/alex/.desktop-session.sh (owned by alex, executable).
WORK=${PMV_WORK:-$HOME/pmv/work}; DISP=${PMV_DISPLAY:-:1}; N=${DISP#:}
mkdir -p "$WORK/logs"
pgrep -x Xvfb >/dev/null && pkill -x Xvfb; sleep 0.5; rm -f /tmp/.X$N-lock /tmp/.X11-unix/X$N
(nohup Xvfb $DISP -screen 0 1920x1080x24 +extension GLX +extension RANDR +render -dpi 96 -noreset -nolisten tcp > "$WORK/logs/xvfb.log" 2>&1 &)
for i in $(seq 1 30); do [ -e /tmp/.X11-unix/X$N ] && break; sleep 0.2; done
# System D-Bus: after a container restart a stale socket/pid can be left behind, so check for the daemon itself.
mkdir -p /run/dbus
if ! pgrep -u messagebus -x dbus-daemon >/dev/null; then rm -f /run/dbus/system_bus_socket /run/dbus/pid; dbus-daemon --system --fork; fi
U=$(id -u alex); mkdir -p /run/user/$U && chown alex:alex /run/user/$U && chmod 700 /run/user/$U
# The python3.13 bind mount is a workaround carried over from the original rig (a failed mount is harmless).
(nohup unshare --uts --mount --propagation private bash -c "hostname alex-desktop; mount -t tmpfs tmpfs /run/systemd; mount --bind /usr/bin/python3.12 /usr/bin/python3.13; exec runuser -u alex -- env -i LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 HOME=/home/alex USER=alex LOGNAME=alex SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin DISPLAY=$DISP XDG_RUNTIME_DIR=/run/user/$U CHROME_DEVEL_SANDBOX=/opt/chromium/chrome_sandbox dbus-run-session -- /home/alex/.desktop-session.sh" > "$WORK/logs/session.log" 2>&1 &)
