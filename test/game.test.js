const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, writeFileSync, rmSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { io } = require('socket.io-client');
const { createApp, listen } = require('../server');
const { loadQuestions } = require('../questions');
const { Game } = require('../game');

const oldPack = join(__dirname, '..', 'question-pack.json.old');

async function fixture(t, pack = loadQuestions(oldPack)) {
  const app = createApp({
    pack,
    lanOrigin: 'http://192.168.1.42:3000',
    localPublicOrigin: 'http://127.0.0.1:3000'
  });
  t.after(() => Promise.all([app.publicIO.close(), app.hostIO.close()]));
  await Promise.all([listen(app.hostServer, 0, '127.0.0.1'), listen(app.publicServer, 0, '127.0.0.1')]);
  const hostPort = app.hostServer.address().port;
  const publicUrl = `http://127.0.0.1:${app.publicServer.address().port}`;

  async function connect(auth, host = false, extraHeaders) {
    const socket = io(host ? `http://127.0.0.1:${hostPort}` : publicUrl, {
      auth, extraHeaders, forceNew: true, autoConnect: false, reconnection: false
    });
    t.after(() => socket.disconnect());
    socket.on('state', state => { socket.state = state; });
    const ready = new Promise((resolve, reject) => {
      socket.once('state', resolve);
      socket.once('connect_error', error => reject(new Error(error.message + ' ' + error.description)));
    });
    socket.connect();
    await ready;
    return socket;
  }

  return { connect, publicUrl, hostPort };
}

function send(socket, event, payload) {
  return socket.timeout(1500).emitWithAck(event, payload);
}

async function stateMatching(socket, predicate) {
  if (socket.state && predicate(socket.state)) return socket.state;
  const signal = AbortSignal.timeout(1800);
  while (!signal.aborted) {
    const [state] = await once(socket, 'state', { signal });
    if (predicate(state)) return state;
  }
}

function control(host, action, data = {}) {
  const { id: roundId, buzzerVersion } = host.state.round ?? {};
  return send(host, 'host:control', { action, roundId, buzzerVersion, ...data });
}

function clipEvent(tv, event, round, data = {}) {
  return send(tv, `tv:clip${event}`, { roundId: round.id, version: round.clip.version, ...data });
}

async function ok(promise) {
  assert.deepEqual(await promise, { ok: true });
}

