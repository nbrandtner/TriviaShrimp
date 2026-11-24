const fs = require('node:fs');
const path = require('node:path');
const { readAsset } = require('./media');
const { validGuess } = require('./game');

function validate(condition, location, message) {
  if (!condition) throw new Error(`${location}: ${message}`);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadQuestions(file = process.env.QUESTION_PACK || 'question-pack.json') {
  const resolved = path.resolve(file);
  try {
    const source = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
    const pack = JSON.parse(source);
    validate(isObject(pack), 'Question pack', 'expected a JSON object.');
    const ids = new Set();
    const media = new Map();
    const mediaDirectory = path.join(path.dirname(resolved), 'media');

    function checkMedia(file, kind, location) {
      validate(isText(file), location, 'add a media filename.');
      if (media.has(file)) {
        validate((media.get(file).type === 'audio/mpeg') === (kind === 'audio'),
          location, 'this file is already used for another media type.');
        return;
      }
      try {
        media.set(file, readAsset(mediaDirectory, file, kind));
      } catch (error) {
        throw new Error(`${location}: ${error.message}`);
      }
    }

    function checkQuestion(question, label) {
      const location = `${label}${isText(question?.id) ? ` ("${question.id}")` : ''}`;
      validate(isObject(question), location, 'expected a question object.');
      validate(isText(question.id), location, 'add a nonempty string id.');
      validate(!ids.has(question.id), location, `duplicate question id "${question.id}".`);
      validate(isText(question.prompt), location, 'add a nonempty prompt.');
      validate(question.topic === undefined || isText(question.topic),
        location, 'topic must be nonempty text when provided.');
      validate(question.explanation === undefined || isText(question.explanation),
        location, 'explanation must be nonempty text when provided.');
      validate(question.label === undefined || isText(question.label), location, 'label must be nonempty text.');
      if (question.images !== undefined) {
        validate(Array.isArray(question.images) && question.images.length > 0 && question.images.length <= 4,
          location, 'images must have 1–4 entries.');
        for (const [index, image] of question.images.entries()) {
          const item = `${location}, image #${index + 1}`;
          validate(isObject(image) && isText(image.alt), item, 'add a file and a short alt description.');
          checkMedia(image.file, 'image', item);
        }
      }
      ids.add(question.id);
      return location;
    }

    validate(Array.isArray(pack.quiz) && pack.quiz.length, 'quiz', 'add at least one question.');
    for (const [index, question] of pack.quiz.entries()) {
      const location = checkQuestion(question, `quiz question #${index + 1}`);
      validate(Array.isArray(question.options) && question.options.length === 4 && question.options.every(isText),
        location, 'options must contain exactly four nonempty strings.');
      validate(new Set(question.options.map(option => option.trim().toLowerCase())).size === 4,
        location, 'options must be different.');
      validate(Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex <= 3,
        location, 'correctIndex must be 0, 1, 2, or 3 (the first option is 0).');
    }

    validate(Array.isArray(pack.higherLower) && pack.higherLower.length, 'higherLower', 'add at least one question.');
    for (const [index, question] of pack.higherLower.entries()) {
      const location = checkQuestion(question, `higherLower question #${index + 1}`);
      validate(isText(question.knownItem) && isText(question.secondItem), location,
        'knownItem and secondItem must be nonempty text.');
      validate(isText(question.unit), location, 'unit must be nonempty text shared by both values.');
      validate(Number.isFinite(question.knownValue) && Number.isFinite(question.secondValue), location,
        'knownValue and secondValue must be finite numbers.');
      validate(question.knownValue !== question.secondValue, location, 'the two values must be different.');
    }

    for (const mode of ['numberGuess', 'songQuiz', 'pictureBuzz']) {
      if (pack[mode] === undefined) continue;
      validate(Array.isArray(pack[mode]), mode, 'expected a question list.');
      for (const [index, question] of pack[mode].entries()) {
        const location = checkQuestion(question, `${mode} question #${index + 1}`);
        if (mode === 'numberGuess') {
          validate(validGuess(question.answer), location, 'answer must be between −1 billion and 1 billion with at most six decimal places.');
          validate(question.unit === undefined || isText(question.unit), location, 'unit must be nonempty text.');
          continue;
        }
        validate(isText(question.answer), location, 'add a nonempty answer.');
        if (mode === 'pictureBuzz') {
          validate(question.images?.length > 0, location, 'add at least one image.');
        } else {
          const { audio } = question;
          validate(isObject(audio), location, 'add an audio object with an MP3 file.');
          validate(Number.isFinite(audio.start ?? 0) && (audio.start ?? 0) >= 0, location,
            'audio.start must be a nonnegative number of seconds.');
          validate(Number.isFinite(audio.duration ?? 10) && (audio.duration ?? 10) >= 1 &&
            (audio.duration ?? 10) <= 60, location, 'audio.duration must be between 1 and 60 seconds.');
          checkMedia(audio.file, 'audio', `${location}, audio`);
        }
      }
    }

    const board = pack.jeopardy;
    validate(isObject(board), 'jeopardy', 'add a board with values and categories.');
    const { values, categories } = board;
    validate(Array.isArray(categories) && categories.length <= 6,
      'jeopardy.categories', 'use an empty list or add up to 6 categories.');
    validate(Array.isArray(values) && values.length <= 6 && (!categories.length || values.length > 0) &&
      values.every((value, index) => Number.isInteger(value) && value >= 1 && value <= 10000 &&
        (index === 0 || value > values[index - 1])),
    'jeopardy.values', 'use 1–6 distinct, increasing whole numbers from 1 to 10,000, or leave both lists empty.');
    const names = new Set();
    for (const [index, category] of categories.entries()) {
      const label = `jeopardy category #${index + 1}`;
      validate(isObject(category) && isText(category.name), label, 'add a nonempty name.');
      const categoryLocation = `${label} ("${category.name}")`;
      const name = category.name.trim().toLowerCase();
      validate(!names.has(name), categoryLocation, 'category names must be different.');
      names.add(name);
      validate(Array.isArray(category.clues), categoryLocation, 'add a clues array.');
      const clueValues = new Set();
      for (const [clueIndex, clue] of category.clues.entries()) {
        const location = checkQuestion(clue, `${categoryLocation}, clue #${clueIndex + 1}`);
        validate(values.includes(clue.value), location, 'value must appear in jeopardy.values.');
        validate(!clueValues.has(clue.value), location, `a ${clue.value}-point clue already exists in this category.`);
        validate(isText(clue.answer), location, 'add a nonempty answer.');
        clueValues.add(clue.value);
      }
      validate(clueValues.size === values.length, categoryLocation,
        `add one clue for each board value. Missing: ${values.filter(value => !clueValues.has(value)).join(', ')}.`);
    }

    Object.defineProperty(pack, 'media', { value: media });
    return pack;
  } catch (error) {
    throw new Error(`Question pack ${resolved}\n${error.message}`);
  }
}

if (require.main === module) {
  try {
    loadQuestions(process.argv[2]);
    console.log('Question pack is valid.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { loadQuestions };
