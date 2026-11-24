const { randomUUID } = require('node:crypto');

const QUESTION_POINTS = 100;
const MAX_PLAYERS = 24;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MODES = ['quiz', 'higherLower', 'jeopardy', 'songQuiz', 'numberGuess', 'pictureBuzz'];
const BUZZER_MODES = ['jeopardy', 'songQuiz', 'pictureBuzz'];
const HIGHER_LOWER_OPTIONS = ['Higher', 'Lower'];
const ROUND_SECONDS = { quiz: 30, higherLower: 20, jeopardy: 15, songQuiz: 15, numberGuess: 30, pictureBuzz: 15 };
const GUESS_SCALE = 1000000;

function scaledGuess(value) {
  return Math.round(value * GUESS_SCALE);
}

function validGuess(value) {
  return Number.isFinite(value) && Math.abs(value) <= 1000000000 && scaledGuess(value) / GUESS_SCALE === value;
}

function requireState(condition, message) {
  if (!condition) throw new Error(message);
}

class Game {
  constructor(pack, joinUrl, lanUrl, tvUrl, onTimerExpired) {
    this.pack = pack;
    this.joinUrl = joinUrl;
    this.lanUrl = lanUrl;
    this.tvUrl = tvUrl;
    this.onTimerExpired = onTimerExpired;
    this.created = false;
    this.mode = 'quiz';
    this.round = null;
    this.players = new Map();
    this.usedQuestions = new Set();
    this.clues = new Map(pack.jeopardy.categories.flatMap(category =>
      category.clues.map(clue => [clue.id, { ...clue, category: category.name }])));
  }

  join(token, nickname, socketId) {
    requireState(this.created, 'The host is still setting up the room.');
    requireState(typeof token === 'string' && TOKEN_PATTERN.test(token), 'Refresh this page and try again.');
    const existing = this.players.get(token);
    if (existing) {
      existing.sockets.add(socketId);
      return existing;
    }
    requireState(typeof nickname === 'string', 'Enter a nickname.');
    const name = nickname.normalize('NFC').trim();
    requireState(name.length >= 1 && name.length <= 20 && !/[\p{Cc}\p{Cf}]/u.test(name),
      'Use a nickname of 1–20 characters.');
    requireState(![...this.players.values()].some(player => player.name.toLowerCase() === name.toLowerCase()),
      'That nickname is taken. Try another.');
    requireState(this.players.size < MAX_PLAYERS, 'This room is full.');
    const player = { id: randomUUID(), name, score: 0, sockets: new Set([socketId]) };
    this.players.set(token, player);
    return player;
  }

  resume(token, socketId) {
    this.players.get(token)?.sockets.add(socketId);
  }

  disconnect(token, socketId) {
    this.players.get(token)?.sockets.delete(socketId);
  }

  control(action, data) {
    if (action === 'setJoinUrl') {
      this.joinUrl = data.url;
      return;
    }
    if (action === 'create') {
      this.created = true;
      return;
    }

    requireState(this.created, 'Create the room first.');
    const round = this.round;
    this.expireTimer(round);
    if (action === 'adjust') {
      const player = [...this.players.values()].find(candidate => candidate.id === data.playerId);
      requireState(player, 'That player is no longer in the room.');
      requireState(Number.isSafeInteger(data.delta) && data.delta !== 0 && Math.abs(data.delta) <= 10000,
        'Enter a whole-number adjustment between −10,000 and 10,000.');
      this.addPoints(player, data.delta);
      return;
    }
    if (action === 'setMode' || action === 'select' || action === 'returnBoard') {
      requireState(!round || round.phase === 'revealed',
        'Finish and reveal this question first.');
      if (action === 'setMode') {
        requireState(MODES.includes(data.mode), 'Choose a valid mode.');
        this.mode = data.mode;
        this.round = null;
      } else if (action === 'select') {
        this.selectQuestion(data.questionId);
      } else {
        requireState(this.mode === 'jeopardy' && round?.id === data.roundId, 'That clue has changed.');
        this.round = null;
      }
      return;
    }

    requireState(round && round.id === data.roundId, 'That question has changed.');
    if (BUZZER_MODES.includes(this.mode)) {
      requireState(data.buzzerVersion === round.buzzerVersion, 'The buzzer has changed.');
    }
    if (action === 'pauseTimer' || action === 'resumeTimer') {
      this.controlTimer(round, action);
      return;
    }
    if (BUZZER_MODES.includes(this.mode)) {
      this.controlClue(round, action);
      return;
    }
    if (action === 'close') {
      requireState(round.phase === 'open', 'Submissions are already closed.');
      this.closeRound(round);
    } else if (action === 'reveal') {
      requireState(round.phase === 'closed', 'Close submissions before revealing.');
      if (this.mode === 'numberGuess') {
        this.scoreGuesses(round);
      } else {
        for (const player of this.players.values()) {
          if (round.answers.get(player.id) === round.correctIndex) {
            this.addPoints(player, QUESTION_POINTS);
          }
        }
      }
      this.usedQuestions.add(round.question.id);
      round.phase = 'revealed';
    } else {
      throw new Error('Unknown host action.');
    }
  }

