#!/bin/bash
# Print a URL-encoded Proxmox login ticket for root@pam (valid 2 hours), generated on pve1 as root over ssh (key login,
# no password involved). examples/s03-preroll.cjs sets it as Chromium's PVEAuthCookie. The output is a live credential:
# pass it on, never log or save it.
# usage: ticket.sh   (env PMV_PVE1_SSH_CONFIG, default $PMV_TS_DIR/ssh_config; PMV_TS_DIR, default $PMV_LAB/ts-lab)
WORK=${PMV_WORK:-$HOME/pmv/work}; LAB=${PMV_LAB:-$WORK/lab}; T=${PMV_TS_DIR:-$LAB/ts-lab}
CFG=${PMV_PVE1_SSH_CONFIG:-$T/ssh_config}
timeout 40 ssh -o ConnectTimeout=25 -F "$CFG" pve1-lab "perl -MPVE::AccessControl -MURI::Escape -e 'print uri_escape(PVE::AccessControl::assemble_ticket(q{root@pam}))'"
