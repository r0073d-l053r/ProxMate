# Narration style guide (ProxMate tutorials)

Built from: Wikipedia's "Signs of AI writing", the humanizer, avoid-ai-writing, anti-slop-writing and
teleprompter skills (read, not installed), Kobak et al.'s excess-vocabulary data, Microsoft and GitLab UI
style guides, plainlanguage.gov, Jeff Geerling's and Techno Tim's notes on how they script, and Kokoro's
model notes. The previous part-two script broke most of these rules, which is why it sounded fake.

## The creator's voice (from their own rewrite of part two's V01 to V03)

This section comes first because it wins over everything below it. The creator rewrote the opening three
sections themselves, and the rest of the script is matched to that.

- Talk like you're walking someone through it, not labeling the screen. "And the first card you'll see here is
  where you can add a cloud image." beats "The first card, Add a cloud image, downloads an official image."
- Say who is doing what. "I'll be picking Debian thirteen." "I'm going to speed through this process." "We'll
  start by setting up the Template Store." Use "we" for the tour, "I" for my clicks, "you" for the viewer.
- Use "going to", "will" and "I'll be ...ing" for what's about to happen. Leave some "we will" uncontracted.
- Spell the relation out instead of compressing it. "in case you have one that isn't on the list", not "in case
  yours isn't". Repeat the noun ("official images") instead of "ones".
- Small connecting words people really say are welcome: also, already, now, first, then, back in, later.
- Name the kind of thing: "the Save as template option", "an Add from cluster button", "the trash icon".
- Plain phrasal verbs: boot it up, shut it down, turn it into, start it back up.
- "virtual machine" and "VM" both appear. Don't force either one.
- Viewers' friends are "our friends", and Mike stays Mike.
- A short complete sentence is fine when it's what someone would say ("I'll be picking Debian thirteen.").
- Don't mention the ProxMate IDE in part two.

## Who is talking

- One calm person who runs a homelab, showing a friend how they do this. First person for what I do on
  screen ("I'll pick Debian thirteen"), second person for what the viewer can do ("you can change this later").
- Plain American English, because the voice is American: favorite, check and uncheck, the trash icon.
- Ordinary contractions: it's, I'll, you'll, don't, that's. No "gonna", no slang, no fake-casual openers
  ("Honestly?", "Look,", "Real talk", "Okay, so").
- Never invent an opinion, experience, number or reason. Every fact must be visible in the footage or in the
  old script, which was checked against ProxMate. If a sentence needs a fact we don't have, drop the sentence.

## Sentences

- Every sentence is a complete sentence with a subject and a verb. No one-word or two-word sentences, no
  verbless labels ("Sensible defaults.", "Backups and Snapshots."), no commands shouted as sentences ("Deploy!").
- Most sentences run 8 to 20 words, averaging about 12 to 16. A shorter one is fine if it's a complete thing
  a person would say. Never three short sentences in a row.
- One idea per sentence. At most one extra clause, and put it at the end ("..., so it's ready on first boot").
  No long lead-in clauses, no "which" clauses in the middle.
- Lists use the serial comma ("Debian, Ubuntu, Fedora, and others"). Outside a list, keep to two commas.
- Join ideas the way people talk: so, because, and then, now, once that's done, while that runs.

## Things that make it sound like AI (never use)

- Fragments for drama: "Gone.", "Done.", "Deploy!", "One click."
- Label and colon: "Nice detail:", "Quick note:", "Heads-up:", "Bonus:".
- Not-X-but-Y in any form: "not just X, but Y", "It's not X, it's Y", "X doesn't just Y, it Z".
- Questions you answer yourself: "The best part? ...". Use an if-sentence instead: "If you forget the
  password, you can reset it here."
- Reveal set-ups: "Here's the thing", "Here's the deal", "Here's where it gets interesting", "Let's dive in",
  "Let's break this down", "without further ado".
