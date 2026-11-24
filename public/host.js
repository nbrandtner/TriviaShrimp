const hostError = $('#host-error');
const hostRound = $('#host-round');
const questionList = $('#questions');
const topicFilter = $('#pack-topic');
const scorePlayer = $('#score-player');
const joinInput = $('#public-origin');
let hostState;
let hostBusy = false;

const phaseLabels = {
  open: 'Submissions open', closed: 'Submissions closed', revealed: 'Revealed'
};

function timerControl(round) {
  if (!round.timer) return '';
  return round.timer.paused
    ? '<button type="button" class="button secondary small" data-action="resumeTimer">Resume timer</button>'
    : '<button type="button" class="button secondary small" data-action="pauseTimer">Pause timer</button>';
}

function renderRound(state) {
  const { round } = state;
  if (buzzerModes.includes(state.mode)) return hostClue(state);
  if (!round) {
    return `<p class="eyebrow">CURRENT ROUND</p><h2>Pick a question</h2>
      <p class="muted">Selecting a question opens submissions and starts the timer.</p>`;
  }
  const next = { open: ['close', 'Close submissions'], closed: ['reveal', 'Reveal answer'] };
  const action = next[round.phase];
  const numberGuess = state.mode === 'numberGuess';
  const answer = numberGuess ? comparisonValue(round.answer, round.unit) : escapeHtml(round.options[round.correctIndex]);
  return `<div class="section-heading"><p class="eyebrow">CURRENT ROUND</p>
    <div class="round-status"><span class="pill phase-${round.phase}">${phaseLabels[round.phase]}</span>${roundTimer(round)}</div></div>
    <h2>${escapeHtml(round.prompt)}</h2>
    ${roundImages(round)}
    <p class="host-answer">Answer · ${answer}${state.mode === 'higherLower' ?
      ` · ${escapeHtml(round.secondItem)} · ${comparisonValue(round.secondValue, round.unit)}` : ''}</p>
    ${round.explanation ? `<p class="muted">${escapeHtml(round.explanation)}</p>` : ''}
    <div class="round-footer">
      <span class="muted">${round.submitted} / ${state.players.length} submitted · ${round.points} pts</span>
      <div class="button-row">${timerControl(round)}
        ${action ? `<button class="button primary small" data-action="${action[0]}">${action[1]} <span aria-hidden="true">→</span></button>` :
        '<span class="pill phase-revealed">Points awarded</span>'}
      </div>
    </div>`;
}

