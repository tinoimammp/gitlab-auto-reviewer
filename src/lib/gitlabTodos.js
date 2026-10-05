/**
 * Startup catch-up: uses the GitLab Todos API to find MRs that already
 * assigned you as reviewer or mentioned you before this server started
 * (e.g. while the server was down). The Todos API automatically covers
 * both cases without having to scan every MR one by one.
 */
const REASON_BY_ACTION = {
  review_requested: 'assigned-as-reviewer',
  mentioned: 'mentioned-in-comment',
  directly_addressed: 'mentioned-in-comment',
};

function actorLabel(user) {
  if (!user) return 'unknown';
  return user.username ? `${user.name} (@${user.username})` : user.name || 'unknown';
}

async function fetchPendingReviewTodos(gitlabUrl, gitlabToken) {
  const url = `${gitlabUrl.replace(/\/$/, '')}/api/v4/todos?state=pending&per_page=100`;
  const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': gitlabToken } });
  if (!res.ok) {
    throw new Error(`GitLab API ${res.status}: ${await res.text()}`);
  }
  const todos = await res.json();

  return todos
    .filter(
      (t) =>
        t.target_type === 'MergeRequest' &&
        REASON_BY_ACTION[t.action_name] &&
        t.target?.state === 'opened'
    )
    .map((t) => ({
      todoId: t.id,
      projectPath: t.project.path_with_namespace,
      mrIid: t.target.iid,
      reason: REASON_BY_ACTION[t.action_name],
      actor: actorLabel(t.author),
      actorUsername: t.author?.username,
    }));
}

async function markTodoDone(gitlabUrl, gitlabToken, todoId) {
  const url = `${gitlabUrl.replace(/\/$/, '')}/api/v4/todos/${todoId}/mark_as_done`;
  const res = await fetch(url, { method: 'POST', headers: { 'PRIVATE-TOKEN': gitlabToken } });
  if (!res.ok) {
    throw new Error(`GitLab API ${res.status}: ${await res.text()}`);
  }
}

/**
 * Mark every pending review/mention todo for one MR as done — used after
 * a review succeeds (from a webhook or the catch-up scan), so the next
 * startup's catch-up scan doesn't review the same MR again. Covers the
 * case where one MR has several todos (e.g. assigned + mentioned).
 */
async function markMrTodosDone(gitlabUrl, gitlabToken, projectPath, mrIid) {
  const todos = await fetchPendingReviewTodos(gitlabUrl, gitlabToken);
  const matching = todos.filter(
    (t) => t.projectPath.toLowerCase() === projectPath.toLowerCase() && String(t.mrIid) === String(mrIid)
  );
  for (const t of matching) {
    await markTodoDone(gitlabUrl, gitlabToken, t.todoId);
  }
  return matching.length;
}

module.exports = { fetchPendingReviewTodos, markTodoDone, markMrTodosDone };
