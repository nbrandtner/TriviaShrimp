const http = require('node:http');
const os = require('node:os');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game, TOKEN_PATTERN } = require('./game');
const { loadQuestions } = require('./questions');
const { serveMedia } = require('./media');
const { startQuickTunnel } = require('./tunnel');

const assets = {
  '/': ['player.html', 'text/html'],
  '/play': ['player.html', 'text/html'],
  '/tv': ['tv.html', 'text/html'],
  '/host': ['host.html', 'text/html'],
  '/host.js': ['host.js', 'text/javascript'],
  '/tv.js': ['tv.js', 'text/javascript'],
  '/player.js': ['player.js', 'text/javascript'],
  '/common.js': ['common.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/inter.woff2': ['inter.woff2', 'font/woff2'],
  '/inter-OFL.txt': ['inter-OFL.txt', 'text/plain']
};

function validOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a full URL beginning with http:// or https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use just the HTTP(S) address, without a path, query, or credentials.');
  }
  return url.origin;
}

function localAddresses() {
  const interfaces = Object.values(os.networkInterfaces()).flat();
  return interfaces.filter(address => address.family === 'IPv4' && !address.internal &&
    !address.address.startsWith('169.254.')).map(address => address.address);
}

function portFromEnv(name, fallback) {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number from 1 to 65535.`);
  }
  return port;
}

function createApp({ pack, lanOrigin, publicOrigin, localPublicOrigin }) {
  const game = new Game(pack, `${publicOrigin || lanOrigin}/play`, `${lanOrigin}/play`, `${localPublicOrigin}/tv`, broadcast);
  const images = new Map([...(pack.media?.values() ?? [])]
    .filter(asset => asset.type.startsWith('image/')).map(asset => [asset.url, asset]));
  let cachedQr;

  function localHostRequest({ host, origin }, port) {
    const address = `127.0.0.1:${port}`;
    return host === address && (!origin || origin === `http://${address}`);
  }

  function localTVRequest(headers, port, address) {
    if (address !== '127.0.0.1') return false;
    if (['cf-ray', 'cf-connecting-ip', 'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']
      .some(header => headers[header] !== undefined)) return false;
    const { host, origin } = headers;
    return (host === `127.0.0.1:${port}` || host === `localhost:${port}`) && (!origin || origin === `http://${host}`);
  }

  function serve(isHost) {
    return http.createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (isHost && !localHostRequest(request.headers, request.socket.localPort)) {
        response.writeHead(403).end('Open the host URL printed by the server.');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      let pathname = request.url.split('?')[0];
      if (isHost && pathname === '/') pathname = '/host';
      if (pathname.startsWith('/media/')) {
        const asset = images.get(pathname) || (!isHost &&
          localTVRequest(request.headers, request.socket.localPort, request.socket.remoteAddress) && game.audioFor(pathname));
        if (asset) await serveMedia(request, response, asset);
        else response.writeHead(404).end('Media file not found.');
        return;
      }
      if (!isHost && pathname === '/qr.png') {
        try {
          if (cachedQr?.url !== game.joinUrl) {
            const url = game.joinUrl;
            cachedQr = { url, image: QRCode.toBuffer(url, { width: 480, margin: 4, errorCorrectionLevel: 'M' }) };
          }
          const image = await cachedQr.image;
          response.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
        } catch {
          response.writeHead(500).end('The QR code could not be generated.');
        }
        return;
      }
      const hostOnly = pathname === '/host' || pathname === '/host.js';
      const publicOnly = ['/', '/play', '/tv', '/tv.js', '/player.js'].includes(pathname);
      const asset = Object.hasOwn(assets, pathname) && assets[pathname];
      if (!asset || (hostOnly && !isHost) || (publicOnly && isHost)) {
        response.writeHead(404).end('Page not found.');
        return;
      }
      try {
        const [filename, type] = asset;
        const contents = await fs.promises.readFile(path.join(__dirname, 'public', filename));
        const contentType = type.startsWith('text/') ? `${type}; charset=utf-8` : type;
        response.writeHead(200, { 'Content-Type': contentType }).end(contents);
      } catch {
        response.writeHead(500).end('The page could not be loaded.');
      }
    });
  }

  const publicServer = serve(false);
  publicServer.once('close', () => {
    game.stopTimer();
    game.stopClip();
  });
  const hostServer = serve(true);
  const publicIO = new Server(publicServer, { maxHttpBufferSize: 8192 });
  const hostIO = new Server(hostServer, {
    maxHttpBufferSize: 8192,
    allowRequest(request, done) {
      done(null, localHostRequest(request.headers, request.socket.localPort));
    }
  });

  function broadcast() {
    for (const socket of hostIO.sockets.sockets.values()) {
      socket.emit('state', game.snapshot('host'));
    }
    for (const socket of publicIO.sockets.sockets.values()) {
      socket.emit('state', game.snapshot(socket.data.role, socket.data.token));
    }
  }

  function setJoinOrigin(origin, expectedUrl) {
    if (expectedUrl && game.joinUrl !== expectedUrl) return false;
    const url = origin ? `${validOrigin(origin)}/play` : game.lanUrl;
    game.control('setJoinUrl', { url });
    return true;
  }

  function handle(socket, event, action) {
    socket.on(event, (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        action(payload);
        ack({ ok: true });
        broadcast();
      } catch (error) {
        ack({ ok: false, error: error.message });
      }
    });
  }

  hostIO.on('connection', socket => {
    socket.emit('state', game.snapshot('host'));
    handle(socket, 'host:control', ({ action, ...data }) => {
      if (action === 'setJoinUrl') {
        setJoinOrigin(data.origin);
      } else if (action === 'playClip') {
        const round = game.clipToPlay(data.roundId, data.buzzerVersion);
        const states = [...publicIO.sockets.sockets.values()];
        const tv = states.findLast(client => client.data.role === 'localTV');
        if (!tv) throw new Error('Open the local TV screen first.');
        tv.emit('tv:playClip', round.id, round.buzzerVersion);
      } else {
        game.control(action, data);
      }
    });
  });

  publicIO.on('connection', socket => {
    const { role, token } = socket.handshake.auth;
    const localTV = role === 'tv' &&
      localTVRequest(socket.handshake.headers, publicServer.address()?.port, socket.handshake.address);
    socket.data.role = localTV ? 'localTV' : role === 'tv' ? 'tv' : 'player';
    socket.data.token = socket.data.role === 'player' && typeof token === 'string' && TOKEN_PATTERN.test(token)
      ? token : undefined;
    game.resume(socket.data.token, socket.id);
    broadcast();

    socket.on('host:control', (_data, ack) => {
      if (typeof ack === 'function') ack({ ok: false, error: 'Host controls are available on the laptop only.' });
    });
    if (socket.data.role === 'player') {
      handle(socket, 'player:join', ({ nickname }) => game.join(socket.data.token, nickname, socket.id));
      handle(socket, 'player:submit', data => game.submit(socket.data.token, data));
      handle(socket, 'player:buzz', data => game.buzz(socket.data.token, data));
    }
    if (localTV) {
      handle(socket, 'tv:clipStarted', ({ roundId, version }) => game.startClip(roundId, version, socket.id));
      handle(socket, 'tv:clipPaused', ({ roundId, version, position }) =>
        game.saveClipPosition(roundId, version, socket.id, position));
      handle(socket, 'tv:clipFinished', ({ roundId, version }) => {
        if (!game.finishClip(roundId, version, socket.id)) throw new Error('That clip has ended.');
      });
      socket.on('tv:clipBlocked', payload => {
        const round = game.round;
        if (round && round.id === payload?.roundId && round.buzzerVersion === payload.version && game.clipReady(round)) {
          hostIO.emit('host:clipBlocked');
        }
      });
    } else {
      for (const event of ['tv:clipStarted', 'tv:clipPaused', 'tv:clipFinished']) {
        socket.on(event, (_data, ack) => {
          if (typeof ack === 'function') ack({ ok: false, error: 'Song playback requires the local TV screen.' });
        });
      }
    }
    socket.on('disconnect', () => {
      game.disconnect(socket.data.token, socket.id);
      if (localTV && game.round?.playback) game.finishClip(game.round.id, game.round.playback.version, socket.id);
      broadcast();
    });
  });

  return {
    publicServer, hostServer, publicIO, hostIO,
    setJoinOrigin(origin, expectedUrl) {
      if (!setJoinOrigin(origin, expectedUrl)) return false;
      broadcast();
      return true;
    }
  };
}

