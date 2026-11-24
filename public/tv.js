const tvStage = $('#tv-stage');
const fullscreen = $('#fullscreen');
const audio = $('#song-audio');
let song;

function lobby(state) {
  return `<section class="lobby">
    <div class="lobby-copy">
      <p class="eyebrow"><span class="signal"></span> ${state.created ? 'ROOM OPEN' : 'ROOM SETUP'}</p>
      <h1 aria-label="TriviaShrimp">Trivia<span class="lobby-accent">Shrimp<span class="lobby-dot">.</span></span></h1>
      <p class="lobby-description">${state.created ? 'Scan to join the game.' : 'The host is getting the game ready.'}</p>
      <div class="lobby-count"><span class="signal"></span> ${playerCount(state.players.length)} joined</div>
    </div>
    <div class="join-ticket">
      <span class="ticket-caption">PLAY ON YOUR PHONE</span>
      <img class="qr" src="/qr.png?url=${encodeURIComponent(state.joinUrl)}" width="480" height="480" alt="QR code for the player join page">
      <a class="ticket-url" href="${escapeHtml(state.joinUrl)}">${escapeHtml(state.joinUrl)}</a>
    </div>
  </section>`;
}

function tvRound(state) {
  const { round } = state;
  const comparison = state.mode === 'higherLower';
  const guessing = state.mode === 'numberGuess';
  const status = { open: guessing ? 'Guess on your phone' : 'Pick on your phone', closed: 'Submissions closed', revealed: 'Answer reveal' };
  return `<section class="tv-round${comparison ? ' tv-comparison' : ''}">
    <div class="tv-meta"><p class="eyebrow"><span class="signal"></span> ${modeNames[state.mode]}</p>
    <div class="round-status"><span class="pill phase-${round.phase}">${status[round.phase]}</span>${roundTimer(round)}</div></div>
    <h1>${escapeHtml(round.prompt)}</h1>
    ${roundImages(round)}
    ${comparison ? comparisonCards(round) : ''}
    ${guessing ? tvGuess(round) : optionCards(round, false, comparison)}
    ${round.phase === 'revealed' && round.explanation ? `<p class="tv-round-note">${escapeHtml(round.explanation)}</p>` :
      round.phase === 'open' ? `<p class="tv-round-note">${round.submitted} of ${state.players.length} answered</p>` : ''}
  </section>`;
}

function tvGuess(round) {
  if (round.phase !== 'revealed') return round.unit ? `<p class="tv-round-note">Guess in ${escapeHtml(round.unit)}</p>` : '';
  return `<div class="clue-callout reveal"><p class="eyebrow">THE ANSWER</p>
    <strong>${comparisonValue(round.answer, round.unit)}</strong>
    ${round.winners.length ? `<span>Closest · ${round.winners.map(winner =>
      `${escapeHtml(winner.name)} (${comparisonValue(winner.guess, round.unit)})`).join(' · ')}</span>` :
      '<span>No guesses submitted</span>'}</div>`;
}

function tvBoard(state) {
  return `<section class="tv-board">
    <div class="tv-meta"><h1>Jeopardy board<span class="accent">.</span></h1><span class="pill">${playerCount(state.players.length)}</span></div>
    ${boardGrid(state.board)}
  </section>`;
}

function tvClue(round, mode) {
  const status = {
    listening: 'Ready to play', open: 'Buzz on your phone', answering: 'Answering aloud',
    closed: 'Buzzer closed', revealed: 'Answer reveal'
  };
  const detail = round.phase === 'revealed' ? `<div class="clue-callout reveal"><p class="eyebrow">THE ANSWER</p>
    <strong>${escapeHtml(round.answer)}</strong>
    ${round.winner ? `<span>${escapeHtml(round.winner)} · +${formatNumber(round.points)} points</span>` : ''}
    ${round.explanation ? `<span>${escapeHtml(round.explanation)}</span>` : ''}</div>` :
    round.buzz ? `<div class="clue-callout"><p class="eyebrow">FIRST TO BUZZ</p><strong>${escapeHtml(round.buzz)}</strong><span>Answer aloud</span></div>` : '';
  return `<section class="tv-round clue-round">
    <div class="tv-meta"><p class="eyebrow"><span class="signal"></span> ${escapeHtml(round.category ?? modeNames[mode])} · ${formatNumber(round.points)} pts</p>
    <div class="round-status"><span class="pill phase-${round.phase}">${status[round.phase]}</span>${roundTimer(round)}</div></div>
    <h1>${escapeHtml(round.prompt)}</h1>${roundImages(round)}${detail}
    ${round.clip ? `<div class="clip-controls"><button type="button" class="button primary" data-play-clip disabled>${round.canResumeClip ? 'Resume clip' : 'Play clip'}</button><p class="tv-round-note" id="clip-note" role="status">Loading audio…</p></div>` :
      round.phase === 'listening' || round.canResumeClip ? '<p class="tv-round-note">Use the local TV screen on the host laptop to play the clip.</p>' : ''}
  </section>`;
}