test('lobby and quiz run end to end with separate public state and reconnecting players', { timeout: 15000 }, async t => {
  const { connect, publicUrl, hostPort } = await fixture(t);
  const host = await connect({}, true);
  const tv = await connect({ role: 'tv' });
  const firstToken = randomBytes(32).toString('hex');
  const firstAuth = { role: 'player', token: firstToken };
  const first = await connect(firstAuth);
  const second = await connect({ token: randomBytes(32).toString('hex') });
  const intruder = await connect({ role: 'host' });
  assert.equal(tv.state.created, false);
  assert.equal((await send(first, 'player:join', { nickname: 'Alex' })).ok, false);
  assert.equal((await control(intruder, 'create')).ok, false);
  const responses = await Promise.all(['/play', '/tv', '/qr.png', '/host', '/host.js', '/question-pack.json']
    .map(route => fetch(publicUrl + route)));
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 404, 404, 404]);
  assert.equal(responses[2].headers.get('content-type'), 'image/png');
  const crossSite = { headers: { Origin: 'https://quiz-example.trycloudflare.com' } };
  assert.equal((await fetch(`http://127.0.0.1:${hostPort}/tv`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${hostPort}/host`, crossSite)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${hostPort}/socket.io/?EIO=4&transport=polling`, crossSite)).status, 403);

  await ok(control(host, 'create'));
  await ok(send(first, 'player:join', { nickname: 'Alex' }));
  assert.equal((await send(second, 'player:join', { nickname: 'alex' })).ok, false);
  await ok(send(second, 'player:join', { nickname: 'Sam' }));
  await stateMatching(tv, state => state.players.length === 2);
  assert.equal(tv.state.joinUrl, 'http://192.168.1.42:3000/play');
  assert.equal(Object.hasOwn(tv.state, 'questions'), false);

  await ok(control(host, 'setJoinUrl', { origin: 'https://quiz-example.trycloudflare.com' }));
  await stateMatching(tv, state => state.joinUrl.startsWith('https:'));
  assert.equal(tv.state.joinUrl, 'https://quiz-example.trycloudflare.com/play');
  const publicQr = await (await fetch(publicUrl + '/qr.png')).arrayBuffer();
  await ok(control(host, 'setJoinUrl', { origin: '' }));
  const lanQr = await (await fetch(publicUrl + '/qr.png')).arrayBuffer();
  assert.notDeepEqual(publicQr, lanQr);

  await ok(control(host, 'select', { questionId: 'quiz-octopus' }));
  const { id } = (await stateMatching(host, state => state.round?.phase === 'open')).round;
  await stateMatching(tv, state => state.round?.phase === 'open');
  assert.equal(host.state.round.correctIndex, 2);
  assert.equal(Object.hasOwn(tv.state.round, 'correctIndex'), false);
  assert.equal(Object.hasOwn(tv.state.round, 'explanation'), false);
  assert.equal(host.state.round.durationSeconds, 30);
  assert.ok(tv.state.round.timer.remainingMs > 0 && tv.state.round.timer.remainingMs <= 30000);
  await ok(send(first, 'player:submit', { roundId: id, choice: 0 }));
  const open = await stateMatching(tv, state => state.round?.submitted === 1);
  assert.ok(open.round.timer.remainingMs > 0 && open.round.timer.remainingMs <= 30000);
  assert.equal((await control(intruder, 'pauseTimer', { roundId: id })).ok, false);
  await ok(control(host, 'pauseTimer'));
  const paused = await stateMatching(tv, state => state.round?.timer?.paused);
  assert.equal(paused.round.phase, 'open');
  await ok(send(first, 'player:submit', { roundId: id, choice: 2 }));
  const revised = await stateMatching(first, state => state.round?.choice === 2);
  assert.equal(revised.round.submitted, 1);
  assert.deepEqual(revised.round.timer, paused.round.timer);
  assert.equal((await send(second, 'player:submit', { roundId: 'old-round', choice: 0 })).ok, false);
  await ok(send(second, 'player:submit', { roundId: id, choice: 0 }));
  await stateMatching(first, state => state.round?.choice === 2);
  first.disconnect();
  await stateMatching(host, state => state.players.find(player => player.name === 'Alex')?.online === false);
  const refreshed = await connect(firstAuth);
  assert.equal(refreshed.state.self.name, 'Alex');
  assert.equal(refreshed.state.round.choice, 2);
  assert.deepEqual(refreshed.state.round.timer, paused.round.timer);
  assert.equal(Object.hasOwn(refreshed.state.round, 'correctIndex'), false);

  assert.equal((await control(intruder, 'reveal', { roundId: id })).ok, false);
  assert.equal((await control(host, 'reveal')).ok, false);
  await ok(control(host, 'resumeTimer'));
  const resumed = await stateMatching(tv, state => state.round?.timer?.paused === false);
  assert.ok(resumed.round.timer.remainingMs <= paused.round.timer.remainingMs);
  await ok(control(host, 'close'));
  assert.equal((await send(refreshed, 'player:submit', { roundId: id, choice: 0 })).ok, false);
  await ok(control(host, 'reveal'));
  const revealed = await stateMatching(tv, state => state.round?.phase === 'revealed');
  assert.equal(revealed.round.correctIndex, 2);
  assert.deepEqual(revealed.round.counts, [1, 0, 1, 0]);
  assert.deepEqual(revealed.players.map(player => [player.name, player.score]), [['Alex', 100], ['Sam', 0]]);
  assert.equal((await control(host, 'reveal')).ok, false);
  assert.equal((await connect(firstAuth)).state.self.score, 100);
});

