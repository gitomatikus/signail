export interface Pack {
  author: string;
  name: string;
  rounds: Round[];
}

export interface Round {
  name: string;
  themes: Theme[];
}

export interface Theme {
  name: string;
  description: string;
  ordered: boolean;
  questions: Question[];
}

export interface Question {
  id: number;
  price?: Price;
  type: QuestionType;
  rules?: Rule[];
  after_round?: Rule[];
  image?: string;
  /** Find-a-cat task text shown to players; supports %total% and %left% placeholders */
  task?: string;
  /** @deprecated Legacy find-a-cat target name (e.g. "котиків"); used when `task` is absent */
  name?: string;
  map?: FindACatArea[];
  duration?: number;
  max_clicks?: number;
  first_place_bonus?: number;
  answer?: number;
  perfect_bonus?: number;
  multiple?: boolean;
  options?: ChoiceOption[];
  effect?: RevealEffect;
  curve?: RevealCurve;
  /** Crocodile scoring mode: 'fastest' (only the quickest correct guesser scores) or 'dixit' (everyone submits a text guess and anyone can score) */
  crocodile_mode?: 'fastest' | 'dixit';
}

export interface ChoiceOption {
  content: string;
  correct: boolean;
}

export type RevealEffect = 'blur' | 'pixelate' | 'zoom';

export type RevealCurve = 'linear' | 'slow-start' | 'fast-start';

export interface FindACatArea {
  left: string;
  top: string;
  width: string;
  height: string;
  style?: {
    background?: string;
    [key: string]: any;
  };
}

export interface Price {
  text: string;
  correct: number;
  incorrect: number;
  random_range: string;
}

export interface Rule {
  type: RuleType;
  content?: string;
  duration?: number;
  path?: string;
}

export enum QuestionType {
  Normal = 'normal',
  Secret = 'secret',
  Empty = 'empty',
  FindACat = 'find-a-cat',
  CloseEnough = 'close-enough',
  Choice = 'choice',
  TextAnswer = 'text-answer',
  ProgressiveReveal = 'progressive-reveal',
  Crocodile = 'crocodile'
}

export enum RuleType {
  App = 'app',
  Embedded = 'embedded'
} 