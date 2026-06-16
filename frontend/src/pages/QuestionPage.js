import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import wsManager from '../utils/websocket';
import OnlineUsers from '../components/OnlineUsers';
import KaraokeQuestion from '../components/KaraokeQuestion';
import ProgressiveImage from '../components/ProgressiveImage';
import ImageLightbox from '../components/ImageLightbox';
import AnswerComposer from '../components/AnswerComposer';
import Settings from '../components/Settings';
import Logo from '../components/Logo';
import config from '../config';
import { getVolume, setGlobalVolume } from '../utils/volumeManager';
import { getHostLayout, HOST_LAYOUT_EVENT } from '../utils/hostLayout';
import { isAutoSubmitSingleChoice } from '../utils/answerSettings';
import { getHostToken } from '../services/gameAuth';
import { useGame } from '../contexts/GameContext';
import { useTranslation } from '../i18n/LanguageContext';

// Sanitize HTML content to allow only safe tags and attributes
const sanitizeHtml = (html) => {
  const allowedTags = ['img', 'video', 'audio', 'source', 'p', 'br', 'strong', 'em', 'u', 'i', 'b'];
  const allowedAttributes = {
    img: ['src', 'alt', 'width', 'height', 'style'],
    video: ['src', 'controls', 'autoplay', 'loop', 'muted', 'width', 'height', 'style'],
    audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'style'],
    source: ['src', 'type'],
    '*': ['style', 'class']
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const sanitizeNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();

      if (!allowedTags.includes(tagName)) {
        return node.textContent;
      }

      const allowedAttrs = allowedAttributes[tagName] || allowedAttributes['*'] || [];
      const sanitizedAttrs = {};

      for (const attr of allowedAttrs) {
        if (node.hasAttribute(attr)) {
          sanitizedAttrs[attr] = node.getAttribute(attr);
        }
      }

      const sanitizedNode = document.createElement(tagName);
      for (const [attr, value] of Object.entries(sanitizedAttrs)) {
        sanitizedNode.setAttribute(attr, value);
      }

      for (const child of node.childNodes) {
        const sanitizedChild = sanitizeNode(child);
        if (typeof sanitizedChild === 'string') {
          sanitizedNode.appendChild(document.createTextNode(sanitizedChild));
        } else {
          sanitizedNode.appendChild(sanitizedChild);
        }
      }

      return sanitizedNode;
    }

    return '';
  };

  const sanitized = sanitizeNode(doc.body);
  return sanitized.innerHTML;
};

