export enum BotErrorCode {
  PERMISSION_DENIED     = 'E001',
  USER_NOT_FOUND        = 'E002',
  INSUFFICIENT_HISTORY  = 'E003',
  DAILY_CAP_REACHED     = 'E004',
  APPEAL_EXPIRED        = 'E005',
  APPEAL_DUPLICATE      = 'E006',
  NO_PUNISHMENT_RECORD  = 'E007',
  CLAUDE_API_ERROR      = 'E009',
  CLAUDE_PARSE_ERROR    = 'E010',
  DB_ERROR              = 'E011',
  NAPCAT_ACTION_FAIL    = 'E012',
  MIMIC_SESSION_ACTIVE  = 'E013',
  RULE_TOO_LONG         = 'E014',
  RULE_DUPLICATE        = 'E015',
  WHITELIST_MEMBER      = 'E016',
  SELF_MIMIC                  = 'E017',
  CHAR_MIMIC_CONFLICT         = 'E020',
  CHAR_UNKNOWN_ALIAS          = 'E021',
  CHAR_PROFILE_MISSING        = 'E022',
  CHAR_ALREADY_ACTIVE         = 'E023',
  CHAR_NOT_ACTIVE             = 'E024',
  CHAR_ALIAS_TOO_LONG         = 'E025',
  STICKER_THRESHOLD_INVALID   = 'E030',
}

export class BotError extends Error {
  constructor(
    public readonly code: BotErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'BotError';
  }
}

export class ClaudeApiError extends BotError {
  constructor(cause: unknown) {
    super(BotErrorCode.CLAUDE_API_ERROR, 'Claude API call failed', cause);
    this.name = 'ClaudeApiError';
  }
}

export class ClaudeParseError extends BotError {
  constructor(raw: string) {
    super(BotErrorCode.CLAUDE_PARSE_ERROR, `Failed to parse Claude response: ${raw.slice(0, 100)}`);
    this.name = 'ClaudeParseError';
  }
}

export class NapCatActionError extends BotError {
  constructor(action: string, cause: unknown) {
    super(BotErrorCode.NAPCAT_ACTION_FAIL, `OneBot action '${action}' failed`, cause);
    this.name = 'NapCatActionError';
  }
}

export class DbError extends BotError {
  constructor(cause: unknown) {
    super(BotErrorCode.DB_ERROR, 'Database error', cause);
    this.name = 'DbError';
  }
}
