const $ = (selector) => document.querySelector(selector);
const letters = ['A', 'B', 'C', 'D'];
const modeNames = {
  quiz: 'Four-answer quiz', higherLower: 'Higher / Lower', jeopardy: 'Jeopardy',
  songQuiz: 'Song Quiz', numberGuess: 'Number Guessing', pictureBuzz: 'Picture Buzz'
};
const buzzerModes = ['jeopardy', 'songQuiz', 'pictureBuzz'];
const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 }).format;
const playerCount = count => `${count} ${count === 1 ? 'player' : 'players'}`;

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, char => entities[char]);
}

function setMarkup(element, markup) {
  if (element.renderedMarkup !== markup) {
    element.innerHTML = markup;
    element.renderedMarkup = markup;
  }
}

function roundTimer(round) {
  return round.timer ? '<span class="round-timer" data-round-timer role="timer" aria-label="Time remaining"></span>' : '';
}

let countdown;
function showRoundTimer(container, round) {
  clearInterval(countdown);
  const display = container.querySelector('[data-round-timer]');
  if (!display || !round?.timer) return;
  const { paused, remainingMs } = round.timer;
  const deadline = performance.now() + remainingMs;

  function update() {
    const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    const label = paused ? `Paused · ${Math.ceil(remainingMs / 1000)} s` : seconds ? `${seconds} s` : 'Time’s up';
    if (display.textContent !== label) display.textContent = label;
    display.dataset.urgent = !paused && seconds <= 5 ? 'yes' : 'no';
    if (!seconds) clearInterval(countdown);
  }

  if (!paused) countdown = setInterval(update, 100);
  update();
}

function connect({ auth, onState, onConnection }) {
  const socket = io({ auth, autoConnect: false });
  const status = $('[data-connection]');
  function setConnection(online) {
    status.dataset.online = online ? 'yes' : 'no';
    status.textContent = online ? 'Connected' : 'Reconnecting…';
    onConnection?.(online);
  }
  socket.on('state', onState);
  socket.on('connect', () => setConnection(true));
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));
  socket.connect();
  return socket;
}

async function send(socket, event, payload, errorBox) {
  errorBox.hidden = true;
  try {
    if (!socket.connected) throw new Error('Connection lost. Wait for the room to reconnect.');
    const result = await socket.timeout(5000).emitWithAck(event, payload);
    if (!result.ok) throw new Error(result.error);
    return true;
  } catch (error) {
    errorBox.textContent = error.message === 'operation has timed out'
      ? 'No reply yet. Check the room connection and try again.' : error.message;
    errorBox.hidden = false;
    return false;
  }
}

function optionCards(round, interactive = false, comparison = false) {
  return `<div class="options">${round.options.map((option, index) => {
    const correct = round.phase === 'revealed' && round.correctIndex === index;
    const selected = round.choice === index;
    const classes = `option option-${index}${correct ? ' correct' : ''}${selected ? ' selected' : ''}`;
    const canChoose = interactive && round.phase === 'open';
    const tag = canChoose ? 'button' : 'div';
    return `<${tag} class="${classes}"${canChoose ? ` type="button" data-choice="${index}" aria-pressed="${selected}"` : ''}>
      <span class="option-letter">${comparison ? ['↑', '↓'][index] : letters[index]}</span><span class="option-text">${escapeHtml(option)}</span>
      ${correct ? '<span class="option-check" aria-label="Correct answer">✓</span>' : selected ?
        `<span class="option-check" ${canChoose ? 'aria-hidden="true"' : 'aria-label="Your answer"'}>●</span>` : ''}
      ${!interactive && round.counts ? `<span class="option-count" title="Votes">${round.counts[index]}</span>` : ''}
    </${tag}>`;
  }).join('')}</div>`;
}

function comparisonValue(number, unit) {
  if (unit === 'year') return String(number);
  return formatNumber(number) + (unit ? ` <small>${escapeHtml(unit)}</small>` : '');
}

function roundImages(round) {
  if (!round.images?.length) return '';
  const images = round.images.map(({ url, alt }) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`);
  return `<div class="round-images${images.length === 1 ? ' single' : ''}">${images.join('')}</div>`;
}

function comparisonCards(round) {
  const value = number => comparisonValue(number, round.unit);
  return `<div class="comparison">
    <div class="comparison-card"><span>${escapeHtml(round.knownItem)}</span><strong>${value(round.knownValue)}</strong></div>
    <div class="comparison-card mystery"><span>${escapeHtml(round.secondItem)}</span><strong>${round.phase === 'revealed' ? value(round.secondValue) : '?'}</strong></div>
  </div>`;
}

function boardGrid(board, { interactive = false, locked = false, selected } = {}) {
  const columns = board.categories.map(category => `<div class="board-column" role="group" aria-label="${escapeHtml(category.name)}">
    <h3 class="board-category">${escapeHtml(category.name)}</h3>
    ${board.values.map(value => {
      const clue = category.clues.find(candidate => candidate.value === value);
      const used = clue.used;
      const current = clue.id === selected;
      const classes = `board-tile${used ? ' used' : ''}${current ? ' current' : ''}`;
      const label = `${category.name} for ${formatNumber(value)}${used ? ', used' : ''}`;
      return interactive
        ? `<button type="button" class="${classes}" data-question="${escapeHtml(clue.id)}" aria-label="${escapeHtml(label)}" ${used || locked ? 'disabled' : ''}>${used ? '✓' : formatNumber(value)}</button>`
        : `<div class="${classes}" aria-label="${escapeHtml(label)}">${used ? '✓' : formatNumber(value)}</div>`;
    }).join('')}
  </div>`).join('');
  return `<div class="board-scroll"><div class="board-grid" data-columns="${board.categories.length}" data-rows="${board.values.length}">${columns}</div></div>`;
}
