import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFollowUpPrompt,
  buildSystemPrompt,
  buildUserPrompt,
   parseReviewAssessment,
  POLICY_REVISION
} from './codex-guardian.mjs';
import {
  CIRCUIT_BREAKER_REFUSAL_MESSAGE,
  MAX_CONSECUTIVE_DENIALS,
  MAX_CONVERSATION_TOKENS,
  MAX_RECENT_DENIALS,
  MODE_OFF,
  OUTPUT_RESERVE_TOKENS,
  RECENT_DENIAL_WINDOW_SIZE,
  REJECTION_INSTRUCTIONS
} from './constants.mjs';
import { classifyToolCall, encloseInDelegationEnvelope } from './gate.mjs';
import { completeReviewModelCall, streamChatCompletionOnce } from './magpie-client.mjs';
import { createReviewLogger } from './review-log.mjs';
import {
  computePolicyFingerprint,
  resolveEffectiveMode,
  resolveHookAllowDecision,
  resolvePluginDataDirectory,
  writeJsonAtomically
} from './settings.mjs';
import { approximateTokens, readAntigravitySteps, renderTranscriptFromSteps } from './transcript.mjs';

export class DenialCircuitBreaker {
  constructor(initialState = {}) {
    this.consecutiveDenials = Number(initialState.consecutiveDenials || 0);
    this.recentDenials = Array.isArray(initialState.recentDenials)
      ? initialState.recentDenials.map(Boolean).slice(-RECENT_DENIAL_WINDOW_SIZE)
      : [];
  }

  refusal() {
    const recentCount = this.recentDenials.filter(Boolean).length;
    if (
      this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS ||
      recentCount >= MAX_RECENT_DENIALS
    ) {
      return CIRCUIT_BREAKER_REFUSAL_MESSAGE;
    }
    return undefined;
  }

  recordDenial() {
    this.consecutiveDenials += 1;
    this.recordRecent(true);
  }

  recordNonDenial() {
    this.consecutiveDenials = 0;
    this.recordRecent(false);
  }

  resetTurn() {
    this.consecutiveDenials = 0;
    this.recentDenials = [];
  }

  recordRecent(denied) {
    this.recentDenials.push(Boolean(denied));
    if (this.recentDenials.length > RECENT_DENIAL_WINDOW_SIZE) {
      this.recentDenials.shift();
    }
  }

  toJSON() {
    return {
      consecutiveDenials: this.consecutiveDenials,
      recentDenials: [...this.recentDenials]
    };
  }
}

