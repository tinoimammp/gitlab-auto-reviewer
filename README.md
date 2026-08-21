# GitLab Auto-Reviewer

A webhook receiver that automatically triggers Claude Code (headless) to
review a GitLab Merge Request as soon as you're assigned as reviewer or
mentioned in an MR comment — no manual repo mapping needed, and it checks
that the MCP is ready before running.

## Structure

```
gitlab-auto-reviewer/
├── package.json
├── .env.example
├── README.md
└── src/
    ├── index.js          # entry point: webhook server (express)
    ├── config.js         # load & validate env vars
    └── lib/
        ├── logger.js       # timestamped logging
        ├── repoResolver.js # auto-detect local repo folder from git remote
        ├── mcpHealth.js    # health check for GitLab MCP before running a review
        ├── claudeReview.js # spawn Claude Code headless + per-repo queue
        ├── gitlabTodos.js  # GitLab Todos API, used for the startup catch-up scan
        └── ngrokTunnel.js  # auto-start an ngrok tunnel on npm start
```

## How it works

1. GitLab sends a webhook event (`merge_request` or `note`) to `/webhook`.
2. The server checks: were you just assigned as reviewer, or mentioned?
3. If so, the server looks for the matching local repo folder — by scanning
   `REPOS_ROOT`, reading each repo's `git remote get-url origin`, and
   matching it against `project.path_with_namespace` from the webhook
   payload. **No manual mapping needed**, as long as the repo is already
   cloned on the laptop/server and its `origin` remote actually points to
   that project.
4. The server checks that GitLab MCP is ready (`claude mcp list`), cached
   briefly so it doesn't spawn a process for every incoming webhook.
5. If everything's fine, the server runs `claude -p "<prompt>"` headless in
   that repo's folder. Claude Code takes care of fetching the MR diff and
   posting the review via GitLab MCP — exactly like your manual flow, just
   automated.

There's a simple per-repo-folder queue, so if two webhooks come in at the
same time for the same repo, the reviews run one after another — not in
conflict.

On startup, the server also runs a **catch-up scan**: it checks the GitLab
Todos API for any open MR that already assigned/mentioned you before this
server was running (e.g. while it was down), and reviews those too.

## Setup — from scratch

### 0. Prerequisites

- **Node.js 18+** (needs the built-in global `fetch`).
- **Claude Code CLI installed standalone** — the VS Code/IDE extension is
  not enough, this app spawns `claude -p "..."` as a headless child
  process, which the extension doesn't expose. Both can coexist:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude --version
  ```
- **ngrok CLI**, installed and logged in (needed so GitLab, which lives on
  the internet, can reach your local webhook server):
  ```bash
  brew install ngrok
  ngrok config add-authtoken <your-authtoken>   # get one at https://dashboard.ngrok.com/get-started/your-authtoken
  ```
- **A GitLab Personal Access Token** with `api` scope — GitLab
  **Settings → Access Tokens**. You'll use this token for both step 1 and
  the `.env` file.

### 1. Set up the GitLab MCP server

Claude Code needs a working GitLab MCP server so it can read MRs and post
comments/approvals headlessly. Register it once at **user scope** so it's
available in every repo (no need to repeat this per project):

```bash
claude mcp add gitlab --scope user -- npx -y @zereight/mcp-gitlab \
  --token=<YOUR_GITLAB_PERSONAL_ACCESS_TOKEN> \
  --api-url=<YOUR_GITLAB_URL>/api/v4
```

Verify it's connected (run from inside any of the repos under
`REPOS_ROOT`, or anywhere once it's registered at user scope):

```bash
claude mcp list
# gitlab: npx -y @zereight/mcp-gitlab --token=... --api-url=... - ✔ Connected
```

If a repo has its own project-level MCP config (a `.mcp.json`, or a
`local`-scope entry from `claude mcp add` run inside that repo folder
without `--scope user`), that takes precedence for that repo — the
user-scope one above is just the fallback that makes every other repo work
without per-repo setup.

### 2. Find your GitLab user ID

```bash
curl -s --header "PRIVATE-TOKEN: <YOUR_GITLAB_PERSONAL_ACCESS_TOKEN>" \
  "<YOUR_GITLAB_URL>/api/v4/user"
