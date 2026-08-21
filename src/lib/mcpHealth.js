/**
 * Check whether the GitLab MCP server is ready to use before we actually
 * run Claude Code for a review.
 *
 * NOTE: the Claude Code CLI's command & output format ("claude mcp list")
 * can change between versions. Before using this in production, run
 * `claude mcp list` manually in a terminal to see exactly what the format
 * looks like, then adjust parseHealthFromOutput() below. Also check
 * docs.claude.com/en/docs/claude-code for the latest official approach.
 */
const { execFile } = require('child_process');
const logger = require('./logger');

function parseHealthFromOutput(output, serverName) {
  const lines = output.split('\n').filter((l) => l.toLowerCase().includes(serverName.toLowerCase()));
  if (lines.length === 0) return { ok: false, reason: `Server "${serverName}" doesn't show up in "claude mcp list"` };

  const badSignals = ['error', 'failed', 'disconnected', 'unreachable'];
  const hasBadSignal = lines.some((l) => badSignals.some((sig) => l.toLowerCase().includes(sig)));

  if (hasBadSignal) {
    return { ok: false, reason: `MCP status for "${serverName}" looks broken: ${lines.join(' | ')}` };
  }
  return { ok: true, reason: lines.join(' | ') };
}

function checkMcpHealth(claudeCodeBin, serverName = 'gitlab', cwd) {
  return new Promise((resolve) => {
    execFile(claudeCodeBin, ['mcp', 'list'], { timeout: 15000, cwd }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, reason: `Failed to run "${claudeCodeBin} mcp list": ${stderr || err.message}` });
        return;
      }
      resolve(parseHealthFromOutput(stdout, serverName));
    });
  });
}

/**
 * Wrapper with a short per-repo-folder cache, so we don't spawn an
 * "mcp list" process for every webhook that comes in back-to-back for the
 * same repo. Cached per "cwd" because the MCP server can be configured
 * differently per project (project-level .mcp.json), so results can differ
 * between repos.
 */
function createMcpHealthChecker(claudeCodeBin, cacheMs, serverName = 'gitlab') {
  const cache = new Map(); // cwd -> { result, cachedAt }

  return async function check(cwd) {
    const now = Date.now();
    const entry = cache.get(cwd);
    if (entry && now - entry.cachedAt < cacheMs) return entry.result;

    const result = await checkMcpHealth(claudeCodeBin, serverName, cwd);
    cache.set(cwd, { result, cachedAt: now });

    if (!result.ok) logger.warn(`MCP health check failed${cwd ? ` (${cwd})` : ''}: ${result.reason}`);
    return result;
  };
}

module.exports = { createMcpHealthChecker };
