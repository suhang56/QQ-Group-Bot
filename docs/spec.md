# QQ Group Bot — Functional Spec

## 1. Command List

> **Global rule**: All slash commands (`/...`) are restricted to group admins and owner at the router level. Messages starting with `/` sent by `member`-role users are silently ignored — they fall through to the normal chat/mimic pipeline. Individual command handlers may add further permission checks (e.g. `rule_add`, `rule_false_positive`) as defense-in-depth.
>
> **`/appeal` caveat**: Even though `/appeal` is intended for regular members to appeal their own punishments, it is currently subject to the same admin-only gate. Punished members who are not admins cannot invoke `/appeal` via the slash command. This is a known limitation — the workaround is to contact an admin who can trigger the appeal flow or use `/rule_false_positive` directly.

### `/help`
- **Syntax**: `/help`
- **Permission**: admins and owner only (router gate)
- **Response**: plain-text menu listing all commands with one-line descriptions
- **Edge cases**:
  1. Sent in private message → reply "This bot only works in group chats."
  2. Bot lacks send permission → silently log error, no crash
  3. Sent during bot startup (modules not ready) → reply "Bot is initializing, please wait."

---

### `/mimic @user [topic]`
- **Syntax**: `/mimic @<QQ_ID> [optional topic text]`
- **Permission**: admins and owner only (router gate)
- **Response**: `[模仿 @Nickname] <generated reply in target's style>`
- **Edge cases**:
  1. Target user has 0 messages in DB → reply "No message history found for @Nickname. Cannot mimic."
  2. Target user has <5 messages → reply "⚠️ Only N messages found for @Nickname. Mimicry may be inaccurate." then proceed
  3. @-ing the bot itself → reply "I can't mimic myself."
  4. Topic text >500 chars → truncate to 500, proceed normally

---

### `/mimic_on @user`
- **Syntax**: `/mimic_on @<QQ_ID>`
- **Permission**: admins and owner only (router gate); one active mimic session per group at a time
- **Response**: "Mimic mode ON: all my replies in this group will imitate @Nickname. Use /mimic_off to stop."
- **Edge cases**:
  1. Another mimic session already active → reply "Mimic mode already active for @OtherUser. Use /mimic_off first."
  2. Target has 0 messages → reject same as `/mimic`
  3. Admin calls `/mimic_on @bot_admin` → allowed, no special restriction
  4. Bot restarts mid-session → session state lost; next message treated as no mimic mode (persisted in group_config)

---

### `/mimic_off`
- **Syntax**: `/mimic_off`
- **Permission**: admins and owner only (router gate)
- **Response**: "Mimic mode OFF. Back to normal chat mode."
- **Edge cases**:
  1. No active mimic session → reply "Mimic mode is not currently active."
  2. Called by different user than who started session → allowed (no ownership enforcement)
  3. Called while bot is generating a mimic reply → finish current reply, then disable

---

### `/rule_add <description>`
- **Syntax**: `/rule_add <natural-language rule or violation example>`
- **Permission**: group admins and owner only
- **Response**: "Rule added (ID: {rule_id}): {first 80 chars of rule}..."
- **Edge cases**:
  1. Non-admin calls → reply "Permission denied. Only admins can add rules."
  2. Empty description → reply "Rule description cannot be empty."
  3. Duplicate rule (cosine similarity >0.95 with existing) → reply "Similar rule already exists (ID: {id}). Add anyway? Reply /rule_add --force <description>"
  4. Description >2000 chars → reject, reply "Rule too long (max 2000 chars)."
  5. DB write fails → reply "Failed to save rule. Please try again." and log error

---

### `/rule_false_positive <msg_id>`
- **Syntax**: `/rule_false_positive <message_id>`
- **Permission**: group admins and owner only
- **Response**: "Marked message {msg_id} as false positive. Moderation action reversed. Adding as negative example to learner."
- **Edge cases**:
  1. Non-admin calls → "Permission denied."
  2. msg_id not found in moderation_log → "No moderation record found for message ID {msg_id}."
  3. Punishment already reversed (appealed earlier) → "This action was already reversed."
  4. msg_id refers to a kick (user already removed) → reverse the record in DB, but cannot un-kick; reply "Record corrected, but user was already kicked and must be re-invited manually."
  5. msg_id >72h old → process normally (no time limit on admin corrections)

---

