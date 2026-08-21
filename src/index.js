const express = require('express');
const config = require('./config');
const logger = require('./lib/logger');
const { createRepoResolver } = require('./lib/repoResolver');
const { createMcpHealthChecker } = require('./lib/mcpHealth');
const { queueReview } = require('./lib/claudeReview');
const { startNgrokTunnel } = require('./lib/ngrokTunnel');
const { fetchPendingReviewTodos, markTodoDone } = require('./lib/gitlabTodos');

const app = express();
app.use(express.json());

const repoResolver = createRepoResolver(config.reposRoot, config.repoIndexRefreshMs);
const checkMcpHealth = createMcpHealthChecker(config.claudeCodeBin, config.mcpHealthCacheMs, 'gitlab');

function actorLabel(payload) {
  const user = payload.user;
  if (!user) return 'unknown';
  return user.username ? `${user.name} (@${user.username})` : user.name || 'unknown';
}

function shouldTrigger(payload) {
  if (payload.object_kind === 'merge_request') {
    const reviewers = payload.changes?.reviewers?.current || [];
    const isTarget = reviewers.some((r) => String(r.id) === String(config.targetUserId));
    if (isTarget) {
      return {
        reason: 'assigned-as-reviewer',
        projectPath: payload.project.path_with_namespace,
        mrIid: payload.object_attributes.iid,
        actor: actorLabel(payload),
      };
    }
  }
  if (payload.object_kind === 'note' && payload.merge_request) {
    const note = payload.object_attributes.note || '';
    if (note.includes(`@${config.targetUsername}`)) {
      return {
        reason: 'mentioned-in-comment',
        projectPath: payload.project.path_with_namespace,
        mrIid: payload.merge_request.iid,
        actor: actorLabel(payload),
      };
    }
  }
  return null;
}

function buildPrompt({ projectPath, mrIid, reason }) {
  return `Please handle merge request !${mrIid} in GitLab project "${projectPath}".
(Trigger: ${reason === 'assigned-as-reviewer' ? 'you were just assigned as reviewer' : 'you were mentioned in a comment on this MR'}.)

IMPORTANT — first check for an AGENTS.md or CLAUDE.md file at the repo root:
- If it exists, and it defines how to handle this situation (review, replying to
  mentions, specific skills/commands, comment/template format, approve/merge/resolve
  rules, etc.), follow it FULLY as top priority — ignore the generic steps below
  whenever they conflict.
- The generic steps below are only a fallback default, used when this repo has no
  AGENTS.md/CLAUDE.md, or when that file doesn't cover this specific situation.

Generic steps (fallback):
0. Write the review comment (and any replies) in English, regardless of
   what language this prompt or the MR/comments are in.
1. This is a code review, NOT QA — do not build or run the app/test suite
   (go build/test, npm test, phpunit, etc.). If you need to know the
   build/test status, check this MR's pipeline via GitLab MCP tools
   (list_merge_request_pipelines, get_pipeline, get_pipeline_job_output)
   from CI that already ran, instead of re-running it locally.
2. Fetch the diff and description of MR !${mrIid} via GitLab MCP tools.
3. Read the changes, checking context in this local repo if needed (read
   files, don't build/run them).
4. If there's an old discussion thread still open (from a previous review),
   check each one to see whether the concern has been CORRECTLY addressed in
   the latest diff. If so, resolve that thread. If you're not sure, or the
   fix isn't correct, do NOT resolve it — leave it open and mention it in the
   review.
5. Write a short, actionable, specific review (potential bugs, improvement
   suggestions, style notes).
6. Post that review as a comment on MR !${mrIid} via the GitLab MCP tool,
   not just printed to the terminal.
7. If this review (and the threads resolved above) genuinely found NO
   blocking major/high findings, approve this MR via the GitLab MCP tool.
   If there are blocking findings, or you're unsure, do NOT approve.`;
}

