#!/usr/bin/env node
/**
 * Run the client dev server and the LAN bridge together.
 *
 * Both are needed to play: the client serves the PWA with hot reload, the bridge
 * serves rooms and the relay at `/ws`. Running only the client used to leave
 * "Host LAN Match" dialling the Vite dev server, which accepts the WebSocket and
 * never answers — eight seconds later, "bridge handshake timed out". Starting
 * both is the fix that needs no remembering.
 *
 * Written by hand rather than with a task runner so the repo keeps its zero
 * extra-dependency posture for something this small.
 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const TASKS = [
  { name: 'client', args: ['run', 'dev', '-w', '@aerocade/client'], colour: '[36m' },
  { name: 'bridge', args: ['run', 'dev', '-w', '@aerocade/server'], colour: '[33m' },
];
const RESET = '[0m';

/** Prefix every line so two interleaved logs stay readable. */
function pipe(stream, name, colour) {
  let carry = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${colour}[${name}]${RESET} ${line}\n`);
  });
  stream.on('end', () => {
    if (carry !== '') process.stdout.write(`${colour}[${name}]${RESET} ${carry}\n`);
  });
}

const children = TASKS.map(({ name, args, colour }) => {
  const child = spawn(npm, args, { stdio: ['inherit', 'pipe', 'pipe'] });
  pipe(child.stdout, name, colour);
  pipe(child.stderr, name, colour);
  child.on('exit', (code, signal) => {
    // One dying makes the other useless, so take the whole thing down rather than
    // leaving a half-running setup that fails in a confusing way later.
    if (shuttingDown) return;
    process.stdout.write(`${colour}[${name}]${RESET} exited (${String(signal ?? code)})\n`);
    stop(code ?? 1);
  });
  return child;
});

let shuttingDown = false;
function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  // Give them a moment to go quietly before the process ends.
  setTimeout(() => process.exit(code), 300);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(0);
  });
}

process.stdout.write(
  '\nAerocade dev: client on http://localhost:5173, bridge on http://localhost:8080\n' +
    'Hosting a LAN match from the dev server works — the client looks for the bridge on 8080.\n\n',
);
