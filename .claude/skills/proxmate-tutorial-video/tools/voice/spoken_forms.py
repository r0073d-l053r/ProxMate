# Spoken forms for narration text: how Kokoro should say names, acronyms, commands and numbers it would misread.
# Merged from part one's table (script2manifest.py SPOKEN) and part two's additions (script2lines.py EXTRA).
# Part two's forms come first, as they did when part two prepended them, because the rules run in order.
# Add new words for a new episode to EPISODE (they run first), or to the end of the right table.
# usage: from spoken_forms import spoken; spoken("SSH into web-01")  ->  "S S H into web oh one"
import re

# part two (tutorial 2: templates, VMs and consoles)
PART2 = [
    (r"\bweb-01\b", "web oh one"), (r"\bweb-golden\b", "web golden"), (r"\bdebian-12-golden\b", "debian twelve golden"),
    (r"docker run hello-world", "docker run hello world"), (r"\bnotes\.txt\b", "notes dot T X T"), (r"\bsudo\b", "sue doo"),
    (r"\bcode-server\b", "code server"), (r"\bcloud-config\b", "cloud config"), (r"\btailnet\b", "tail net"), (r"\btailscale\b", "tail scale"),
    (r"Ctrl\+Alt\+Del", "Control Alt Delete"), (r"\bCtrl-click\b", "Control click"),
    (r"\bMateStates\b", "Mate States"), (r"\bMateState\b", "Mate State"), (r"\bQEMU\b", "Q E M U"),
    (r"\bVM ID\b", "V M I D"), (r"\bIDE\b", "I D E"), (r"\bIP\b", "I P"), (r"\bLXC\b", "L X C"), (r"\bOS\b", "O S"),
    (r"\bCPU\b", "C P U"), (r"\bGPU\b", "G P U"), (r"\bPCI\b", "P C I"), (r"\bDebian 13\b", "Debian thirteen"),
]

# part one (tutorial 1: first-time setup)
PART1 = [
    (r"proxmate\.host", "proxmate dot host"), (r"root@pam", "root at pam"), (r"proxmox-token\.sh", "proxmox token dot S H"),
    (r"docker compose up -d backend", "docker compose up dash D backend"), (r"docker compose up -d", "docker compose up dash D"), (r"\bVE\b", "V E"), (r"\.env\b", "dot env"), (r"\bSSHFS\b", "S S H F S"), (r"\bNFS\b", "N F S"),
    (r"\b8006\b", "eighty oh six"), (r"\b24\.04\b", "twenty-four oh four"), (r"\bvCPUs\b", "V C P Us"), (r"\bAPI\b", "A P I"),
    (r"\bSSH\b", "S S H"), (r"\bHTTPS\b", "H T T P S"), (r"\bhttps\b", "H T T P S"), (r"\bHTTP\b", "H T T P"), (r"\bTLS\b", "T L S"),
    (r"\bISOs\b", "eye so images"), (r"\bISO\b", "eye so"), (r"\bbtop\b", "b top"),
    (r"\bfail2ban\b", "fail to ban"), (r"\bcloud-init\b", "cloud init"), (r"\bCloud-init\b", "Cloud init"), (r"\bhomelabbing\b", "home labbing"),
    (r"\bhomelab\b", "home lab"), (r"\bSuperfile\b", "Super file"), (r"\bTailscale\b", "Tail scale"), (r"\bspf\b", "S P F"), (r"\bSNIPPET_DIR\b", "snippet dir"), (r"\bSNIPPET_STORAGE\b", "snippet storage"),
]

# new episodes: (regex, spoken form) pairs for words this episode adds
EPISODE = []

SPOKEN = EPISODE + PART2 + PART1


def spoken(t):
    for a, b in SPOKEN: t = re.sub(a, b, t)
    return t
