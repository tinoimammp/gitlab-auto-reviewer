const { spawn } = require('child_process');
const logger = require('./logger');

async function waitForPublicUrl(retries = 20, delayMs = 500) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (res.ok) {
        const data = await res.json();
        const tunnel = data.tunnels?.find((t) => t.proto === 'https') || data.tunnels?.[0];
        if (tunnel) return tunnel.public_url;
      }
    } catch (_) {
      // local ngrok API not ready yet, try again
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('timed out waiting for the ngrok API to be ready at 127.0.0.1:4040');
}

// Starts the tunnel and returns a promise of its public URL (or null if it
// couldn't be fetched). With `domain` (e.g. your free ngrok static domain,
// "xxx.ngrok-free.app"), the URL stays the same across restarts.
function startNgrokTunnel(port, domain) {
  const args = ['http', String(port), '--log=stdout', '--log-format=json'];
  if (domain) args.push(`--url=${domain.startsWith('http') ? domain : `https://${domain}`}`);

  const proc = spawn('ngrok', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.on('error', (err) => {
    logger.error(`Failed to run ngrok — make sure the CLI is installed (brew install ngrok): ${err.message}`);
  });

  proc.stderr.on('data', (chunk) => {
    logger.error(`[ngrok] ${chunk.toString().trim()}`);
  });

  process.on('exit', () => {
    proc.kill();
  });

  return waitForPublicUrl()
    .then((url) => {
      logger.info(`ngrok tunnel ready: ${url}`);
      return url;
    })
    .catch((err) => {
      logger.error(`Couldn't fetch the ngrok URL: ${err.message}`);
      return null;
    });
}

module.exports = { startNgrokTunnel };