// Process a single trigger (from a webhook OR from the startup catch-up
// scan): resolve the local repo, check MCP is ready, then queue the review.
// Returns the review job's promise (so the caller can tell when it's
// done/succeeded), or null if it was skipped (repo not found / MCP not
// ready).
function processTrigger(trigger) {
  const { projectPath, mrIid, reason, actor } = trigger;
  const label = `MR !${mrIid} @ ${projectPath} (${reason}, by ${actor})`;

  const repoPath = repoResolver.resolve(projectPath);
  if (!repoPath) {
    logger.error(
      `Local repo for "${projectPath}" not found under ${config.reposRoot}. ` +
      `Make sure the repo is cloned and its "origin" remote points to this project.`
    );
    return null;
  }

  return checkMcpHealth(repoPath).then((health) => {
    if (!health.ok) {
      logger.error(`Skipping review "${label}" — GitLab MCP not ready at ${repoPath}: ${health.reason}`);
      return null;
    }

    return queueReview({
      claudeCodeBin: config.claudeCodeBin,
      repoPath,
      prompt: buildPrompt(trigger),
      timeoutMs: config.reviewTimeoutMs,
      label,
    });
  });
}

app.post('/webhook', async (req, res) => {
  if (req.headers['x-gitlab-token'] !== config.webhookSecret) {
    return res.status(401).send('Invalid token');
  }

  const trigger = shouldTrigger(req.body);
  if (!trigger) {
    logger.info(
      `Incoming webhook (${req.body.object_kind || 'unknown'}) from project ` +
      `"${req.body.project?.path_with_namespace || 'unknown'}" — ignored (doesn't match trigger criteria).`
    );
    return res.status(200).send('Ignored');
  }

  // Reply to GitLab quickly, keep processing in the background.
  res.status(200).send('Processing');

  logger.info(`Incoming webhook — trigger matched: MR !${trigger.mrIid} @ ${trigger.projectPath} (${trigger.reason}, by ${trigger.actor})`);
  processTrigger(trigger);
});

// Startup catch-up: when the server first starts, check for MRs that were
// already opened before (assigned as reviewer / mentioned) and haven't
// been handled yet — e.g. because the server was down when that event
// happened. Uses the GitLab Todos API, and only marks a todo "done" once
// the review has actually been processed successfully, so failed/skipped
// ones stay pending and get retried on the next startup.
async function runStartupCatchup() {
  if (!config.gitlabUrl || !config.gitlabToken) {
    logger.warn('GITLAB_URL/GITLAB_TOKEN not set — skipping startup catch-up scan.');
    return;
  }

  let todos;
  try {
    todos = await fetchPendingReviewTodos(config.gitlabUrl, config.gitlabToken);
  } catch (err) {
    logger.error(`Startup catch-up: failed to fetch pending GitLab todos: ${err.message}`);
    return;
  }

  if (todos.length === 0) {
    logger.info('Startup catch-up: no open MRs assigning/mentioning you that are still unhandled.');
    return;
  }

  logger.info(`Startup catch-up: found ${todos.length} MR(s) that need reviewing.`);

  for (const todo of todos) {
    logger.info(`Startup catch-up — trigger matched: MR !${todo.mrIid} @ ${todo.projectPath} (${todo.reason}, by ${todo.actor})`);

    const job = processTrigger({
      reason: todo.reason,
      projectPath: todo.projectPath,
      mrIid: todo.mrIid,
      actor: todo.actor,
    });

    if (job) {
      job
        .then((result) => {
          if (!result) return; // skipped along the way (health not ok), leave it pending
          return markTodoDone(config.gitlabUrl, config.gitlabToken, todo.todoId);
        })
        .catch((err) => {
          logger.error(`Startup catch-up: review failed for MR !${todo.mrIid} @ ${todo.projectPath}, leaving todo pending: ${err.message}`);
        });
    }
  }
}

app.get('/healthz', async (req, res) => {
  const repos = repoResolver.list();
  const entries = await Promise.all(
    Object.entries(repos).map(async ([projectPath, repoPath]) => {
      const health = await checkMcpHealth(repoPath);
      return [projectPath, { repoPath, ok: health.ok, reason: health.reason }];
    })
  );

  const reposHealth = Object.fromEntries(entries);
  const ok = entries.every(([, h]) => h.ok);

  res.json({ ok, reposIndexed: entries.length, repos: reposHealth });
});

app.listen(config.port, () => {
  logger.info(`Webhook server running on port ${config.port}`);
  logger.info(`Scanning repos in: ${config.reposRoot}`);

  if (config.enableNgrok) {
    startNgrokTunnel(config.port);
  }

  if (config.enableStartupCatchup) {
    runStartupCatchup();
  }
});
