// Shared question-type model (frontend copy).
//
// `type` used to bundle several independent things together. Some of the old
// "types" are really cross-cutting options on a normal question:
//   secret      -> a question with user_selection (one chosen player)
//   text-answer -> a question answered via a text field instead of buzzing
//   choice      -> a question answered by picking from options
//
// normalizeQuestion() rewrites those legacy types at read time so the rest of
// the app only ever deals with base types + option flags. It is idempotent.
//
// Mirror of backend/src/questionModel.js and packer/src/utils/questionModel.ts
// — keep the three in sync.

const LEGACY_TYPE_MAP = {
  secret: { type: 'normal', user_selection: true },
  'text-answer': { type: 'normal', response: 'text' },
  choice: { type: 'normal', response: 'choice' },
};

export function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return q;
  const legacy = LEGACY_TYPE_MAP[q.type];
  if (legacy) return { ...q, ...legacy };
  // Crocodile: fold the legacy crocodile_mode into the unified response axis
  // (fastest -> buzz guessers, dixit -> text guessers). The performer always
  // draws live regardless of mode; crocodile_mode only picks the guess method.
  if (q.type === 'crocodile' && q.response === undefined && q.crocodile_mode) {
    return { ...q, response: q.crocodile_mode === 'dixit' ? 'text' : 'buzz' };
  }
  return q;
}

// Selected player is the only one allowed to answer; everyone else is locked
// out (whether the answer is a buzz race or a text field) — today's "secret",
// generalized.
export const SELECTION_EXCLUSIVE_TYPES = ['normal', 'progressive-reveal'];
// Everyone answers in parallel, but only the selected player can score.
export const SELECTION_PARALLEL_TYPES = ['find-a-cat'];
// One performer is always picked (selection is intrinsic to the type).
export const SELECTION_MANDATORY_TYPES = ['karaoke', 'crocodile'];

export function hasUserSelection(q) {
  if (!q) return false;
  if (SELECTION_MANDATORY_TYPES.includes(q.type)) return true;
  if (SELECTION_EXCLUSIVE_TYPES.includes(q.type) || SELECTION_PARALLEL_TYPES.includes(q.type)) {
    return !!q.user_selection;
  }
  return false;
}

export function allowsSelfPick(q) {
  return hasUserSelection(q) && !!q.allow_self_pick;
}

// How a player submits their answer. For normal/reveal/crocodile this is the
// configurable response axis: 'buzz' (race), 'text' (field) or 'choice' (pick).
// 'multi-buzz' is a buzz race whose buzzes are consumed per-verdict (see
// isMultiBuzz), so it maps to 'buzz' here and all buzz mechanics apply.
export function responseMethod(q) {
  if (!q) return 'buzz';
  switch (q.type) {
    case 'close-enough': return 'numeric';
    case 'find-a-cat': return 'click';
    case 'karaoke': return 'audio';
    case 'voting': return 'text';
    case 'crocodile':
      // guessers' answer method (legacy crocodile_mode: fastest=buzz, dixit=text)
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
export function isMultiBuzz(q) {
  if (!q) return false;
  return (q.type === 'normal' || q.type === 'progressive-reveal' || q.type === 'crocodile')
    && q.response === 'multi-buzz';
}

// Selection that runs through the shared "secret" assignment channel
// (normal / reveal / find-a-cat). Karaoke and crocodile have their own
// assignment channels.
export function usesSecretSelection(q) {
  return hasUserSelection(q)
    && (SELECTION_EXCLUSIVE_TYPES.includes(q.type) || SELECTION_PARALLEL_TYPES.includes(q.type));
}

// True when only the chosen player may answer (others wait), as opposed to
// inclusive selection where everyone plays but only the chosen player scores.
// Applies to normal/reveal whether the answer is a buzz or a text field — e.g.
// a "draw a cat" text task where only the chosen player responds.
export function isExclusiveSelection(q) {
  return hasUserSelection(q) && SELECTION_EXCLUSIVE_TYPES.includes(q.type);
}

// Everyone answers independently and several can score — no buzz race, so one
// player's answer must not pause question media for the rest. Crocodile and
// karaoke run their own flows and are never treated as multi-winner here.
export function isMultiWinner(q) {
  if (!q) return false;
  if (q.type === 'crocodile' || q.type === 'karaoke') return false;
  if (isExclusiveSelection(q)) return false;
  return responseMethod(q) !== 'buzz';
}

// Whether this question collects per-player submissions (close-enough numbers,
// choice picks, text answers, crocodile guesses, voting answers).
export function usesNumberAnswers(q) {
  if (!q) return false;
  if (q.type === 'crocodile' || q.type === 'voting') return true;
  const rm = responseMethod(q);
  return rm === 'text' || rm === 'numeric' || rm === 'choice';
}

// Whether submitted answers stay masked from other players until reveal.
// Defaults preserve historical behavior: text/numeric hidden, choice live.
// Voting and crocodile guesses are always hidden (guessing games).
export function isHiddenUntilReveal(q) {
  if (!q || q.type === 'voting' || q.type === 'crocodile') return true;
  if (typeof q.hidden_until_reveal === 'boolean') return q.hidden_until_reveal;
  const rm = responseMethod(q);
  return rm === 'text' || rm === 'numeric';
}
