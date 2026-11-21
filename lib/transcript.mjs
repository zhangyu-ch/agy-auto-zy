import { existsSync, readFileSync } from 'node:fs';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  ENTRY_MESSAGE_TOKEN_BUDGET,
  ENTRY_TOOL_TOKEN_BUDGET,
  MAX_RECENT_UNTRUSTED_ENTRIES,
  TRANSCRIPT_MESSAGE_TOKEN_BUDGET,
  TRANSCRIPT_TOOL_TOKEN_BUDGET,
  TRUNCATION_HEAD_RATIO,
  TRUNCATION_MARKER
} from './constants.mjs';

export function approximateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function serializeUnknown(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncateToCharacters(text, maxCharacters) {
  if (text.length <= maxCharacters) return text;
  const available = Math.max(0, maxCharacters - TRUNCATION_MARKER.length);
  const headLength = Math.floor(available * TRUNCATION_HEAD_RATIO);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${TRUNCATION_MARKER}${text.slice(text.length - tailLength)}`;
}

export function truncateToFit(text, maxCharacters, renderFn) {
  if (renderFn(text).length <= maxCharacters) return text;
  let lower = 0;
  let upper = Math.min(text.length, maxCharacters);
  let fitted = truncateToCharacters(text, 0);
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = truncateToCharacters(text, middle);
    if (renderFn(candidate).length <= maxCharacters) {
      fitted = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return fitted;
}

export function extractUserRequestText(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return '';
  const match = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  return rawContent.trim();
}

function parseMaybeJsonString(rawVal) {
  if (typeof rawVal !== 'string') return rawVal;
  const trimmed = rawVal.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return rawVal;
    }
  }
  return rawVal;
}

function parseStructuredAskQuestionAnswers(questionsRaw, resultContent) {
  const questions = parseMaybeJsonString(questionsRaw);
  if (!Array.isArray(questions) || questions.length === 0 || typeof resultContent !== 'string') {
    return null;
  }

  const answerMap = new Map();
  const lines = resultContent.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const match = line.match(/^A(\d+):\s*(.+)$/);
    if (match) {
      answerMap.set(Number(match[1]) - 1, match[2].trim());
    }
  }
  if (answerMap.size === 0) return null;

  const structured = [];
  for (let i = 0; i < questions.length; i += 1) {
    const questionText = questions[i]?.question;
    const answerText = answerMap.get(i);
    if (typeof questionText === 'string' && questionText.trim() && answerText) {
      structured.push({
        question: questionText.trim(),
        answer: answerText
      });
    }
  }
  return structured.length > 0 ? structured : null;
}

function stripStepTimestamps(rawContent) {
  if (typeof rawContent !== 'string') return '';
  return rawContent
    .replace(/^(?:Created At|Completed At):\s*[^\n]+\n?/gm, '')
    .trim();
}

export function readAntigravitySteps(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim() || !existsSync(transcriptPath)) {
    return [];
  }
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const steps = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
          steps.push(parsed);
        }
      } catch {
        // Ignore partially written or malformed line.
      }
    }
    return steps;
  } catch {
    return [];
  }
}

export function decodeAntigravitySteps(steps = [], { lastUserInput = '' } = {}) {
  const entries = [];
  let pendingAskQuestionsQueue = [];
  let pendingToolNamesQueue = [];
  let lastSeenUserText = '';

  for (let idx = 0; idx < steps.length; idx += 1) {
    const step = steps[idx];
    const stepIndex = Number.isInteger(step.step_index) ? step.step_index : idx;

    if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
      const userText = extractUserRequestText(step.content || '');
      if (userText) {
        lastSeenUserText = userText;
        entries.push({
          index: stepIndex,
          kind: 'user',
          label: 'user',
          text: userText
        });
      }
      pendingAskQuestionsQueue = [];
      pendingToolNamesQueue = [];
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      pendingAskQuestionsQueue = [];
      pendingToolNamesQueue = [];

      if (typeof step.content === 'string' && step.content.trim()) {
        entries.push({
          index: stepIndex,
          kind: 'assistant',
          label: 'assistant',
          text: step.content.trim()
        });
      }

      if (Array.isArray(step.tool_calls)) {
        for (const call of step.tool_calls) {
          const callName = typeof call?.name === 'string' ? call.name : 'unknown';
          const normalizedArgs = {};
          if (call?.args && typeof call.args === 'object') {
            for (const [k, v] of Object.entries(call.args)) {
              normalizedArgs[k] = parseMaybeJsonString(v);
            }
          }
          if (callName === 'ask_question' || callName === 'ask_user_question') {
            pendingAskQuestionsQueue.push(normalizedArgs.questions);
          }
          pendingToolNamesQueue.push(callName);
          entries.push({
            index: stepIndex,
            kind: 'tool',
            label: `tool:${callName}`,
            text: serializeUnknown(normalizedArgs)
          });
        }
      }
      continue;
    }

    const nextToolName = pendingToolNamesQueue.shift() || step.type?.toLowerCase() || 'result';
    const isError = step.status === 'ERROR' || Boolean(step.error);

    if (
      (nextToolName === 'ask_question' || nextToolName === 'ask_user_question') &&
      !isError &&
      pendingAskQuestionsQueue.length > 0
    ) {
      const questionsSpec = pendingAskQuestionsQueue.shift();
      const structuredAnswers = parseStructuredAskQuestionAnswers(questionsSpec, step.content || '');
      if (structuredAnswers) {
        entries.push({
          index: stepIndex,
          kind: 'user_interaction',
          label: `user_interaction:${nextToolName}`,
          text: JSON.stringify(structuredAnswers)
        });
        continue;
      }
    }

    const cleanedResult = stripStepTimestamps(step.content || step.error || '');
    if (cleanedResult) {
      entries.push({
        index: stepIndex,
        kind: 'tool',
        label: `tool:${nextToolName}${isError ? ' (error)' : ''}`,
        text: cleanedResult
      });
    }
  }

  const trimmedLastUser = extractUserRequestText(lastUserInput || '');
  if (trimmedLastUser && trimmedLastUser !== lastSeenUserText) {
    const nextIdx =
      steps.length > 0
        ? Math.max(...steps.map((s, i) => (Number.isInteger(s.step_index) ? s.step_index : i))) + 1
        : 0;
    entries.push({
      index: nextIdx,
      kind: 'user',
      label: 'user',
      text: trimmedLastUser
    });
  }

  return entries;
}

function renderEntryJson(entry) {
  return JSON.stringify({
    index: entry.index,
    source: entry.kind,
    label: entry.label,
    content: entry.text
  });
}

function entryPool(entry) {
  return entry.kind === 'tool' ? 'tool' : 'message';
}

function pretruncateEntry(entry) {
  const tokenBudget =
    entryPool(entry) === 'tool' ? ENTRY_TOOL_TOKEN_BUDGET : ENTRY_MESSAGE_TOKEN_BUDGET;
  const maxChars = tokenBudget * CHARS_PER_TOKEN_ESTIMATE;
  const fittedText = truncateToFit(entry.text, maxChars, candidate =>
    renderEntryJson({ ...entry, text: candidate })
  );
  return fittedText === entry.text
    ? entry
    : { ...entry, text: fittedText, truncated: true };
}

function isTrustedEntry(entry) {
  return entry.kind === 'user' || entry.kind === 'user_interaction';
}

export function renderTranscriptFromSteps(steps = [], { fromStepIndex = 0, lastUserInput = '' } = {}) {
  const allDecoded = decodeAntigravitySteps(steps, { lastUserInput })
    .filter(entry => entry.index >= fromStepIndex)
    .map(pretruncateEntry);

  const trusted = allDecoded.filter(isTrustedEntry);
  const selected = new Set();
  const usedTokens = { message: 0, tool: 0 };
  const poolCaps = {
    message: TRANSCRIPT_MESSAGE_TOKEN_BUDGET,
    tool: TRANSCRIPT_TOOL_TOKEN_BUDGET
  };

  const tryTake = (entry, force = false) => {
    const pool = entryPool(entry);
    const tokens = approximateTokens(renderEntryJson(entry));
    if (!force && usedTokens[pool] + tokens > poolCaps[pool]) {
      return false;
    }
    usedTokens[pool] += tokens;
    selected.add(entry);
    return true;
  };

  for (const anchor of [trusted[0], trusted.at(-1)]) {
    if (anchor !== undefined && !selected.has(anchor)) {
      tryTake(anchor, true);
    }
  }

  for (let i = trusted.length - 1; i >= 0; i -= 1) {
    if (!selected.has(trusted[i])) {
      tryTake(trusted[i]);
    }
  }

  let untrustedRetained = 0;
  for (let i = allDecoded.length - 1; i >= 0; i -= 1) {
    const entry = allDecoded[i];
    if (!isTrustedEntry(entry) && untrustedRetained < MAX_RECENT_UNTRUSTED_ENTRIES) {
      if (tryTake(entry)) {
        untrustedRetained += 1;
      }
    }
  }

  const retained = allDecoded.filter(entry => selected.has(entry));
  const countByKind = kind => {
    const matches = entry => kind === undefined || entry.kind === kind;
    const kept = retained.filter(matches);
    return {
      retained: kept.length,
      omitted: allDecoded.filter(matches).length - kept.length,
      truncated: kept.filter(entry => entry.truncated === true).length
    };
  };

  const total = countByKind(undefined);
  const userStats = countByKind('user');
  const interactionStats = countByKind('user_interaction');
  const latestTrusted = trusted.at(-1);
  const maxStepIndex =
    allDecoded.length > 0 ? Math.max(...allDecoded.map(e => e.index)) : fromStepIndex - 1;

  return {
    entries: retained.map(renderEntryJson),
    lastStepIndex: maxStepIndex,
    stats: {
      transcriptEntriesRetained: total.retained,
      transcriptEntriesOmitted: total.omitted,
      transcriptEntriesTruncated: total.truncated,
      directUserEntriesRetained: userStats.retained,
      directUserEntriesOmitted: userStats.omitted,
      directUserEntriesTruncated: userStats.truncated,
      userInteractionEntriesRetained: interactionStats.retained,
      userInteractionEntriesOmitted: interactionStats.omitted,
      userInteractionEntriesTruncated: interactionStats.truncated,
      latestTrustedEntryRetained: latestTrusted !== undefined && selected.has(latestTrusted)
    }
  };
}

export function loadRenderedTranscript({
  transcriptPath,
  lastUserInput = '',
  fromStepIndex = 0
} = {}) {
  const steps = readAntigravitySteps(transcriptPath);
  return renderTranscriptFromSteps(steps, { fromStepIndex, lastUserInput });
}
