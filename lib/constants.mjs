export const PLUGIN_ID = 'agy-auto-zy';
export const PLUGIN_DISPLAY_NAME = 'Auto-ZY Permissions';
export const PLUGIN_VERSION = '1.0.0';

export const MODE_AUTO_ZY = 'auto-zy';
export const MODE_AUTO_WORKSPACE_ZY = 'auto-workspace-zy';
export const MODE_OFF = 'off';
export const REVIEW_MODES = Object.freeze([MODE_AUTO_ZY, MODE_AUTO_WORKSPACE_ZY, MODE_OFF]);
export const DEFAULT_REVIEW_MODE = MODE_AUTO_ZY;
export const HOOK_ALLOW_DECISION = 'allow';
export const CLI_HOOK_ALLOW_DECISION = 'auto_approve';

export const REASONING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

export const FOLLOW_UP_REVIEW_MODES = Object.freeze(['auto', 'always', 'off']);
export const DEFAULT_FOLLOW_UP_REVIEW_MODE = 'auto';

export const RULE_LIST_NAMES = Object.freeze(['environment', 'allow', 'soft_deny', 'hard_deny']);
export const DEFAULTS_ENTRY = '$defaults';

export const DEFAULT_MAGPIE_PROVIDER = 'magpie';
export const DEFAULT_MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
export const DEFAULT_MAGPIE_API_KEY = 'magpie';
export const DEFAULT_REVIEWER_MODEL = 'group/ds-flash';
export const DEFAULT_REVIEWER_REASONING = 'max';

export const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;
export const MAX_REVIEW_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_CONFIGURABLE_RETRIES = 20;
export const FIRST_RETRY_DELAY_MS = 250;
export const MAX_RETRY_DELAY_MS = 30_000;

export const OUTPUT_RESERVE_TOKENS = 16_384;
export const MAX_CONVERSATION_TOKENS = 256_000;
export const DEFAULT_MODEL_CONTEXT_WINDOW = 400_000;
export const SESSION_AFFINITY_PREFIX = 'auto-review:';

export const MAX_CONSECUTIVE_DENIALS = 3;
export const RECENT_DENIAL_WINDOW_SIZE = 50;
export const MAX_RECENT_DENIALS = 10;
export const CIRCUIT_BREAKER_REFUSAL_MESSAGE =
  'Too many denials this turn; further requests are refused unreviewed until the next turn. Ask the user for explicit approval before retrying';
export const REJECTION_INSTRUCTIONS =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input';

export const MAX_RECENT_UNTRUSTED_ENTRIES = 40;
export const TRANSCRIPT_MESSAGE_TOKEN_BUDGET = 10_000;
export const TRANSCRIPT_TOOL_TOKEN_BUDGET = 10_000;
export const ENTRY_MESSAGE_TOKEN_BUDGET = 2_000;
export const ENTRY_TOOL_TOKEN_BUDGET = 1_000;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TRUNCATION_HEAD_RATIO = 0.7;
export const TRUNCATION_MARKER = '\n...[truncated]...\n';

export const MAX_RATIONALE_LENGTH = 4_000;
export const REVIEW_LOG_FIELD_MAX_WIDTH = 1_000;
export const MAX_RECENT_DECISIONS_IN_UI = 40;

export const CDP_POLL_INTERVAL_MS = 1_800;
export const CDP_CONNECT_TIMEOUT_MS = 3_500;
export const CDP_COMMAND_TIMEOUT_MS = 5_000;
export const CDP_EVALUATE_TIMEOUT_MS = 8_000;
export const CDP_MAX_BINDING_PAYLOAD_BYTES = 131_072;

export const HOST_BINDING_NAME = '__agyAutoZyHost';
export const CLIENT_RECEIVE_GLOBAL = '__agyAutoZyReceive';
export const CLIENT_PUSH_GLOBAL = '__agyAutoZyPush';
export const CLIENT_INSTANCE_GLOBAL = '__agyAutoZy';
