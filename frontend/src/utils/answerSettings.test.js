import {
  isBuzzAnswerButtonHidden,
  setBuzzAnswerButtonHidden,
} from './answerSettings';

describe('buzz answer settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('persists the hidden Answer button preference', () => {
    expect(isBuzzAnswerButtonHidden()).toBe(false);

    setBuzzAnswerButtonHidden(true);
    expect(isBuzzAnswerButtonHidden()).toBe(true);

    setBuzzAnswerButtonHidden(false);
    expect(isBuzzAnswerButtonHidden()).toBe(false);
  });
});
