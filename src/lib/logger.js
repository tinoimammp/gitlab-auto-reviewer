// Color only when writing to a terminal — plain text when piped to a file,
// or when NO_COLOR is set.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const COLORS = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local time, e.g. "2026-10-05 16:35:26"
function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prefix(level) {
  if (!useColor) return `[${ts()}] [${level}]`;
  return `${DIM}[${ts()}]${RESET} ${COLORS[level]}[${level}]${RESET}`;
}

module.exports = {
  info: (...args) => console.log(prefix('INFO'), ...args),
  warn: (...args) => console.warn(prefix('WARN'), ...args),
  error: (...args) => console.error(prefix('ERROR'), ...args),
};
