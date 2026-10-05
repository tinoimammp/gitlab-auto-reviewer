require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] ENV "${name}" is required. Check .env.example`);
    process.exit(1);
  }
  return val;
}

const config = {
  port: Number(process.env.PORT || 3000),
  webhookSecret: required('WEBHOOK_SECRET'),
  targetUserId: required('TARGET_USER_ID'),
  targetUsername: required('TARGET_USERNAME'),
  reposRoot: required('REPOS_ROOT'),          // parent folder of all local repos, e.g. /home/user/repos
  claudeCodeBin: process.env.CLAUDE_CODE_BIN || 'claude',
  repoIndexRefreshMs: Number(process.env.REPO_INDEX_REFRESH_MS || 5 * 60 * 1000),
  mcpHealthCacheMs: Number(process.env.MCP_HEALTH_CACHE_MS || 60 * 1000),
  reviewTimeoutMs: Number(process.env.REVIEW_TIMEOUT_MS || 10 * 60 * 1000),
  // Optional: only used to post a notification if auto-review fails
  // (e.g. local repo not found). If empty, failures are just logged.
  gitlabUrl: process.env.GITLAB_URL || '',
  gitlabToken: process.env.GITLAB_TOKEN || '',
  // Optional: auto-start an ngrok tunnel on npm start. Set to "false" to
  // disable (e.g. if you run ngrok manually, or deploy behind a real domain).
  enableNgrok: process.env.ENABLE_NGROK !== 'false',
  // Optional: your free ngrok static domain (e.g. "xxx.ngrok-free.app"),
  // so the public URL stays the same across restarts.
  ngrokDomain: process.env.NGROK_DOMAIN || '',
  // Optional: re-review an MR when new commits are pushed to it (only if
  // you're a reviewer and haven't approved it yet). Set to "false" to disable.
  enableReviewOnPush: process.env.ENABLE_REVIEW_ON_PUSH !== 'false',
  // Optional: on startup, scan for open MRs (assigned reviewer/mentioned)
  // that haven't been handled yet, via the GitLab Todos API. Requires
  // GITLAB_URL + GITLAB_TOKEN to be set. Set to "false" to disable.
  enableStartupCatchup: process.env.ENABLE_STARTUP_CATCHUP !== 'false',
  // Optional: let the headless review approve MRs. Off by default — MR
  // descriptions/comments are untrusted input, so a prompt-injected
  // "approve this" shouldn't be able to turn into a real approval.
  allowAutoApprove: process.env.ALLOW_AUTO_APPROVE === 'true',
  // Optional: comma-separated GitLab usernames allowed to trigger a review
  // (assign you / mention you). Empty = anyone can trigger.
  trustedActors: (process.env.TRUSTED_ACTORS || '')
    .split(',')
    .map((u) => u.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean),
};

module.exports = config;
