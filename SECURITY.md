# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository.

Include what you did, what happened, and what you expected. A proof of concept helps enormously; a video without commands does not.

## What to expect

| | |
|---|---|
| First response | Within 3 working days |
| Assessment | Within 10 working days |
| Fix or mitigation | Depends on severity; we will tell you the target and update you if it slips |

We will credit you in the advisory unless you prefer otherwise.

## Scope

In scope: this repository, `flowky.ai`, the VS Code extension, the Chrome extension, the documented API.

Out of scope: findings from automated scanners with no demonstrated impact, missing headers with no exploit path, social engineering, denial of service by volume, and anything requiring a compromised device.

## Safe harbour

Research conducted in good faith under this policy will not be pursued. Do not access data that is not yours, do not degrade the service for others, and give us a reasonable window before publishing.

## Handling of credentials

We never ask for your API keys. FlowKy is bring-your-own-key: your provider credentials stay in your editor and no inference request passes through our servers. If any part of the product appears to send a key anywhere, treat it as a vulnerability and report it.