  startTimer(round, remainingMs = ROUND_SECONDS[this.mode] * 1000) {
    const timer = { deadline: performance.now() + remainingMs };
    round.timer = timer;
    const schedule = () => {
      timer.timeout = setTimeout(() => {
        if (this.round !== round || round.timer !== timer) return;
        if (!this.expireTimer(round)) schedule();
      }, Math.ceil(timer.deadline - performance.now())).unref();
    };
    schedule();
  }

  controlTimer(round, action) {
    requireState(round.phase === 'open', 'The round is closed.');
    requireState(round.timer, 'The countdown starts after the clip.');
    if (action === 'pauseTimer') {
      requireState(round.timer.deadline !== undefined, 'The timer is already paused.');
      const remainingMs = round.timer.deadline - performance.now();
      if (remainingMs <= 0) {
        this.expireTimer(round);
        throw new Error('The round is closed.');
      }
      this.stopTimer(round);
      round.timer = { remainingMs };
    } else {
      requireState(round.timer.deadline === undefined, 'The timer is already running.');
      this.startTimer(round, round.timer.remainingMs);
    }
  }

  expireTimer(round) {
    const deadline = round?.timer?.deadline;
    if (deadline === undefined || performance.now() < deadline) return false;
    this.closeRound(round);
    this.onTimerExpired?.();
    return true;
  }

  stopTimer(round = this.round) {
    if (!round?.timer) return;
    clearTimeout(round.timer.timeout);
    round.timer = null;
  }

  closeRound(round) {
    this.stopTimer(round);
    this.stopClip(round);
    round.phase = 'closed';
  }

  selectQuestion(questionId) {
    const board = this.mode === 'jeopardy';
    const question = board ? this.clues.get(questionId) :
      this.pack[this.mode]?.find(candidate => candidate.id === questionId);
    requireState(question && (!board || !this.usedQuestions.has(questionId)),
      board ? 'Choose an unused clue.' : 'Choose a question from the pack.');
    if (BUZZER_MODES.includes(this.mode)) {
      const song = this.mode === 'songQuiz';
      this.round = {
        id: randomUUID(), question, phase: song ? 'listening' : 'open', attempted: new Set(),
        points: board ? question.value : QUESTION_POINTS, buzz: null, winner: null, buzzerVersion: song ? 0 : 1
      };
      if (song) {
        this.round.clipUrl = `/media/song/${randomUUID()}`;
        return;
      }
    } else {
      const comparison = this.mode === 'higherLower';
      this.round = {
        id: randomUUID(), question, phase: 'open', answers: new Map(),
        options: comparison ? HIGHER_LOWER_OPTIONS : question.options,
        correctIndex: comparison ? Number(question.secondValue < question.knownValue) : question.correctIndex
      };
    }
    this.startTimer(this.round);
  }

  audioFor(url) {
    const round = this.round;
    if (round?.clipUrl === url && (this.clipReady(round) || round.playback)) {
      return this.pack.media.get(round.question.audio.file);
    }
  }

  clipEnd(round) {
    const { start = 0, duration = 10 } = round.question.audio;
    return start + duration;
  }

  clipReady(round) {
    return round.phase === 'listening' || (round.phase === 'closed' && round.pausedClip &&
      round.pausedClip.position < this.clipEnd(round));
  }

  clipToPlay(roundId, version) {
    const round = this.round;
    requireState(round && round.id === roundId && round.buzzerVersion === version && this.clipReady(round),
      'That clip is no longer ready to play.');
    return round;
  }

  startClip(roundId, version, owner) {
    const round = this.clipToPlay(roundId, version);
    const position = round.pausedClip?.position ?? round.question.audio.start ?? 0;
    this.openBuzzer(round, false);
    // Recover if the TV stalls or loses the end-of-playback event.
    const timeout = setTimeout(() => {
      if (this.finishClip(roundId, version, owner)) this.onTimerExpired?.();
    }, (this.clipEnd(round) - position + 10) * 1000).unref();
    round.playback = { owner, version, timeout, position, startedAt: performance.now() };
  }

