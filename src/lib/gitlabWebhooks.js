/**
 * Auto-register this server's webhook on every GitLab project cloned under
 * REPOS_ROOT, so there's no per-project manual setup — and so a changed
 * public URL (e.g. ngrok without a static domain) gets updated everywhere
 * on the next startup.
 *
 * A project hook counts as "ours" when it carries our name, our URL
 * marker, or points to /webhook on an ngrok domain (a hook registered by
 * hand following the README). Ours gets updated in place; extra copies we
 * created ourselves are deleted. Any other hook is never touched.
 */
const crypto = require('crypto');
const logger = require('./logger');

const HOOK_NAME = 'gitlab-auto-reviewer';
const URL_MARKER = 'source=gitlab-auto-reviewer';
const NGROK_HOST = /\.ngrok(-free)?\.(app|dev|io)$/i;

// GitLab never returns a hook's secret token, so we can't tell whether an
// existing hook still has the current WEBHOOK_SECRET. A short fingerprint
// of the secret in the URL solves that: same URL ⇒ same secret, so an
// up-to-date hook can be left alone entirely.
function secretFingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

function hookUrl(publicUrl, secret) {
  return `${publicUrl.replace(/\/$/, '')}/webhook?${URL_MARKER}&v=${secretFingerprint(secret)}`;
}

// The only events the server handles. Every other trigger is switched off
// explicitly — GitLab defaults push_events to true, and a hook registered
// by hand earlier may have had extra events ticked.
const ON_EVENTS = ['merge_requests_events', 'note_events'];
const OFF_EVENTS = [
  'push_events',
  'tag_push_events',
  'issues_events',
  'confidential_issues_events',
  'confidential_note_events',
  'job_events',
  'pipeline_events',
  'wiki_page_events',
  'deployment_events',
  'releases_events',
  'emoji_events',
  'feature_flag_events',
  'resource_access_token_events',
];

function isUpToDate(hook, url) {
  return hook.url === url && ON_EVENTS.every((e) => hook[e]) && OFF_EVENTS.every((e) => !hook[e]);
}

function isOurs(hook) {
  if (hook.name === HOOK_NAME) return 'marked';
  if ((hook.url || '').includes(URL_MARKER)) return 'marked';
  try {
    const u = new URL(hook.url);
    if (NGROK_HOST.test(u.hostname) && u.pathname.replace(/\/$/, '') === '/webhook') return 'legacy';
  } catch {
    // unparseable URL — not ours
  }
  return null;
}

async function api(gitlabUrl, gitlabToken, method, path, body) {
  const res = await fetch(`${gitlabUrl.replace(/\/$/, '')}/api/v4${path}`, {
    method,
    headers: { 'PRIVATE-TOKEN': gitlabToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitLab API ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function ensureProjectWebhook({ gitlabUrl, gitlabToken, projectPath, url, secret }) {
  const project = encodeURIComponent(projectPath);
  const settings = {
    url,
    token: secret,
    name: HOOK_NAME,
    description: 'Auto-review MRs with Claude Code — https://github.com/tinoimammp/gitlab-auto-reviewer',
    ...Object.fromEntries(ON_EVENTS.map((e) => [e, true])),
    ...Object.fromEntries(OFF_EVENTS.map((e) => [e, false])),
    enable_ssl_verification: true,
  };

  const hooks = await api(gitlabUrl, gitlabToken, 'GET', `/projects/${project}/hooks?per_page=100`);
  const ours = hooks.filter(isOurs);

  if (ours.length === 0) {
    await api(gitlabUrl, gitlabToken, 'POST', `/projects/${project}/hooks`, settings);
    return 'created';
  }

  // Prefer a hook that's already up to date, so it can be left untouched.
  const keep = ours.find((h) => isUpToDate(h, url)) || ours[0];
  const extra = ours.filter((h) => h !== keep);
  const upToDate = isUpToDate(keep, url);
  if (!upToDate) {
    await api(gitlabUrl, gitlabToken, 'PUT', `/projects/${project}/hooks/${keep.id}`, settings);
  }

  for (const hook of extra) {
    if (isOurs(hook) === 'marked') {
      await api(gitlabUrl, gitlabToken, 'DELETE', `/projects/${project}/hooks/${hook.id}`);
    } else {
      logger.warn(
        `Webhooks: ${projectPath} has another hand-registered ngrok webhook (${hook.url}) — ` +
        `left as is; delete it in Settings → Webhooks if it's a stale duplicate.`
      );
    }
  }
  return upToDate ? 'up-to-date' : 'updated';
}

async function registerWebhooks({ gitlabUrl, gitlabToken, projectPaths, publicUrl, secret }) {
  const url = hookUrl(publicUrl, secret);
  const counts = { created: 0, updated: 0, 'up-to-date': 0, failed: 0 };

  for (const projectPath of projectPaths) {
    try {
      const result = await ensureProjectWebhook({ gitlabUrl, gitlabToken, projectPath, url, secret });
      counts[result] += 1;
      if (result !== 'up-to-date') logger.info(`Webhooks: ${result} on ${projectPath}`);
    } catch (err) {
      counts.failed += 1;
      const hint = err.status === 403 || err.status === 404
        ? ' (needs Maintainer role on the project — register it by hand instead)'
        : '';
      logger.warn(`Webhooks: couldn't register on ${projectPath}${hint}: ${err.message}`);
    }
  }

  logger.info(
    `Webhooks → ${url}: ${counts.created} created, ${counts.updated} updated, ` +
    `${counts['up-to-date']} up to date, ${counts.failed} failed`
  );
}

module.exports = { registerWebhooks, isOurs, hookUrl };