### `/appeal`
- **Syntax**: `/appeal` (must be sent by the punished user, within 24h of punishment)
- **Permission**: admins and owner only (router gate — see caveat above)
- **Response**: "Appeal submitted for your most recent punishment. An admin will review. Punishment suspended pending review."
- **Edge cases**:
  1. No recent punishment for this user → "No recent punishment found for your account."
  2. >24h since punishment → "Appeal window has expired (24 hours). Contact an admin directly."
  3. Already appealed same punishment → "You have already submitted an appeal for this punishment."
  4. User has been kicked → they cannot send group messages; reply via private message if possible, else log only
  5. Admin reviews: approve → call `/rule_false_positive <msg_id>` flow; deny → reply to user "Your appeal was denied."

---

### `/rules`
- **Syntax**: `/rules`
- **Permission**: admins and owner only (router gate)
- **Response**: numbered list of all active rules for this group (truncated to 20 shown; "... and N more. Use /rules page 2")
- **Edge cases**:
  1. No rules configured → "No rules have been set for this group yet. Admins can use /rule_add."
  2. >20 rules → paginate: `/rules page <N>`
  3. Rule text >200 chars → truncate with "..."

---

### `/stats`
- **Syntax**: `/stats`
- **Permission**: admins and owner only (router gate)
- **Response**:
  ```
  📊 Group Stats (last 7 days):
  - Messages processed: {N}
  - Violations detected: {N}
  - Punishments issued: {N}
  - Appeals: {N} ({N} approved)
  - Daily punishment cap remaining: {remaining}/{cap}
  - Active mimic mode: {OFF | @Nickname}
  ```
- **Edge cases**:
  1. No data yet → show zeros
  2. DB query timeout → "Stats temporarily unavailable."
  3. Called by non-member (edge: forwarded to another chat) → show group stats anyway (not sensitive)

---

## 2. Claude API JSON Schemas

### 2.1 Moderator — Initial Screen (claude-sonnet-4-6)

**Request payload** (messages array entry role=user):
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 256,
  "system": [
    {
      "type": "text",
      "text": "<group_rules_and_examples>",
      "cache_control": {"type": "ephemeral"}
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Assess this message for rule violations.\nMessage: \"<escaped_message_content>\"\nSender role: <member|admin|owner>\n\nRespond ONLY with valid JSON matching this schema, no other text."
    }
  ]
}
```

**Response schema** (Claude must return):
```json
{
  "violation": true,
  "severity": 3,
  "reason": "User posted spam links violating rule #2",
  "confidence": 0.87
}
```

**Field constraints**:
| Field | Type | Values | Required |
|---|---|---|---|
| `violation` | boolean | true/false | yes |
| `severity` | integer | 1–5 (null if violation=false) | yes |
| `reason` | string | max 200 chars | yes |
| `confidence` | float | 0.0–1.0 | yes |

**Severity meaning**:
- 1: Minor (spam/off-topic)
- 2: Moderate (mild insult, repeated spam)
- 3: Significant (harassment, hate-adjacent)
- 4: Severe (explicit hate, serious threats)
- 5: Critical (illegal content, doxxing, extreme violence)

### 2.2 Moderator — Kick Confirmation (claude-opus-4-6)

Same schema as above. Called only when initial screen returns severity=5. If second call also returns severity=5 with confidence>0.8, proceed to kick.

### 2.3 Chat Module (claude-sonnet-4-6)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 300,
  "system": [
    {
      "type": "text",
      "text": "You are a longtime member of the QQ group '{group_name}'. Match the casual, informal tone of the group. Reply naturally in Chinese. Keep replies short (1-3 sentences). Do NOT reveal you are an AI unless directly asked.",
      "cache_control": {"type": "ephemeral"}
    }
  ],
  "messages": "<last 20 group messages as alternating user/assistant turns>"
}
```

