# Contributing

The starter and the documentation take pull requests. The extension and web app are closed source and live in private repositories.

## Before you open a PR

**Open an issue first for anything non-trivial.** A PR that takes a direction we were not going to take is wasted work, and saying so after you have written it is worse for both of us.

**One concern per PR.** A refactor bundled with a feature cannot be reviewed properly and cannot be reverted cleanly.

**Run the checks.** `node starter/create-site.mjs test-output` should scaffold cleanly, and refuse on a second run.

## What we will merge quickly

- Fixes to the starter that make it work on a platform where it did not
- Documentation corrections, especially anything factually wrong
- Tips that are specific and checkable

## What we will push back on

- New dependencies in the starter. It is deliberately zero-dependency and one file, so people can read it before running it.
- Tips that are generic advice. "Write good tests" helps nobody; "forbid the agent from editing tests while fixing implementation" is a rule someone can apply today.
- Invented statistics. If you cite a number, it needs a source or an explicit worked example with its assumptions.

## Style

British English. No emoji in documentation. Explain why a thing is done, not what the code plainly says.
