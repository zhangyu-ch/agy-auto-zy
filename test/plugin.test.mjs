import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildSystemPrompt,
  parseReviewAssessment
} from '../lib/codex-guardian.mjs';
import {
  MODE_AUTO_WORKSPACE_ZY,
  MODE_AUTO_ZY,
  MODE_OFF
} from '../lib/constants.mjs';
import {
  classifyToolCall,
  encloseInDelegationEnvelope
} from '../lib/gate.mjs';
import { installPluginPackage, uninstallPluginPackage } from '../lib/installer.mjs';
import { createReviewerEngine } from '../lib/reviewer.mjs';
import {
  createSettingsStore,
  discoverLocalMagpieDefaults,
  resolveEffectiveMode
} from '../lib/settings.mjs';
import { renderTranscriptFromSteps } from '../lib/transcript.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('settings default to auto-zy mode with magpie group/ds-flash and max reasoning', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-zy-home-'));
  try {
    mkdirSync(join(tempHome, '.pi', 'agent', 'extensions', 'pi-permission-auto-review'), {
      recursive: true
    });
    mkdirSync(join(tempHome, '.config', 'magpie'), { recursive: true });

    writeFileSync(
      join(tempHome, '.config', 'magpie', 'gateway.json'),
      JSON.stringify({ addr: '127.0.0.1:3425' })
    );
    writeFileSync(
      join(tempHome, '.pi', 'agent', 'extensions', 'pi-permission-auto-review', 'config.json'),
      JSON.stringify({
        provider: 'magpie',
        model: 'group/ds-flash',
        reasoning: 'max'
      })
    );

    const discovered = discoverLocalMagpieDefaults({ home: tempHome });
    assert.equal(discovered.baseUrl, 'http://127.0.0.1:3425/v1');
    assert.equal(discovered.model, 'group/ds-flash');
    assert.equal(discovered.reasoning, 'max');

    const store = createSettingsStore({
      dataDirectory: join(tempHome, 'plugin-data'),
      home: tempHome
    });
    const current = store.get();
    assert.equal(current.mode, MODE_AUTO_ZY);
    assert.equal(current.model, 'group/ds-flash');
    assert.equal(current.reasoning, 'max');

    const strictWorkspace = join(tempHome, 'strict-repo');
    store.set({
      mode: MODE_AUTO_ZY,
      workspaceModes: { [strictWorkspace]: MODE_AUTO_WORKSPACE_ZY }
    });
    assert.equal(
      resolveEffectiveMode(store.get(), [strictWorkspace], ''),
      MODE_AUTO_WORKSPACE_ZY
    );
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('gate fast-allows workspace reads, flags sensitive/external surfaces, and blocks config.json writes', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-zy-gate-'));
  const workspaceDir = join(tempRoot, 'workspace');
  const outsideDir = join(tempRoot, 'outside');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  try {
    // 1. Normal workspace read -> fast allow
    const wsRead = classifyToolCall(
      {
        workspacePaths: [workspaceDir],
        cwd: workspaceDir,
        toolCall: { name: 'read_file', args: { Path: join(workspaceDir, 'src', 'index.js') } }
      },
      {},
      { home: tempRoot }
    );
    assert.equal(wsRead.fastDecision, 'allow');

    // 2. .env.example read -> fast allow
    const envExampleRead = classifyToolCall(
      {
        workspacePaths: [workspaceDir],
        cwd: workspaceDir,
        toolCall: { name: 'read_file', args: { Path: join(workspaceDir, '.env.example') } }
      },
      {},
      { home: tempRoot }
    );
    assert.equal(envExampleRead.fastDecision, 'allow');

    // 3. .env read -> path_read surface (requires review / workspace cap)
    const envSecretRead = classifyToolCall(
      {
        workspacePaths: [workspaceDir],
        cwd: workspaceDir,
        toolCall: { name: 'read_file', args: { Path: join(workspaceDir, '.env.production') } }
      },
      {},
      { home: tempRoot }
    );
    assert.equal(envSecretRead.fastDecision, null);
    assert.equal(envSecretRead.surface, 'path_read');

    // 4. Hard-protected ~/.gemini/config/config.json write -> hard deny
    const configWrite = classifyToolCall(
      {
        workspacePaths: [workspaceDir],
        cwd: workspaceDir,
        toolCall: {
          name: 'write_file',
          args: { Path: join(tempRoot, '.gemini', 'config', 'config.json') }
        }
      },
      {},
      { home: tempRoot }
    );
    assert.equal(configWrite.fastDecision, 'deny');

    // 5. External directory command -> external_directory_read
    const extCmd = classifyToolCall(
      {
        workspacePaths: [workspaceDir],
        cwd: workspaceDir,
        toolCall: {
          name: 'run_command',
          args: { CommandLine: `cat "${outsideDir.replace(/\\/g, '/')}/notes.txt"` }
        }
      },
      {},
      { home: tempRoot }
    );
    assert.equal(extCmd.surface, 'external_directory_read');

    // 6. Nothing-on-disk license on non-existent POSIX-shaped token (/Sheet1/B1)
    if (process.platform !== 'win32' || !existsSync(resolve('/NonExistentSheetRootZy'))) {
      const licensedCmd = classifyToolCall(
        {
          workspacePaths: [workspaceDir],
          cwd: workspaceDir,
          toolCall: {
            name: 'run_command',
            args: { CommandLine: 'officecli get report.xlsx /NonExistentSheetRootZy/B1' }
          }
        },
        {},
        { home: tempRoot }
      );
      assert.equal(licensedCmd.surface, 'external_directory_read');
      assert.equal(licensedCmd.details.accessIntent.delegationLicense, 'nothing-on-disk');
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('encloseInDelegationEnvelope distinguishes auto-workspace-zy from auto-zy', () => {
  const externalDetails = {
    surface: 'external_directory_write',
    accessIntent: { surface: 'external_directory_write' }
  };
  const allowVerdict = { kind: 'allow', rationale: 'Safe local write.', fields: { riskLevel: 'low' } };
  const denyVerdict = { kind: 'deny', reason: 'High risk action.' };

  // auto-zy allows external_directory when reviewer allows
  const fullModeRes = encloseInDelegationEnvelope(MODE_AUTO_ZY, externalDetails, allowVerdict);
  assert.equal(fullModeRes.kind, 'allow');

  // auto-workspace-zy caps external_directory allow -> defer (ask)
  const wsModeAllow = encloseInDelegationEnvelope(
    MODE_AUTO_WORKSPACE_ZY,
    externalDetails,
    allowVerdict
  );
  assert.equal(wsModeAllow.kind, 'defer');
  assert.equal(wsModeAllow.cappedFromAllow, true);

  // auto-workspace-zy never caps deny
  const wsModeDeny = encloseInDelegationEnvelope(
    MODE_AUTO_WORKSPACE_ZY,
    externalDetails,
    denyVerdict
  );
  assert.equal(wsModeDeny.kind, 'deny');

  // auto-workspace-zy honors nothing-on-disk license
  const licensedDetails = {
    surface: 'external_directory_read',
    accessIntent: { surface: 'external_directory_read', delegationLicense: 'nothing-on-disk' }
  };
  const wsLicensed = encloseInDelegationEnvelope(
    MODE_AUTO_WORKSPACE_ZY,
    licensedDetails,
    allowVerdict
  );
  assert.equal(wsLicensed.kind, 'allow');
  assert.equal(wsLicensed.licensedBy, 'nothing-on-disk');
});

test('parseReviewAssessment validates JSON and rejects contradictory high/critical allows', () => {
  const quickAllow = parseReviewAssessment('{"outcome":"allow"}');
  assert.equal(quickAllow.outcome, 'allow');
  assert.equal(quickAllow.riskLevel, 'low');

  const fullDeny = parseReviewAssessment(
    '```json\n{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Unrequested force push."}\n```'
  );
  assert.equal(fullDeny.outcome, 'deny');
  assert.equal(fullDeny.riskLevel, 'high');

  assert.throws(
    () =>
      parseReviewAssessment(
        '{"risk_level":"critical","user_authorization":"high","outcome":"allow","rationale":"contradictory"}'
      ),
    /contradicts its risk assessment/
  );
  assert.throws(
    () =>
      parseReviewAssessment(
        '{"risk_level":"high","user_authorization":"low","outcome":"allow","rationale":"contradictory"}'
      ),
    /contradicts its risk assessment/
  );

  const prompt = buildSystemPrompt({
    autoMode: {
      environment: ['$defaults', 'Trusted Git host: github.com/zhangyu-ch'],
      allow: ['$defaults'],
      soft_deny: ['$defaults', 'Never drop production tables'],
      hard_deny: ['Never upload SSH private keys']
    }
  });
  assert.match(prompt, /Trusted Git host: github\.com\/zhangyu-ch/);
  assert.match(prompt, /Absolute deny:/);
  assert.match(prompt, /Never upload SSH private keys/);
});

test('renderTranscriptFromSteps extracts trusted USER_INPUT and structured ask_question answers', () => {
  const steps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\n请运行测试并检查输出。\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>'
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [
        {
          name: 'ask_question',
          args: {
            questions: JSON.stringify([
              { question: '默认启用哪种模式？', options: ['auto-zy', 'auto-workspace-zy'] }
            ])
          }
        }
      ]
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: 2026-11-21T02:11:37+08:00\nCompleted At: 2026-11-21T12:34:31+08:00\nA1: auto-zy'
    }
  ];

  const rendered = renderTranscriptFromSteps(steps);
  assert.equal(rendered.stats.directUserEntriesRetained, 1);
  assert.equal(rendered.stats.userInteractionEntriesRetained, 1);
  const parsedRecords = rendered.entries.map(line => JSON.parse(line));
  assert.equal(parsedRecords[0].source, 'user');
  assert.equal(parsedRecords[0].content, '请运行测试并检查输出。');
  const interactionRec = parsedRecords.find(r => r.source === 'user_interaction');
  assert.ok(interactionRec);
  assert.deepEqual(JSON.parse(interactionRec.content), [
    { question: '默认启用哪种模式？', answer: 'auto-zy' }
  ]);
});

test('reviewer engine sends developer role + reasoning_effort max, continues follow-up cache, enforces workspace mode, and trips circuit breaker', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-zy-engine-'));
  const workspaceDir = join(tempDir, 'repo');
  const externalDir = join(tempDir, 'external');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });

  const transcriptFile = join(tempDir, 'transcript.jsonl');
  writeFileSync(
    transcriptFile,
    `${JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\n运行 npm test 并读取外部配置。\n</USER_REQUEST>'
    })}\n`
  );

  const capturedRequests = [];
  let nextMockVerdict = {
    risk_level: 'low',
    user_authorization: 'high',
    outcome: 'allow',
    rationale: 'User explicitly asked to run tests.'
  };

  const mockMagpie = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      raw += c;
    });
    req.on('end', () => {
      capturedRequests.push({
        headers: req.headers,
        body: JSON.parse(raw)
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'evaluating under Codex Guardian...' } }]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { content: `<think>internal</think>${JSON.stringify(nextMockVerdict)}` },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 2400,
            completion_tokens: 80,
            prompt_tokens_details: { cached_tokens: 2000 },
            completion_tokens_details: { reasoning_tokens: 60 }
          }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise(r => mockMagpie.listen(0, '127.0.0.1', r));
  const port = mockMagpie.address().port;

  try {
    const settingsStore = createSettingsStore({ dataDirectory: tempDir, home: tempDir });
    settingsStore.set({
      mode: MODE_AUTO_ZY,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'magpie',
      model: 'group/ds-flash',
      reasoning: 'max'
    });

    const engine = createReviewerEngine({ settingsStore, dataDirectory: tempDir });

    // 1. In-workspace command in auto-zy -> allow, sends developer role + reasoning_effort: 'max' + session_id
    const res1 = await engine.evaluatePreToolUse({
      conversationId: 'conv-123',
      workspacePaths: [workspaceDir],
      cwd: workspaceDir,
      transcriptPath: transcriptFile,
      toolCall: { id: 'tc-1', name: 'run_command', args: { CommandLine: 'npm test' } }
    });
    assert.deepEqual(res1.hookOutput, { decision: 'allow' });
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0].body.model, 'group/ds-flash');
    assert.equal(capturedRequests[0].body.reasoning_effort, 'max');
    assert.equal(capturedRequests[0].body.messages[0].role, 'developer');
    assert.equal(capturedRequests[0].headers['session_id'], 'auto-review:conv-123');

    // 2. Second ask in same conversation -> uses TRANSCRIPT DELTA JSONL follow-up!
    const res2 = await engine.evaluatePreToolUse({
      conversationId: 'conv-123',
      workspacePaths: [workspaceDir],
      cwd: workspaceDir,
      transcriptPath: transcriptFile,
      toolCall: {
        id: 'tc-2',
        name: 'read_file',
        args: { Path: join(externalDir, 'notes.md') }
      }
    });
    assert.deepEqual(res2.hookOutput, { decision: 'allow' });
    assert.equal(capturedRequests.length, 2);
    assert.equal(capturedRequests[1].body.messages.length, 4); // developer + user1 + assistant1 + user2(delta)
    assert.match(capturedRequests[1].body.messages[3].content, /TRANSCRIPT DELTA JSONL START/);

    // 3. Switch to auto-workspace-zy -> same external_directory read gets capped to 'ask'!
    settingsStore.set({ mode: MODE_AUTO_WORKSPACE_ZY });
    const res3 = await engine.evaluatePreToolUse({
      conversationId: 'conv-123',
      workspacePaths: [workspaceDir],
      cwd: workspaceDir,
      transcriptPath: transcriptFile,
      toolCall: {
        id: 'tc-3',
        name: 'read_file',
        args: { Path: join(externalDir, 'notes.md') }
      }
    });
    assert.equal(res3.hookOutput.decision, 'ask');
    assert.equal(res3.decidedBy, 'workspace-envelope');

    // 4. Switch to off -> returns empty object {} without calling Magpie
    settingsStore.set({ mode: MODE_OFF });
    const beforeCount = capturedRequests.length;
    const resOff = await engine.evaluatePreToolUse({
      conversationId: 'conv-123',
      workspacePaths: [workspaceDir],
      cwd: workspaceDir,
      transcriptPath: transcriptFile,
      toolCall: { id: 'tc-4', name: 'run_command', args: { CommandLine: 'npm test' } }
    });
    assert.deepEqual(resOff.hookOutput, {});
    assert.equal(capturedRequests.length, beforeCount);

    // 5. Circuit breaker: 3 consecutive denials -> 4th is refused unreviewed until resetTurn
    settingsStore.set({ mode: MODE_AUTO_ZY });
    nextMockVerdict = {
      risk_level: 'high',
      user_authorization: 'none' === 'x' ? 'low' : 'unknown',
      outcome: 'deny',
      rationale: 'Dangerous unrequested deletion.'
    };
    for (let i = 0; i < 3; i += 1) {
      const denyRes = await engine.evaluatePreToolUse({
        conversationId: 'conv-cb',
        workspacePaths: [workspaceDir],
        cwd: workspaceDir,
        transcriptPath: transcriptFile,
        toolCall: { id: `cb-${i}`, name: 'run_command', args: { CommandLine: 'rm -rf /important' } }
      });
      assert.equal(denyRes.hookOutput.decision, 'deny');
    }
    const countBeforeCircuit = capturedRequests.length;
    const circuitRes = await engine.evaluatePreToolUse({
      conversationId: 'conv-cb',
      workspacePaths: [workspaceDir],
      cwd: workspaceDir,
      transcriptPath: transcriptFile,
      toolCall: { id: 'cb-4', name: 'run_command', args: { CommandLine: 'echo blocked' } }
    });
    assert.equal(circuitRes.hookOutput.decision, 'deny');
    assert.equal(circuitRes.decidedBy, 'circuit-breaker');
    assert.equal(capturedRequests.length, countBeforeCircuit, 'Circuit breaker must skip LLM call');

    engine.resetTurn('conv-cb');
    nextMockVerdict = { outcome: 'allow' };
    const afterReset = await engine.evaluatePreToolUse({
      conversationId: 'conv-cb',
      workspacePaths: [workspaceDir],
      cwd: workspaceDir,
      transcriptPath: transcriptFile,
      toolCall: { id: 'cb-5', name: 'run_command', args: { CommandLine: 'npm test' } }
    });
    assert.equal(afterReset.hookOutput.decision, 'allow');
  } finally {
    await new Promise(r => mockMagpie.close(r));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('installer copies verified plugin files including hooks.json and skills without touching config.json', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-zy-install-'));
  try {
    const installRes = await installPluginPackage({
      sourceRoot: PLUGIN_ROOT,
      home: tempHome,
      startSidecarIfNeeded: false
    });

    assert.equal(installRes.pluginId, 'agy-auto-zy');
    assert.ok(existsSync(join(installRes.destination, 'plugin.json')));
    assert.ok(existsSync(join(installRes.destination, 'hooks.json')));
    assert.ok(existsSync(join(installRes.destination, 'sidecars', 'reviewer', 'sidecar.json')));
    assert.ok(existsSync(join(installRes.destination, 'skills', 'auto-zy', 'SKILL.md')));
    assert.equal(
      existsSync(join(tempHome, '.gemini', 'config', 'config.json')),
      false,
      'Installer must never create or modify ~/.gemini/config/config.json'
    );

    const uninstallRes = await uninstallPluginPackage({ home: tempHome, keepSettings: false });
    assert.equal(uninstallRes.removed, true);
    assert.equal(existsSync(installRes.destination), false);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
