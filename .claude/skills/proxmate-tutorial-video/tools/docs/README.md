# Docs tools

**gen_repo_doc.py** rebuilds the committed script document (`docs/video-script-*.md`) with the final narration:
the lab table, chapter titles and ON SCREEN notes stay, each line gets its start time in the finished video, long
sped-up waits get `[FF]`, the old Hooks section goes, and the Length bullet is updated from the word count and the
cut's runtime. Usage: `gen_repo_doc.py <doc path in repo> narration.json beats.json chapters.json out.md [--ref HEAD]
[--voice TEXT] [--narration-note TEXT] [--drop TEXT]`. `examples/part2-gen_repo_doc.txt` is part two's call, which
reproduces commit b7e35a0 exactly.

**ytchapters.py** writes the YouTube chapter list (`youtube-chapters.txt` next to the cut's chapters.json) after
checking YouTube's rules (first chapter at 0:00, at least three, each at least ten seconds). Usage:
`ytchapters.py titles.json chapters.json`; `examples/titles-part2.json` holds part two's titles.
