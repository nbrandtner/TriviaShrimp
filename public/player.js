const playerError = $('#player-error');
const joinButton = $('#player-join button');
const playerStage = $('#player-stage');
// Keep the existing key so players can reconnect after the rename.
const storageKey = 'quiz-club-player';
let token;
try {
  token = localStorage.getItem(storageKey);
} catch {
  // Play remains available when browser storage is blocked.
}
if (!/^[0-9a-f]{64}$/.test(token ?? '')) {
  token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(storageKey, token);
  } catch {
    // The current tab can still reconnect with its in-memory token.
  }
}

let playerState;
let online = false;
let busy = false;

function playerRound(state) {
  const { round } = state;
  if (buzzerModes.includes(state.mode)) return playerClue(state);
  if (!round) {
    return `<p class="eyebrow"><span class="signal"></span> IN THE ROOM</p>
      <h1>You're in<span class="accent">.</span></h1><p class="muted">Waiting for the host to pick a question.</p>`;
  }
  if (state.mode === 'numberGuess') return playerGuess(state);
  let status = 'Submissions closed. Waiting for the reveal.';
  if (round.phase === 'open') status = round.choice === null ? 'Tap an answer. You can change it while submissions are open.' :
    `Answer submitted · ${round.options[round.choice]}. Tap another to change it.`;
  if (round.phase === 'closed' && round.choice !== null) {
    status = `Answer locked · ${round.options[round.choice]}. Waiting for the reveal.`;
  }
  if (round.phase === 'revealed') {
    status = round.choice === round.correctIndex ? `Correct! +${round.points} points` :
      round.choice === null ? 'Answer revealed' : 'Incorrect. On to the next question!';
  }
  const comparison = state.mode === 'higherLower';
  return `<div class="section-heading"><p class="eyebrow"><span class="signal"></span> ${modeNames[state.mode]}</p>${roundTimer(round)}</div>
    <h1>${escapeHtml(round.prompt)}</h1>
    ${roundImages(round)}
    <p class="player-status${round.choice !== null ? ' submitted' : ''}" role="status">${escapeHtml(status)}</p>
    ${comparison ? comparisonCards(round) : ''}
    ${optionCards(round, true, comparison)}`;
}

function playerGuess({ round, self }) {
  const open = round.phase === 'open';
  const revealed = round.phase === 'revealed';
  const own = round.guess === null ? '' : comparisonValue(round.guess, round.unit);
  const won = revealed && round.winners.some(player => player.id === self.id);
  return `<div class="section-heading"><p class="eyebrow"><span class="signal"></span> Number Guessing</p>${roundTimer(round)}</div>
    <h1>${escapeHtml(round.prompt)}</h1>
    ${roundImages(round)}
    ${revealed ? `<div class="clue-callout reveal"><p class="eyebrow">THE ANSWER</p><strong>${comparisonValue(round.answer, round.unit)}</strong></div>` : ''}
    <p class="player-status" role="status">${own ? `${open ? 'Saved guess' : 'Your guess'} · ${own}` :
      open ? 'Enter your best estimate.' : revealed ? 'No guess submitted.' : 'Submissions closed.'}
      ${won ? ` · Closest! +${round.points} pts` : ''}</p>
    ${open ? `<form class="guess-form" data-guess-form>
      <label for="guess">Your guess${round.unit ? ` (${escapeHtml(round.unit)})` : ''}</label>
      <input id="guess" type="number" inputmode="decimal" min="-1000000000" max="1000000000" step="any" required value="${round.guess ?? ''}">
      <button type="submit" class="button primary">${own ? 'Update guess' : 'Submit guess'}</button>
    </form>` : ''}`;
}