### 2.4 Mimic Module (claude-sonnet-4-6)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 300,
  "system": [
    {
      "type": "text",
      "text": "You are roleplaying as '{nickname}'. Below are their real messages. Match their exact vocabulary, sentence length, emoji usage, and topics. Prefix your reply with '[模仿]'.",
      "cache_control": {"type": "ephemeral"}
    }
  ],
  "messages": [
    {"role": "user", "content": "Here are {nickname}'s past messages:\n<50-100 sampled messages>\n\nNow reply to: {topic_or_latest_message}"}
  ]
}
```

### 2.5 Learner — Rule Embedding (local @xenova/transformers)

No Claude API call. Uses local embedding model. Input: rule text string. Output: Float32Array vector stored as BLOB in `rules.embedding_vec`.

---

## 3. Error Code Table

| Code | Name | Cause | Bot response |
|---|---|---|---|
| E001 | PERMISSION_DENIED | Non-admin used admin command | "Permission denied. Admins only." |
| E002 | USER_NOT_FOUND | @-mentioned user has no DB record | "No history found for @User." |
| E003 | INSUFFICIENT_HISTORY | Target has <5 messages | Warning shown, proceeds |
| E004 | DAILY_CAP_REACHED | Group hit daily punishment limit | No punishment, log only; send warning to admins |
| E005 | APPEAL_EXPIRED | Appeal >24h after punishment | "Appeal window expired." |
| E006 | APPEAL_DUPLICATE | Already appealed same punishment | "Already appealed." |
| E007 | NO_PUNISHMENT_RECORD | msg_id not in moderation_log | "No record found." |
| E008 | ALREADY_REVERSED | Punishment already reversed | "Already reversed." |
| E009 | CLAUDE_API_ERROR | Anthropic API returned error/timeout | Fail-safe: no punishment, log error |
| E010 | CLAUDE_PARSE_ERROR | Claude response not valid JSON | Fail-safe: treat as violation=false |
| E011 | DB_ERROR | SQLite read/write failure | "Temporarily unavailable." + log |
| E012 | NAPCAT_ACTION_FAIL | OneBot action (ban/kick) returned error | Log, notify admin via group msg |
| E013 | MIMIC_SESSION_ACTIVE | /mimic_on called while session active | "Mimic already active for @User." |
| E014 | RULE_TOO_LONG | Rule description >2000 chars | "Too long (max 2000 chars)." |
| E015 | RULE_DUPLICATE | Similarity >0.95 with existing rule | Prompt to use --force |
| E016 | WHITELIST_MEMBER | Admin triggered moderation | Skip all punishment silently |
| E017 | SELF_MIMIC | Bot asked to mimic itself | "Cannot mimic myself." |

---

## 4. `group_config` DB Schema

Table: `group_config`

| Column | Type | Default | Description |
|---|---|---|---|
| `group_id` | TEXT | PK | QQ group ID |
| `enabled_modules` | TEXT | `'chat,mimic,moderator,learner'` | Comma-separated active modules |
| `auto_mod` | INTEGER | `1` | 1=fully automatic punishment |
| `daily_punishment_limit` | INTEGER | `10` | Max punishments per day |
| `punishments_today` | INTEGER | `0` | Resets at midnight |
| `punishments_reset_date` | TEXT | today | ISO date of last reset |
| `mimic_active_user_id` | TEXT | `NULL` | QQ ID of current mimic target |
| `mimic_started_by` | TEXT | `NULL` | QQ ID of who started mimic mode |
| `chat_trigger_keywords` | TEXT | `NULL` | JSON array of keywords to trigger chat |
| `chat_trigger_at_only` | INTEGER | `0` | 1=only reply when @-mentioned |
| `chat_debounce_ms` | INTEGER | `2000` | Debounce window for consecutive messages |
| `mod_confidence_threshold` | float | `0.7` | Min confidence to act on violation |
| `mod_whitelist` | TEXT | `'[]'` | JSON array of whitelisted QQ IDs |
| `appeal_window_hours` | INTEGER | `24` | Hours user can appeal after punishment |
| `kick_confirm_model` | TEXT | `'claude-opus-4-6'` | Model for sev5 double-check |
| `created_at` | TEXT | now | ISO datetime |
| `updated_at` | TEXT | now | ISO datetime, updated on each change |

---

## 5. Rate Limit Rules

### Per-User
| Action | Limit | Window | Cooldown on exceed |
|---|---|---|---|
| Any command | 10 | 60s | 30s block |
| `/mimic` | 3 | 60s | 2min block |
| `/appeal` | 1 per punishment | — | N/A (hard limit) |
| `/rules` | 5 | 60s | 10s block |

### Per-Group
| Action | Limit | Window | On exceed |
|---|---|---|---|
| Bot chat replies | 20 | 60s | Silently stop replying |
| Moderator API calls | 60 | 60s | Queue (FIFO, max depth 100) |
| Total punishments | `daily_punishment_limit` | 24h | E004 |

### Implementation
- In-memory `Map<userId, {count, windowStart}>` in `rateLimiter.ts`
- Persisted daily punishment count in `group_config.punishments_today`
- Window reset: rolling window (not fixed clock)

---

## 6. Moderation Escalation Ladder

```
severity 1 (confidence >= threshold):
  → delete_msg
  → send_group_msg: "@User 请注意群规 (warning #{warn_count})"
  → log to moderation_log

