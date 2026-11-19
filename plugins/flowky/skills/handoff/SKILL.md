---
name: handoff
description: Write a clean technical handoff of the session (goal, decisions, files touched, open items, next step) so the user can compact or restart without losing work. Use when the user asks for a handoff, a summary before /compact or /clear, or after the FlowKy context hint.
disable-model-invocation: true
---

Write a clean technical handoff of this session so the user can compact or restart without losing anything.
Use exactly these headings, short bullet points, no prose:

1. Goal (one line)
2. Decisions taken (with the reason for each)
3. Files touched (path: what changed)
4. Open items and known problems (commands that still fail, with the error)
5. Next step (the very next action, concrete)

Save the same text to `.flowky/cache/handoff.md` (overwrite it), then show it to the user and remind them,
in one line, that they can now run `/compact` or `/clear` and ask you to read `.flowky/cache/handoff.md`.