function hostClue({ round, mode, board, questions }) {
  if (!round) {
    if (!(board ? board.categories : questions).length) {
      return `<p class="eyebrow">${modeNames[mode]}</p><h2>No clues in this pack</h2>`;
    }
    const message = mode === 'songQuiz' ? 'Select a song, then play the clip from here or the TV screen.' :
      'Selecting a clue opens the buzzer and starts the timer.';
    return `<p class="eyebrow">${modeNames[mode]}</p><h2>Pick a clue</h2><p class="muted">${message}</p>`;
  }
  const status = {
    listening: 'Ready to play', open: 'Buzzer open', answering: 'Answering aloud', closed: 'Buzzer closed', revealed: 'Revealed'
  };
  const action = (name, label, style = 'secondary', disabled = false) =>
    `<button type="button" class="button ${style} small" data-action="${name}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  let actions;
  if (round.phase === 'listening') {
    actions = action('playClip', 'Play on TV', 'primary') + action('skipClip', 'Skip clip and open buzzer');
  } else if (round.phase === 'open') {
    actions = timerControl(round) + action('close', 'Close buzzer', 'primary');
  } else if (round.phase === 'answering') {
    actions = action('correct', `Correct +${formatNumber(round.points)}`, 'primary') +
      action('incorrect', `Incorrect −${formatNumber(round.points)}`);
  } else if (round.phase === 'closed') {
    actions = round.canResumeClip ? action('playClip', 'Resume on TV', 'primary') +
      action('open', 'Reopen without audio', 'secondary', !round.eligible) :
      action('open', 'Reopen buzzer', 'primary', !round.eligible);
    actions += action('reveal', 'Reveal answer');
  } else if (mode === 'jeopardy') {
    actions = action('returnBoard', 'Return to board', 'primary');
  } else {
    actions = '';
  }
  return `<div class="section-heading"><p class="eyebrow">${escapeHtml(round.category ?? modeNames[mode])} · ${formatNumber(round.points)} pts</p>
    <div class="round-status"><span class="pill phase-${round.phase}">${status[round.phase]}</span>${roundTimer(round)}</div></div>
    <h2>${escapeHtml(round.prompt)}</h2>
    ${roundImages(round)}
    <p class="host-answer">Answer · ${escapeHtml(round.answer)}</p>
    ${round.explanation ? `<p class="muted">${escapeHtml(round.explanation)}</p>` : ''}
    <div class="round-footer">
      <span class="muted">${round.phase === 'listening' ? 'If the browser blocks playback, click Play clip in the TV window.' :
        round.clipPlaying ? 'Clip playing. Players can buzz now.' :
        round.buzz ? `${escapeHtml(round.buzz)} is answering aloud` :
        round.phase === 'revealed' ? (round.winner ? `${escapeHtml(round.winner)} scored ${formatNumber(round.points)} pts` : 'Clue used') :
        `${round.eligible} eligible to buzz${round.phase === 'closed' ? ` · ${round.durationSeconds} s per opening` : ''}`}</span>
      <div class="button-row">${actions}</div>
    </div>`;
}

function renderPack(state, locked) {
  $('#pack-title').textContent = state.board ? 'Clue board' : 'Question pack';
  topicFilter.hidden = !state.questions?.some(question => question.topic);
  if (state.board) {
    const remaining = state.board.categories.flatMap(category => category.clues).filter(clue => !clue.used).length;
    $('#pack-count').textContent = `${remaining} unused`;
    setMarkup(questionList, state.board.categories.length ?
      boardGrid(state.board, { interactive: true, locked, selected: state.round?.clueId }) :
      '<p class="muted">Add clues for this mode in your question pack.</p>');
  } else {
    const selectedTopic = topicFilter.value;
    const topics = [...new Set(state.questions.map(question => question.topic).filter(Boolean))];
    setMarkup(topicFilter, '<option value="">All topics</option>' + topics.map(topic =>
      `<option value="${escapeHtml(topic)}">${escapeHtml(topic)}</option>`).join(''));
    topicFilter.value = topics.includes(selectedTopic) ? selectedTopic : '';
    const questions = topicFilter.value ? state.questions.filter(question => question.topic === topicFilter.value) : state.questions;
    const count = questions.length;
    $('#pack-count').textContent = `${count} ${count === 1 ? 'question' : 'questions'}`;
    setMarkup(questionList, questions.length ? questions.map(question => {
      const label = question.played ? 'Played' : 'Select';
      return `<button type="button" class="question-row" data-question="${escapeHtml(question.id)}" ${locked ? 'disabled' : ''}>
        <span class="question-copy">${escapeHtml(question.prompt)}${question.topic ? `<small>${escapeHtml(question.topic)}</small>` : ''}</span><span class="question-tag">${label}</span>
      </button>`;
    }).join('') : '<p class="muted">Add questions for this mode in your question pack.</p>');
  }
}

function renderHost(state) {
  const changedJoinAddress = state.joinUrl !== hostState?.joinUrl;
  if (state.round?.phase === 'open' && (hostState?.round?.phase === 'listening' || hostState?.round?.canResumeClip)) {
    hostError.hidden = true;
  }
  hostState = state;
  $('#setup').hidden = state.created;
  $('#game-controls').hidden = !state.created;
  $('#join-settings').hidden = !state.created;
  const tvLink = $('#tv-link');
  tvLink.href = state.tvUrl;
  tvLink.hidden = !state.created;
  const joinAddress = $('#join-address');
  joinAddress.href = state.joinUrl;
  joinAddress.textContent = state.joinUrl;
  $('#join-type').textContent = state.joinUrl === state.lanUrl ? 'Local Wi-Fi' : 'Public';
  if (changedJoinAddress) {
    joinInput.value = state.joinUrl === state.lanUrl ? '' : new URL(state.joinUrl).origin;
  }
  const locked = state.round && state.round.phase !== 'revealed';
  setMarkup($('#modes'), Object.entries(modeNames).map(([mode, label]) =>
    `<button class="mode-tab${mode === state.mode ? ' active' : ''}" type="button" data-mode="${mode}" aria-pressed="${mode === state.mode}" ${locked ? 'disabled' : ''}>${label}</button>`).join(''));
  setMarkup(hostRound, renderRound(state));
  showRoundTimer(hostRound, state.round);
  renderPack(state, locked);

  $('#host-count').textContent = playerCount(state.players.length);
  setMarkup($('#host-roster'), state.players.length ? state.players.map(player => `<div class="host-player">
    <span class="player-dot ${player.online ? 'online' : ''}" title="${player.online ? 'Connected' : 'Disconnected'}"></span>
    <span class="host-player-name">${escapeHtml(player.name)}</span><strong>${formatNumber(player.score)}</strong>
  </div>`).join('') : '<p class="muted">Players will appear here when they join.</p>');
  $('#score-form').hidden = !state.players.length;
  const selected = scorePlayer.value;
  setMarkup(scorePlayer, state.players.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join(''));
  if (selected && state.players.some(player => player.id === selected)) scorePlayer.value = selected;
}

const hostSocket = connect({
  onState: renderHost,
  onConnection(online) {
    $('#create').disabled = !online;
    $('#game-controls').inert = !online;
    $('#join-settings').inert = !online;
    $('#score-form').inert = !online;
  }
});
hostSocket.on('host:clipBlocked', () => {
  const label = hostState?.round?.canResumeClip ? 'Resume clip' : 'Play clip';
  hostError.textContent = `Playback could not start from here. Click ${label} in the TV window.`;
  hostError.hidden = false;
});

async function control(action, data = {}) {
  if (hostBusy) return false;
  hostBusy = true;
  const { id: roundId, buzzerVersion } = hostState?.round ?? {};
  const ok = await send(hostSocket, 'host:control', { action, roundId, buzzerVersion, ...data }, hostError);
  hostBusy = false;
  return ok;
}

$('#create').addEventListener('click', () => control('create'));
hostRound.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action) control(action);
});
$('#modes').addEventListener('click', event => {
  const mode = event.target.closest('[data-mode]')?.dataset.mode;
  if (mode && mode !== hostState.mode) control('setMode', { mode });
});
questionList.addEventListener('click', event => {
  const questionId = event.target.closest('[data-question]')?.dataset.question;
  if (questionId) control('select', { questionId });
});
topicFilter.addEventListener('change', () => renderPack(hostState, hostState.round && hostState.round.phase !== 'revealed'));
$('#join-form').addEventListener('submit', event => {
  event.preventDefault();
  control('setJoinUrl', { origin: joinInput.value.trim() });
});
$('#use-lan').addEventListener('click', () => control('setJoinUrl', { origin: '' }));
$('#score-form').addEventListener('submit', async event => {
  event.preventDefault();
  const delta = $('#score-delta');
  if (await control('adjust', { playerId: scorePlayer.value, delta: delta.valueAsNumber })) delta.value = '';
});
