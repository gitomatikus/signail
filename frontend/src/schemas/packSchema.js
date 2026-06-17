/**
 * @typedef {Object} Pack
 * @property {string} author - The author of the pack
 * @property {string} name - The name of the pack
 * @property {Round[]} rounds - Array of rounds in the pack
 */

/**
 * @typedef {Object} Round
 * @property {string} name - The name of the round
 * @property {Theme[]} themes - Array of themes in the round
 */

/**
 * @typedef {Object} Theme
 * @property {string} name - The name of the theme
 * @property {string} description - Description of the theme
 * @property {boolean} ordered - Whether questions should be ordered
 * @property {Question[]} questions - Array of questions in the theme
 */

/**
 * @typedef {Object} Question
 * @property {number} id - Unique identifier for the question
 * @property {Price} [price] - Optional price information
 * @property {QuestionType} type - Type of the question
 * @property {Rule[]} [rules] - Optional rules for the question
 * @property {Rule[]} [after_round] - Optional rules to apply after the round
 * @property {string} [image] - Image path for find-a-cat
 * @property {string} [task] - Find-a-cat task text shown to players; supports %total% (total targets) and %left% (targets left) placeholders
 * @property {string} [name] - Legacy find-a-cat target name (e.g. "котиків"); used when task is absent
 * @property {Object[]} [map] - Map areas for find-a-cat
 * @property {number} [duration] - Optional duration for the question
 * @property {number} [max_clicks] - Find-a-cat click budget (hits and misses); 0/absent = unlimited
 * @property {number} [first_place_bonus] - Find-a-cat extra points for the fastest solver, on top of the normal award
 * @property {number} [answer] - Close-enough numeric correct answer; the closest submitted number wins
 * @property {number} [perfect_bonus] - Close-enough extra points for guessing the exact answer
 * @property {boolean} [multiple] - Choice: whether several options can be correct
 * @property {Object[]} [options] - Choice options: { content: html, correct: boolean }
 * @property {string} [effect] - Progressive-reveal hiding effect: blur | pixelate | zoom
 * @property {string} [curve] - Progressive-reveal speed curve: linear | slow-start | fast-start
 * @property {string} [crocodile_mode] - Crocodile scoring: 'fastest' | 'dixit'
 * @property {string} [vote_mode] - Voting visibility: 'open' | 'closed'
 * @property {string} [media] - Karaoke track (audio/video) as a base64 data URL
 * @property {string} [lyrics] - Karaoke lyrics (plain text or LRC)
 * @property {string} [lyrics_format] - 'plain' | 'lrc'
 * @property {boolean} [user_selection] - Option: designate one player (only-answerer for buzz types, only-scorer for parallel types)
 * @property {boolean} [allow_self_pick] - Option: the selector may pick themselves
 * @property {string} [response] - Option: answer method for normal/reveal — 'buzz' | 'text'
 * @property {boolean} [hidden_until_reveal] - Option: keep submitted answers masked until the host reveals
 */

/**
 * @typedef {Object} Price
 * @property {string} text - Text representation of the price
 * @property {number} correct - Points for correct answer
 * @property {number} incorrect - Points for incorrect answer
 * @property {string} random_range - Range for random price selection (e.g. "1-300" or "null")
 */

/**
 * @typedef {Object} Rule
 * @property {RuleType} type - Type of the rule
 * @property {string} [content] - Optional content for the rule
 * @property {number} [duration] - Optional duration for the rule
 * @property {string} [path] - Optional path for the rule
 */

/**
 * @enum {string}
 */
const QuestionType = {
    Normal: 'normal',
    // @deprecated Read-only: normalized to Normal + user_selection
    Secret: 'secret',
    Empty: 'empty',
    FindACat: 'find-a-cat',
    CloseEnough: 'close-enough',
    Choice: 'choice',
    // @deprecated Read-only: normalized to Normal + response:'text'
    TextAnswer: 'text-answer',
    ProgressiveReveal: 'progressive-reveal',
    Karaoke: 'karaoke',
    Crocodile: 'crocodile',
    Voting: 'voting'
};

/**
 * @enum {string}
 */
const RuleType = {
    App: 'app',
    Embedded: 'embedded'
};

export { QuestionType, RuleType }; 