function playerClue({ round, mode }) {
  if (!round) {
    return `<p class="eyebrow"><span class="signal"></span> ${modeNames[mode]}</p>
      <h1>You're in<span class="accent">.</span></h1><p class="muted">Waiting for the host to choose a clue.</p>`;
  }
  let status = 'Buzzer closed. Waiting for the host.';
  if (round.phase === 'listening') status = 'Watch the TV. You can buzz as soon as the clip starts.';
  if (round.canResumeClip) status = 'Waiting for the host to resume the clip.';
  if (round.phase === 'open') status = round.clipPlaying ? 'Buzz when you recognize the song.' : 'Tap to buzz in.';
  if (round.phase === 'answering') status = round.isAnswering ? 'You buzzed first! Answer aloud.' : `${round.buzz} is answering aloud.`;
  if (round.attempted && ['open', 'closed'].includes(round.phase)) status = 'You already buzzed for this clue.';
  if (round.phase === 'revealed') status = round.winner ? `${round.winner} scored ${formatNumber(round.points)} points.` : 'Answer revealed';
  return `<div class="section-heading"><p class="eyebrow"><span class="signal"></span> ${escapeHtml(round.category ?? modeNames[mode])} · ${formatNumber(round.points)} pts</p>${roundTimer(round)}</div>
    <h1>${escapeHtml(round.prompt)}</h1>
    ${roundImages(round)}
    <p class="player-status${round.isAnswering ? ' submitted' : ''}" role="status">${escapeHtml(status)}</p>
    ${round.phase === 'open' && !round.attempted ? '<button type="button" class="buzzer" data-buzz>Buzz in</button>' : ''}
    ${round.phase === 'revealed' ? `<div class="clue-callout reveal"><p class="eyebrow">THE ANSWER</p><strong>${escapeHtml(round.answer)}</strong></div>` : ''}`;
}

function syncControls() {
  joinButton.disabled = !online || !playerState?.created || busy;
  playerStage.inert = !online || busy;
  const status = $('#join-status');
  status.textContent = !online ? 'Connecting to the room…' : playerState?.created ?
    'Pick the name you want on the scoreboard.' : 'Waiting for the host to open the room.';
}

function renderPlayer(state) {
  if (playerState?.round?.id !== state.round?.id || playerState?.round?.phase !== state.round?.phase) {
    playerError.hidden = true;
  }
  playerState = state;
  $('#join-card').hidden = Boolean(state.self);
  $('#player-game').hidden = !state.self;
  if (state.self) {
    setMarkup($('#player-identity'), `<span class="identity-name">${escapeHtml(state.self.name)}</span><strong>${formatNumber(state.self.score)} <span>pts</span></strong>`);
    const focusedChoice = playerStage.querySelector('[data-choice]:focus')?.dataset.choice;
    setMarkup(playerStage, playerRound(state));
    if (focusedChoice !== undefined) playerStage.querySelector(`[data-choice="${focusedChoice}"]`)?.focus();
  }
  showRoundTimer(playerStage, state.self ? state.round : null);
  syncControls();
}

const playerSocket = connect({
  auth: { role: 'player', token },
  onState: renderPlayer,
  onConnection(connected) {
    online = connected;
    syncControls();
  }
});

async function playerAction(event, payload) {
  if (busy) return;
  busy = true;
  syncControls();
  await send(playerSocket, event, payload, playerError);
  if (event === 'player:buzz' && playerState?.round?.phase === 'answering') playerError.hidden = true;
  busy = false;
  syncControls();
}

$('#player-join').addEventListener('submit', event => {
  event.preventDefault();
  playerAction('player:join', { nickname: $('#nickname').value });
});
playerStage.addEventListener('submit', event => {
  if (!event.target.matches('[data-guess-form]')) return;
  event.preventDefault();
  const guess = event.target.querySelector('#guess').valueAsNumber;
  playerAction('player:submit', { roundId: playerState.round.id, guess });
});
playerStage.addEventListener('click', event => {
  const button = event.target.closest('[data-choice]');
  if (button) send(playerSocket, 'player:submit', { roundId: playerState.round.id, choice: Number(button.dataset.choice) }, playerError);
  if (event.target.closest('[data-buzz]')) {
    const { id, buzzerVersion } = playerState.round;
    playerAction('player:buzz', { roundId: id, buzzerVersion });
  }
});