function renderTV(state) {
  const { round, mode } = state;
  const markup = round ? (buzzerModes.includes(mode) ? tvClue(round, mode) : tvRound(state)) :
    state.board?.categories.length ? tvBoard(state) : lobby(state);
  setMarkup(tvStage, markup);
  showRoundTimer(tvStage, round);
  syncClip(round);
  $('#tv-scores').hidden = !state.players.length;
  setMarkup($('#tv-roster'), state.players.map((player, index) => `<div class="tv-player">
    <span class="tv-rank">${index + 1}</span><span class="tv-name">${escapeHtml(player.name)}</span><strong>${formatNumber(player.score)}</strong>
  </div>`).join(''));
}

const tvSocket = connect({
  auth: { role: 'tv' },
  onState: renderTV,
  onConnection(online) {
    if (!online && song?.playing) {
      audio.pause();
      clearInterval(song.check);
      song.playing = false;
      song.note = 'Connection lost. Play the clip again after reconnecting.';
      renderClipControls();
    }
  }
});
tvSocket.on('tv:playClip', (roundId, version) => {
  if (song?.id === roundId && song.version === version) void playClip();
});

function syncClip(round) {
  if (song?.id !== round?.id || song?.version !== round?.clip?.version) {
    clearInterval(song?.check);
    if (song) {
      audio.pause();
      if (song.id === round?.id && round.phase === 'answering' && song.playing) {
        tvSocket.timeout(4000).emit('tv:clipPaused', {
          roundId: song.id, version: song.version, position: audio.ended ? song.end : audio.currentTime
        }, () => {});
      }
      audio.removeAttribute('src');
      audio.load();
    }
    song = undefined;
    if (round?.clip) {
      song = { ...round.clip, id: round.id, note: 'Loading audio…' };
      audio.src = song.url;
    }
  }
  if (song) {
    if (!song.playing) song.position = round.clip.position;
    song.startedOnTV = Boolean(round.clipPlaying);
  }
  renderClipControls();
}

function renderClipControls() {
  const button = $('[data-play-clip]');
  if (!button || !song) return;
  button.disabled = !song.ready || song.playing || song.finishing || song.startedOnTV;
  $('#clip-note').textContent = song.startedOnTV && !song.playing && !song.finishing
    ? 'A clip is playing on the TV.' : song.note;
}

function reportBlocked(current) {
  tvSocket.emit('tv:clipBlocked', { roundId: current.id, version: current.version });
}

audio.addEventListener('loadedmetadata', () => {
  if (!song) return;
  song.ready = song.position < audio.duration;
  song.note = song.ready ? 'Players can buzz during playback.' :
    'The clip starts past the end of the file. Open the buzzer from the host console.';
  renderClipControls();
  if (song.playWhenReady) {
    song.playWhenReady = false;
    if (song.ready) void playClip();
    else reportBlocked(song);
  }
});
audio.addEventListener('error', () => {
  if (!song) return;
  if (song.playing && song.startedOnTV) {
    void finishPlayback();
    return;
  }
  clearInterval(song.check);
  song.ready = song.playing = false;
  song.note = 'Audio could not load. Use the host console to skip the clip.';
  if (song.playWhenReady) reportBlocked(song);
  song.playWhenReady = false;
  renderClipControls();
});

async function finishPlayback() {
  const current = song;
  if (!current?.playing) return;
  clearInterval(current.check);
  current.playing = false;
  current.finishing = true;
  current.note = 'Clip ended. Waiting for the countdown…';
  audio.pause();
  renderClipControls();
  if (tvSocket.connected) {
    try {
      const reply = await tvSocket.timeout(4000).emitWithAck('tv:clipFinished', { roundId: current.id, version: current.version });
      if (reply.ok || song !== current) return;
    } catch {
      // The server starts the countdown if the playback acknowledgement is lost.
    }
  }
  if (song !== current) return;
  current.finishing = false;
  current.note = 'Clip ended. The buzzer is open.';
  renderClipControls();
}

audio.addEventListener('ended', finishPlayback);
tvStage.addEventListener('click', event => {
  if (event.target.closest('[data-play-clip]')) void playClip();
});

async function playClip() {
  if (!song || song.startedOnTV || song.playing || !tvSocket.connected) return;
  const current = song;
  if (!current.ready) {
    if (audio.error || audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      reportBlocked(current);
    } else {
      current.playWhenReady = true;
    }
    return;
  }
  current.playing = true;
  current.note = 'Playing clip…';
  renderClipControls();
  try {
    audio.currentTime = current.position;
    await audio.play();
    if (song !== current || !current.playing) return;
    const reply = await tvSocket.timeout(4000).emitWithAck('tv:clipStarted', { roundId: current.id, version: current.version });
    if (song !== current || !current.playing) return;
    if (!reply.ok) throw new Error(reply.error);
    if (audio.ended || audio.currentTime >= current.end) {
      void finishPlayback();
      return;
    }
    current.check = setInterval(() => {
      if (audio.currentTime >= current.end) void finishPlayback();
    }, 40);
  } catch (error) {
    if (song !== current) return;
    audio.pause();
    current.playing = false;
    current.note = error.name === 'NotAllowedError' ? 'Click the playback button on this TV screen to enable audio.' :
      'Playback did not start. Try again or open the buzzer from the host console.';
    reportBlocked(current);
    renderClipControls();
  }
}

if (!document.fullscreenEnabled) fullscreen.hidden = true;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    fullscreen.title = 'Use your browser’s fullscreen command';
  }
});
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen';
  fullscreen.setAttribute('aria-label', label);
  fullscreen.title = label;
});
