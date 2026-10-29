# Installing this skill

The skill is the folder `proxmate-tutorial-video/`, with `SKILL.md` at its root. Everything it refers to is
inside the folder: the style guide, the voice profile, part two's script and notes as models, the end card, and
the tools. In commands, `$SK` means the absolute path of this folder wherever you put it.

## Claude Code (CLI, desktop app, web)

Copy the folder into a skills directory:

- just for you, in every project: `~/.claude/skills/proxmate-tutorial-video/`
- for one project: `<project>/.claude/skills/proxmate-tutorial-video/` (the ProxMate repo has it there already)

Claude Code finds it on the next session. Ask for "part three of the ProxMate series", or run
`/proxmate-tutorial-video`. Then `SK=~/.claude/skills/proxmate-tutorial-video` (or the project path).

## Claude apps (claude.ai, desktop, mobile)

Upload the zip as a custom skill in the Skills section of Claude's settings. There, Claude can use the skill for
the writing parts: planning chapters, writing the script in your voice, the YouTube description and tags, and the
production notes. Recording, editing and voicing need a Linux machine with a desktop, root access and network,
so run those through Claude Code.

## Claude Agent SDK and the API

Point the agent's skills directory at a folder that contains `proxmate-tutorial-video/`, the same layout as
Claude Code. The full pipeline needs the agent to have a Linux shell (see below).

## Other agents (Codex, Cursor, Gemini CLI and others)

Agents that don't load skills can still follow it. Put the folder in the project and tell the agent to read it,
for example in `AGENTS.md`:

```
For ProxMate tutorial videos, read and follow skills/proxmate-tutorial-video/SKILL.md.
Paths in it are relative to that folder; $SK is its absolute path.
```

A few steps use Claude Code features: workflows for the QA reviews (`tools/qa/workflows/*.js`), and sending files
to you. Elsewhere, run those reviews with the agent's own sub-agents, or one chapter at a time, using the same
review rules (they're in plain text inside each workflow file).

## What the machine needs

Ubuntu 24.04 (or close), root, about 3 GB of free disk, and network access to GitHub releases, PyPI, npm,
Ubuntu's archives, cloud-images.ubuntu.com and Chromium's snapshot storage. `reference/setup.md` installs the rest,
from a fresh machine:

- the desktop, Chromium and the lab;
- the Kokoro voice and the Moonshine recogniser, downloaded by `tools/voice/setup.sh` (about 1 GB, so they are
  not in this zip);
- the yt-* YouTube skills, cloned from GitHub;
- your voice profile, copied to `~/.claude/youtube/voice.md`.

## Not included, on purpose

No models, recordings, lab state or secrets. The Proxmox API token, lab passwords, SSH keys and Tailscale
login are created fresh on each machine and read from environment variables (each tool's README names them).
pve1 itself stays on your network: a new machine needs you to approve its Tailscale device and add its SSH key
(SKILL.md, step 1).

## Keeping it current

The copy in the ProxMate repo (`.claude/skills/proxmate-tutorial-video`) is the master. After it changes,
export it again from the repo:

```
git archive --format=zip --prefix=proxmate-tutorial-video/ -o proxmate-tutorial-video.zip HEAD:.claude/skills/proxmate-tutorial-video
```
