# voice.md

The creator's voice for ProxMate tutorials. The yt-script, yt-seo and yt-package skills read this file from
`~/.claude/youtube/voice.md`; copy it there at the start of a session (the skill's setup step does).

Evidence: the creator's own rewrite of part two's opening three sections (quoted below), their feedback on
two rejected scripts ("too robotic, too artificial", "odd and sterile"), and their approval of the take-three
script that followed this profile. Update this file whenever they rewrite lines again.

## Who I am talking to

Someone who runs Proxmox at home or for a small team, is comfortable in a Linux terminal, and keeps getting
asked for VMs by friends, family or coworkers. They don't want to hand anyone a Proxmox login. Their friends
are "our friends" in the narration; the demo friend is Mike.

## How I actually talk

Walking someone through it, not labeling the screen. In my own words (part two, V01 to V03):

> Welcome back to part two of the Set Up Your ProxMate series. This is a VM that we will deploy later in this
> video. We will show you how it boots with SSH keys and Docker installed. Today we will be discussing how to
> build a VM, how to work with the Template Store, and how to get inside of a VM once it's deployed.

> And the first card you'll see here is where you can add a cloud image. This downloads an official image for
> you. There is also an Add from cluster button for templates you made in Proxmox already.

> Let's add a new cloud image from the Image list. It has official images straight from Debian, Ubuntu,
> Fedora, and others. The last option takes a link to your own image, in case you have one that isn't on the
> list. I'll be picking Debian 13.

What that shows:

- "We" for the tour, "I" for my own clicks, "you" for the viewer. "We will", "I'll be picking", "I'm going to".
- Full sentences that spell out the relation ("in case you have one that isn't on the list"), not compressed
  labels. Some "we will" stays uncontracted.
- Small connecting words people really say: also, already, now, first, then, back in, later.
- Names the kind of thing on screen: "the Save as template option", "an Add from cluster button".
- Plain phrasal verbs: boot it up, shut it down, turn it into.
- "virtual machine" and "VM" both.
- A short sentence is fine when it's what I'd say ("I'll be picking Debian 13.").

## Words I never use

Hype and filler: game-changer, insane, unlock, dive in, let's get into it, ultimate, powerful, revolutionary,
seamless, robust, leverage, delve. No "hey guys", no "smash that like button", no subscribe pitch before the
payoff. None of the scripted-sounding patterns in `docs/narration-style-guide.md`: fragments for drama
("Gone."), colon labels ("Quick note:"), not-X-but-Y, questions I answer myself, "Here's the thing/deal",
three-item recaps, praise with no reason.

## What I will not claim

No invented numbers, timings or results. Facts come from what is on screen, ProxMate's README, docs and
release notes, and are attributed when they are figures. No claim that a feature works on a Proxmox version
it was not tested on.

## My format

Screen-recorded tutorial of the real ProxMate UI on a real Proxmox node, narrated by a text-to-speech voice
(Kokoro `af_heart`, normal speed), about 10 to 14 minutes so far (part one 10:41, part two 13:46), a series ("Set Up Your ProxMate", part one, part two...).
Opens with the finished result and what today covers. Real waits are sped up with a fast-forward badge. Ends
with one ask ("Let me know in the comments what you're going to deploy first") and the same animated
ProxMate end card every time.