function listen(server, port, hostname) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function start() {
  const useTunnel = process.argv.includes('--tunnel');
  const useConfiguredOrigin = !useTunnel && !process.argv.includes('--local');
  const port = portFromEnv('PORT', 3000);
  const hostPort = portFromEnv('HOST_PORT', 3001);
  if (port === hostPort) throw new Error('PORT and HOST_PORT must be different.');
  const addresses = localAddresses();
  const lanIp = process.env.LAN_IP || addresses[0] || '127.0.0.1';
  if (!net.isIPv4(lanIp)) throw new Error('LAN_IP must be an IPv4 address, for example 192.168.1.42.');
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  const localPublicOrigin = `http://127.0.0.1:${port}`;
  const lanOrigin = `http://${lanIp}:${port}`;
  const publicOrigin = useConfiguredOrigin && process.env.PUBLIC_JOIN_URL ? validOrigin(process.env.PUBLIC_JOIN_URL) : '';
  const app = createApp({ pack: loadQuestions(), lanOrigin, publicOrigin, localPublicOrigin });
  try {
    await listen(app.hostServer, hostPort, '127.0.0.1');
    await listen(app.publicServer, port, '0.0.0.0');
  } catch (error) {
    await Promise.all([app.publicIO.close(), app.hostIO.close()]);
    throw error;
  }
  let tunnel;
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    tunnel?.stop();
    await Promise.all([app.publicIO.close(), app.hostIO.close()]);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => tunnel?.stop());

  console.log(`Host  ${hostOrigin}/host`);
  console.log(`TV    ${localPublicOrigin}/tv`);
  if (useTunnel) {
    console.log('Starting Cloudflare Quick Tunnel. Wait for the Join link before sharing the QR code.');
    let tunnelOrigin;
    tunnel = startQuickTunnel(localPublicOrigin, {
      onReady(origin, { usedFallbackDns }) {
        tunnelOrigin = origin;
        if (app.setJoinOrigin(origin, `${lanOrigin}/play`)) {
          console.log(`Join  ${origin}/play`);
          if (usedFallbackDns) console.log('Verified using Cloudflare DNS. Try the join link on a phone before sharing.');
        }
      },
      onRetry(reason, detail) {
        console.warn(`Quick Tunnel attempt failed: ${reason}. Requesting a new URL…`);
        if (detail) console.warn(detail);
      },
      onUnavailable(reason, detail) {
        const usingLan = app.setJoinOrigin('', `${tunnelOrigin || lanOrigin}/play`);
        console.warn(`Quick Tunnel unavailable: ${reason}.`);
        if (detail) console.warn(detail);
        if (usingLan) console.log(`Local Wi-Fi join  ${lanOrigin}/play`);
      }
    });
  } else {
    console.log(`Join  ${publicOrigin || lanOrigin}/play`);
  }
  if (addresses.length > 1 && !process.env.LAN_IP) {
    console.log(`Detected IPv4 addresses: ${addresses.join(', ')}. Set LAN_IP if the join address uses the wrong adapter.`);
  }
}

if (require.main === module) {
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp, listen };
