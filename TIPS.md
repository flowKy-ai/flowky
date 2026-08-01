# Tips for shipping with an agent

Short, checkable things that make a measurable difference. Longer guides live at [flowky.ai/vibe-coding](https://flowky.ai/vibe-coding).

## Context

**Put the build command in `CLAUDE.md`, not in chat.** Anything you retype twice belongs in a file the agent reads every session.

**Keep `CLAUDE.md` under 200 lines.** Past that, adherence measurably drops. If it is growing, the overflow belongs in a skill, not in more lines.

**Do not list your directory tree.** The agent can read it, and a tree written down goes stale on the next refactor. Write the things it *cannot* infer: the load-bearing hack, the reason that file is not what it looks like.

**Absolute rules go in an unscoped file.** Path-scoped rules are dropped on compaction and only return when a matching file is read. A "never commit secrets" rule that lives in a scoped file stops applying halfway through a session.

## Prompting

**Say what "done" looks like.** "Add auth" is a research project. "Add email/password login, redirect to /dashboard, tests pass" is a task with an end.

**Give it the error, not your summary.** Paste the stack trace. Your paraphrase drops the line number, which is the only part that mattered.

**One concern per turn.** Two unrelated changes in one prompt produce a diff you cannot review, and a rollback that takes both.

## Loops

**Three identical failures is the signal.** If the same command has failed three times, the next attempt will fail too. Stop, read the actual error, change the input.

**Stash before attempt five.** `git stash push -u` costs nothing and gives you a floor to return to when the fifth attempt makes things worse.

## Review

**Read the diff, not the summary.** The summary describes intent. The diff is what happens.

**Grep for what should not be there.** `console.log`, `any`, `TODO`, hard-coded URLs, `.env` values. Thirty seconds, catches most of it.

**Ask where it duplicated something.** Agents rewrite rather than reuse, because what exists is not in their context. This is exactly what FlowKy's guard automates.

## Tests

**Write the test first when the behaviour is precise.** An agent given a failing test has an unambiguous target and knows when to stop.

**Forbid editing tests while fixing implementation.** Otherwise the fastest path to green is deleting the assertion.

**Truncate test output.** `pnpm test 2>&1 | tail -n 40` keeps a thousand lines of passing output out of the context window.

## Security

**Never paste a real key to check a format.** Use `sk-test-000…`. Anything in a prompt is in a transcript.

**Check every generated query is scoped to the tenant.** Filtering in application code after fetching everything is the single most common data-leak shape in agent-written code.

**Read generated migrations line by line.** A dropped column is not recoverable from a code review after the fact.

## Cost

**Clear between unrelated tasks.** Carrying the previous task's exploration into the next one pays for context you will not use.

**Cheap models for mechanical work.** Renames, moving files, formatting. Save the expensive model for decisions.

**Watch for the same file being read repeatedly.** That is a context problem, not a model problem, and it is what a project map fixes.
