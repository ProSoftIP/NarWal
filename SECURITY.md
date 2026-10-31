# Security policy

NarWal records web pages and a microphone, so a security bug in it can
expose what a person recorded. Please report one privately, and give us a
chance to fix it before you publish it.

## Reporting a vulnerability

- **Preferred:** on GitHub, open the repository's **Security** tab and press
  **Report a vulnerability**. Only the maintainers see the report.
- **Or by email:** info@prosoftip.com, with "NarWal security" in the
  subject.

Do not open a public issue, and do not attach a recording or bundle of a
real page. Include:

- the NarWal version and the browser and its version;
- what an attacker can do, and what they need first (a page the user
  records, a bundle the user opens, another extension, local access);
- the steps or a proof of concept, made with a test page or invented data.

We answer within five business days, and say what we will do and when. When
a fix is released we credit you in the release notes, unless you ask us not
to.

## Supported versions

Only the newest release gets security fixes: the version in the Chrome Web
Store and Microsoft Edge Add-ons, and the newest
[GitHub release](https://github.com/ProSoftIP/NarWal/releases/latest).

## In scope

- The extension in `packages/` and the bundles it writes: anything that
  records a tab the user did not start, records typed text or a URL value
  unmasked, sends data to a host other than the speech model hosts and
  OpenAI (when chosen), leaks an API key into a recording or export, or lets
  a recorded page or an opened bundle run code in the extension.
- The store package that `npm run release` builds.

## Out of scope

- The speech models and third-party libraries themselves: report those to
  their projects (the notices in `dist/THIRD-PARTY-NOTICES.txt` and
  `dist/runtime/` name them). Tell us too if NarWal's use of one is the
  problem.
- Attacks that need the user's unlocked computer or browser profile: the
  recordings are stored there, as the privacy policy says.
- What an AI agent does with a bundle the user gave it.