  finishClip(roundId, version, owner) {
    const round = this.round;
    const playback = round?.playback;
    if (!playback || round.id !== roundId || playback.owner !== owner || playback.version !== version) return false;
    this.stopClip(round);
    this.startTimer(round);
    return true;
  }

  saveClipPosition(roundId, version, owner, position) {
    const round = this.round;
    const paused = round?.pausedClip;
    requireState(round?.id === roundId && paused?.owner === owner && paused.version === version,
      'That clip is no longer paused.');
    requireState(Number.isFinite(position), 'Invalid clip position.');
    paused.position = Math.min(Math.max(paused.start, position), this.clipEnd(round));
  }

  stopClip(round = this.round) {
    if (!round?.playback) return;
    clearTimeout(round.playback.timeout);
    round.playback = null;
  }

  openBuzzer(round, timed = true) {
    round.pausedClip = null;
    round.buzzerVersion++;
    round.phase = 'open';
    if (timed) this.startTimer(round);
  }

  controlClue(round, action) {
    if (action === 'skipClip') {
      requireState(round.phase === 'listening', 'The clip is already past the start of the round.');
      this.openBuzzer(round);
    } else if (action === 'open') {
      requireState(round.phase === 'closed', 'The buzzer cannot be reopened now.');
      requireState(this.eligibleBuzzers(round) > 0, 'There are no eligible players left to buzz.');
      this.openBuzzer(round);
    } else if (action === 'close') {
      requireState(round.phase === 'open', 'The buzzer is already closed.');
      this.closeRound(round);
    } else if (action === 'correct' || action === 'incorrect') {
      requireState(round.phase === 'answering', 'Wait for a player to buzz.');
      const player = round.buzz;
      this.addPoints(player, action === 'correct' ? round.points : -round.points);
      if (action === 'correct') round.winner = player;
      round.buzz = null;
      round.phase = 'closed';
      if (action === 'correct') this.revealClue(round);
    } else if (action === 'reveal') {
      requireState(round.phase === 'closed', 'Close the buzzer before revealing.');
      this.revealClue(round);
    } else {
      throw new Error('Unknown host action.');
    }
  }

  revealClue(round) {
    round.pausedClip = null;
    this.usedQuestions.add(round.question.id);
    round.phase = 'revealed';
  }

  eligibleBuzzers(round) {
    return [...this.players.values()].filter(player => player.sockets.size && !round.attempted.has(player.id)).length;
  }

  buzz(token, { roundId, buzzerVersion }) {
    const player = this.players.get(token);
    const round = this.round;
    requireState(player, 'Join the room first.');
    this.expireTimer(round);
    requireState(BUZZER_MODES.includes(this.mode) && round && round.id === roundId &&
      round.phase === 'open' && round.buzzerVersion === buzzerVersion, 'The buzzer is closed.');
    requireState(!round.attempted.has(player.id), 'You have already buzzed for this clue.');
    round.buzz = player;
    round.attempted.add(player.id);
    this.stopTimer(round);
    if (round.playback) {
      const { owner, version, position: start, startedAt } = round.playback;
      // Estimate where to resume until the local TV reports the actual pause position.
      const position = Math.min(start + (performance.now() - startedAt) / 1000, this.clipEnd(round));
      round.pausedClip = { owner, version, start, position };
    }
    this.stopClip(round);
    round.phase = 'answering';
  }

  addPoints(player, amount) {
    player.score += amount;
  }

  submit(token, { roundId, choice, guess }) {
    const player = this.players.get(token);
    const round = this.round;
    requireState(player, 'Join the room first.');
    this.expireTimer(round);
    requireState(!BUZZER_MODES.includes(this.mode) && round && round.id === roundId && round.phase === 'open', 'Submissions are closed.');
    if (this.mode === 'numberGuess') {
      requireState(validGuess(guess), 'Enter a number from −1 billion to 1 billion with up to six decimal places.');
      round.answers.set(player.id, guess);
      return;
    }
    requireState(Number.isInteger(choice) && choice >= 0 && choice < round.options.length, 'Choose a valid answer.');
    round.answers.set(player.id, choice);
  }

  scoreGuesses(round) {
    let closest = Infinity;
    const target = scaledGuess(round.question.answer);
    round.winners = [];
    for (const player of this.players.values()) {
      const guess = round.answers.get(player.id);
      if (guess === undefined) continue;
      const distance = Math.abs(scaledGuess(guess) - target);
      if (distance < closest) {
        closest = distance;
        round.winners = [];
      }
      if (distance === closest) round.winners.push(player);
    }
    for (const player of round.winners) this.addPoints(player, QUESTION_POINTS);
  }

