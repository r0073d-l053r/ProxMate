#!/bin/bash
# Runs as alex inside dbus-run-session: a GNOME Shell "ubuntu" X11 session on the Xvfb display.
# usage: install as /home/alex/.desktop-session.sh (owned by alex, executable); start-desktop.sh runs it.
export XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=ubuntu:GNOME XDG_SESSION_DESKTOP=ubuntu DESKTOP_SESSION=ubuntu GNOME_SHELL_SESSION_MODE=ubuntu
export XDG_DATA_DIRS=/usr/share/ubuntu:/usr/local/share:/usr/share XDG_CONFIG_DIRS=/etc/xdg/xdg-ubuntu:/etc/xdg
export NO_AT_BRIDGE=1 LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy ALL_PROXY all_proxy
cd "$HOME"
dbus-update-activation-environment --all 2>/dev/null || true
gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
gsettings set org.gnome.desktop.interface gtk-theme 'Yaru-dark'
gsettings set org.gnome.desktop.interface icon-theme 'Yaru'
gsettings set org.gnome.desktop.interface cursor-theme 'Yaru'
gsettings set org.gnome.desktop.interface cursor-size 32  # the creator's bigger pointer; Chromium needs a restart to show it
echo 'Xcursor.size: 32' | xrdb -merge 2>/dev/null || true
gsettings set org.gnome.desktop.interface enable-hot-corners false
gsettings set org.gnome.desktop.interface font-antialiasing 'grayscale'
gsettings set org.gnome.shell favorite-apps "['org.gnome.Nautilus.desktop', 'chromium.desktop', 'org.gnome.Terminal.desktop']"
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.notifications show-banners false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
/usr/libexec/gsd-xsettings &
exec gnome-shell --x11 --replace
