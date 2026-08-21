/**
 * Scan the parent folder of local repos, matching each repo to its
 * GitLab project via `git remote get-url origin`, with no manual mapping
 * needed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('./logger');

/**
 * Turn a git remote URL (ssh or https) into "namespace/repo" (lowercase),
 * so it can be matched against project.path_with_namespace from the
 * webhook payload.
 *   git@gitlab.com:group/sub/project.git      -> group/sub/project
 *   https://gitlab.com/group/sub/project.git  -> group/sub/project
 */
function remoteUrlToPath(remoteUrl) {
  let cleaned = remoteUrl.trim().replace(/\.git$/, '');
  const sshMatch = cleaned.match(/^[^@]+@[^:]+:(.+)$/); // git@host:namespace/repo
  if (sshMatch) return sshMatch[1].toLowerCase();

  try {
    const u = new URL(cleaned);
    return u.pathname.replace(/^\//, '').toLowerCase();
  } catch {
    return null;
  }
}

function findGitDirs(rootDir, maxDepth = 3) {
  const results = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn(`Can't read folder ${dir}: ${err.message}`);
      return;
    }

    if (entries.some((e) => e.isDirectory() && e.name === '.git')) {
      results.push(dir);
      return; // already found a git repo, no need to go deeper
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(rootDir, 0);
  return results;
}

/**
 * Build the index: { "group/repo": "/abs/path/to/folder" }
 */
function buildRepoIndex(reposRoot) {
  const index = {};
  const gitDirs = findGitDirs(reposRoot);

  for (const dir of gitDirs) {
    let remoteUrl;
    try {
      remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
    } catch {
      logger.warn(`Repo at ${dir} has no "origin" remote, skipping.`);
      continue;
    }

    const projectPath = remoteUrlToPath(remoteUrl);
    if (!projectPath) {
      logger.warn(`Couldn't parse remote URL "${remoteUrl}" at ${dir}, skipping.`);
      continue;
    }

    if (index[projectPath] && index[projectPath] !== dir) {
      logger.warn(
        `Project "${projectPath}" found in two local folders (${index[projectPath]} and ${dir}). Using the first one found.`
      );
      continue;
    }

    index[projectPath] = dir;
  }

  logger.info(`Repo index built: ${Object.keys(index).length} repo(s) found in ${reposRoot}`);
  return index;
}

/**
 * Wrapper that keeps an in-memory index and refreshes it periodically,
 * so we don't need to re-scan the filesystem on every incoming webhook.
 */
function createRepoResolver(reposRoot, refreshMs) {
  let index = buildRepoIndex(reposRoot);
  setInterval(() => {
    index = buildRepoIndex(reposRoot);
  }, refreshMs).unref();

  return {
    resolve(projectPath) {
      const key = projectPath.toLowerCase();
      return index[key] || null;
    },
    list() {
      return { ...index };
    },
    forceRefresh() {
      index = buildRepoIndex(reposRoot);
    },
  };
}

module.exports = { createRepoResolver, remoteUrlToPath };