test('question pack errors identify the invalid question or clue', t => {
  const directory = mkdtempSync(join(tmpdir(), 'triviashrimp-test-'));
  const file = join(directory, 'broken.json');
  t.after(() => {
    rmSync(file, { force: true });
    rmdirSync(directory);
  });
  const pack = loadQuestions(oldPack);
  for (const question of [...pack.quiz, ...pack.higherLower]) delete question.images;
  delete pack.pictureBuzz;
  delete pack.songQuiz;
  const invalidQuiz = structuredClone(pack);
  invalidQuiz.quiz[0].correctIndex = 4;
  writeFileSync(file, JSON.stringify(invalidQuiz));
  assert.throws(() => loadQuestions(file), /broken\.json\nquiz question #1 \("quiz-octopus"\): correctIndex/);

  const invalidComparison = structuredClone(pack);
  invalidComparison.higherLower[0].secondValue = invalidComparison.higherLower[0].knownValue;
  writeFileSync(file, JSON.stringify(invalidComparison));
  assert.throws(() => loadQuestions(file), /higherLower question #1 \("higher-mountains"\): the two values must be different/);

  pack.jeopardy.categories[0].clues[0].answer = '';
  writeFileSync(file, JSON.stringify(pack));
  assert.throws(() => loadQuestions(file), /jeopardy category #1 \("Around the World"\), clue #1 \("world-100"\): add a nonempty answer/);

  pack.quiz[0].images = [{ file: '../private.png', alt: 'An image' }];
  writeFileSync(file, JSON.stringify(pack));
  assert.throws(() => loadQuestions(file), /quiz question #1 \("quiz-octopus"\), image #1: use a path relative to the media folder/);
  delete pack.quiz[0].images;
  pack.songQuiz = [{ id: 'missing-song', prompt: 'Name the tune.', answer: 'Example', audio: { file: 'missing.mp3' } }];
  writeFileSync(file, JSON.stringify(pack));
  assert.throws(() => loadQuestions(file), /songQuiz question #1 \("missing-song"\), audio: could not read "media\/missing\.mp3"/);
});

test('the default pack supports empty modes and serves the new instrumentals', { timeout: 15000 }, async t => {
  const pack = loadQuestions(join(__dirname, '..', 'question-pack.json'));
  const { connect, publicUrl } = await fixture(t, pack);
  const host = await connect({}, true);
  const tv = await connect({ role: 'tv' });
  await ok(control(host, 'create'));
  await ok(control(host, 'setMode', { mode: 'jeopardy' }));
  const board = await stateMatching(tv, state => state.mode === 'jeopardy');
  assert.deepEqual(board.board, { values: [], categories: [] });
  assert.equal((await control(host, 'select', { questionId: 'world-100' })).ok, false);
  await ok(control(host, 'setMode', { mode: 'pictureBuzz' }));
  const pictures = await stateMatching(host, state => state.mode === 'pictureBuzz');
  assert.deepEqual(pictures.questions, []);
  await ok(control(host, 'setMode', { mode: 'songQuiz' }));
  for (const question of pack.songQuiz) {
    await ok(control(host, 'select', { questionId: question.id }));
    const { round } = await stateMatching(tv, state => state.round?.phase === 'listening');
    const response = await fetch(publicUrl + round.clip.url, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    await ok(clipEvent(tv, 'Started', round));
    await ok(clipEvent(tv, 'Finished', round));
    await stateMatching(host, state => state.round?.phase === 'open');
    await ok(control(host, 'close'));
    await ok(control(host, 'reveal'));
    await stateMatching(tv, state => state.round?.phase === 'revealed');
  }
});

test('new modes share scores and keep song controls and answers private', { timeout: 15000 }, async t => {
  const { connect, publicUrl } = await fixture(t);
  const host = await connect({}, true);
  const publicTV = await connect({ role: 'tv' }, false, { 'cf-ray': 'test-tunnel' });
  const tv = await connect({ role: 'tv' });
  const auth = { token: randomBytes(32).toString('hex') };
  const alex = await connect(auth);
  const sam = await connect({ token: randomBytes(32).toString('hex') });
  await ok(control(host, 'create'));
  await ok(send(alex, 'player:join', { nickname: 'Alex' }));
  await ok(send(sam, 'player:join', { nickname: 'Sam' }));

  await ok(control(host, 'setMode', { mode: 'songQuiz' }));
  await ok(control(host, 'select', { questionId: 'song-01' }));
  const clip = (await stateMatching(tv, state => state.round?.phase === 'listening')).round;
  const hidden = (await stateMatching(publicTV, state => state.round?.phase === 'listening')).round;
  assert.equal(hidden.clip, undefined);
  assert.equal(hidden.answer, undefined);
  assert.equal(clip.timer, undefined);
  assert.equal(clip.clip.position, 0.4);
  const audioUrl = publicUrl + clip.clip.url;
  const partial = await fetch(audioUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-type'), 'audio/mpeg');
  assert.match(partial.headers.get('content-range'), /^bytes 0-15\//);
  assert.equal((await partial.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(audioUrl, { headers: { Origin: 'https://example.trycloudflare.com' } })).status, 404);
  assert.equal((await fetch(audioUrl, { headers: { 'cf-ray': 'test-tunnel' } })).status, 404);
  assert.equal((await fetch(publicUrl + '/media/clip-01.mp3')).status, 404);
  assert.equal((await send(alex, 'player:buzz', { roundId: clip.id, buzzerVersion: 0 })).ok, false);
  assert.equal((await clipEvent(publicTV, 'Started', clip)).ok, false);
  assert.equal((await clipEvent(tv, 'Started', clip, { roundId: 'old-round' })).ok, false);
  const playbackRequest = once(tv, 'tv:playClip');
  await ok(control(host, 'playClip'));
  assert.deepEqual(await playbackRequest, [clip.id, clip.clip.version]);
  await ok(clipEvent(tv, 'Started', clip));
  const song = (await stateMatching(tv, state => state.round?.phase === 'open')).round;
  assert.equal(song.timer, undefined);
  assert.equal(song.clipPlaying, true);
  assert.equal(song.clip.url, clip.clip.url);
  assert.equal((await clipEvent(publicTV, 'Finished', clip)).ok, false);
  assert.equal((await send(alex, 'host:control', { action: 'playClip', roundId: clip.id })).ok, false);
  await ok(send(alex, 'player:buzz', { roundId: song.id, buzzerVersion: song.buzzerVersion }));
  const stopped = await stateMatching(tv, state => state.round?.phase === 'answering');
  assert.equal(stopped.round.clip, undefined);
  assert.equal((await fetch(audioUrl)).status, 404);
  assert.equal((await clipEvent(tv, 'Finished', clip)).ok, false);
  await ok(control(host, 'correct'));
  await stateMatching(tv, state => state.round?.answer === 'Twinkle, Twinkle, Little Star');

  await ok(control(host, 'setMode', { mode: 'numberGuess' }));
  await ok(control(host, 'select', { questionId: 'guess-marathon' }));
  const number = (await stateMatching(tv, state => state.mode === 'numberGuess' && state.round?.phase === 'open')).round;
  assert.equal(number.answer, undefined);
  assert.equal((await send(alex, 'player:submit', { roundId: number.id, guess: '42' })).ok, false);
  await ok(send(alex, 'player:submit', { roundId: number.id, guess: 5 }));
  await ok(send(alex, 'player:submit', { roundId: number.id, guess: 42.194 }));
  await ok(send(sam, 'player:submit', { roundId: number.id, guess: 42.196 }));
  assert.equal((await connect(auth)).state.round.guess, 42.194);
  await ok(control(host, 'close'));
  assert.equal((await send(sam, 'player:submit', { roundId: number.id, guess: 42.195 })).ok, false);
  await ok(control(host, 'reveal'));
  const revealed = await stateMatching(tv, state => state.round?.answer === 42.195);
  assert.deepEqual(revealed.round.winners.map(player => player.name), ['Alex', 'Sam']);
  assert.deepEqual(revealed.players.map(player => player.score), [200, 100]);

  await ok(control(host, 'setMode', { mode: 'pictureBuzz' }));
  await ok(control(host, 'select', { questionId: 'picture-death-note' }));
  const picture = (await stateMatching(tv, state => state.mode === 'pictureBuzz' && state.round?.phase === 'open')).round;
  assert.equal(picture.answer, undefined);
  assert.equal(picture.images.length, 2);
  const image = await fetch(publicUrl + picture.images[0].url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  await ok(send(sam, 'player:buzz', { roundId: picture.id, buzzerVersion: picture.buzzerVersion }));
  await stateMatching(host, state => state.round?.phase === 'answering');
  await ok(control(host, 'incorrect'));
  await stateMatching(host, state => state.round?.phase === 'closed');
  await ok(control(host, 'open'));
  const reopened = (await stateMatching(tv, state => state.round?.buzzerVersion === 2)).round;
  assert.equal((await send(sam, 'player:buzz', { roundId: reopened.id, buzzerVersion: 2 })).ok, false);
  await ok(send(alex, 'player:buzz', { roundId: reopened.id, buzzerVersion: 2 }));
  await stateMatching(host, state => state.round?.phase === 'answering');
  await ok(control(host, 'correct'));
  const result = await stateMatching(tv, state => state.round?.answer === 'Death Note');
  assert.deepEqual(result.players.map(player => player.score), [300, 0]);

  await ok(control(host, 'setMode', { mode: 'quiz' }));
  await ok(control(host, 'select', { questionId: 'quiz-maple-leaf' }));
  assert.equal((await stateMatching(tv, state => state.mode === 'quiz' && state.round?.images)).round.images.length, 1);
  await ok(control(host, 'close'));
  await ok(control(host, 'reveal'));
  await ok(control(host, 'setMode', { mode: 'higherLower' }));
  await ok(control(host, 'select', { questionId: 'higher-dice' }));
  assert.equal((await stateMatching(tv, state => state.mode === 'higherLower' && state.round?.images)).round.images.length, 1);
});

test('a missed Song Quiz guess lets the TV resume at the pause point', { timeout: 15000 }, async t => {
  const { connect, publicUrl } = await fixture(t);
  const host = await connect({}, true);
  const spectator = await connect({ role: 'tv' });
  const tv = await connect({ role: 'tv' });
  const first = await connect({ token: randomBytes(32).toString('hex') });
  await ok(control(host, 'create'));
  await ok(send(first, 'player:join', { nickname: 'Alex' }));
  await ok(control(host, 'setMode', { mode: 'songQuiz' }));
  await ok(control(host, 'select', { questionId: 'song-01' }));
  const initial = (await stateMatching(tv, state => state.round?.clip)).round;
  await ok(clipEvent(tv, 'Started', initial));
  const open = (await stateMatching(first, state => state.round?.clipPlaying)).round;
  await ok(send(first, 'player:buzz', { roundId: open.id, buzzerVersion: open.buzzerVersion }));
  await stateMatching(host, state => state.round?.phase === 'answering');
  assert.equal((await clipEvent(spectator, 'Paused', initial, { position: 2 })).ok, false);
  await ok(clipEvent(tv, 'Paused', initial, { position: 1.25 }));
  assert.equal((await fetch(publicUrl + initial.clip.url)).status, 404);
  assert.equal((await control(host, 'playClip')).ok, false);
  await ok(control(host, 'incorrect'));

  const paused = (await stateMatching(host, state => state.round?.canResumeClip)).round;
  assert.equal(paused.eligible, 0);
  const resume = (await stateMatching(tv, state => state.round?.canResumeClip)).round;
  assert.equal(resume.clip.position, 1.25);
  assert.equal(resume.clip.end, initial.clip.end);
  assert.equal(resume.answer, undefined);
  assert.equal((await fetch(publicUrl + resume.clip.url, { method: 'HEAD' })).status, 200);
  assert.equal((await clipEvent(tv, 'Started', initial)).ok, false);
  const playbackRequest = once(tv, 'tv:playClip');
  await ok(control(host, 'playClip'));
  assert.deepEqual(await playbackRequest, [resume.id, resume.clip.version]);
  await ok(clipEvent(tv, 'Started', resume));
  assert.equal((await clipEvent(tv, 'Finished', initial)).ok, false);
  const resumed = (await stateMatching(first, state => state.round?.clipPlaying &&
    state.round.buzzerVersion > open.buzzerVersion)).round;
  assert.equal(resumed.attempted, true);
  assert.equal((await send(first, 'player:buzz', { roundId: resumed.id, buzzerVersion: resumed.buzzerVersion })).ok, false);

  const second = await connect({ token: randomBytes(32).toString('hex') });
  await ok(send(second, 'player:join', { nickname: 'Sam' }));
  await ok(send(second, 'player:buzz', { roundId: resumed.id, buzzerVersion: resumed.buzzerVersion }));
  await stateMatching(host, state => state.round?.buzz === 'Sam');
  assert.equal((await clipEvent(tv, 'Paused', initial, { position: 2 })).ok, false);
  await ok(clipEvent(tv, 'Paused', resume, { position: 3.5 }));
  await ok(control(host, 'incorrect'));
  const pausedAgain = (await stateMatching(tv, state => state.round?.canResumeClip)).round;
  assert.equal(pausedAgain.clip.position, 3.5);
  await ok(clipEvent(tv, 'Started', pausedAgain));
  await ok(clipEvent(tv, 'Finished', pausedAgain));
  const finished = (await stateMatching(host, state => state.round?.timer)).round;
  assert.ok(finished.timer.remainingMs > 0 && finished.timer.remainingMs <= 15000);
  await ok(control(host, 'close'));
  await stateMatching(host, state => state.round?.phase === 'closed');
  assert.equal((await control(host, 'playClip')).ok, false);
  await ok(control(host, 'reveal'));
  const revealed = await stateMatching(tv, state => state.round?.phase === 'revealed');
  assert.equal(revealed.round.answer, 'Twinkle, Twinkle, Little Star');
  assert.deepEqual(revealed.players.map(player => player.score), [-100, -100]);
});

test('deadlines close the round and reject late input even before the timeout callback runs', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const expirations = [];
  const game = new Game(loadQuestions(oldPack), '', '', '', () => expirations.push(game.snapshot('tv').round.phase));
  const token = randomBytes(32).toString('hex');
  game.control('create', {});
  game.join(token, 'Alex', 'phone');
  game.control('select', { questionId: 'quiz-octopus' });
  const quiz = { roundId: game.round.id };
  assert.equal(game.snapshot('tv').round.timer.remainingMs, 30000);
  game.submit(token, { ...quiz, choice: 0 });
  now += 5000;
  t.mock.timers.tick(5000);
  game.control('pauseTimer', quiz);
  now += 30000;
  t.mock.timers.tick(30000);
  assert.equal(game.snapshot('tv').round.timer.remainingMs, 25000);
  game.submit(token, { ...quiz, choice: 2 });
  game.control('resumeTimer', quiz);
  now += 25000;
  t.mock.timers.tick(25000);
  assert.deepEqual(expirations, ['closed']);
  assert.equal(game.snapshot('player', token).round.choice, 2);
  assert.throws(() => game.submit(token, { ...quiz, choice: 0 }), /Submissions are closed/);
  game.control('reveal', quiz);
  assert.equal(game.snapshot('player', token).self.score, 100);

  game.control('setMode', { mode: 'jeopardy' });
  game.control('select', { questionId: 'world-100' });
  const clue = { roundId: game.round.id, buzzerVersion: game.round.buzzerVersion };
  assert.equal(game.snapshot('tv').round.timer.remainingMs, 15000);
  now += 15000;
  assert.throws(() => game.buzz(token, clue), /The buzzer is closed/);
  assert.deepEqual(expirations, ['closed', 'closed']);
  game.control('open', clue);
  game.buzz(token, { ...clue, buzzerVersion: 2 });
  now += 30000;
  t.mock.timers.tick(30000);
  assert.equal(game.snapshot('tv').round.phase, 'answering');
  assert.deepEqual(expirations, ['closed', 'closed']);
});

test('mode switches keep scores and Jeopardy awards the first valid buzz', { timeout: 15000 }, async t => {
  const { connect } = await fixture(t);
  const host = await connect({}, true);
  const tv = await connect({ role: 'tv' });
  const auth = [1, 2].map(() => ({ token: randomBytes(32).toString('hex') }));
  const phones = await Promise.all(auth.map(credentials => connect(credentials)));
  const names = ['Alex', 'Sam'];
  await ok(control(host, 'create'));
  await Promise.all(phones.map((phone, index) => ok(send(phone, 'player:join', { nickname: names[index] }))));
  await stateMatching(host, state => state.players.length === 2);
  const alexId = host.state.players.find(player => player.name === 'Alex').id;
  await ok(control(host, 'adjust', { playerId: alexId, delta: 150 }));

  await ok(control(host, 'setMode', { mode: 'higherLower' }));
  await ok(control(host, 'select', { questionId: 'higher-mountains' }));
  const { round: higher } = await stateMatching(host, state => state.mode === 'higherLower' && state.round?.phase === 'open');
  assert.equal(higher.durationSeconds, 20);
  assert.ok(higher.timer.remainingMs > 0 && higher.timer.remainingMs <= 20000);
  const comparison = await stateMatching(tv, state => state.mode === 'higherLower' && state.round?.phase === 'open');
  assert.equal(comparison.round.knownValue, 5895);
  assert.equal(comparison.round.secondItem, 'Mont Blanc');
  for (const view of [comparison, (await stateMatching(phones[0], state => state.round?.id === higher.id))]) {
    assert.equal(Object.hasOwn(view.round, 'secondValue'), false);
    assert.equal(Object.hasOwn(view.round, 'correctIndex'), false);
  }
  assert.equal((await send(phones[0], 'player:submit', { roundId: higher.id, choice: 2 })).ok, false);
  assert.equal((await control(host, 'setMode', { mode: 'jeopardy' })).ok, false);
  await ok(send(phones[0], 'player:submit', { roundId: higher.id, choice: 0 }));
  await ok(send(phones[0], 'player:submit', { roundId: higher.id, choice: 1 }));
  await ok(send(phones[1], 'player:submit', { roundId: higher.id, choice: 0 }));
  await ok(control(host, 'close'));
  await ok(control(host, 'reveal'));
  const revealed = await stateMatching(tv, state => state.round?.phase === 'revealed');
  assert.equal(revealed.round.secondValue, 4806);
  assert.equal(revealed.round.correctIndex, 1);
  assert.deepEqual(revealed.players.map(player => player.score), [250, 0]);

  await ok(control(host, 'setMode', { mode: 'jeopardy' }));
  const board = (await stateMatching(tv, state => Boolean(state.board))).board;
  assert.deepEqual(board.values, [100, 200, 300, 400, 500]);
  assert.equal(board.categories.length, 6);
  assert.deepEqual(Object.keys(board.categories[0].clues[0]), ['id', 'value', 'used']);
  await ok(control(host, 'select', { questionId: 'world-100' }));
  const clue = await stateMatching(host, state => state.round?.phase === 'open');
  assert.equal(clue.round.durationSeconds, 15);
  assert.ok(clue.round.timer.remainingMs > 0 && clue.round.timer.remainingMs <= 15000);
  const { round: opened } = await stateMatching(tv, state => state.round?.phase === 'open');
  assert.equal(Object.hasOwn(opened, 'answer'), false);
  const { id: roundId, buzzerVersion } = opened;
  const results = await Promise.all(phones.map(phone => send(phone, 'player:buzz', { roundId, buzzerVersion })));
  assert.equal(results.filter(result => result.ok).length, 1);
  const first = results.findIndex(result => result.ok);
  const other = 1 - first;
  const locked = await stateMatching(tv, state => state.round?.phase === 'answering');
  assert.equal(locked.round.buzz, names[first]);
  assert.equal(Object.hasOwn(locked.round, 'answer'), false);
  assert.equal(Object.hasOwn(locked.round, 'timer'), false);
  const refreshed = await connect(auth[first]);
  assert.equal(refreshed.state.round.isAnswering, true);

  await stateMatching(host, state => state.round?.phase === 'answering');
  await ok(control(host, 'incorrect'));
  assert.equal((await control(host, 'incorrect')).ok, false);
  await ok(control(host, 'open'));
  const reopened = await stateMatching(tv, state => state.round?.phase === 'open');
  assert.ok(reopened.round.buzzerVersion > buzzerVersion);
  assert.ok(reopened.round.timer.remainingMs > 0 && reopened.round.timer.remainingMs <= 15000);
  assert.equal((await send(phones[first], 'player:buzz', { roundId, buzzerVersion: reopened.round.buzzerVersion })).ok, false);
  assert.equal((await send(phones[other], 'player:buzz', { roundId, buzzerVersion })).ok, false);
  await ok(send(phones[other], 'player:buzz', { roundId, buzzerVersion: reopened.round.buzzerVersion }));
  await stateMatching(host, state => state.round?.phase === 'answering');
  assert.equal((await control(host, 'correct', { buzzerVersion })).ok, false);
  await ok(control(host, 'correct'));
  const correct = await stateMatching(tv, state => state.round?.phase === 'revealed');
  assert.equal(correct.round.answer, 'Rome');
  assert.equal(correct.round.winner, names[other]);
  const expected = [250, 0];
  expected[first] -= 100;
  expected[other] += 100;
  assert.deepEqual(names.map(name => correct.players.find(player => player.name === name).score), expected);
  await ok(control(host, 'returnBoard'));
  const used = await stateMatching(tv, state => state.round === null);
  assert.equal(used.board.categories[0].clues[0].used, true);
  assert.equal((await control(host, 'select', { questionId: 'world-100' })).ok, false);
  await ok(control(host, 'setMode', { mode: 'quiz' }));
  await stateMatching(tv, state => state.mode === 'quiz');
  assert.deepEqual(names.map(name => tv.state.players.find(player => player.name === name).score), expected);
});
