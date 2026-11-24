const { spawn } = require('node:child_process');
const https = require('node:https');
const { isIPv4 } = require('node:net');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

const EXECUTABLE = 'cloudflared-windows-amd64.exe';
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|"]|$)/i;
const STARTUP_TIMEOUT_MS = 60000;

async function verifyJoinPage(origin, signal) {
  function requestJoinPage(address) {
    // Keep the tunnel hostname for TLS and HTTP routing even when using a resolved address.
    const options = address ? {
      agent: false,
      family: 4,
      lookup: (_hostname, _options, callback) => callback(null, address, 4)
    } : {};
    return new Promise((resolve, reject) => {
      const request = https.get(`${origin}/play`, {
        ...options,
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)])
      }, async response => {
        try {
          if (response.statusCode !== 200) {
            response.resume();
            throw new Error(`Public join page returned HTTP ${response.statusCode}`);
          }
          let body = '';
          response.setEncoding('utf8');
          for await (const chunk of response) {
            body += chunk;
            if (body.includes('id="player-join"')) {
              resolve();
              return;
            }
            if (body.length > 64 * 1024) break;
          }
          reject(new Error('The public URL did not serve the TriviaShrimp join page'));
        } catch (error) {
          reject(error);
        }
      });
      request.once('error', reject);
    });
  }

  try {
    await requestJoinPage();
    return { usedFallbackDns: false };
  } catch (error) {
    if (signal.aborted || !['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) throw error;
    const hostname = new URL(origin).hostname;
    const response = await fetch(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Cloudflare DNS returned HTTP ${response.status}`);
    const records = await response.json();
    const address = records.Answer?.find(record => record.type === 1 && isIPv4(record.data))?.data;
    if (!address) throw new Error(`The tunnel hostname ${hostname} has no IPv4 DNS record yet`);
    await requestJoinPage(address);
    return { usedFallbackDns: true };
  }
}

function launchTunnel(origin, { onReady, onUnavailable }) {
  const child = spawn(path.join(__dirname, EXECUTABLE), ['tunnel', '--no-autoupdate', '--url', origin], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const controller = new AbortController();
  const { signal } = controller;
  let publicOrigin;
  let connectorError;
  let probeError;
  let probeAfter;
  let registered = false;
  let ready = false;
  const timeout = setTimeout(() => unavailable('the public join page did not become reachable within 60 seconds'), STARTUP_TIMEOUT_MS);

  function stop() {
    if (signal.aborted) return;
    controller.abort();
    clearTimeout(timeout);
    child.kill();
  }

  function unavailable(reason, retryable = true) {
    if (signal.aborted) return;
    stop();
    onUnavailable(reason, ready ? connectorError : probeError || connectorError, retryable && !ready);
  }

  async function checkJoinPage() {
    while (!signal.aborted) {
      try {
        if (registered || Date.now() >= probeAfter) {
          const result = await verifyJoinPage(publicOrigin, signal);
          if (signal.aborted) return;
          clearTimeout(timeout);
          ready = true;
          onReady(publicOrigin, result);
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        probeError = error.cause?.message || error.message;
      }
      await delay(1000, undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  }

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
      if (/\b(?:ERR|FTL)\b/.test(line)) connectorError = line;
      if (line.includes('Registered tunnel connection')) registered = true;
      if (publicOrigin || signal.aborted) return;
      const match = line.match(QUICK_TUNNEL_URL);
      if (match) {
        publicOrigin = match[0];
        probeAfter = Date.now() + 5000;
        void checkJoinPage();
      }
    });
  }
  child.once('error', error => {
    unavailable(error.code === 'ENOENT' ? `could not find ${EXECUTABLE} in the project folder` : error.message, false);
  });
  child.once('close', (code, exitSignal) => unavailable(`cloudflared exited (${exitSignal || code})`));
  return { stop };
}

function startQuickTunnel(origin, { onReady, onRetry, onUnavailable }) {
  let attempts = 0;
  let tunnel;
  let retry;
  let stopped = false;

  function launch() {
    attempts++;
    tunnel = launchTunnel(origin, {
      onReady,
      onUnavailable(reason, detail, retryable) {
        if (stopped) return;
        if (retryable && attempts < 2) {
          onRetry(reason, detail);
          retry = setTimeout(launch, 1500);
        } else {
          onUnavailable(reason, detail);
        }
      }
    });
  }

  launch();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      tunnel.stop();
    }
  };
}

module.exports = { startQuickTunnel };
