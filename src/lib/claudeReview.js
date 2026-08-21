const { execFile } = require('child_process');
const logger = require('./logger');

// Simple per-repoPath queue, so two Claude Code jobs never run at the
// same time in the same folder.
const queues = new Map();

// Read-only GitLab MCP tools (file, repo tree, branch, commit, MR, issue,
// pipeline) plus comment/discussion/resolve/approve, auto-approved for
// headless runs. Deliberately does NOT include merge, create/update/delete
// project/branch/issue/milestone, or triggering CI — those stay a human
// decision. The prompt (see buildPrompt in index.js) decides when
// resolve/approve are actually used, and repos whose AGENTS.md says
// "never approve/resolve" (advisory-only) are still respected, because the
// prompt instructs deferring to AGENTS.md above the generic fallback.
const ALLOWED_GITLAB_TOOLS = [
  // File & repo (reading code outside the diff for context)
  'get_file_contents',
  'get_repository_tree',
  'search_repositories',
  // Branch & commit (read-only)
  'get_branch',
  'list_branches',
  'list_commits',
  'get_commit',
  'get_commit_diff',
  'get_file_blame',
  'list_commit_statuses',
  'list_protected_branches',
  'get_protected_branch',
  'get_branch_diffs',
  // Merge request (read-only)
  'get_merge_request',
  'get_merge_request_diffs',
  'list_merge_request_changed_files',
  'list_merge_request_diffs',
  'get_merge_request_file_diff',
  'list_merge_request_versions',
  'get_merge_request_version',
  'list_merge_requests',
  'get_merge_request_conflicts',
  'list_merge_request_pipelines',
  'get_merge_request_approval_state',
  // Discussion / comment / resolve / approve
  'mr_discussions',
  'create_merge_request_note',
  'get_merge_request_note',
  'get_merge_request_notes',
  'create_merge_request_discussion_note',
  'create_merge_request_thread',
  'resolve_merge_request_thread',
  'approve_merge_request',
  'unapprove_merge_request',
  // Issue (read-only, for context on issues referenced by the MR)
  'get_issue',
  'list_issues',
  'my_issues',
  'list_issue_links',
  'list_issue_discussions',
  'get_issue_link',
  // Project & user (read-only)
  'get_project',
  'list_project_members',
  'get_users',
  // Pipeline (read-only, to check CI status/failure reasons)
  'list_pipelines',
  'get_pipeline',
  'list_pipeline_jobs',
  'get_pipeline_job',
  'get_pipeline_job_output',
].map((tool) => `mcp__gitlab__${tool}`);

// Besides MCP, allow local git fetch (read-only, grabbing the latest refs
// before reading files/diffs) — the same pattern already used in some
// repos' project settings.
const ALLOWED_TOOLS = [...ALLOWED_GITLAB_TOOLS, 'Bash(git fetch *)'];

// This review only reads the diff + code, it does NOT need to build or
// run the app or test suite — build/test status is already covered by the
// GitLab CI pipeline (readable via mcp__gitlab__list_merge_request_pipelines
// etc. above). Explicitly denied (not just "not allowed") so it's skipped
// right away instead of getting stuck waiting for an approval that will
// never come in a headless run.
const DISALLOWED_TOOLS = [
  'Bash(git worktree*)',
  'Bash(go build*)',
  'Bash(go vet*)',
  'Bash(go test*)',
  'Bash(npm test*)',
  'Bash(npm run build*)',
  'Bash(npm run test*)',
  'Bash(yarn test*)',
  'Bash(yarn build*)',
  'Bash(pnpm test*)',
  'Bash(pnpm build*)',
  'Bash(composer test*)',
  'Bash(php artisan test*)',
  'Bash(php artisan migrate*)',
  'Bash(php artisan db:*)',
  'Bash(vendor/bin/phpunit*)',
  'Bash(./vendor/bin/phpunit*)',
  'Bash(pytest*)',
  'Bash(make test*)',
  'Bash(make build*)',
];

function runClaudeCode(claudeCodeBin, repoPath, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      claudeCodeBin,
      [
        '-p', prompt,
        '--allowedTools', ALLOWED_TOOLS.join(','),
        '--disallowedTools', DISALLOWED_TOOLS.join(','),
      ],
      { cwd: repoPath, maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

function queueReview({ claudeCodeBin, repoPath, prompt, timeoutMs, label }) {
  const prev = queues.get(repoPath) || Promise.resolve();

  const job = prev
    .catch(() => {}) // previous job failed, still move on to the next one
    .then(() => {
      logger.info(`Starting review: ${label} (repo: ${repoPath})`);
      return runClaudeCode(claudeCodeBin, repoPath, prompt, timeoutMs);
    })
    .then((output) => {
      logger.info(`Finished review: ${label}`);
      logger.info(output);
    })
    .catch((err) => {
      logger.error(`Review failed: ${label} — ${err.message}`);
    });

  queues.set(repoPath, job);
  return job;
}

module.exports = { queueReview };