function sessionStateFilePath(sessionsDir, conversationId) {
  const safeKey = createHash('sha256')
    .update(String(conversationId || 'default'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return join(sessionsDir, `${safeKey}.json`);
}

function summarizeToolTarget(details = {}) {
  if (details.command) return details.command.slice(0, 180);
  if (details.path) return details.path;
  return details.toolName || 'tool';
}

export function createReviewerEngine({
  settingsStore,
  dataDirectory = resolvePluginDataDirectory(),
  requestImpl = streamChatCompletionOnce,
  logger,
  onStateChange
} = {}) {
  assert.ok(settingsStore, 'settingsStore is required');
  const sessionsDir = join(dataDirectory, 'sessions');
  const memorySessions = new Map();
  let activeReviewsCount = 0;

  const reviewLogger =
    logger ||
    createReviewLogger({
      dataDirectory,
      enabled: () => Boolean(settingsStore.get().permissionReviewLog)
    });

  function emitState(eventPayload) {
    try {
      onStateChange?.({
        activeReviewsCount,
        ...eventPayload
      });
    } catch {
      // UI listener errors must never disrupt permission adjudication.
    }
  }

  function loadSessionRecord(conversationId) {
    const id = String(conversationId || 'default');
    if (memorySessions.has(id)) {
      return memorySessions.get(id);
    }
    const filePath = sessionStateFilePath(sessionsDir, id);
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        const loaded = {
          limiter: new DenialCircuitBreaker(raw.limiter),
          conversation: raw.conversation || null
        };
        memorySessions.set(id, loaded);
        return loaded;
      } catch {
        // Ignore corrupted session cache and create fresh state.
      }
    }
    const fresh = {
      limiter: new DenialCircuitBreaker(),
      conversation: null
    };
    memorySessions.set(id, fresh);
    return fresh;
  }

  function persistSessionRecord(conversationId, record) {
    const id = String(conversationId || 'default');
    memorySessions.set(id, record);
    try {
      mkdirSync(sessionsDir, { recursive: true });
      writeJsonAtomically(sessionStateFilePath(sessionsDir, id), {
        limiter: record.limiter.toJSON(),
        conversation: record.conversation
      });
    } catch {
      // Session persistence is an optimization; ignore write errors.
    }
  }

  function resetTurn(conversationId) {
    const id = String(conversationId || 'default');
    const record = loadSessionRecord(id);
    record.limiter.resetTurn();
    persistSessionRecord(id, record);
    emitState({ type: 'turn-reset', conversationId: id });
  }

  function clearSessions() {
    memorySessions.clear();
    if (existsSync(sessionsDir)) {
      try {
        rmSync(sessionsDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  async function runCodexGuardianReview({
    settings,
    policyFingerprint,
    conversationId,
    steps,
    lastUserInput,
    details,
    toolInput,
    priorConversation,
    signal
  }) {
    const systemPrompt = buildSystemPrompt(settings);
    const contextWindow = Number(settings.contextWindow || 400_000);
    const canAttemptFollowUp =
      settings.followUpReviews !== 'off' &&
      priorConversation &&
      priorConversation.policyFingerprint === policyFingerprint &&
      Array.isArray(priorConversation.messages) &&
      priorConversation.messages.length > 0 &&
      Number.isInteger(priorConversation.lastStepIndex);

    let messages;
    let transcript;
    let priorReviews = 0;
    let estimatedTokens;

    if (canAttemptFollowUp) {
      const deltaTranscript = renderTranscriptFromSteps(steps, {
        fromStepIndex: priorConversation.lastStepIndex + 1,
        lastUserInput
      });
      const followUpContent = buildFollowUpPrompt(deltaTranscript, details, toolInput);
      const nextTokens = priorConversation.tokens + approximateTokens(followUpContent);
      if (nextTokens + OUTPUT_RESERVE_TOKENS <= Math.min(contextWindow, MAX_CONVERSATION_TOKENS)) {
        messages = [...priorConversation.messages, { role: 'user', content: followUpContent }];
        transcript = deltaTranscript;
        priorReviews = Number(priorConversation.reviews || 0);
        estimatedTokens = nextTokens;
      }
    }

    if (!messages) {
      const fullTranscript = renderTranscriptFromSteps(steps, {
        fromStepIndex: 0,
        lastUserInput
      });
      const fullContent = buildUserPrompt(fullTranscript, details, toolInput);
      messages = [{ role: 'user', content: fullContent }];
      transcript = fullTranscript;
      priorReviews = 0;
      estimatedTokens = approximateTokens(systemPrompt + fullContent);
    }

    const baseFields = {
      toolInputIncluded: toolInput !== undefined,
      ...transcript.stats,
      priorReviews
    };

    const completion = await completeReviewModelCall({
      settings,
      sessionId: conversationId || 'default',
      systemPrompt,
      messages,
      estimatedTokens,
      parseResponse: parseReviewAssessment,
      requestImpl,
      signal
    });

    if (!completion.ok) {
      return {
        kind: 'failed',
        failure: completion.failure,
        errorMessage: completion.errorMessage,
        fields: baseFields,
        usage: completion.usage
      };
    }

    const assessment = completion.value;
    const shouldKeepFollowUp =
      settings.followUpReviews === 'always' ||
      (settings.followUpReviews === 'auto' &&
        (priorReviews === 0 || (completion.replyUsage?.cacheRead || 0) > 0));

    const maxSeenStep = Math.max(
      transcript.lastStepIndex ?? -1,
      priorConversation?.lastStepIndex ?? -1
    );

    const nextConversation =
      shouldKeepFollowUp && maxSeenStep >= 0
        ? {
            policyFingerprint,
            messages: [...messages, { role: 'assistant', content: completion.replyText }],
            lastStepIndex: maxSeenStep,
            tokens:
              (completion.replyUsage?.input || 0) +
                (completion.replyUsage?.cacheRead || 0) +
                (completion.replyUsage?.output || 0) ||
              estimatedTokens + approximateTokens(completion.replyText),
            reviews: priorReviews + 1
          }
        : null;

    const gradedFields = {
      ...baseFields,
      riskLevel: assessment.riskLevel,
      userApproval: assessment.userAuthorization
    };

    if (assessment.outcome === 'allow') {
      return {
        kind: 'allow',
        rationale: assessment.rationale,
        fields: gradedFields,
        usage: completion.usage,
        conversation: nextConversation
      };
    }

    return {
      kind: 'deny',
      rationale: assessment.rationale,
      reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization}). ${REJECTION_INSTRUCTIONS}`,
      fields: gradedFields,
      usage: completion.usage,
      conversation: nextConversation
    };
  }

  async function evaluatePreToolUse(payload = {}, { signal } = {}) {
    const startedAt = Date.now();
    const settings = settingsStore.get({ force: true });
    const allowDecision = resolveHookAllowDecision(payload, { dataDirectory });
    const effectiveMode = resolveEffectiveMode(
      settings,
      payload.workspacePaths,
      payload.cwd
    );

    if (effectiveMode === MODE_OFF) {
      return { hookOutput: {}, mode: effectiveMode, skipped: true };
    }

    const classification = classifyToolCall(payload, settings);
    if (classification.fastDecision === 'allow') {
      return {
        hookOutput: { decision: allowDecision },
        mode: effectiveMode,
        decidedBy: 'fast-path',
        surface: classification.surface
      };
    }

    const conversationId = String(payload.conversationId || 'default');
    const policyFingerprint = computePolicyFingerprint(settings);
    const toolName = payload?.toolCall?.name || 'unknown';

    if (classification.fastDecision === 'deny') {
      reviewLogger.appendEvent('auto_zy.decision', {
        conversationId,
        mode: effectiveMode,
        toolName,
        surface: classification.surface,
        decision: 'deny',
        decidedBy: classification.decidedBy,
        reason: classification.reason,
        durationMs: Date.now() - startedAt
      });
      emitState({ type: 'decision', decision: 'deny', mode: effectiveMode, toolName });
      return {
        hookOutput: { decision: 'deny', reason: classification.reason },
        mode: effectiveMode,
        decidedBy: classification.decidedBy
      };
    }

    const sessionRecord = loadSessionRecord(conversationId);
    const circuitRefusal = sessionRecord.limiter.refusal();
    if (circuitRefusal !== undefined) {
      reviewLogger.appendEvent('auto_zy.decision', {
        requestId: classification.details.requestId,
        conversationId,
        mode: effectiveMode,
        provider: settings.provider,
        model: settings.model,
        reasoning: settings.reasoning,
        policyFingerprint,
        toolName,
        surface: classification.surface,
        target: summarizeToolTarget(classification.details),
        decision: 'deny',
        decidedBy: 'circuit-breaker',
        errorCategory: 'circuit-open',
        reason: circuitRefusal,
        durationMs: Date.now() - startedAt
      });
      emitState({ type: 'decision', decision: 'deny', mode: effectiveMode, toolName });
      return {
        hookOutput: { decision: 'deny', reason: circuitRefusal },
        mode: effectiveMode,
        decidedBy: 'circuit-breaker'
      };
    }

    activeReviewsCount += 1;
    emitState({
      type: 'review-start',
      mode: effectiveMode,
      toolName,
      target: summarizeToolTarget(classification.details)
    });

    try {
      const steps = readAntigravitySteps(payload.transcriptPath);
      const rawVerdict = await runCodexGuardianReview({
        settings,
        policyFingerprint,
        conversationId,
        steps,
        lastUserInput: payload.lastUserInput || '',
        details: classification.details,
        toolInput: classification.toolInput,
        priorConversation: sessionRecord.conversation,
        signal
      });

      const durationMs = Math.max(0, Date.now() - startedAt);

      if (rawVerdict.kind === 'failed') {
        if (rawVerdict.failure !== 'cancelled') {
          sessionRecord.conversation = null;
        }
        sessionRecord.limiter.recordNonDenial();
        persistSessionRecord(conversationId, sessionRecord);

        const isCancelled = rawVerdict.failure === 'cancelled';
        const fallbackDecision = isCancelled ? 'deny' : 'ask';
        const fallbackReason = isCancelled
          ? 'Automatic review was cancelled before completion.'
          : `[${effectiveMode}] 自动审核暂不可用（${rawVerdict.failure}），请人工确认该操作。`;

        reviewLogger.appendEvent('auto_zy.decision', {
          requestId: classification.details.requestId,
          conversationId,
          mode: effectiveMode,
          provider: settings.provider,
          model: settings.model,
          reasoning: settings.reasoning,
          policyFingerprint,
          policyRevision: POLICY_REVISION,
          toolName,
          surface: classification.surface,
          target: summarizeToolTarget(classification.details),
          decision: fallbackDecision,
          decidedBy: 'fallback',
          errorCategory: rawVerdict.failure,
          errorMessage: rawVerdict.errorMessage,
          durationMs,
          ...rawVerdict.fields,
          usage: rawVerdict.usage
        });
        emitState({ type: 'decision', decision: fallbackDecision, mode: effectiveMode, toolName });
        return {
          hookOutput: { decision: fallbackDecision, reason: fallbackReason },
          mode: effectiveMode,
          decidedBy: 'fallback'
        };
      }

      sessionRecord.conversation = rawVerdict.conversation;
      const enveloped = encloseInDelegationEnvelope(
        effectiveMode,
        classification.details,
        rawVerdict
      );

      if (enveloped.kind === 'allow') {
        sessionRecord.limiter.recordNonDenial();
        persistSessionRecord(conversationId, sessionRecord);

        if (enveloped.licensedBy) {
          reviewLogger.appendEvent('authorizer_allow_licensed', {
            requestId: classification.details.requestId,
            conversationId,
            link: 'auto-review',
            license: enveloped.licensedBy
          });
        }

        reviewLogger.appendEvent('auto_zy.decision', {
          requestId: classification.details.requestId,
          conversationId,
          mode: effectiveMode,
          provider: settings.provider,
          model: settings.model,
          reasoning: settings.reasoning,
          policyFingerprint,
          policyRevision: POLICY_REVISION,
          toolName,
          surface: classification.surface,
          target: summarizeToolTarget(classification.details),
          decision: 'allow',
          decidedBy: 'auto-review',
          rationale: rawVerdict.rationale,
          durationMs,
          ...rawVerdict.fields,
          usage: rawVerdict.usage
        });
        emitState({ type: 'decision', decision: 'allow', mode: effectiveMode, toolName });
        return {
          hookOutput: { decision: allowDecision },
          mode: effectiveMode,
          decidedBy: 'auto-review'
        };
      }

      if (enveloped.kind === 'defer') {
        sessionRecord.limiter.recordNonDenial();
        persistSessionRecord(conversationId, sessionRecord);

        reviewLogger.appendEvent('auto_zy.decision', {
          requestId: classification.details.requestId,
          conversationId,
          mode: effectiveMode,
          provider: settings.provider,
          model: settings.model,
          reasoning: settings.reasoning,
          policyFingerprint,
          policyRevision: POLICY_REVISION,
          toolName,
          surface: classification.surface,
          target: summarizeToolTarget(classification.details),
          decision: 'ask',
          decidedBy: enveloped.cappedFromAllow ? 'workspace-envelope' : 'auto-review-defer',
          rationale: enveloped.reason || rawVerdict.rationale,
          durationMs,
          ...rawVerdict.fields,
          usage: rawVerdict.usage
        });
        emitState({ type: 'decision', decision: 'ask', mode: effectiveMode, toolName });
        return {
          hookOutput: {
            decision: 'ask',
            reason: enveloped.reason || `[${effectiveMode}] 需人工确认该操作。`
          },
          mode: effectiveMode,
          decidedBy: enveloped.cappedFromAllow ? 'workspace-envelope' : 'auto-review-defer'
        };
      }

      sessionRecord.limiter.recordDenial();
      persistSessionRecord(conversationId, sessionRecord);

      reviewLogger.appendEvent('auto_zy.decision', {
        requestId: classification.details.requestId,
        conversationId,
        mode: effectiveMode,
        provider: settings.provider,
        model: settings.model,
        reasoning: settings.reasoning,
        policyFingerprint,
        policyRevision: POLICY_REVISION,
        toolName,
        surface: classification.surface,
        target: summarizeToolTarget(classification.details),
        decision: 'deny',
        decidedBy: 'auto-review',
        rationale: rawVerdict.rationale,
        reason: rawVerdict.reason,
        durationMs,
        ...rawVerdict.fields,
        usage: rawVerdict.usage
      });
      emitState({ type: 'decision', decision: 'deny', mode: effectiveMode, toolName });
      return {
        hookOutput: {
          decision: 'deny',
          reason: rawVerdict.reason
        },
        mode: effectiveMode,
        decidedBy: 'auto-review'
      };
    } catch (err) {
      sessionRecord.conversation = null;
      sessionRecord.limiter.recordNonDenial();
      persistSessionRecord(conversationId, sessionRecord);

      reviewLogger.appendEvent('auto_zy.decision', {
        requestId: classification.details?.requestId,
        conversationId,
        mode: effectiveMode,
        toolName,
        surface: classification.surface,
        decision: 'ask',
        decidedBy: 'internal-error',
        errorMessage: err?.message || String(err),
        durationMs: Math.max(0, Date.now() - startedAt)
      });
      emitState({ type: 'decision', decision: 'ask', mode: effectiveMode, toolName });
      return {
        hookOutput: {
          decision: 'ask',
          reason: `[${effectiveMode}] 审核内部异常，已回退人工确认。`
        },
        mode: effectiveMode,
        decidedBy: 'internal-error'
      };
    } finally {
      activeReviewsCount = Math.max(0, activeReviewsCount - 1);
      emitState({ type: 'review-idle' });
    }
  }

  async function testSampleReview() {
    const settings = settingsStore.get({ force: true });
    const startedAt = Date.now();
    const steps = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: '<USER_REQUEST>\n运行当前项目的单元测试并查看测试通过情况。\n</USER_REQUEST>'
      }
    ];
    const details = {
      requestId: `test-${Date.now()}`,
      source: 'tool_call',
      toolName: 'run_command',
      surface: 'bash',
      command: 'node --test',
      accessIntent: { surface: 'bash', hasWriteIntent: false }
    };
    const verdict = await runCodexGuardianReview({
      settings,
      policyFingerprint: computePolicyFingerprint(settings),
      conversationId: `self-test-${Date.now()}`,
      steps,
      lastUserInput: '',
      details,
      toolInput: { CommandLine: 'node --test' },
      priorConversation: null
    });

    if (verdict.kind === 'failed') {
      return {
        ok: false,
        error: verdict.errorMessage || verdict.failure,
        elapsedMs: Date.now() - startedAt
      };
    }
    return {
      ok: true,
      outcome: verdict.kind,
      riskLevel: verdict.fields?.riskLevel,
      userAuthorization: verdict.fields?.userApproval,
      rationale: verdict.rationale,
      usage: verdict.usage,
      elapsedMs: Date.now() - startedAt
    };
  }

  return {
    evaluatePreToolUse,
    resetTurn,
    clearSessions,
    testSampleReview,
    getActiveReviewsCount: () => activeReviewsCount,
    logger: reviewLogger
  };
}
