// Shared question-type model.
//
// `type` used to bundle three independent things together. Two of the old
// "types" are really cross-cutting options on a normal question:
//   secret      -> a question with user_selection (one chosen player)
//   text-answer -> a question answered via a text field instead of buzzing
//
// normalizeQuestion() rewrites those legacy types at read time so the rest of
// the app only ever deals with base types + option flags. It is idempotent:
// a question already in the new shape passes through unchanged.
//
// This module is duplicated (near-identically) in the frontend and the packer
// editor — the three runtimes are separate codebases. Keep them in sync.

const LEGACY_TYPE_MAP = {
  secret: { type: 'normal', user_selection: true },
  'text-answer': { type: 'normal', response: 'text' },
  choice: { type: 'normal', response: 'choice' },
};

function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return q;
  const legacy = LEGACY_TYPE_MAP[q.type];
  if (legacy) return { ...q, ...legacy };
  // Crocodile: fold the legacy crocodile_mode into the unified response axis.
  // The performer always draws live; crocodile_mode only picks the guess method.
  if (q.type === 'crocodile' && q.response === undefined && q.crocodile_mode) {
    return { ...q, response: q.crocodile_mode === 'dixit' ? 'text' : 'buzz' };
  }
  return q;
}

// Selected player is the only one allowed to answer; everyone else is locked
// out (buzz race or text field) — today's "secret", generalized.
const SELECTION_EXCLUSIVE_TYPES = ['normal', 'progressive-reveal'];
// Everyone answers in parallel, but only the selected player can score.
const SELECTION_PARALLEL_TYPES = ['find-a-cat'];
// One performer/clue-giver is always picked (selection is intrinsic to the type).
const SELECTION_MANDATORY_TYPES = ['karaoke', 'crocodile', 'spectrum'];

function hasUserSelection(q) {
  if (!q) return false;
  if (SELECTION_MANDATORY_TYPES.includes(q.type)) return true;
  if (SELECTION_EXCLUSIVE_TYPES.includes(q.type) || SELECTION_PARALLEL_TYPES.includes(q.type)) {
    return !!q.user_selection;
  }
  return false;
}

function allowsSelfPick(q) {
  return hasUserSelection(q) && !!q.allow_self_pick;
}

// How a player submits their answer. 'multi-buzz' is a buzz race whose
// buzzes are consumed per-verdict (see isMultiBuzz), so it maps to 'buzz'
// here and all buzz-race mechanics apply unchanged.
function responseMethod(q) {
  if (!q) return 'buzz';
  switch (q.type) {
    case 'close-enough': return 'numeric';
    case 'find-a-cat': return 'click';
    case 'point-on-image': return 'point';
    case 'karaoke': return 'audio';
    case 'voting': return 'text';
    case 'spectrum': return 'spectrum';
    case 'crocodile':
      return q.response === 'multi-buzz'
        ? 'buzz'
        : q.response || (q.crocodile_mode === 'dixit' ? 'text' : 'buzz');
    case 'normal':
    case 'progressive-reveal':
      return q.response === 'multi-buzz' ? 'buzz' : q.response || 'buzz';
    default: return 'buzz';
  }
}

// Multi-buzz: a buzz race where the host's verdict (correct or not) consumes
// the buzz instead of ending the player's participation — the same player may
// buzz again while the timer runs. Made for open questions with many valid
// answers ("name a film with DiCaprio").
function isMultiBuzz(q) {
  if (!q) return false;
  return (q.type === 'normal' || q.type === 'progressive-reveal' || q.type === 'crocodile')
    && q.response === 'multi-buzz';
}

// Selection that runs through the shared "secret" assignment channel
// (normal / reveal / choice / find-a-cat). Karaoke, crocodile and Spectrum have their
// own assignment channels.
function usesSecretSelection(q) {
  return hasUserSelection(q)
    && (SELECTION_EXCLUSIVE_TYPES.includes(q.type) || SELECTION_PARALLEL_TYPES.includes(q.type));
}

// True when only the chosen player may answer (others wait), as opposed to
// inclusive selection where everyone plays but only the chosen player scores.
// Applies to normal/reveal whether buzz or text field (e.g. a "draw a cat"
// text task answered by the one chosen player).
function isExclusiveSelection(q) {
  return hasUserSelection(q) && SELECTION_EXCLUSIVE_TYPES.includes(q.type);
}

// Whether submitted answers stay masked from other players until the host
// reveals them. Defaults preserve historical behavior: text/numeric answers
// are hidden, choice picks are live. Voting masking is handled separately
// (host always sees answers live; players never do until reveal).
function isHiddenUntilReveal(q) {
  if (!q || q.type === 'voting' || q.type === 'crocodile') return true;
  if (q.type === 'point-on-image') return true;
  if (typeof q.hidden_until_reveal === 'boolean') return q.hidden_until_reveal;
  const rm = responseMethod(q);
  return rm === 'text' || rm === 'numeric';
}

module.exports = {
  normalizeQuestion,
  hasUserSelection,
  allowsSelfPick,
  responseMethod,
  isMultiBuzz,
  usesSecretSelection,
  isExclusiveSelection,
  isHiddenUntilReveal,
};
