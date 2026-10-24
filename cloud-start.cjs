
'use strict';

// VeriMash temporary cloud demo startup.
// Runs two private Hardhat chains, deploys contracts,
// and launches the verification backend behind the public gateway.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { setState } = require('./cloud-gateway.cjs');

const ROOT = __dirname;
const HARDHAT = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'hardhat.cmd' : 'hardhat'
);

const childProcesses = [];
let stopping = false;

function child(name, cmd, args) {
  console.log(`[${name}] starting`);

  const env = {
    ...process.env,
    NODE_OPTIONS: '--import tsx/esm',
  };

  // IMPORTANT:
  // Render's PORT belongs to the public gateway.
  // The internal backend must use a different port.
  if (name === 'internal-api') {
    env.PORT = '4173';
  }

  const proc = spawn(cmd, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  childProcesses.push(proc);

  for (const [stream, level] of [
    [proc.stdout, 'log'],
    [proc.stderr, 'error'],
  ]) {
    stream.on('data', chunk => {
      const msg = String(chunk).trim();
      if (msg) console[level](`[${name}] ${msg.slice(0, 2400)}`);
    });
  }

  proc.on('error', error => {
    console.error(`[${name}]`, error.message);
  });

  proc.on('exit', code => {
    console.error(`[${name}] stopped (code ${code})`);

    if (!stopping) {
      setState('error', `${name} exited`);
      stop(1);
    }
  });

  return proc;
}

async function waitRpc(port, chainId, timeout = 120000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        }),
        signal: AbortSignal.timeout(2000),
      });

      const data = await response.json();

      if (parseInt(data.result, 16) === chainId) return;

      if (data.result) {
        throw Error(`Unexpected chain ID ${data.result} on ${port}`);
      }
    } catch (error) {
      if (error.message?.startsWith('Unexpected chain')) {
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw Error(`Blockchain on port ${port} did not become ready`);
}

function runDeployment() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [path.join(ROOT, 'chainproof-dashboard', 'scripts', 'deploy-dual.cjs')],
      {
        cwd: ROOT,
        env: process.env,
        stdio: 'inherit',
      }
    );

    proc.on('error', reject);

    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(Error(`Deployment exited with code ${code}`));
    });
  });
}

async function waitWeb(timeout = 60000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        'http://127.0.0.1:4173/api/status',
        { signal: AbortSignal.timeout(3000) }
      );

      if (response.ok) return;
    } catch (_) {}

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw Error('Verification backend did not become ready');
}

function stop(code) {
  if (stopping) return;

  stopping = true;

  for (const proc of childProcesses) {
    if (!proc.killed) proc.kill('SIGTERM');
  }

  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

async function main() {
  setState('starting', 'Starting Blockchain A and Blockchain B');

  child('chain-A', HARDHAT, [
    '--config', 'hardhat.config.cts',
    'node', '--hostname', '127.0.0.1', '--port', '8545',
  ]);

  child('chain-B', HARDHAT, [
    '--config', 'chainproof-dashboard/hardhat-chain-b.config.cts',
    'node', '--hostname', '127.0.0.1', '--port', '8546',
  ]);

  await Promise.all([
    waitRpc(8545, 31337),
    waitRpc(8546, 31338),
  ]);

  setState('deploying', 'Deploying local contracts');

  await runDeployment();

  setState('starting-api', 'Starting transaction backend');

  child('internal-api', process.execPath, [
    path.join(ROOT, 'chainproof-dashboard', 'server.cjs'),
  ]);

  await waitWeb();

  setState(
    'ready',
    'Demo ready. Blockchain history resets when Render sleeps or restarts.'
  );

  console.log(
    'VERIMASH READY: two local chains and restricted gateway'
  );
}

main().catch(error => {
  console.error('CLOUD STARTUP FAILED:', error);
  setState('error', error.message);
  stop(1);
});
