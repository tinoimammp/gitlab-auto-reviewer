# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-10-05

### Changed

- Log timestamps now use local time without milliseconds, e.g.
  `[2026-10-05 16:37:21]` instead of `[2026-10-05T09:37:21.734Z]`.

## [2.0.0] - 2026-10-05

### ⚠️ Breaking changes

- **Auto-approve is now opt-in.** Set `ALLOW_AUTO_APPROVE=true` to keep
  approving MRs. When it's off, the approve tool is blocked at the CLI level.
- **Comments written by you no longer trigger a review.** The bot posts with
  your token, so this stops it from triggering itself. To run a review by
  hand, assign yourself as reviewer instead.
- **The webhook URL format changed** to
  `<ngrok URL>/webhook?source=gitlab-auto-reviewer&v=<fingerprint>`. Webhooks
  are re-registered automatically on the first startup.

### Added

- **Webhook auto-registration.** On startup, the webhook is registered on
  every GitLab repo cloned under `REPOS_ROOT`. Hooks that are already up to
  date are left untouched, a hook you registered by hand is updated instead
  of duplicated, and only merge request and comment events are enabled
  (`ENABLE_WEBHOOK_AUTOREGISTER`).
- **Static ngrok domain** via `NGROK_DOMAIN`, so the webhook URL stays the
  same across restarts.
- **Re-review on push.** New commits on an MR you review trigger a review,
  unless the MR is a draft, the push is yours, or you already approved it
  (`ENABLE_REVIEW_ON_PUSH`).
- **Stricter approve rule.** Approves only with zero major and zero minor
  findings. Findings are tagged `[major]`/`[minor]`/`[nit]`, and every review
  ends with a verdict line.
- **`TRUSTED_ACTORS`** allowlist for who can trigger a review.
- **Prompt hardening.** MR content is treated as untrusted data, and
  AGENTS.md/CLAUDE.md is read only from the local checkout.
- **Footer** on every review comment, linking to this project.
- **Flow diagrams and restart scenarios** in the README.
- **Version in the startup log.**

### Fixed

- **Startup catch-up todos are now marked done.** Previously they never
  were, so every restart re-reviewed them.
- **No more duplicate reviews.** The reviewer trigger now fires only when
  you're newly added. An MR's todos are cleared after any successful
  review, and repeat triggers for a queued MR are deduplicated.
- **The catch-up skips MRs you already approved by hand.**
- **Merged and closed MRs are ignored.**
- **One malformed webhook payload can no longer crash the server.**

### Security

- **`/healthz` is served to localhost only.** It used to expose local repo
  paths through the public ngrok URL.
- **Broken JSON no longer leaks a stack trace** with local file paths.

## [1.0.0] - 2026-08-21

### Added

- Initial release:
  - webhook server that reviews MRs with headless Claude Code when you're
    assigned as reviewer or mentioned,
  - auto-detection of the local repo from its git remote,
  - GitLab MCP health check,
  - per-repo review queue,
  - ngrok auto-start,
  - startup catch-up via the GitLab Todos API.

[2.0.1]: https://github.com/tinoimammp/gitlab-auto-reviewer/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/tinoimammp/gitlab-auto-reviewer/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/tinoimammp/gitlab-auto-reviewer/releases/tag/v1.0.0