- Grand openers and slogans: "Everything starts in...", "At its core...", "That's the magic."
- Closers that repeat what we just saw: "Like it never happened.", "Simple as that.", "And that's it."
- Counting: "three ways to...", "two things to know", and three-item recaps at the end of a section or video.
- Lists of three by habit. Use three items only when there really are three, and not twice in a row.
- Favorites or praise with no reason: "This one's my favorite.", "Nice.", "Sweet." Give the real reason or cut it.
- Describing what is plainly on screen ("There it is.") unless you add what it means or what happens next.
- Stacked hedges and lecture phrases: "It's worth noting", "It's important to remember", "could potentially".
- "-ing" clauses tacked on for weight: ", making it easier than ever", ", ensuring that...".
- "serves as", "acts as", "boasts", "features", "offers" where "is" or "has" works.
- Starting several sentences in a row the same way ("Now... Now... Now...").

Banned words: delve, tapestry, testament, landscape, realm, crucial, pivotal, vital, key (as an adjective; "SSH
key" is fine), robust, seamless, seamlessly, streamline, leverage, harness, utilize, enhance, elevate, empower,
unlock, unleash, foster, garner, showcase, highlight (verb), underscore (verb), intricate, nuanced, multifaceted,
interplay, meticulous, comprehensive, insights, notably, additionally, moreover, furthermore, importantly,
interestingly, certainly, actually, quietly, deeply, fundamentally, remarkably, arguably, game changer,
cutting-edge, groundbreaking, transformative, vibrant, journey, embark, navigate (figurative), ensure (say
"make sure"), various, effortless, magic, awesome, super (as an intensifier), simply, just (as filler).

## Talking about the screen

- Say where, then what, then why if it helps: "In the Snapshots card, I'll click Take snapshot, so there's
  something to roll back to."
- Use the exact on-screen label and say what kind of thing it is: "the Deploy button", "the Insights tab",
  "the Actions menu". The listener can't hear capital letters.
- Call each thing by one name every time. If it's the Template Store, it never becomes "the library".
- Define a term once, in plain words, the first time it matters (cloud-init: what sets up the user, the SSH key
  and the software on first boot; the guest agent: what lets ProxMate see the IP address and shut the VM down
  cleanly). Don't explain Proxmox or VM.
- Name a click just before or as it happens, never seconds early. Don't narrate every click; the picture shows it.
- After a result appears, it's fine to say nothing for a moment. Silence is part of the pacing.
- When the picture is sped up, say once, plainly, that you're skipping the wait. Don't fill it with chatter.
- End each section with one plain sentence that leads into the next, or just stop. End the video with one ask.

## Written for the voice (Kokoro af_heart)

- Spoken text uses only letters, spaces, straight apostrophes, commas, periods, and a rare real question mark.
  No exclamation marks, colons, semicolons, dashes, ellipses, parentheses, slashes or quotes.
- Write numbers and versions the way you'd say them: "Debian thirteen", "Ubuntu twenty-four oh four",
  "forty gigabytes". Don't read IP addresses, URLs or passwords aloud; point at them instead.
- Spell acronyms the way they're said: V M, I P, S S H, L X C, C P U. These are handled in the spoken form.
- The voice reads at one speed (1.0) for the whole video. Lines are never sped up to fit. If a line doesn't
  fit its window, it gets shorter.
- A line is a short paragraph of one to three related sentences, at least seven words and at most about 45
  words. The voice is weak on very short calls, so never write a line like "Share." or "Let's go."
- Don't tell the viewer something is easy: no "simply", "just click", "easy", "quick".
- Budget: about 2.6 spoken words per second of the window the line has, counting the pause after it.

## Before it's final

- Read each line out loud. If you wouldn't say it to a friend sitting next to you, rewrite it.
- Check every sentence against the lists above; if one sentence has two problems, rewrite it from scratch.
- Check grammar and agreement, and that every label, number and claim matches the footage.