```

The `"id"` field in the response is your `TARGET_USER_ID` (used below).

### 3. Configure `.env`

```bash
cp .env.example .env
```

Then fill in:

- `WEBHOOK_SECRET` — any random string. Generate one with:
  ```bash
  openssl rand -hex 32
  ```
- `TARGET_USER_ID` — from step 2.
- `TARGET_USERNAME` — your GitLab username.
- `REPOS_ROOT` — the parent folder where all your local repo clones live
  (e.g. `/home/you/repos`).
- `GITLAB_URL` / `GITLAB_TOKEN` — same GitLab instance URL and personal
  access token used in step 1. Needed for the startup catch-up scan and
  for failure notifications.

The other vars (`PORT`, `CLAUDE_CODE_BIN`, `ENABLE_NGROK`,
`ENABLE_STARTUP_CATCHUP`, etc.) have sane defaults — see the comments in
`.env.example`.

### 4. Install & run

```bash
npm install
npm start
```

On startup the app will:

- Start the webhook server on `PORT` (default `3001`).
- Auto-start an ngrok tunnel (unless `ENABLE_NGROK=false`) and print the
  public URL + `/webhook` path in the logs.
- Run the startup catch-up scan for MRs you're already assigned to review
  or mentioned in (unless `ENABLE_STARTUP_CATCHUP=false`).

### 5. Register the webhook in GitLab

Copy the ngrok URL printed in the logs, e.g.:

```
[INFO] ngrok tunnel ready: https://xxxx.ngrok-free.dev
[INFO] Register the GitLab webhook to: https://xxxx.ngrok-free.dev/webhook
```

**This is a per-repo step, not a one-time setup.** Repeat it individually
for every single GitLab project you want auto-reviewed on — e.g. if you
have `group-a/service-one`, `group-a/service-two`, `group-b/frontend-app`,
etc., each one needs its own webhook registered. A project that's cloned
under `REPOS_ROOT` but has no webhook configured on GitLab will simply
never trigger a review — it'll never send anything to `/webhook` in the
first place.

For each such project, go to that project's **Settings → Webhooks** and
add:

- **URL**: the printed `.../webhook` URL above.
- **Secret Token**: same value as `WEBHOOK_SECRET`.
- **Trigger**: check **Merge request events** and **Comments**.

> On ngrok's free tier, the public URL changes every time you restart the
> app — you'll need to update the webhook URL on **every one of those
> projects** again after each restart, unless you're on a paid ngrok plan
> with a reserved domain.
>
> If your GitLab tier supports **group-level webhooks** (Settings →
> Webhooks at the group, not project, level — a GitLab Premium/Ultimate
> feature), you can register it once on the group instead of once per
> project, and it'll apply to every project underneath.

### 6. Verify

```bash
curl http://localhost:3001/healthz
```

Should return `"ok": true`, with every scanned repo showing
`"ok": true` for its GitLab MCP check.

## MUST-check before using this for real

- **Claude Code non-interactive flag**: `src/lib/claudeReview.js` runs
  `claude -p "<prompt>" --allowedTools <list of GitLab MCP tools>` so
  GitLab MCP tool calls (reading files/repo/branch/commit/MR/issue/pipeline,
  posting comments/replies, resolving threads, approving MRs, etc.) get
  auto-approved without waiting for manual confirmation — since a headless
  run has no one around to approve. The tool list (`ALLOWED_GITLAB_TOOLS`
  in that file) is read-only + comment/discussion/resolve/approve — it
  **does not** include merge, create/update/delete project/branch/issue/
  milestone, or triggering CI — those stay a human decision.
  - `resolve_merge_request_thread` and `approve_merge_request` are in the
    allowlist, but the prompt (`buildPrompt` in `src/index.js`) guards when
    they're actually used: resolve only if an old concern has genuinely
    been fixed correctly in the latest diff, approve only if there are no
    blocking major/high findings. If unsure, the model is instructed not
    to resolve/approve.
  - Repos whose AGENTS.md/CLAUDE.md explicitly says "advisory-only, never
    approve/resolve" (as some custom skills do) are still respected,
    because the prompt tells it to defer to AGENTS.md as top priority
    above these generic steps.
  - If a repo needs an extra tool (e.g. via a custom AGENTS.md skill), add
    its name to `ALLOWED_GITLAB_TOOLS`.
  - `DISALLOWED_TOOLS` in the same file explicitly blocks build/test/run
    commands (go build/test, npm test, phpunit, git worktree, etc.) — this
    is a code review, not QA, and build/test status should come from the
    existing CI pipeline (readable via the allowed pipeline tools) instead
    of re-running things locally.
- **`claude mcp list` format**: `lib/mcpHealth.js` parses this CLI's output
  heuristically (looking for a line containing "gitlab" with no
  error/failed/disconnected wording). Run it manually in a terminal first
  to see the actual output format on your Claude Code version, and adjust
  if it differs.
- **Repo auto-detect** only works if: the repo is actually cloned under
  `REPOS_ROOT`, and its `origin` remote points exactly to the same GitLab
  project (via SSH or HTTPS). If two local folders turn out to have the
  same remote, the first one found during the scan is used — logged as a
  warning.
- **Comment identity**: review results get posted using whichever GitLab
  account your GitLab MCP is authenticated as, not a separate bot account.