severity 2 (confidence >= threshold):
  → delete_msg
  → send_group_msg: "@User 违规警告 #{warn_count}。累计3次警告将自动禁言。"
  → log to moderation_log

severity 3 (confidence >= threshold):
  → delete_msg
  → set_group_ban: duration=600 (10 min)
  → send_group_msg: "@User 已禁言10分钟: {reason}"
  → log to moderation_log

severity 4 (confidence >= threshold):
  → delete_msg
  → set_group_ban: duration=3600 (1 hour)
  → send_group_msg: "@User 已禁言1小时: {reason}"
  → log to moderation_log

severity 5 (confidence >= threshold):
  → [PAUSE — call claude-opus-4-6 for confirmation]
  → if confirmed (sev=5, confidence>0.8):
    → delete_msg
    → set_group_kick
    → send_group_msg: "用户 {nickname} 因严重违规已被移出群聊: {reason}"
    → log to moderation_log (action='kick')
  → else:
    → downgrade to severity returned by Opus, re-run ladder
```

**Whitelist check**: Before ANY action, if sender QQ ID in `group_config.mod_whitelist` → skip entirely (E016), log only.

**Daily cap check**: Before ANY punishment action, if `punishments_today >= daily_punishment_limit` → E004, notify admin group, skip punishment.

**Warn accumulation**: Track warnings per user per group in `moderation_log`. If warn_count >= 3 within 7 days → auto-escalate next offense by +1 severity.

---

## 7. Whitelist + Daily Cap Semantics

### Whitelist
- Stored as JSON array of QQ IDs in `group_config.mod_whitelist`
- Default: `[]` (empty — group owner and admins are determined dynamically via OneBot `get_group_member_info`, not hardcoded)
- Bot checks `role` field from OneBot: `owner` and `admin` → always whitelisted at runtime regardless of stored list
- Manual whitelist entries: added via future `/whitelist_add @user` command (admin only); for now populated only by direct DB edit
- Whitelisted user triggers → log as E016, zero punishment, zero cap decrement

### Daily Cap
- `group_config.punishments_today` increments on each completed punishment action (delete, ban, kick)
- Warning-only actions (sev 1 no delete) do NOT count toward cap
- Reset: at midnight (local server time), a scheduled job sets `punishments_today=0`, `punishments_reset_date=today`
- When cap reached: send one group message "⚠️ Daily moderation limit reached. Further violations will be logged but not punished automatically. Admins please review."
- Message sent only once per day (tracked by flag in memory)

---

## 8. Appeal Flow

```
User sends /appeal in group chat
  ↓
Check: user has punishment in moderation_log where appealed=0 AND timestamp > NOW()-24h
  ↓ not found → E001/E005
  ↓ found
Mark moderation_log.appealed=1
If action was 'ban': call set_group_ban(duration=0) to lift ban immediately
Send group: "@User 申诉已提交，禁言已暂时解除，等待管理员审核。"
Notify admins: "用户 @User 申诉了 {punishment_type}，原因: {ai_reason}. 使用 /rule_false_positive {msg_id} 批准或 /appeal_deny {msg_id} 拒绝。"
  ↓
Admin approves via /rule_false_positive:
  → moderation_log.reversed=1
  → Add message as negative example to learner
  → Send: "@User 申诉成功，处罚已撤销。"

Admin denies via /appeal_deny {msg_id}:  [future command, phase 2]
  → If ban: re-apply original ban duration minus time already served
  → moderation_log.appealed=2 (denied)
  → Send: "@User 申诉被拒绝。"
```

**24h window**: `appeal_window_hours` in group_config (default 24). Calculated as `punishment_timestamp + appeal_window_hours*3600 > NOW()`.

**Kick edge case**: Kicked user cannot send group messages. Bot attempts private message (send_private_msg). If that also fails (user blocked bot), log E012 and notify admins instead.

---

## 9. Additional Notes

### Prompt Injection Defense
- All group message content passed to Claude in `user` role messages only
- System prompt never interpolates raw message content
- Message content is escaped (no markdown special chars passed raw)

### Fail-Safe Defaults
- Any Claude API error → E009, treat violation=false, no punishment
- Any JSON parse failure → E010, treat violation=false, no punishment
- Any OneBot action failure → E012, log, alert admin, do NOT retry automatically

### Storage Notes
- `messages.deleted=1` marks soft-deleted messages (moderated)
- `moderation_log` never deletes rows — append-only audit trail
- `rules.type`: `'positive'` = this IS a violation example; `'negative'` = false positive, NOT a violation