// Players must not be able to pause/play/seek question media — only the admin
// controls playback. Strip native controls and block pointer interaction;
// loudness is adjusted with the page-level volume slider instead.
const strippedMediaCache = new Map();
const stripMediaControls = (html) => {
  if (typeof html !== 'string' || (!html.includes('<audio') && !html.includes('<video'))) {
    return html;
  }
  if (strippedMediaCache.has(html)) {
    return strippedMediaCache.get(html);
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('audio, video').forEach((el) => {
    el.removeAttribute('controls');
    el.style.pointerEvents = 'none';
  });
  const result = doc.body.innerHTML;
  strippedMediaCache.set(html, result);
  return result;
};

// Players get audio with controls stripped, so audio-only content renders as
// nothing visible — detect that case to avoid showing an empty question card
const isAudioOnlyContent = (html) => {
  if (typeof html !== 'string' || !html.includes('<audio')) {
    return false;
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('audio').forEach((el) => el.remove());
  if (doc.body.querySelector('img, video')) {
    return false;
  }
  return !(doc.body.textContent || '').trim();
};

// Question types where every player answers independently and several can
// score: one player's answer (or the admin scoring it) must not stop
// question media for everyone else
const MULTI_WINNER_TYPES = ['close-enough', 'choice', 'text-answer', 'find-a-cat', 'voting'];

// Audio/video that belongs to the question content itself (not avatars etc.)
const getQuestionMedia = () =>
  Array.from(document.querySelectorAll('.question-content audio, .question-content video'));

// Programmatic play/pause (buzz auto-pause, applying admin commands) must not
// be re-broadcast as if the admin clicked the controls
const suppressMediaEvents = (el) => { el.__suppressMediaUntil = Date.now() + 400; };
const isMediaEventSuppressed = (el) => !!el.__suppressMediaUntil && Date.now() < el.__suppressMediaUntil;

const QuestionPage = () => {
  const { questionId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // The game host is the admin of their own game; everyone else is a player
  const { gameId, isHost, onlineUsers, pack, packLoading, downloadProgress } = useGame();
  const isAdmin = isHost;
  const isReadOnly = !isHost;
  const boardPath = `/game/${gameId}`;
  // The question comes straight from the in-memory pack (GameContext loads it
  // once per game entry), so rendering needs no per-question I/O at all
  const { question, themeName, roundIndex } = useMemo(() => {
    const qid = parseInt(questionId);
    for (let r = 0; r < (pack?.rounds.length || 0); r++) {
      for (const theme of pack.rounds[r].themes) {
        const q = theme.questions.find(item => item.id === qid);
        if (q) return { question: q, themeName: theme.name || '', roundIndex: r };
      }
    }
    return { question: null, themeName: '', roundIndex: null };
  }, [pack, questionId]);
  const [isQuestionRevealed, setIsQuestionRevealed] = useState(false);
  const [isAnswerRevealed, setIsAnswerRevealed] = useState(false);
  const [isResponseRevealed, setIsResponseRevealed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentRuleIndex, setCurrentRuleIndex] = useState(0);
  const [showAfterRound, setShowAfterRound] = useState(false);
  const [currentAfterRoundIndex, setCurrentAfterRoundIndex] = useState(0);
  const [timer, setTimer] = useState(15);
  const [startTime, setStartTime] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [hasRecordedTime, setHasRecordedTime] = useState(false);
  const [userTimes, setUserTimes] = useState({});
  const [clickedIndices, setClickedIndices] = useState(new Set());
  const [secretSelectorId, setSecretSelectorId] = useState(null);
  const [secretTargetId, setSecretTargetId] = useState(null);
  const [karaokeSelectorId, setKaraokeSelectorId] = useState(null);
  const [karaokeTargetId, setKaraokeTargetId] = useState(null);
  const [crocodileSelectorId, setCrocodileSelectorId] = useState(null);
  const [crocodileTargetId, setCrocodileTargetId] = useState(null);
  const [crocodileResponse, setCrocodileResponse] = useState(null);
  const [clicksLeftMap, setClicksLeftMap] = useState({});
  const [numberAnswers, setNumberAnswers] = useState({});
  const [answersRevealed, setAnswersRevealed] = useState(false);
  // Voting: voterId -> targetUserId (or `true` in closed mode before reveal,
  // meaning "this player voted but the target is still hidden")
  const [votes, setVotes] = useState({});
  const [votesRevealed, setVotesRevealed] = useState(false);
  const [answerInput, setAnswerInput] = useState('');
  const [selectedOptions, setSelectedOptions] = useState(new Set());
  const [lightboxImage, setLightboxImage] = useState(null);
  const [redJudgedUsers, setRedJudgedUsers] = useState(new Set());
  const [mediaVolume, setMediaVolume] = useState(() => getVolume());
  // How the host sees question+answer once both are visible ('split' | 'tabs'),
  // chosen in Settings; players are unaffected
  const [hostLayout, setHostLayoutState] = useState(() => getHostLayout());
  const [hostTab, setHostTab] = useState('question');
  // Whether the host opened the answer tab for this question — used to mount
  // the answer card lazily (its media may autoplay and would spoil the answer
  // audibly) and to keep host-only inline answers hidden until peeked at
  const [hostAnswerSeen, setHostAnswerSeen] = useState(false);
  // Grants already applied; a grant must never be applied twice even if the
  // same broadcast is somehow delivered more than once
  const processedGrantIds = useRef(new Set());
  // True while media is stopped on the admin's command (or after a correct
  // answer): the buzz-resolved auto-resume must not override it
  const adminPausedMediaRef = useRef(false);
  // Media we auto-paused because a buzz is pending; resumed once every buzz
  // is judged wrong
  const autoPausedMediaRef = useRef(new Set());
  // Bumped whenever in-flight state-restore responses must be discarded (the
  // question changed underneath them, or the host reset the question state)
  const hydrationEpochRef = useRef(0);

  useEffect(() => {
    // The question changed: state-restore responses still in flight belong to
    // the previous question and must not be applied
    hydrationEpochRef.current += 1;
    const epoch = hydrationEpochRef.current;

    // Any scroll position carried over from the board would push the
    // question media below the fold on small screens
    window.scrollTo(0, 0);
    setClicksLeftMap({}); // Click budgets are per-question; drop stale entries
    setNumberAnswers({});
    setAnswersRevealed(false);
    setVotes({});
    setVotesRevealed(false);
    setAnswerInput('');
    setSelectedOptions(new Set());
    setCrocodileSelectorId(null);
    setCrocodileTargetId(null);
    setCrocodileResponse(null);
    setRedJudgedUsers(new Set());
    setHostTab('question');
    setHostAnswerSeen(false);
    adminPausedMediaRef.current = false;
    autoPausedMediaRef.current.clear();

    if (!pack) {
      // Direct load/refresh: GameContext is still fetching the pack
      return;
    }
    if (!question) {
      // Stale URL (pack replaced or bad id): nothing to show here
      navigate(boardPath);
      return;
    }

    localStorage.setItem(`currentRoundIndex-${gameId}`, roundIndex.toString());

    // Restore server-side question state (buzz times, submissions, secret
    // assignment, click budgets) in the background - rendering doesn't wait,
    // the question itself is already in memory. Responses only fill in
    // underneath whatever already arrived via the socket or the player's own
    // actions: live data wins over the fetched snapshot.
    const hydrate = async (path, apply) => {
      try {
        const response = await fetch(`${config.apiUrl}/api/games/${gameId}/questions/${questionId}${path}`);
        const result = await response.json();
        if (hydrationEpochRef.current === epoch && result.status === 'success') {
          apply(result.data);
        }
      } catch (error) {
        console.error(`Error fetching question state (${path}):`, error);
      }
    };

    // For cat-in-the-bag, restore who selected it and who answers it (survives refresh)
    if (question.type === 'secret') {
      hydrate('/secret', (data) => {
        setSecretSelectorId(prev => prev || data.selectorId || null);
        setSecretTargetId(prev => prev || data.assignment?.targetUserId || null);
        if (data.revealed) {
          setIsQuestionRevealed(true);
        }
      });
    }

    // For crocodile, restore who picked the performer, who performs and their
    // submitted response (survives refresh for everyone)
    if (question.type === 'crocodile') {
      hydrate('/crocodile', (data) => {
        setCrocodileSelectorId(prev => prev || data.selectorId || null);
        setCrocodileTargetId(prev => prev || data.targetUserId || null);
        setCrocodileResponse(prev => prev || data.response || null);
        if (data.revealed) {
          setIsQuestionRevealed(true);
        }
      });
    }

    // For submission-based types (close-enough numbers, choice picks, text
    // answers, crocodile dixit guesses), restore submissions (masked until
    // reveal; own value included). Crocodile "fastest" mode stores no answers,
    // so the fetch just comes back empty there.
    if (['close-enough', 'choice', 'text-answer', 'crocodile', 'voting'].includes(question.type)) {
      const storedUser = localStorage.getItem('user');
      const myId = storedUser ? JSON.parse(storedUser).id : null;
      const params = new URLSearchParams();
      if (myId) params.set('userId', myId);
      // The host token unmasks voting answers so a host refresh keeps the live view
      const ht = getHostToken(gameId);
      if (ht) params.set('hostToken', ht);
      const query = params.toString() ? `?${params.toString()}` : '';
      hydrate(`/answers${query}`, (data) => {
        setNumberAnswers(prev => ({ ...(data.answers || {}), ...prev }));
        setAnswersRevealed(prev => prev || !!data.revealed);
      });
    }

    // For voting, restore who voted for whom (targets masked in closed mode
    // until revealed; own vote always included)
    if (question.type === 'voting') {
      const storedUser = localStorage.getItem('user');
      const myId = storedUser ? JSON.parse(storedUser).id : null;
      const query = myId ? `?userId=${encodeURIComponent(myId)}` : '';
      hydrate(`/votes${query}`, (data) => {
        setVotes(prev => ({ ...(data.votes || {}), ...prev }));
        setVotesRevealed(prev => prev || !!data.revealed);
      });
    }

    // For find-a-cat with a click limit, restore remaining clicks (survives refresh)
    if (question.type === 'find-a-cat' && question.max_clicks > 0) {
      hydrate('/clicks', (data) => {
        setClicksLeftMap(prev => ({ ...data, ...prev }));
      });
    }

    // Restore times recorded before a refresh/rejoin
    hydrate('/times', (data) => {
      setUserTimes(prev => ({ ...data, ...prev }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, pack, navigate, gameId]);

  useEffect(() => {
    // Apply an admin playback command to the matching media element.
    // Match by index first (same content => same DOM order), fall back to
    // src in case admin and player views differ
    const applyMediaControl = ({ action, time, mediaIndex, src }) => {
      const media = getQuestionMedia();
      let el = media[mediaIndex];
      const srcOf = (m) => m.currentSrc || m.src || '';
      if (src && (!el || srcOf(el) !== src)) {
        el = media.find(m => srcOf(m) === src) || el;
      }
      if (!el) return;
      suppressMediaEvents(el);
      if (action === 'play') {
        adminPausedMediaRef.current = false;
        autoPausedMediaRef.current.delete(el);
        if (typeof time === 'number' && Math.abs(el.currentTime - time) > 0.75) {
          el.currentTime = time;
        }
        el.play().catch(() => {});
      } else if (action === 'pause') {
        adminPausedMediaRef.current = true;
        autoPausedMediaRef.current.delete(el);
        el.pause();
        if (typeof time === 'number') {
          el.currentTime = time;
        }
      } else if (action === 'seek' && typeof time === 'number') {
        el.currentTime = time;
      }
    };

    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'question_reveal' && data.data.questionId === parseInt(questionId)) {
        setIsQuestionRevealed(true);
      } else if (data.type === 'answer_reveal' && data.data.questionId === parseInt(questionId)) {
        setIsAnswerRevealed(true);
        setShowAfterRound(true);
        setCurrentAfterRoundIndex(0);
      } else if (data.type === 'response_reveal' && data.data.questionId === parseInt(questionId)) {
        setIsResponseRevealed(true);
        setShowAfterRound(true);
      } else if (data.type === 'return_to_game') {
        navigate(boardPath);
      } else if (data.type === 'elapsed_time') {
        setUserTimes(prev => ({
          ...prev,
          [data.data.userId]: data.data.elapsedTime
        }));
      } else if (data.type === 'secret_assign' && data.data.questionId === parseInt(questionId)) {
        setSecretTargetId(data.data.targetUserId);
        if (data.data.selectorUserId) {
          setSecretSelectorId(data.data.selectorUserId);
        }
      } else if (data.type === 'karaoke_assign' && data.data.questionId === parseInt(questionId)) {
        setKaraokeTargetId(data.data.targetUserId);
        if (data.data.selectorUserId) {
          setKaraokeSelectorId(data.data.selectorUserId);
        }
      } else if (data.type === 'karaoke_state' && data.data.questionId === parseInt(questionId)) {
        // KaraokeQuestion requests this on mount; assignment state lives here
        // so OnlineUsers can highlight the singer and show award buttons
        if (data.data.targetUserId) {
          setKaraokeTargetId(prev => prev || data.data.targetUserId);
        }
        if (data.data.selectorUserId) {
          setKaraokeSelectorId(prev => prev || data.data.selectorUserId);
        }
      } else if (data.type === 'crocodile_assign' && data.data.questionId === parseInt(questionId)) {
        setCrocodileTargetId(data.data.targetUserId);
        if (data.data.selectorUserId) {
          setCrocodileSelectorId(data.data.selectorUserId);
        }
      } else if (data.type === 'crocodile_response' && data.data.questionId === parseInt(questionId)) {
        setCrocodileResponse(data.data.value);
      } else if (data.type === 'karaoke_start' && data.data.questionId === parseInt(questionId)) {
        // Everyone's countdown follows the performance length
        const durationMs = Number(data.data.durationMs);
        if (Number.isFinite(durationMs) && durationMs > 0) {
          setTimer(Math.ceil(durationMs / 1000));
        }
      } else if (data.type === 'cat_clicks' && data.data.questionId === parseInt(questionId)) {
        // Each client is authoritative for its own clicks; ignore the echo of our own reports
        if (data.data.userId !== currentUserId) {
          setClicksLeftMap(prev => ({ ...prev, [data.data.userId]: data.data.clicksLeft }));
        }
      } else if (data.type === 'cat_clicks_grant' && data.data.questionId === parseInt(questionId)) {
        const { grantId } = data.data;
        const alreadyApplied = grantId !== undefined && processedGrantIds.current.has(grantId);
        if (!alreadyApplied) {
          if (grantId !== undefined) {
            processedGrantIds.current.add(grantId);
          }
          setClicksLeftMap(prev => {
            // No entry yet means the player hasn't clicked: their budget is the full max_clicks
            const base = prev[data.data.userId] ?? (question && question.max_clicks > 0 ? question.max_clicks : null);
            if (base === null) {
              return prev;
            }
            return { ...prev, [data.data.userId]: base + data.data.amount };
          });
        }
      } else if (data.type === 'number_answer_submitted' && data.data.questionId === parseInt(questionId)) {
        // Mark that the player answered; choice picks arrive unmasked so the
        // admin can show results in real time (other types send no value)
        if (data.data.userId !== currentUserId) {
          setNumberAnswers(prev => (
            prev[data.data.userId] === undefined
              ? { ...prev, [data.data.userId]: data.data.value !== undefined ? data.data.value : true }
              : prev
          ));
        }
      } else if (data.type === 'number_answers' && data.data.questionId === parseInt(questionId)) {
        setNumberAnswers(prev => ({ ...prev, ...data.data.answers }));
        setAnswersRevealed(true);
      } else if (data.type === 'vote_cast' && data.data.questionId === parseInt(questionId)) {
        // Another player voted. Open mode carries the target; closed mode only
        // tells us they voted (stored as `true`). Our own vote is tracked
        // optimistically, so ignore the echo. First write wins (votes are final).
        const { voterId, targetUserId } = data.data;
        if (voterId !== currentUserId) {
          setVotes(prev => (
            prev[voterId] !== undefined
              ? prev
              : { ...prev, [voterId]: targetUserId !== undefined ? targetUserId : true }
          ));
        }
      } else if (data.type === 'votes_revealed' && data.data.questionId === parseInt(questionId)) {
        setVotes(prev => ({ ...prev, ...data.data.votes }));
        setVotesRevealed(true);
      } else if (data.type === 'admin_clicked_red_number') {
        // Progressive reveal: a judged-wrong buzz no longer pauses the reveal
        setRedJudgedUsers(prev => new Set([...prev, data.data.userId]));
      } else if (data.type === 'admin_clicked_green_number') {
        // Progressive reveal: a correct answer uncovers the image completely
        if (question?.type === 'progressive-reveal') {
          setTimer(0);
        }
        // A correct answer stops question media for everyone (the admin can
        // still resume playback manually) — except in multi-winner types,
        // where other players may still be answering
        if (!MULTI_WINNER_TYPES.includes(question?.type)) {
          adminPausedMediaRef.current = true;
          autoPausedMediaRef.current.clear();
          getQuestionMedia().forEach((el) => {
            if (!el.paused) {
              suppressMediaEvents(el);
              el.pause();
            }
          });
        }
      } else if (data.type === 'media_control' && data.data.questionId === parseInt(questionId)) {
        // The admin is the playback authority; the admin client ignores the
        // echo of its own commands
        if (!isAdmin) {
          applyMediaControl(data.data);
        }
      } else if (data.type === 'clear_question_times') {
        // The host reset the question: a state-restore response still in
        // flight is now stale and must not resurrect the cleared state
        hydrationEpochRef.current += 1;
        setUserTimes({});
        setElapsedTime(null);
        setHasRecordedTime(false);
        setClickedIndices(new Set());
        setSecretSelectorId(null);
        setSecretTargetId(null);
        setKaraokeSelectorId(null);
        setKaraokeTargetId(null);
        setCrocodileSelectorId(null);
        setCrocodileTargetId(null);
        setCrocodileResponse(null);
        setClicksLeftMap({});
        setNumberAnswers({});
        setAnswersRevealed(false);
        setVotes({});
        setVotesRevealed(false);
        setAnswerInput('');
        setSelectedOptions(new Set());
        setRedJudgedUsers(new Set());
        setHostTab('question');
        setHostAnswerSeen(false);
        adminPausedMediaRef.current = false;
        autoPausedMediaRef.current.clear();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [questionId, navigate, isAdmin, question, currentUserId]);

  useEffect(() => {
    if (!question) return;
    // For cat-in-the-bag, rules don't advance until a player is chosen
    // and (for players) the admin has shown the question
    if (question.type === 'secret' && (!secretTargetId || (!isAdmin && !isQuestionRevealed))) return;

    if (showAfterRound) {
      const afterRoundRules = question.after_round || [];
      if (currentAfterRoundIndex >= afterRoundRules.length) {
        return;
      }

      const currentRule = afterRoundRules[currentAfterRoundIndex];
      const duration = currentRule.duration || 15;
      const timer = setTimeout(() => {
        setCurrentAfterRoundIndex(prev => prev + 1);
      }, duration * 1000);

      return () => clearTimeout(timer);
    } else {
      const rules = question.rules || [];
      if (currentRuleIndex >= rules.length) {
        return;
      }

      const currentRule = rules[currentRuleIndex];
      const duration = currentRule.duration || 15;
      const timer = setTimeout(() => {
        setCurrentRuleIndex(prev => prev + 1);
      }, duration * 1000);

      return () => clearTimeout(timer);
    }
  }, [question, currentRuleIndex, currentAfterRoundIndex, showAfterRound, secretTargetId, isAdmin, isQuestionRevealed]);

  useEffect(() => {
    // For cat-in-the-bag, the countdown waits until a player is chosen
    // and (for players) the admin has shown the question
    if (question?.type === 'secret' && (!secretTargetId || (!isAdmin && !isQuestionRevealed))) {
      return;
    }
    // Crocodile: the guess countdown only runs once the performer's response
    // is on screen for everyone
    if (question?.type === 'crocodile' && !crocodileResponse) {
      return;
    }
    // Progressive reveal: pause while any buzz awaits the admin's verdict
    if (question?.type === 'progressive-reveal'
      && Object.keys(userTimes).some(uid => !redJudgedUsers.has(uid))) {
      return;
    }
    // Start timer immediately for user page, or when question is revealed for admin page
    if (isReadOnly || isQuestionRevealed) {
      const interval = setInterval(() => {
        setTimer((prevTimer) => {
          if (prevTimer <= 0) {
            return 0;
          }
          return prevTimer - 1;
        });
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [isQuestionRevealed, isReadOnly, question, secretTargetId, crocodileResponse, userTimes, redJudgedUsers]);

  // Question audio/video follows the reveal-image rule: while any buzz awaits
  // the admin's verdict, everything pauses; once every buzz is judged wrong,
  // playback continues (unless the admin paused it or the answer was correct).
  // Content-index deps make sure media that appears mid-buzz is paused too.
  useEffect(() => {
    // Multi-winner types have no buzz race: a recorded answer time there
    // only marks a submission and must not pause media for everyone
    if (MULTI_WINNER_TYPES.includes(question?.type)) {
      return;
    }
    const buzzPending = Object.keys(userTimes).some(uid => !redJudgedUsers.has(uid));
    if (buzzPending) {
      getQuestionMedia().forEach((el) => {
        if ((!el.paused || el.autoplay) && !el.ended) {
          suppressMediaEvents(el);
          el.pause();
          autoPausedMediaRef.current.add(el);
        }
      });
    } else {
      if (!adminPausedMediaRef.current) {
        autoPausedMediaRef.current.forEach((el) => {
          if (el.isConnected && el.paused && !el.ended) {
            suppressMediaEvents(el);
            el.play().catch(() => {});
          }
        });
      }
      autoPausedMediaRef.current.clear();
    }
  }, [userTimes, redJudgedUsers, currentRuleIndex, currentAfterRoundIndex, showAfterRound, question]);

  // The admin's native controls drive playback for everyone: relay every
  // user-initiated play/pause/seek on question media to all clients
  useEffect(() => {
    if (!isAdmin) return;
    const handleMediaEvent = (event) => {
      const el = event.target;
      if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
      if (!el.closest || !el.closest('.question-content')) return;
      if (isMediaEventSuppressed(el)) return;
      if (event.type === 'pause' && el.ended) return; // ran out, not an admin pause
      const action = event.type === 'seeked' ? 'seek' : event.type;
      if (action === 'play') adminPausedMediaRef.current = false;
      if (action === 'pause') adminPausedMediaRef.current = true;
      wsManager.sendMediaControl(parseInt(questionId), {
        action,
        time: el.currentTime,
        mediaIndex: getQuestionMedia().indexOf(el),
        src: el.currentSrc || el.src || ''
      });
    };
    const events = ['play', 'pause', 'seeked'];
    events.forEach(type => document.addEventListener(type, handleMediaEvent, true));
    return () => events.forEach(type => document.removeEventListener(type, handleMediaEvent, true));
  }, [isAdmin, questionId]);

  // Whether any of this question's content embeds audio/video — if so,
  // players get a volume slider (their only media control)
  const questionHasMedia = useMemo(() => {
    if (!question) return false;
    // Karaoke always carries audio: the slider is the listener's loudness and
    // the singer's private monitor volume
    if (question.type === 'karaoke') return true;
    const chunks = [
      ...(question.rules || []).map(r => r.content),
      ...(question.after_round || []).map(r => r.content),
      ...(question.options || []).map(o => o.content)
    ];
    return chunks.some(c => typeof c === 'string' && (c.includes('<audio') || c.includes('<video')));
  }, [question]);

  const handleVolumeChange = (event) => {
    const value = parseFloat(event.target.value);
    if (!Number.isFinite(value)) return;
    setMediaVolume(value);
    setGlobalVolume(value);
  };

  // Helper to calculate total duration from question rules
  const getInitialTimerValue = (question) => {
    if (!question) return 15;
    if (question.type === 'find-a-cat') {
      return question.duration || 60;
    }
    if (question.type === 'close-enough' && question.duration) {
      return question.duration;
    }
    if (question.type === 'progressive-reveal') {
      return question.duration || 60;
    }
    if (question.type === 'crocodile') {
      // Guess countdown, only relevant once the response is shown
      return question.duration || 30;
    }
    if (question.type === 'voting') {
      // Answer-writing window; informational, the host reveals when ready
      return question.duration || 60;
    }
    if (question.type === 'karaoke') {
      // Placeholder while the singer gets ready; karaoke_start resets the
      // countdown to the actual track length
      return 120;
    }
    if (!question.rules || question.rules.length === 0) return 15;
    return question.rules.reduce((sum, rule) => sum + (rule.duration || 15), 0);
  };

  // Reset timer when question page is opened or question is revealed
  useEffect(() => {
    setTimer(getInitialTimerValue(question));
  }, [questionId, isQuestionRevealed, question]);

  // Crocodile: give the guessers a fresh countdown the moment the performer's
  // response lands (that is when their buzz phase begins)
  useEffect(() => {
    if (question?.type === 'crocodile' && crocodileResponse) {
      setTimer(getInitialTimerValue(question));
    }
  }, [crocodileResponse, question]);

  // Get current user from localStorage
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        const userData = JSON.parse(storedUser);
        setCurrentUserId(userData.id);
      } catch (error) {
        console.error('Error parsing stored user data:', error);
      }
    }
  }, []);

  // React to the host changing the layout in Settings while on this page
  useEffect(() => {
    const onLayoutChange = () => setHostLayoutState(getHostLayout());
    window.addEventListener(HOST_LAYOUT_EVENT, onLayoutChange);
    return () => window.removeEventListener(HOST_LAYOUT_EVENT, onLayoutChange);
  }, []);

  // Add keyboard event listener for space and right arrow
  useEffect(() => {
    const handleKeyPress = (event) => {
      if (['find-a-cat', 'close-enough', 'choice', 'text-answer', 'karaoke', 'voting'].includes(question?.type)) {
        return; // These types answer by clicking/typing/singing, not by racing on the spacebar
      }
      if (event.code !== 'Space' && event.code !== 'ArrowRight') {
        return;
      }
      // Typing a space in a field or activating a focused button must keep
      // its normal meaning — the buzz keys only apply outside form controls
      const target = event.target;
      if (target instanceof HTMLElement && (
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable
      )) {
        return;
      }
      // Space pages the window down by default; buzzing must not scroll
      event.preventDefault();
      if (question?.type === 'secret') {
        // Only the chosen player can answer a cat-in-the-bag question,
        // and only after the admin has shown the question
        if (!secretTargetId || (!isAdmin && (currentUserId !== secretTargetId || !isQuestionRevealed))) {
          return;
        }
      }
      if (question?.type === 'crocodile') {
        // Buzzing is only for the "fastest" mode; in "dixit" mode guessers
        // submit a text answer instead. Only guessers buzz, and only once the
        // performer's response is shown. The performer and host never guess.
        const crocodileMode = question.crocodile_mode || 'fastest';
        if (crocodileMode === 'dixit' || !crocodileResponse || isAdmin || currentUserId === crocodileTargetId) {
          return;
        }
      }
      if (startTime &&
        ((isAdmin && isQuestionRevealed && !isAnswerRevealed) || (!isAdmin && !isAnswerRevealed)) &&
        !hasRecordedTime &&
        !userTimes[currentUserId]) {
        const endTime = Date.now();
        const timeTaken = (endTime - startTime) / 1000; // Convert to seconds
        setElapsedTime(timeTaken);
        setHasRecordedTime(true);
        // Send elapsed time to other users
        wsManager.sendElapsedTime(parseInt(questionId), timeTaken, currentUserId);
        console.log('=== SCORE LOG ===');
        console.log(`Score: ${question?.price?.correct || 0} points`);
        console.log(`Time taken: ${timeTaken.toFixed(3)} seconds`);
        console.log('================');
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isQuestionRevealed, isAnswerRevealed, startTime, question, isAdmin, hasRecordedTime, questionId, currentUserId, userTimes, secretTargetId, crocodileResponse, crocodileTargetId]);

  // Start timer when question is revealed or when non-admin user sees the question
  // For cat-in-the-bag, wait until a player is chosen and the admin shows the question
  useEffect(() => {
    // The buzz clock starts only once there is question content on screen -
    // on a hard refresh the pack may still be loading
    if (!question) {
      return;
    }
    if (question.type === 'secret' && (!secretTargetId || (!isAdmin && !isQuestionRevealed))) {
      return;
    }
    // Crocodile: the buzz clock starts only once the performer's response is in
    if (question.type === 'crocodile' && !crocodileResponse) {
      return;
    }
    if ((isAdmin && isQuestionRevealed && !isAnswerRevealed) || (!isAdmin && !isAnswerRevealed)) {
      console.log('Starting timer at:', new Date().toISOString());
      setStartTime(Date.now());
      setElapsedTime(null);
      setHasRecordedTime(false);
      setUserTimes({}); // Reset all user times when starting new question
      setClickedIndices(new Set()); // Reset clicked indices for new question!
    }
  }, [question, isQuestionRevealed, isAnswerRevealed, isAdmin, secretTargetId, crocodileResponse]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync clickedIndices when page is loaded/refreshed and user has already recorded time
  useEffect(() => {
    if (currentUserId && userTimes[currentUserId] !== undefined && question && question.type === 'find-a-cat' && question.map) {
      setHasRecordedTime(true);
      setClickedIndices(new Set(question.map.map((_, i) => i)));
    }
  }, [userTimes, currentUserId, question]);

  const handleShowQuestion = () => {
    if (isAdmin && question) {
      wsManager.sendQuestionReveal(question.id);
      setIsQuestionRevealed(true);
      // find-a-cat, crocodile and voting reveal the answer(s) in a separate
      // step; every other type shows question + answer together
      if (question.type !== 'find-a-cat' && question.type !== 'crocodile' && question.type !== 'voting') {
        setIsAnswerRevealed(true);
        setShowAfterRound(true);
        setCurrentAfterRoundIndex(0);
      } else {
        setIsAnswerRevealed(false);
        setShowAfterRound(false);
      }
    }
  };

  const handleShowAnswer = () => {
    if (isAdmin && question) {
      wsManager.sendAnswerReveal(question.id);
      setIsAnswerRevealed(true);
      setShowAfterRound(true);
      setCurrentAfterRoundIndex(0);
    }
  };

  const handleShowAfterRound = () => {
    if (isAdmin && question) {
      // For choice the admin already sees picks live, so there is no separate
      // "Show Result" step: revealing the response also publishes everyone's
      // picks to the players and stops further submissions
      if (question.type === 'choice' && !answersRevealed) {
        wsManager.sendRevealNumberAnswers(parseInt(questionId));
      }
      wsManager.sendResponseReveal(question.id);
      setIsResponseRevealed(true);
      setShowAfterRound(true);
      setCurrentAfterRoundIndex(0);
    }
  };

  const handleReturnToGame = () => {
    if (isAdmin) {
      wsManager.sendReturnToGame();
      navigate(boardPath);
    }
  };

  // Only a direct load/refresh waits here (the pack is being read from
  // IndexedDB or re-downloaded); in-game navigation renders instantly
  if (packLoading || !question) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{
          width: 48,
          height: 48,
          border: '4px solid var(--glass-border)',
          borderTopColor: 'var(--primary)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          marginBottom: '1rem'
        }} />
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.25rem' }}>
          {typeof downloadProgress === 'number' && downloadProgress >= 0
            ? `${t('common.loading')} ${downloadProgress}%`
            : t('common.loading')}
        </div>
      </div>
    );
  }
  if (!question) return null;

  const pageStyle = {
    padding: 0,
    margin: 0,
    width: '100vw',
    minHeight: '100vh',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  };
  // Wider than the 1200px page chrome: on big monitors the extra width goes
  // to question media so wide images can actually use the screen
  const boardGridStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '1.5rem',
    padding: '2rem',
    borderRadius: '16px',
    margin: '0 auto',
    width: '100%',
    maxWidth: 'min(1600px, 100%)',
  };
  const cardStyle = {
    color: 'var(--text-primary)',
    fontWeight: '600',
    fontSize: '1.3rem',
    textAlign: 'center',
    borderRadius: '16px',
    margin: '0',
    padding: '2rem',
    border: '1px solid var(--glass-border)',
    userSelect: 'text',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '200px',
    background: 'var(--glass-bg)',
    boxShadow: 'var(--glass-shadow)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    position: 'relative',
  };
  // Small pill pinned to the card's top-left corner ("Запитання" / "Відповідь")
  const cardBadgeStyle = {
    position: 'absolute',
    top: '0.75rem',
    left: '0.75rem',
    fontSize: '0.7rem',
    fontWeight: '600',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
    border: '1px solid var(--accent-line)',
    padding: '0.2rem 0.6rem',
    borderRadius: '999px',
    userSelect: 'none'
  };
  const themeHeaderStyle = {
    color: 'var(--text-primary)',
    fontWeight: '700',
    fontSize: '1.5rem',
    textAlign: 'center',
    borderRadius: '12px',
    margin: '0',
    padding: '1rem',
    background: 'var(--bg-dark)',
    border: '1px solid var(--glass-border)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    userSelect: 'none'
  };

  // Sizing only — visuals come from the .btn-primary / .btn-danger classes
  const buttonStyle = {
    padding: '0.75rem 1.5rem',
    fontSize: '1rem'
  };

  // The admin keeps native media controls; players get media stripped of them
  const renderHtmlContent = (content) => (isAdmin ? content : stripMediaControls(content));

  const renderRule = (rule) => {
    if (rule.type === 'embedded') {
      return (
        <div
          className="question-content"
          style={{ color: 'var(--text-primary)', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
          dangerouslySetInnerHTML={{ __html: renderHtmlContent(rule.content) }}
        />
      );
    } else if (rule.type === 'app') {
      return (
        <div style={{ color: 'var(--text-primary)', fontSize: '1.1rem' }}>
          {t('question.loadingApp', { path: rule.path })}
        </div>
      );
    }
    return null;
  };



  // Find-a-cat click budget: every click (hit or miss) consumes one click
  const hasClickLimit = question?.type === 'find-a-cat' && Number(question?.max_clicks) > 0;
  const myClicksLeft = hasClickLimit ? (clicksLeftMap[currentUserId] ?? question.max_clicks) : Infinity;
  const isOutOfClicks = hasClickLimit && !isAdmin && myClicksLeft <= 0;

  const consumeClick = () => {
    if (!hasClickLimit || isAdmin || !currentUserId) {
      return;
    }
    const newLeft = Math.max(0, myClicksLeft - 1);
    setClicksLeftMap(prev => ({ ...prev, [currentUserId]: newLeft }));
    wsManager.sendCatClicks(parseInt(questionId), currentUserId, newLeft);
  };

  const handleAreaClick = (e, index) => {
    e.stopPropagation(); // Don't let the container's miss handler count this click too
    if (isAnswerRevealed || hasRecordedTime || (currentUserId && userTimes[currentUserId])) {
      return;
    }
    if (clickedIndices.has(index)) {
      return;
    }
    if (isOutOfClicks) {
      return;
    }

    const newClicked = new Set(clickedIndices);
    newClicked.add(index);
    setClickedIndices(newClicked);

    if (isAdmin) {
      // Admin doesn't submit time
      return;
    }

    consumeClick();

    const totalAreas = question.map ? question.map.length : 0;
    const remaining = totalAreas - newClicked.size;

    if (remaining === 0) {
      const endTime = Date.now();
      const timeTaken = (endTime - startTime) / 1000;
      setElapsedTime(timeTaken);
      setHasRecordedTime(true);
      wsManager.sendElapsedTime(parseInt(questionId), timeTaken, currentUserId);
      console.log('=== SCORE LOG (Find a Cat) ===');
      console.log(`Score: ${question?.price?.correct || 0} points`);
      console.log(`Time taken: ${timeTaken.toFixed(3)} seconds`);
      console.log('================');
    }
  };

  const handleMissClick = () => {
    if (!hasClickLimit || isAdmin) {
      return;
    }
    if (isAnswerRevealed || hasRecordedTime || (currentUserId && userTimes[currentUserId])) {
      return;
    }
    if (myClicksLeft <= 0) {
      return;
    }
    consumeClick();
  };

  const renderFindACatContent = () => {
    const totalAreas = question.map ? question.map.length : 0;
    const remainingCount = totalAreas - clickedIndices.size;
    const hasFailed = isOutOfClicks && remainingCount > 0;
    // `task` is full text with optional %total%/%left% placeholders;
    // legacy packs only have `name` ("котиків") and keep the old wording
    const taskTemplate = question.task
      ? question.task
      : t('question.findTaskLegacy', { name: question.name || '' });
    const renderTaskText = (left) => taskTemplate
      .replace(/%total%/g, String(totalAreas))
      .replace(/%left%/g, String(left));
    const successText = question.task
      ? t('question.foundAll')
      : t('question.foundAllLegacy', { name: question.name || '' });

    const playField = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '1.5rem' }}>
        {/* Helper message */}
        <div className="glass-panel" style={{
          padding: '1rem 2rem',
          fontSize: '1.4rem',
          fontWeight: '700',
          color: 'var(--text-primary)',
          textAlign: 'center',
          border: hasFailed ? '1px solid #ef4444' : '1px solid var(--glass-border)',
          width: '100%',
          maxWidth: '800px',
          boxShadow: hasFailed ? '0 0 20px rgba(239, 68, 68, 0.4)' : 'var(--glass-shadow)',
          textShadow: '0 2px 4px rgba(0,0,0,0.3)'
        }}>
          {hasFailed ? (
            <span style={{ color: '#ef4444' }}>{t('question.outOfClicks')}</span>
          ) : remainingCount > 0 ? (
            renderTaskText(remainingCount)
          ) : (
            successText
          )}
          {hasClickLimit && !isAdmin && !hasFailed && remainingCount > 0 && (
            <div style={{
              fontSize: '1.1rem',
              marginTop: '0.5rem',
              color: myClicksLeft <= 2 ? '#ef4444' : 'var(--text-secondary)'
            }}>
              {t('question.clicksLeft', { count: myClicksLeft })}
            </div>
          )}
        </div>

        {/* Image Container with map areas; container clicks are misses that consume the budget.
            The container shrink-wraps the image (no fixed width) so the %-based
            map areas always line up with the picture; the image itself is capped
            to the viewport so the whole play field is visible without scrolling */}
        <div
          onClick={handleMissClick}
          style={{
            position: 'relative',
            display: 'inline-block',
            maxWidth: '100%',
            borderRadius: '16px',
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
            border: '1px solid var(--glass-border)'
          }}>
          <img
            src={question.image}
            alt={question.task || question.name}
            className="question-media"
            style={{
              maxWidth: '100%',
              maxHeight: 'max(calc(100vh - 500px), 320px)',
              width: 'auto',
              height: 'auto',
              display: 'block',
              userSelect: 'none',
              pointerEvents: 'none'
            }}
          />
          {/* Overlay Map Areas */}
          {question.map && question.map.map((area, idx) => {
            const isClicked = clickedIndices.has(idx);
            const showArea = isAnswerRevealed || isClicked; // Show area if answer is revealed or if the user clicked it

            // Determine custom styles and colors from map area
            let backgroundColor = 'transparent';
            let border = 'none';
            let boxShadow = 'none';

            if (showArea) {
              const style = area.style || {};
              const customBg = style.background || style.backgroundColor || area.background || area.color;
              
              let bg = 'rgba(239, 68, 68, 0.1)';
              let borderStyle = '2px solid #ef4444';
              let shadowStyle = '0 0 12px rgba(239, 68, 68, 0.6)';

              if (customBg) {
                // Try to determine a solid base color to use for border/shadow if not overridden
                let solidColor = customBg;
                if (typeof customBg === 'string') {
                  const rgbaMatch = customBg.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
                  if (rgbaMatch) {
                    solidColor = `rgb(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]})`;
                  } else if (customBg.startsWith('#') && customBg.length === 9) {
                    solidColor = customBg.substring(0, 7);
                  }
                }

                bg = `color-mix(in srgb, ${solidColor} 10%, transparent)`;
                borderStyle = `2px solid ${solidColor}`;
                shadowStyle = `0 0 12px ${solidColor}`;
              }

              if (style.border) {
                borderStyle = style.border;
              } else if (style.borderColor) {
                borderStyle = `2px solid ${style.borderColor}`;
              } else if (area.borderColor) {
                borderStyle = `2px solid ${area.borderColor}`;
              }

              if (style.boxShadow) {
                shadowStyle = style.boxShadow;
              }

              backgroundColor = bg;
              border = borderStyle;
              boxShadow = shadowStyle;
            }

            const areaStyle = {
              position: 'absolute',
              left: area.left,
              top: area.top,
              width: area.width,
              height: area.height,
              cursor: 'default',
              backgroundColor,
              border,
              boxShadow,
              borderRadius: '8px',
              transition: 'background-color 0.2s, border 0.2s, box-shadow 0.2s',
              // Disable clicks if already clicked, answer revealed, out of clicks, or current user has recorded time (unless admin, who can click for demo, but only if not revealed yet)
              pointerEvents: isClicked || isAnswerRevealed || (!isAdmin && hasRecordedTime) || isOutOfClicks ? 'none' : 'auto'
            };

            return (
              <div
                key={idx}
                style={areaStyle}
                onClick={(e) => handleAreaClick(e, idx)}
                title={isAdmin && isAnswerRevealed ? t('question.area', { n: idx + 1 }) : ''}
              />
            );
          })}
        </div>

      </div>
    );

    const afterRoundRules = question.after_round || [];
    if (showAfterRound && afterRoundRules.length > 0) {
      const lastRuleIndex = Math.min(currentAfterRoundIndex, afterRoundRules.length - 1);
      const answerCard = renderRuleCard(afterRoundRules[lastRuleIndex], t('question.answerLabel'));
      // The host gets the same question | answer design as normal questions
      if (isAdmin && isQuestionRevealed) {
        const questionCard = (
          <div style={cardStyle}>
            <div style={cardBadgeStyle}>{t('question.questionLabel')}</div>
            {playField}
          </div>
        );
        return renderHostQuestionAnswer(questionCard, answerCard);
      }
      // Players keep the play field on screen with the answer below it
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '16px' }}>
          {playField}
          {answerCard}
        </div>
      );
    }

    return playField;
  };

  const handleSecretAssign = (targetUserId) => {
    if (secretTargetId) {
      return;
    }
    wsManager.sendSecretAssign(parseInt(questionId), targetUserId, secretSelectorId);
  };

  const renderSecretContent = () => {
    const targetUser = onlineUsers.find(u => u.id === secretTargetId);
    const selectorUser = onlineUsers.find(u => u.id === secretSelectorId);
    // The selector picks who answers; admin can always assign as a host override
    const canAssign = isAdmin || (currentUserId && currentUserId === secretSelectorId);

    if (!secretTargetId) {
      const pendingPanel = (
        <div style={cardStyle}>
          <div style={{ fontSize: '4rem', marginBottom: '0.5rem' }}>🐱</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: '#ffd600', marginBottom: '1rem', textShadow: '0 0 20px rgba(255, 214, 0, 0.4)' }}>
            {t('question.secretTitle')}
          </div>
          <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            {canAssign
              ? t('question.choosePlayer')
              : selectorUser
                ? t('question.selectorChoosing', { name: selectorUser.name })
                : t('question.waitingChoice')}
          </div>
          {/* Everyone sees the candidates; only the selector and admin can click */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {onlineUsers.filter(u => u.id !== secretSelectorId).map(u => (
              <div
                key={u.id}
                onClick={canAssign ? () => handleSecretAssign(u.id) : undefined}
                style={{
                  cursor: canAssign ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem',
                  borderRadius: '12px',
                  border: '1px solid var(--glass-border)',
                  background: 'var(--bg-dark)',
                  transition: 'all 0.2s',
                  width: '110px'
                }}
                onMouseEnter={canAssign ? e => {
                  e.currentTarget.style.border = '1px solid var(--primary)';
                  e.currentTarget.style.boxShadow = '0 0 16px var(--primary-glow)';
                } : undefined}
                onMouseLeave={canAssign ? e => {
                  e.currentTarget.style.border = '1px solid var(--glass-border)';
                  e.currentTarget.style.boxShadow = 'none';
                } : undefined}
              >
                {u.imageUrl && u.imageUrl.toLowerCase().endsWith('.mp4') ? (
                  <video
                    src={u.imageUrl}
                    style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }}
                    autoPlay loop muted playsInline
                  />
                ) : (
                  <img
                    src={u.imageUrl}
                    alt={u.name}
                    style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }}
                  />
                )}
                <span style={{ fontSize: '1rem', fontWeight: '600', textAlign: 'center', wordBreak: 'break-word' }}>
                  {u.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      );

      // Admin still sees the question below the picker; players only see the panel
      if (isAdmin) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {pendingPanel}
            {renderNormalContent()}
          </div>
        );
      }
      return pendingPanel;
    }

    // Player chosen: admins see the question right away, players wait
    // until the admin presses "Show Question"
    const showQuestionContent = isAdmin || isQuestionRevealed;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{
          ...themeHeaderStyle,
          color: '#ffd600',
          textShadow: '0 0 20px rgba(255, 214, 0, 0.4)'
        }}>
          {t('question.secretAnswering', { name: targetUser ? targetUser.name : '...' })}
        </div>
        {showQuestionContent ? (
          renderNormalContent()
        ) : (
          <div style={cardStyle}>
            <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
              {t('question.waitingReveal')}
            </div>
          </div>
        )}
      </div>
    );
  };

  const handleSubmitNumberAnswer = () => {
    const value = parseFloat(answerInput);
    if (!Number.isFinite(value) || !currentUserId) {
      return;
    }
    if (answersRevealed || timer <= 0 || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: value }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, value);
  };

  const renderCloseEnoughContent = () => {
    const myAnswer = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myAnswer !== undefined;
    const acceptingAnswers = !answersRevealed && timer > 0;
    // In tabs mode the host plays along: keep the numeric answer hidden until
    // they open the Answer tab (only when this question has one to open)
    const hostAnswerHidden = hostLayout === 'tabs'
      && (question.after_round || []).length > 0
      && !hostAnswerSeen;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}

        {/* The correct answer stays hidden until the admin presses "Show Response",
            so the numbers can be revealed without spoiling a reusable question */}
        {isResponseRevealed && question.answer !== undefined && (
          <div style={{
            ...themeHeaderStyle,
            color: '#4ade80',
            textShadow: '0 0 20px rgba(74, 222, 128, 0.4)'
          }}>
            {t('question.correctAnswer')} {question.answer}
          </div>
        )}

        {isAdmin && !isResponseRevealed && question.answer !== undefined && !hostAnswerHidden && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            {t('question.answerHostOnly')} <b style={{ color: '#4ade80' }}>{question.answer}</b>
          </div>
        )}

        {!isAdmin && (
          <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
            {hasSubmitted ? (
              <div style={{ fontSize: '1.3rem' }}>
                {t('question.yourAnswer')} <b style={{ color: 'var(--accent)' }}>{myAnswer === true ? '✓' : myAnswer}</b>
              </div>
            ) : acceptingAnswers ? (
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
                <input
                  type="number"
                  value={answerInput}
                  onChange={(e) => setAnswerInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitNumberAnswer(); }}
                  placeholder={t('question.yourNumber')}
                  style={{
                    fontSize: '1.25rem',
                    padding: '0.6rem 1rem',
                    borderRadius: '8px',
                    border: '1px solid var(--glass-border)',
                    background: 'var(--input-bg)',
                    color: 'var(--text-primary)',
                    width: '200px',
                    textAlign: 'center'
                  }}
                />
                <button
                  onClick={handleSubmitNumberAnswer}
                  className="btn-primary"
                  style={{ ...buttonStyle, opacity: Number.isFinite(parseFloat(answerInput)) ? 1 : 0.5 }}
                  disabled={!Number.isFinite(parseFloat(answerInput))}
                >
                  {t('question.submitAnswer')}
                </button>
              </div>
            ) : (
              <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
                {t('question.timeUp')}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Record the moment a player locked in their answer (same as a spacebar press)
  const recordAnswerTime = () => {
    if (hasRecordedTime || (currentUserId && userTimes[currentUserId]) || !startTime) {
      return;
    }
    const timeTaken = (Date.now() - startTime) / 1000;
    setElapsedTime(timeTaken);
    setHasRecordedTime(true);
    wsManager.sendElapsedTime(parseInt(questionId), timeTaken, currentUserId);
  };

  const submitChoicePicks = (picks) => {
    if (!currentUserId || picks.length === 0) {
      return;
    }
    if (answersRevealed || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    const sorted = [...picks].sort((a, b) => a - b);
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: sorted }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, sorted);
    recordAnswerTime();
  };

  const handleToggleOption = (idx) => {
    if (answersRevealed || (currentUserId && numberAnswers[currentUserId] !== undefined)) {
      return;
    }
    // Opt-in setting: a single-choice pick is the whole answer, so send it
    // right away instead of waiting for the Confirm button
    if (!question.multiple && isAutoSubmitSingleChoice()) {
      setSelectedOptions(new Set([idx]));
      submitChoicePicks([idx]);
      return;
    }
    setSelectedOptions(prev => {
      const next = new Set(prev);
      if (question.multiple) {
        if (next.has(idx)) {
          next.delete(idx);
        } else {
          next.add(idx);
        }
      } else {
        next.clear();
        next.add(idx);
      }
      return next;
    });
  };

  const handleConfirmChoice = () => {
    submitChoicePicks([...selectedOptions]);
  };

  const renderChoiceContent = () => {
    const myPicks = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myPicks !== undefined;
    const showCorrect = isAdmin || isResponseRevealed;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}

        <div className="choice-options-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: '1rem'
        }}>
          {(question.options || []).map((option, idx) => {
            const isSelected = hasSubmitted
              ? (Array.isArray(myPicks) && myPicks.includes(idx))
              : selectedOptions.has(idx);
            const highlightCorrect = showCorrect && option.correct;

            return (
              <div
                key={idx}
                onClick={() => !isAdmin && handleToggleOption(idx)}
                style={{
                  ...cardStyle,
                  minHeight: 'auto',
                  padding: '1rem',
                  flexDirection: 'row',
                  gap: '0.75rem',
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  cursor: !isAdmin && !hasSubmitted && !answersRevealed ? 'pointer' : 'default',
                  border: highlightCorrect
                    ? '2px solid #4ade80'
                    : isSelected
                      ? '2px solid var(--primary)'
                      : '1px solid var(--glass-border)',
                  boxShadow: highlightCorrect
                    ? '0 0 16px rgba(74, 222, 128, 0.4)'
                    : isSelected
                      ? '0 0 16px var(--primary-glow)'
                      : 'var(--glass-shadow)'
                }}
              >
                <div style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: highlightCorrect ? '#4ade80' : isSelected ? 'var(--primary)' : 'var(--bg-dark)',
                  // Dark numeral on the bright "correct" chip, theme-defined
                  // contrast color on the selected chip
                  color: highlightCorrect ? '#0e3318' : isSelected ? 'var(--on-primary)' : 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: '700',
                  fontSize: '0.95rem'
                }}>
                  {idx + 1}
                </div>
                <div
                  className="question-content"
                  style={{ color: 'var(--text-primary)', fontSize: '1.05rem', flex: 1, minWidth: 0 }}
                  dangerouslySetInnerHTML={{ __html: renderHtmlContent(option.content) }}
                />
                {isSelected && (
                  <div style={{ color: 'var(--primary)', fontWeight: '800', fontSize: '1.2rem', flexShrink: 0 }}>✓</div>
                )}
              </div>
            );
          })}
        </div>

        {!isAdmin && !hasSubmitted && !answersRevealed && (
          <button
            onClick={handleConfirmChoice}
            className="btn-primary"
            style={{
              ...buttonStyle,
              alignSelf: 'center',
              opacity: selectedOptions.size > 0 ? 1 : 0.5
            }}
            disabled={selectedOptions.size === 0}
          >
            {t('question.confirmAnswer')}
          </button>
        )}
        {!isAdmin && hasSubmitted && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            {t('question.answerAccepted')}
          </div>
        )}
      </div>
    );
  };

  // Record a text-field answer (text, image data URL or audio data URL). The
  // composer in AnswerComposer builds the value; this just submits it.
  const handleSubmitTextAnswer = (value) => {
    if (!currentUserId || !value) {
      return;
    }
    if (answersRevealed || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: value }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, value);
    recordAnswerTime();
  };

  // A submitted text-field value: an image, an audio clip, or plain text
  const renderAnswerValue = (value, { imgMaxWidth = 300, imgMaxHeight = 200, audioWidth = 320 } = {}) => {
    if (typeof value === 'string' && value.startsWith('data:image')) {
      return (
        <img
          src={value}
          alt="answer"
          title={t('question.clickToEnlarge')}
          onClick={() => setLightboxImage(value)}
          style={{ maxWidth: imgMaxWidth, maxHeight: imgMaxHeight, borderRadius: '8px', cursor: 'zoom-in' }}
        />
      );
    }
    if (typeof value === 'string' && value.startsWith('data:audio')) {
      return <audio controls src={value} style={{ maxWidth: audioWidth, width: '100%' }} />;
    }
    return (
      <div style={{ fontSize: '1.2rem', color: 'var(--accent)', fontWeight: '700', wordBreak: 'break-word' }}>
        {value === true ? '✓' : value}
      </div>
    );
  };

  const renderTextAnswerContent = () => {
    const myAnswer = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myAnswer !== undefined;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}

        {!isAdmin && (
          <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
            {hasSubmitted ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>{t('question.yourAnswer')}</div>
                {renderAnswerValue(myAnswer)}
              </div>
            ) : (
              <AnswerComposer
                key={`text-answer-${questionId}`}
                onSubmit={handleSubmitTextAnswer}
                onPreviewImage={setLightboxImage}
                submitLabel={t('question.submitAnswer')}
                buttonStyle={buttonStyle}
              />
            )}
          </div>
        )}
      </div>
    );
  };

  // Voting: submit an answer (text/image/audio). Unlike text-answer this
  // records no buzz time — there is no race, everyone answers, then votes.
  const handleSubmitVotingAnswer = (value) => {
    if (!currentUserId || !value) {
      return;
    }
    if (answersRevealed || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: value }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, value);
  };

  // Cast a final vote for another player's answer
  const handleCastVote = (targetUserId) => {
    if (!currentUserId || targetUserId === currentUserId || votesRevealed) {
      return;
    }
    const myVote = votes[currentUserId];
    if (myVote !== undefined && myVote !== true) {
      return; // one vote, final
    }
    setVotes(prev => ({ ...prev, [currentUserId]: targetUserId })); // optimistic
    wsManager.sendCastVote(parseInt(questionId), currentUserId, targetUserId);
  };

  const renderVotingContent = () => {
    const voteMode = question.vote_mode === 'closed' ? 'closed' : 'open';
    const myAnswer = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myAnswer !== undefined;
    const myVote = currentUserId ? votes[currentUserId] : undefined;
    const hasVoted = myVote !== undefined && myVote !== true;
    // Open voting shows tallies live; closed voting hides them (from everyone,
    // host included) until the host reveals. Counts are only meaningful once
    // voting is open (answers revealed).
    const showVoteCounts = answersRevealed && (voteMode === 'open' || votesRevealed);

    const voteCounts = {};
    if (showVoteCounts) {
      Object.values(votes).forEach(target => {
        if (typeof target === 'string') {
          voteCounts[target] = (voteCounts[target] || 0) + 1;
        }
      });
    }
    const maxVotes = showVoteCounts
      ? Object.values(voteCounts).reduce((m, n) => Math.max(m, n), 0)
      : 0;

    // Only real submissions render a card; masked entries are `true`. The host
    // gets unmasked answers live, so its grid fills in during collection too.
    const answerEntries = Object.entries(numberAnswers).filter(([, v]) => v !== undefined && v !== true);

    const renderAnswerCard = (uid, val) => {
      const author = onlineUsers.find(u => u.id === uid);
      const isOwn = uid === currentUserId;
      const count = voteCounts[uid] || 0;
      const votedForThis = hasVoted && myVote === uid;
      const canVote = !isAdmin && answersRevealed && !votesRevealed && !hasVoted && !isOwn;
      const isWinner = showVoteCounts && count > 0 && count === maxVotes;

      return (
        <div
          key={uid}
          onClick={canVote ? () => handleCastVote(uid) : undefined}
          style={{
            ...cardStyle,
            minHeight: 'auto',
            padding: '1rem',
            gap: '0.75rem',
            cursor: canVote ? 'pointer' : 'default',
            border: votedForThis
              ? '2px solid var(--primary)'
              : isWinner
                ? '2px solid #fbbf24'
                : '1px solid var(--glass-border)',
            boxShadow: votedForThis
              ? '0 0 16px var(--primary-glow)'
              : isWinner
                ? '0 0 16px rgba(251, 191, 36, 0.4)'
                : 'var(--glass-shadow)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', alignSelf: 'stretch' }}>
            {author && (author.imageUrl && author.imageUrl.toLowerCase().endsWith('.mp4') ? (
              <video src={author.imageUrl} style={{ width: '36px', height: '36px', borderRadius: '10px', objectFit: 'cover' }} autoPlay loop muted playsInline />
            ) : (
              <img src={author.imageUrl} alt={author.name} style={{ width: '36px', height: '36px', borderRadius: '10px', objectFit: 'cover' }} />
            ))}
            <span style={{ fontSize: '1rem', fontWeight: '600', flex: 1, minWidth: 0, textAlign: 'left', wordBreak: 'break-word' }}>
              {author ? author.name : '—'}{isOwn ? ` (${t('users.you')})` : ''}
            </span>
            {showVoteCounts && (
              <span style={{
                fontSize: '0.95rem',
                fontWeight: '700',
                color: isWinner ? '#fbbf24' : 'var(--accent)',
                whiteSpace: 'nowrap'
              }}>
                🗳 {count}
              </span>
            )}
          </div>
          {renderAnswerValue(val, { imgMaxWidth: 240, imgMaxHeight: 180, audioWidth: 240 })}
          {canVote && (
            <button className="btn-primary" style={{ ...buttonStyle, padding: '0.5rem 1.25rem' }}>
              {t('question.voteButton')}
            </button>
          )}
          {votedForThis && (
            <div style={{ fontSize: '0.9rem', fontWeight: '700', color: 'var(--primary)' }}>
              {t('question.yourVote')}
            </div>
          )}
        </div>
      );
    };

    const answersGrid = (
      <div className="voting-answers-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '1rem'
      }}>
        {answerEntries.map(([uid, val]) => renderAnswerCard(uid, val))}
      </div>
    );

    // PHASE 1: collecting answers
    if (!answersRevealed) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {renderNormalContent()}
          {!isAdmin && (
            <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
              {hasSubmitted ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>{t('question.yourAnswer')}</div>
                  {renderAnswerValue(myAnswer)}
                </div>
              ) : (
                <AnswerComposer
                  key={`voting-${questionId}`}
                  onSubmit={handleSubmitVotingAnswer}
                  onPreviewImage={setLightboxImage}
                  submitLabel={t('question.submitAnswer')}
                  buttonStyle={buttonStyle}
                />
              )}
            </div>
          )}
          {/* The host watches answers arrive in real time */}
          {isAdmin && (answerEntries.length > 0 ? (
            <>
              <div style={{ ...themeHeaderStyle, color: 'var(--accent)', textShadow: '0 0 20px var(--accent-glow)' }}>
                {t('question.votingAnswersSoFar', { count: answerEntries.length })}
              </div>
              {answersGrid}
            </>
          ) : (
            <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem', color: 'var(--text-secondary)' }}>
              {t('question.votingWaitingAnswers')}
            </div>
          ))}
        </div>
      );
    }

    // PHASE 2: answers revealed — everyone votes / sees results
    const statusText = votesRevealed
      ? t('question.votingClosed')
      : hasVoted
        ? t('question.yourVote')
        : isAdmin
          ? t('question.votingInProgress')
          : !showVoteCounts && voteMode === 'closed'
            ? t('question.votingClosedHint')
            : t('question.votingInstructions');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}
        <div style={{ ...themeHeaderStyle, color: 'var(--accent)', textShadow: '0 0 20px var(--accent-glow)' }}>
          {statusText}
        </div>
        {answersGrid}
      </div>
    );
  };

  const handleCrocodileAssign = (targetUserId) => {
    if (crocodileTargetId) {
      return;
    }
    wsManager.sendCrocodileAssign(parseInt(questionId), targetUserId, crocodileSelectorId);
  };

  const handleSubmitCrocodileResponse = (value) => {
    if (!value || currentUserId !== crocodileTargetId || crocodileResponse) {
      return;
    }
    setCrocodileResponse(value); // optimistic; the broadcast echo is idempotent
    wsManager.sendCrocodileResponse(parseInt(questionId), value);
  };

  // One candidate avatar in the crocodile picker (mirrors the cat-in-the-bag UI)
  const renderCandidateCard = (u, canAssign, onPick) => (
    <div
      key={u.id}
      onClick={canAssign ? () => onPick(u.id) : undefined}
      style={{
        cursor: canAssign ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.75rem',
        borderRadius: '12px',
        border: '1px solid var(--glass-border)',
        background: 'var(--bg-dark)',
        transition: 'all 0.2s',
        width: '110px'
      }}
      onMouseEnter={canAssign ? e => {
        e.currentTarget.style.border = '1px solid var(--primary)';
        e.currentTarget.style.boxShadow = '0 0 16px var(--primary-glow)';
      } : undefined}
      onMouseLeave={canAssign ? e => {
        e.currentTarget.style.border = '1px solid var(--glass-border)';
        e.currentTarget.style.boxShadow = 'none';
      } : undefined}
    >
      {u.imageUrl && u.imageUrl.toLowerCase().endsWith('.mp4') ? (
        <video
          src={u.imageUrl}
          style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }}
          autoPlay loop muted playsInline
        />
      ) : (
        <img
          src={u.imageUrl}
          alt={u.name}
          style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }}
        />
      )}
      <span style={{ fontSize: '1rem', fontWeight: '600', textAlign: 'center', wordBreak: 'break-word' }}>
        {u.name}
      </span>
    </div>
  );

  const renderCrocodileResponseCard = () => (
    <div style={cardStyle}>
      <div style={cardBadgeStyle}>{t('question.crocodileResponseLabel')}</div>
      {renderAnswerValue(crocodileResponse, { imgMaxWidth: 460, imgMaxHeight: 340, audioWidth: 420 })}
    </div>
  );

  const renderCrocodileContent = () => {
    const targetUser = onlineUsers.find(u => u.id === crocodileTargetId);
    const selectorUser = onlineUsers.find(u => u.id === crocodileSelectorId);
    // The selector picks who performs; admin can always assign as a host override.
    // Unlike cat-in-the-bag, the selector may pick themselves.
    const canAssign = isAdmin || (currentUserId && currentUserId === crocodileSelectorId);
    const isPerformer = currentUserId && currentUserId === crocodileTargetId;
    // 'fastest': guessers buzz, the quickest correct one scores. 'dixit':
    // everyone submits a text guess and the host can score anyone.
    const crocodileMode = question.crocodile_mode || 'fastest';

    // PHASE 1: choose the performer
    if (!crocodileTargetId) {
      const pickerPanel = (
        <div style={cardStyle}>
          <div style={{ fontSize: '4rem', marginBottom: '0.5rem' }}>🐊</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: '#4ade80', marginBottom: '1rem', textShadow: '0 0 20px rgba(74, 222, 128, 0.4)' }}>
            {t('question.crocodileTitle')}
          </div>
          <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            {canAssign
              ? t('question.chooseCrocodile')
              : selectorUser
                ? t('question.selectorChoosing', { name: selectorUser.name })
                : t('question.waitingChoice')}
          </div>
          {/* Everyone is a candidate, including the selector; only the selector and admin can click */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {onlineUsers.map(u => renderCandidateCard(u, canAssign, handleCrocodileAssign))}
          </div>
        </div>
      );

      // Admin sees the question below the picker; players only see the panel
      if (isAdmin) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {pickerPanel}
            {renderNormalContent()}
          </div>
        );
      }
      return pickerPanel;
    }

    const header = (
      <div style={{
        ...themeHeaderStyle,
        color: '#4ade80',
        textShadow: '0 0 20px rgba(74, 222, 128, 0.4)'
      }}>
        {t('question.crocodileAnswering', { name: targetUser ? targetUser.name : '...' })}
      </div>
    );

    // PHASE 2: performer assigned, waiting for their response
    if (!crocodileResponse) {
      if (isPerformer) {
        // Only the performer sees the question, plus the composer to respond
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {header}
            {renderNormalContent()}
            <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                {t('question.crocodileYourTurn')}
              </div>
              <AnswerComposer
                key={`crocodile-${questionId}`}
                onSubmit={handleSubmitCrocodileResponse}
                onPreviewImage={setLightboxImage}
                submitLabel={t('question.sendResponse')}
                buttonStyle={buttonStyle}
              />
            </div>
          </div>
        );
      }
      if (isAdmin) {
        // Host watches the prompt and waits for the response
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {header}
            {renderNormalContent()}
            <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem', color: 'var(--text-secondary)' }}>
              {t('question.crocodileWaitingResponse', { name: targetUser ? targetUser.name : '...' })}
            </div>
          </div>
        );
      }
      // Everyone else waits without seeing the question
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {header}
          <div style={cardStyle}>
            <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
              {t('question.crocodilePreparing', { name: targetUser ? targetUser.name : '...' })}
            </div>
          </div>
        </div>
      );
    }

    // PHASE 3: response submitted — guessers buzz, host scores, answer revealed
    const responseCard = renderCrocodileResponseCard();

    // Performer and host also see the underlying question (and the answer once
    // the host reveals it) through the normal content flow
    if (isAdmin || isPerformer) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {header}
          {responseCard}
          {renderNormalContent()}
        </div>
      );
    }

    // Guessers: the response, then either a buzz prompt (fastest mode) or a
    // text composer (dixit mode), and the answer card once revealed
    const afterRoundRules = question.after_round || [];
    const answerCard = (showAfterRound && afterRoundRules.length > 0)
      ? renderRuleCard(afterRoundRules[Math.min(currentAfterRoundIndex, afterRoundRules.length - 1)], t('question.answerLabel'))
      : null;

    // Dixit: everyone types their guess (mirrors the text-answer flow)
    if (crocodileMode === 'dixit') {
      const myGuess = currentUserId ? numberAnswers[currentUserId] : undefined;
      const hasGuessed = myGuess !== undefined;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {header}
          {responseCard}
          <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
            {hasGuessed ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>{t('question.yourAnswer')}</div>
                {renderAnswerValue(myGuess)}
              </div>
            ) : (
              <AnswerComposer
                key={`crocodile-guess-${questionId}`}
                onSubmit={handleSubmitTextAnswer}
                onPreviewImage={setLightboxImage}
                submitLabel={t('question.submitAnswer')}
                buttonStyle={buttonStyle}
              />
            )}
          </div>
          {answerCard}
        </div>
      );
    }

    // Fastest: guessers buzz, the quickest correct one scores
    const hasBuzzed = hasRecordedTime || (currentUserId && userTimes[currentUserId] !== undefined);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {header}
        {responseCard}
        {!answerCard && !hasBuzzed && (
          <div className="glass-panel" style={{
            padding: '1rem 2rem',
            fontSize: '1.3rem',
            fontWeight: '700',
            color: 'var(--text-primary)',
            textAlign: 'center',
            border: '1px solid var(--glass-border)'
          }}>
            {t('question.pressSpace')}
          </div>
        )}
        {answerCard}
      </div>
    );
  };

  // Maps elapsed-time fraction to reveal fraction.
  // slow-start keeps the image hidden longer; fast-start uncovers a lot early.
  const applyRevealCurve = (progress, curve) => {
    if (curve === 'slow-start') return progress * progress;
    if (curve === 'fast-start') return Math.sqrt(progress);
    return progress;
  };

  const renderProgressiveRevealContent = () => {
    const revealDuration = question.duration || 60;
    const rawProgress = revealDuration > 0 ? Math.max(0, Math.min(1, 1 - timer / revealDuration)) : 1;
    const progress = applyRevealCurve(rawProgress, question.curve);
    const buzzPending = Object.keys(userTimes).some(uid => !redJudgedUsers.has(uid));

    const playField = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '1.5rem' }}>
        <div className="glass-panel" style={{
          padding: '1rem 2rem',
          fontSize: '1.3rem',
          fontWeight: '700',
          color: buzzPending ? '#fbbf24' : 'var(--text-primary)',
          textAlign: 'center',
          border: buzzPending ? '1px solid #fbbf24' : '1px solid var(--glass-border)',
          width: '100%',
          maxWidth: '800px',
          boxShadow: buzzPending ? '0 0 20px rgba(251, 191, 36, 0.4)' : 'var(--glass-shadow)'
        }}>
          {progress >= 1
            ? t('question.fullyRevealed')
            : buzzPending
              ? t('question.revealPaused')
              : t('question.pressSpace')}
        </div>

        {/* Shrink-wraps the image so the frame hugs it; the image is capped to
            the viewport inside ProgressiveImage so it fits without scrolling */}
        <div style={{
          width: 'fit-content',
          maxWidth: '100%',
          borderRadius: '16px',
          overflow: 'hidden',
          border: '1px solid var(--glass-border)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)'
        }}>
          <ProgressiveImage
            src={question.image}
            effect={question.effect || 'blur'}
            progress={progress}
          />
        </div>

      </div>
    );

    const afterRoundRules = question.after_round || [];
    if (showAfterRound && afterRoundRules.length > 0) {
      const lastRuleIndex = Math.min(currentAfterRoundIndex, afterRoundRules.length - 1);
      const answerCard = renderRuleCard(afterRoundRules[lastRuleIndex], t('question.answerLabel'));
      // The host gets the same question | answer design as normal questions
      if (isAdmin && isQuestionRevealed) {
        const questionCard = (
          <div style={cardStyle}>
            <div style={cardBadgeStyle}>{t('question.questionLabel')}</div>
            {playField}
          </div>
        );
        return renderHostQuestionAnswer(questionCard, answerCard);
      }
      // Players keep the play field on screen with the answer below it
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '16px' }}>
          {playField}
          {answerCard}
        </div>
      );
    }

    return playField;
  };

  const renderKaraokeContent = () => {
    const playField = (
      <KaraokeQuestion
        question={question}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        onlineUsers={onlineUsers}
        isQuestionRevealed={isQuestionRevealed}
        targetId={karaokeTargetId}
        selectorId={karaokeSelectorId}
        volume={mediaVolume}
        cardStyle={cardStyle}
        themeHeaderStyle={themeHeaderStyle}
      />
    );

    const afterRoundRules = question.after_round || [];
    if (showAfterRound && afterRoundRules.length > 0) {
      const lastRuleIndex = Math.min(currentAfterRoundIndex, afterRoundRules.length - 1);
      const answerCard = renderRuleCard(afterRoundRules[lastRuleIndex], t('question.answerLabel'));
      // The host gets the same question | answer design as normal questions
      if (isAdmin && isQuestionRevealed) {
        return renderHostQuestionAnswer(playField, answerCard);
      }
      // Players keep the performance on screen with the answer below it
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '16px' }}>
          {playField}
          {answerCard}
        </div>
      );
    }

    return playField;
  };

  const renderContent = () => {
    if (question.type === 'find-a-cat') {
      return renderFindACatContent();
    }
    if (question.type === 'karaoke') {
      return renderKaraokeContent();
    }
    if (question.type === 'secret') {
      return renderSecretContent();
    }
    if (question.type === 'close-enough') {
      return renderCloseEnoughContent();
    }
    if (question.type === 'choice') {
      return renderChoiceContent();
    }
    if (question.type === 'text-answer') {
      return renderTextAnswerContent();
    }
    if (question.type === 'progressive-reveal') {
      return renderProgressiveRevealContent();
    }
    if (question.type === 'crocodile') {
      return renderCrocodileContent();
    }
    if (question.type === 'voting') {
      return renderVotingContent();
    }
    return renderNormalContent();
  };

  // Any question-content image opens full-size in the lightbox (players too).
  // Choice options are excluded — clicking those means picking the answer.
  // Find-a-cat and progressive-reveal play fields don't render inside
  // .question-content, so their gameplay clicks are naturally unaffected.
  const handleQuestionImageClick = (e) => {
    if (e.target.tagName !== 'IMG') return;
    if (!e.target.closest('.question-content')) return;
    if (e.target.closest('.choice-options-grid')) return;
    setLightboxImage(e.target.currentSrc || e.target.src);
  };

  const hostTabButtonStyle = (active) => ({
    padding: '0.6rem 1.75rem',
    fontSize: '1rem',
    fontWeight: '600',
    borderRadius: '999px',
    cursor: 'pointer',
    border: active ? '1px solid var(--accent-line)' : '1px solid var(--glass-border)',
    background: active ? 'var(--accent-soft)' : 'var(--glass-bg)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    transition: 'var(--transition-fast)'
  });

  // Tabs keep both cards mounted (hidden via display) so question media keeps
  // playing for everyone while the host peeks at the answer. The answer card
  // mounts only once the host first opens its tab: its media may autoplay and
  // would otherwise be heard right away, defeating the play-along idea.
  const renderHostTabs = (questionCard, answerCard) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem' }}>
        <button
          style={hostTabButtonStyle(hostTab === 'question')}
          onClick={() => setHostTab('question')}
        >
          {t('question.questionLabel')}
        </button>
        <button
          style={hostTabButtonStyle(hostTab === 'answer')}
          onClick={() => { setHostTab('answer'); setHostAnswerSeen(true); }}
        >
          {t('question.answerLabel')}
        </button>
      </div>
      <div style={{ display: hostTab === 'question' ? 'block' : 'none' }}>{questionCard}</div>
      {(hostAnswerSeen || hostTab === 'answer') && (
        <div style={{ display: hostTab === 'answer' ? 'block' : 'none' }}>{answerCard}</div>
      )}
    </div>
  );

  // Question + answer in the host's chosen layout (split | tabs). Every
  // question type funnels its host answer view through here so the design
  // stays the same across types.
  const renderHostQuestionAnswer = (questionCard, answerCard) => {
    if (hostLayout === 'tabs') {
      return renderHostTabs(questionCard, answerCard);
    }
    // Split view: question | answer side by side, falling back to one
    // column on narrow screens; media inside is scaled down via the
    // .host-split-view rules in index.css
    return (
      <div
        className="host-split-view"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
          gap: '16px',
          alignItems: 'stretch'
        }}
      >
        {questionCard}
        {answerCard}
      </div>
    );
  };

  const renderNormalContent = () => {
    if (showAfterRound) {
      const afterRoundRules = question.after_round || [];
      if (afterRoundRules.length > 0) {
        const lastRuleIndex = Math.min(currentAfterRoundIndex, afterRoundRules.length - 1);
        const answerCard = renderRuleCard(afterRoundRules[lastRuleIndex], t('question.answerLabel'));
        // Players only ever see the answer card here; the question stays on
        // their screens while it is the active content
        if (!isAdmin || !isQuestionRevealed) {
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {answerCard}
            </div>
          );
        }
        const questionCard = (
          <div style={cardStyle}>
            <div style={cardBadgeStyle}>{t('question.questionLabel')}</div>
            {question.rules.map((rule, index) => (
              <div
                key={index}
                className="question-content"
                style={{ color: 'var(--text-primary)', fontSize: '1.1rem', whiteSpace: 'pre-wrap', marginBottom: '8px' }}
                dangerouslySetInnerHTML={{ __html: renderHtmlContent(rule.content) }}
              />
            ))}
          </div>
        );
        return renderHostQuestionAnswer(questionCard, answerCard);
      }
    }

    const rules = question.rules || [];
    if (rules.length > 0) {
      const lastRuleIndex = Math.min(currentRuleIndex, rules.length - 1);
      return renderRuleCard(rules[lastRuleIndex], t('question.questionLabel'));
    }

    return null;
  };

  // A single rule inside the question card. Audio-only content has nothing to
  // show players (controls are stripped), so keep the audio mounted (hidden)
  // for playback but skip the empty card entirely.
  const renderRuleCard = (rule, badge) => {
    const badgeEl = badge ? <div style={cardBadgeStyle}>{badge}</div> : null;
    if (rule.type === 'embedded') {
      const html = renderHtmlContent(rule.content);
      if (!isAdmin && isAudioOnlyContent(html)) {
        return (
          <div
            className="question-content"
            style={{ display: 'none' }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }
      return (
        <div style={cardStyle}>
          {badgeEl}
          <div
            className="question-content"
            style={{ color: 'var(--text-primary)', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      );
    }
    return <div style={cardStyle}>{badgeEl}{renderRule(rule)}</div>;
  };

  return (
    <div style={pageStyle}>
      {/* Header: Settings button and the Jeoparty logo */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '2rem 0',
        position: 'relative',
        width: '100%',
        maxWidth: 1200,
      }}>
        <button
          onClick={() => setSettingsOpen(true)}
          className="glass-panel"
          style={{
            padding: '0.75rem 1.25rem',
            color: 'var(--text-secondary)',
            border: '1px solid var(--glass-border)',
            cursor: 'pointer',
            fontSize: '1rem',
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            transition: 'var(--transition-fast)'
          }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
        >
          <span>⚙️</span> {t('common.settings')}
        </button>
        <div style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <Logo />
        </div>
      </div>
      {/* Theme (left) — timer (always centered) — price (right) */}
      <div style={{
        width: '100%',
        maxWidth: 1200,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: '1rem',
        marginBottom: '1rem',
        padding: '0 1rem',
        boxSizing: 'border-box'
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>
          {themeName && (
            <div className="glass-panel" style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '12px',
              color: 'var(--text-primary)',
              fontWeight: '500',
              fontSize: '1.1rem',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              border: '1px solid var(--glass-border)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textShadow: '0 0 20px var(--primary-glow)'
            }}>
              {themeName}
            </div>
          )}
        </div>
        <div className={`glass-panel timer-pill${timer <= 5 ? ' timer-pill--low' : ''}`} style={{
          fontSize: '2.5rem',
          color: timer <= 5 ? 'var(--danger)' : 'var(--text-primary)',
          fontWeight: '800',
          padding: '0.75rem 1.5rem',
          borderRadius: '24px',
          fontVariantNumeric: 'tabular-nums'
        }}>
          {timer}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', minWidth: 0 }}>
          {question.price?.text && (
            <div className="glass-panel" style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '12px',
              color: 'var(--accent)',
              fontWeight: '800',
              fontSize: '1.25rem',
              border: '1px solid var(--glass-border)',
              whiteSpace: 'nowrap',
              textShadow: '0 0 10px var(--accent-glow)'
            }}>
              {question.price.text}
            </div>
          )}
        </div>
      </div>
      {/* Players have no native media controls, so give them a volume slider.
          Karaoke streams play through a hidden element with no controls at
          all, so there the host needs the slider too. */}
      {(!isAdmin || question.type === 'karaoke') && questionHasMedia && (
        <div className="glass-panel" style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.5rem 1.25rem',
          borderRadius: '12px',
          border: '1px solid var(--glass-border)',
          marginBottom: '1rem',
          color: 'var(--text-secondary)',
          fontWeight: '600'
        }}>
          <span role="img" aria-label="volume">🔊</span>
          <input
            type="range"
            className="volume-slider"
            min="0"
            max="1"
            step="0.01"
            value={mediaVolume}
            onChange={handleVolumeChange}
            style={{
              background: `linear-gradient(to right, var(--primary) ${mediaVolume * 100}%, var(--track) ${mediaVolume * 100}%)`
            }}
          />
          <span style={{ minWidth: '3em', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(mediaVolume * 100)}%
          </span>
        </div>
      )}
      {/* Main board: rules grid */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
        width: '100%',
        maxWidth: 'min(1600px, 100%)',
        margin: '0 auto 20px auto'
      }}>
        <div style={boardGridStyle} onClick={handleQuestionImageClick}>
          {renderContent()}
        </div>
      </div>
      {/* Action buttons (Show Question/Show Answer/Show Response/Back to Game) */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {isAdmin && !isQuestionRevealed && (
          <button
            onClick={handleShowQuestion}
            className="btn-primary"
            style={buttonStyle}
          >
            {t('question.showQuestion')}
          </button>
        )}
        {isAdmin && isQuestionRevealed && !isAnswerRevealed && question.type !== 'voting' && (
          <button
            onClick={handleShowAnswer}
            className="btn-primary"
            style={buttonStyle}
          >
            {t('question.showAnswer')}
          </button>
        )}
        {/* Choice has no "Show Result": the admin sees picks in real time */}
        {isAdmin && !answersRevealed && (
          (['close-enough', 'text-answer', 'voting'].includes(question.type) && isQuestionRevealed) ||
          // Crocodile dixit collects text guesses once the performer responds
          (question.type === 'crocodile' && (question.crocodile_mode || 'fastest') === 'dixit' && crocodileResponse)
        ) && (
          <button
            onClick={() => wsManager.sendRevealNumberAnswers(parseInt(questionId))}
            className="btn-primary"
            style={buttonStyle}
          >
            {question.type === 'voting' ? t('question.showAnswers') : t('question.showResult')}
          </button>
        )}
        {/* Voting: once answers are out and votes are in, lock/reveal them */}
        {isAdmin && question.type === 'voting' && answersRevealed && !votesRevealed && (
          <button
            onClick={() => wsManager.sendRevealVotes(parseInt(questionId))}
            className="btn-primary"
            style={buttonStyle}
          >
            {t('question.revealVotes')}
          </button>
        )}
        {isAdmin && isAnswerRevealed && !isResponseRevealed && (
          question.type === 'close-enough'
            ? answersRevealed // submissions first, then the correct answer
            : question.type === 'choice'
              ? true // reveals picks and the correct options in one step
              : question.after_round && question.after_round.length > 0
        ) && (
          <button
            onClick={handleShowAfterRound}
            className="btn-primary"
            style={buttonStyle}
          >
            {t('question.showResponse')}
          </button>
        )}
        {isAdmin && (
          <button
            onClick={handleReturnToGame}
            className="btn-danger"
            style={buttonStyle}
          >
            {t('question.backToGame')}
          </button>
        )}
      </div>
      {/* Online users below the board — full width so a long row fits */}
      <div style={{ width: '100%', margin: 0, padding: 0, lineHeight: 1 }}>
        <OnlineUsers
          users={onlineUsers}
          elapsedTime={elapsedTime}
          currentUserId={currentUserId}
          userTimes={userTimes}
          isAdmin={isAdmin}
          question={question}
          secretTargetId={
            question?.type === 'secret'
              ? secretTargetId
              : question?.type === 'karaoke'
                ? karaokeTargetId // the singer gets the same highlight + award buttons
                : null
          }
          crocodileTargetId={question?.type === 'crocodile' ? crocodileTargetId : null}
          clicksLeftMap={clicksLeftMap}
          numberAnswers={numberAnswers}
          answersRevealed={answersRevealed}
          responseRevealed={isResponseRevealed}
          votes={votes}
          votesRevealed={votesRevealed}
        />
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} isAdmin={isAdmin} />}
      <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
};

export default QuestionPage; 
