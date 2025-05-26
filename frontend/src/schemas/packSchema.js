/**
 * @typedef {Object} Pack
 * @property {string} author - The author of the pack
 * @property {string} name - The name of the pack
 * @property {Round[]} rounds - Array of rounds in the pack
 */

/**
 * @typedef {Object} Round
 * @property {string} name - The name of the round
 * @property {string} [music] - Optional music file path
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
 * @property {string} id - Unique identifier for the question
 * @property {Price} [price] - Optional price information
 * @property {QuestionType} type - Type of the question
 * @property {Rule[]} [rules] - Optional rules for the question
 * @property {Rule[]} [after_round] - Optional rules to apply after the round
 */

/**
 * @typedef {Object} Rule
 * @property {RuleType} type - Type of the rule
 * @property {string} [content] - Optional content for the rule
 * @property {number} [duration] - Optional duration for the rule
 * @property {string} [path] - Optional path for the rule
 */

/**
 * @typedef {Object} Price
 * @property {string} text - Text representation of the price
 * @property {number} correct - Points for correct answer
 * @property {number} incorrect - Points for incorrect answer
 * @property {RandomRange} random_range - Range for random price selection
 */

/**
 * @typedef {Object} RandomRange
 * @property {number} min - Minimum value
 * @property {number} max - Maximum value
 */

/**
 * @enum {string}
 */
const QuestionType = {
    Normal: 'normal',
    Secret: 'secret',
    Self: 'self',
    Empty: 'empty'
};

/**
 * @enum {string}
 */
const RuleType = {
    App: 'app',
    Embedded: 'embedded'
};

export { QuestionType, RuleType }; 