  snapshot(role, token) {
    const player = this.players.get(token);
    const round = this.round;
    const players = [...this.players.values()]
      .sort((first, second) => second.score - first.score)
      .map(({ id, name, score, sockets }) => ({ id, name, score, online: sockets.size > 0 }));
    const state = {
      created: this.created,
      joinUrl: this.joinUrl,
      mode: this.mode,
      players,
      round: round ? this.roundSnapshot(round, role, player) : null
    };
    if (role === 'player') {
      state.self = player ? { id: player.id, name: player.name, score: player.score } : null;
    }
    if (this.mode === 'jeopardy') {
      const { values, categories } = this.pack.jeopardy;
      state.board = {
        values,
        categories: categories.map(({ name, clues }) => ({
          name,
          clues: clues.map(({ id, value }) => ({ id, value, used: this.usedQuestions.has(id) }))
        }))
      };
    }
    if (role === 'host') {
      state.lanUrl = this.lanUrl;
      state.tvUrl = this.tvUrl;
      if (this.mode !== 'jeopardy') {
        state.questions = (this.pack[this.mode] ?? []).map(({ id, prompt, label, topic }) => ({
          id, prompt: label ?? prompt, topic: topic?.trim(), played: this.usedQuestions.has(id)
        }));
      }
    }
    return state;
  }

  roundSnapshot(round, role, player) {
    const { id, phase, question, answers } = round;
    const timer = round.timer && {
      paused: round.timer.deadline === undefined,
      remainingMs: round.timer.remainingMs ?? Math.max(0, round.timer.deadline - performance.now())
    };
    const timing = timer ? { timer } : {};
    if (role === 'host') timing.durationSeconds = ROUND_SECONDS[this.mode];
    const images = question.images?.map(({ file, alt }) => ({ url: this.pack.media.get(file).url, alt }));
    if (BUZZER_MODES.includes(this.mode)) {
      const view = {
        id, phase, prompt: question.prompt, points: round.points,
        category: question.category, images,
        buzzerVersion: round.buzzerVersion, buzz: round.buzz?.name, winner: round.winner?.name, ...timing
      };
      if (role === 'host' && this.mode === 'jeopardy') view.clueId = question.id;
      if (round.playback) view.clipPlaying = true;
      const clipReady = this.clipReady(round);
      if (clipReady && phase === 'closed') view.canResumeClip = true;
      if (role === 'localTV' && (clipReady || round.playback)) {
        const start = question.audio.start ?? 0;
        view.clip = {
          url: round.clipUrl, position: round.playback?.position ?? round.pausedClip?.position ?? start,
          end: this.clipEnd(round), version: round.playback?.version ?? round.buzzerVersion
        };
      }
      if (player) {
        view.attempted = round.attempted.has(player.id);
        view.isAnswering = round.buzz === player;
      }
      if (role === 'host') view.eligible = this.eligibleBuzzers(round);
      if (role === 'host' || phase === 'revealed') {
        view.answer = question.answer;
        view.explanation = question.explanation;
      }
      return view;
    }
    const view = {
      id, phase, prompt: question.prompt, options: round.options, images, submitted: answers.size,
      points: QUESTION_POINTS, ...timing
    };
    if (this.mode === 'numberGuess') {
      view.unit = question.unit;
      if (player) view.guess = answers.get(player.id) ?? null;
      if (role === 'host' || phase === 'revealed') {
        view.answer = question.answer;
        view.explanation = question.explanation;
      }
      if (phase === 'revealed') {
        view.winners = round.winners.map(({ id: playerId, name }) => ({ id: playerId, name, guess: answers.get(playerId) }));
      }
      return view;
    }
    if (this.mode === 'higherLower') {
      view.knownItem = question.knownItem;
      view.knownValue = question.knownValue;
      view.secondItem = question.secondItem;
      view.unit = question.unit;
      if (role === 'host' || phase === 'revealed') view.secondValue = question.secondValue;
    }
    if (player) view.choice = answers.get(player.id) ?? null;
    if (role === 'host' || phase === 'revealed') {
      view.correctIndex = round.correctIndex;
      view.explanation = question.explanation;
    }
    if (phase === 'revealed') {
      view.counts = round.options.map((_, index) => [...answers.values()].filter(choice => choice === index).length);
    }
    return view;
  }
}

module.exports = { Game, TOKEN_PATTERN, validGuess };
