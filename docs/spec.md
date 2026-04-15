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

---

## 10. Sticker-First Mode

### 10.1 Overview

**User request (verbatim):** "给 bot 加一个表情包权重的功能 就是按照它想说的话发表情包 如果有合适的表情包就发 不发文字 如果没有就发文字"

**Interpretation:** A per-group toggle that changes *how* the bot replies. When enabled, the bot first generates the text it would normally send, then searches the local sticker library for a sticker whose emotional/contextual meaning matches that intended text. If the best match scores at or above a configurable threshold, the bot sends the sticker instead of the text. If no sticker qualifies, the bot sends the text as normal. The feature is additive and never causes a silent drop — if sticker search is unavailable or yields no match, text always wins.

---

### 10.2 User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-1 | group admin | turn sticker-first mode ON for my group | the bot replies with stickers when context matches, feeling more like a real member |
| US-2 | group admin | turn sticker-first mode OFF | the bot reverts to text-only replies immediately |
| US-3 | group admin | set a custom match threshold | I can tune how picky the bot is about sticker matching |
| US-4 | group admin | see the current mode status | I can confirm the mode without guessing |
| US-5 | group member | receive a contextually appropriate sticker reply | the bot feels natural, not mechanical |
| US-6 | group member | receive a text reply when no sticker fits | the bot never goes silent unexpectedly |

---

### 10.3 Commands

#### `/stickerfirst_on`
- **Syntax**: `/stickerfirst_on`
- **Permission**: admins and owner only (router gate — `E001` if member)
- **Effect**: Sets `group_config.sticker_first_enabled = 1` for this group
- **Response**: `表情包优先模式已开启。当我有话说时，会优先找合适的表情包代替文字发送。`
- **Edge cases**:
  1. Mode already ON → idempotent, respond: `表情包优先模式本来就是开着的。`
  2. Local sticker library empty for this group → enable anyway, warn: `已开启，但本群暂无本地表情包记录，暂时只能发文字。`
  3. Non-admin sends command → `E001` (silently ignored at router gate)

#### `/stickerfirst_off`
- **Syntax**: `/stickerfirst_off`
- **Permission**: admins and owner only
- **Effect**: Sets `group_config.sticker_first_enabled = 0`
- **Response**: `表情包优先模式已关闭，恢复正常文字回复。`
- **Edge cases**:
  1. Mode already OFF → idempotent, respond: `表情包优先模式本来就是关着的。`

#### `/stickerfirst_threshold <value>`
- **Syntax**: `/stickerfirst_threshold <float>`
- **Permission**: admins and owner only
- **Effect**: Sets `group_config.sticker_first_threshold` to `<value>` (must be in `[0.0, 1.0]`)
- **Response**: `表情包匹配阈值已设为 <value>。`
- **Error cases**:
  1. Value is not a valid float → `E030`: `无效的阈值格式，必须是 0 到 1 之间的数字（如 /stickerfirst_threshold 0.3）。`
  2. Value < 0.0 → `E030`: same message
  3. Value > 1.0 → `E030`: same message
  4. No argument given → `E030`: usage hint
- **Validation**: `parseFloat()` must succeed AND result must satisfy `0.0 <= value <= 1.0`. Non-numeric strings, empty string, `NaN`, `Infinity` all trigger E030.
- **Note**: The Architect selects the recommended default value based on observed score distributions in the live `local_stickers` table. This spec allocates the column with a placeholder of `0.20` pending that calibration. The default is documented here for completeness; the Architect MUST override this based on real data and document the chosen default in the Iteration Contract.

#### `/stickerfirst_status`
- **Syntax**: `/stickerfirst_status`
- **Permission**: admins and owner only
- **Response format**:
  ```
  【表情包优先模式状态】
  开关: ON / OFF
  匹配阈值: <threshold>
  本群本地表情包库大小: <N> 张
  最近发送表情包时间: <timestamp or 暂无>
  ```
- **Edge cases**:
  1. No stickers in local library → `本群本地表情包库大小: 0 张`
  2. No sticker ever sent in sticker-first mode → `最近发送表情包时间: 暂无`
  3. Last sticker timestamp: format as `YYYY-MM-DD HH:mm` in bot's local timezone

---

### 10.4 Scoring Pipeline

#### Background: how the existing sticker library works

The local sticker library (`local_stickers` table) stores image stickers captured from the group. Each row has:
- `key`: SHA-256 hash of the image (first 16 hex chars)
- `summary`: a 2–6 character Chinese description generated by vision model (e.g. "笑哭", "摆烂", "震惊")
- `context_samples`: JSON array of up to 3 text strings from messages that appeared near this sticker
- `count`: how many times observed in the group
- `usage_positive` / `usage_negative`: feedback signal from `recordUsage()`
- `cq_code`: the `[CQ:image,file=file:///...]` code to send

The current `_getContextStickers()` in `chat.ts` ranks stickers by embedding-based cosine similarity between the query text and `context_samples`, subject to a `stickerMinScoreFloor` cutoff on `(usagePositive - usageNegative)`.

#### Sticker-first scoring: what changes

In sticker-first mode, the scoring query text changes from the **trigger message** to the **intended reply text** that the LLM just generated. This is the key design insight: we are asking "which sticker best represents what I was about to say?" rather than "which sticker fits the incoming message?"

**Pipeline (when sticker-first mode is ON)**:

```
1. generateReply() runs LLM call as normal → produces intendedText
2. If intendedText is null / <skip> / "..." → return null (no change)
3. Call _pickStickerForReply(groupId, intendedText) →
     a. Query local_stickers: top-20 by count with non-null summary and
        usagePositive - usageNegative >= stickerMinScoreFloor
     b. If embedder ready: embed intendedText and each sticker's context_samples;
        compute max cosine similarity per sticker vs intendedText
     c. If embedder NOT ready: rank by count (usage-weighted fallback)
     d. Apply repeat-suppression filter (see §10.5)
     e. Return top-1 sticker IF score >= stickerFirstThreshold; else return null
4. If sticker returned → send sticker.cqCode ONLY (discard intendedText)
5. If sticker null → send intendedText as normal (existing path)
```

**Cosine similarity score**: ranges [-1, 1] in theory but in practice cluster around [0.0, 0.6] for meaningful semantic matches with the MiniLM-L6 embedder used in this project. Scores above 0.20 typically indicate contextual relevance. The Architect must verify this against real `local_stickers` data before finalising the default threshold.

**Score fallback (embedder not ready)**: when the embedder is unavailable (`embedder.isReady === false`), sticker-first mode falls through to text. Sending a random sticker without semantic validation would be worse than no sticker at all. This is intentional — sticker-first requires the embedding layer.

---

### 10.5 Repeat Suppression

The bot must not send the same sticker twice within a short window, as this feels broken/looping.

**Requirement**: After sending a sticker in sticker-first mode, that sticker's `key` is excluded from consideration for the next **5 minutes** in the same group.

**Mechanism** (implementation detail for Architect/Developer):
- An in-memory `Map<groupId, Map<stickerKey, expiresAtMs>>` in `ChatModule`
- Before returning a candidate sticker, filter out keys that are still in the cooldown window
- On sticker send, insert `key → now + 5min` into the map
- Cap the map per group at 50 entries (evict oldest on overflow)
- After suppression filter: if the top-1 sticker is suppressed, try the next-best candidate. If all candidates are suppressed or the next-best falls below threshold, fall through to text reply.
- Map is in-memory only (resets on restart) — acceptable, cooldown is short

---

### 10.6 Mode Interaction Matrix

| Active mode | sticker-first ON | Behaviour |
|---|---|---|
| Normal chat | Yes | Sticker-first intercept fires after LLM generates intended text |
| `/mimic_on` active | Yes | Mimic path runs first (router §475). `ChatModule.generateReply` is NOT called. Sticker-first does **not** apply to mimic replies. Rationale: mimic output replicates a specific user's textual style; inserting a sticker breaks the persona contract. |
| `/char` active (if implemented) | Yes | `/char` mode operates inside `ChatModule.generateReply` via persona injection into the system prompt. Sticker-first fires on the LLM output from the char persona. The sticker that replaces the text will represent the char's intended reply — behaviorally correct. |
| Proactive mood messages (silence breaker / `_moodProactiveTick`) | Yes — **MODE DOES NOT APPLY** | Proactive messages bypass `generateReply` entirely. Sticker-first is only wired into the `generateReply` path. V1 explicitly excludes proactive messages. |
| Deflections (identity probe, task request, etc.) | Yes — **MODE DOES NOT APPLY** | Deflection shortcuts return before the LLM call. Sticker-first intercept fires after the LLM generates the intended text; since deflections never reach that point, they are unaffected. |

**Summary rule**: sticker-first is a post-LLM filter within `generateReply`. Anything that bypasses or short-circuits `generateReply` is unaffected by the mode.

---

### 10.7 Fail-Safe Guarantees

| Condition | Result |
|---|---|
| Local sticker library empty for group | Fall through to text (never silent drop) |
| Embedder not ready (`isReady === false`) | Fall through to text |
| All candidate stickers below threshold | Fall through to text |
| All candidate stickers suppressed by repeat-suppression | Fall through to text |
| CQ code malformed or missing local file | Fall through to text (sticker selection validates `localPath` existence before returning) |
| LLM returns `<skip>` or null | sticker-first check never reached; `generateReply` returns null as normal |
| DB read error during sticker query | Log warning, fall through to text |

**Invariant**: sticker-first mode can only replace a text reply with a sticker. It can never cause a non-null reply to become null, and it can never produce a zero-output when the LLM was going to reply.

---

### 10.8 Error Codes (additions)

| Code | Name | Cause | Bot response |
|---|---|---|---|
| E030 | STICKER_THRESHOLD_INVALID | `/stickerfirst_threshold` value is not a float in [0,1] | `无效的阈值格式，必须是 0 到 1 之间的数字（如 /stickerfirst_threshold 0.3）。` |

---

### 10.9 Schema Changes

**`group_config` new columns** (added via `ALTER TABLE` migration in `applyMigrations()`, NOT in CREATE TABLE — see project SQLite migration convention):

| Column | Type | Default | Description |
|---|---|---|---|
| `sticker_first_enabled` | INTEGER | `0` | 1 = sticker-first mode ON for this group |
| `sticker_first_threshold` | REAL | `0.20` | Min cosine similarity for a sticker match (Architect must calibrate from real data) |

**`GroupConfig` TypeScript interface** additions:
```typescript
stickerFirstEnabled: boolean;
stickerFirstThreshold: number;
```

**`defaultGroupConfig()` additions**:
```typescript
stickerFirstEnabled: false,
stickerFirstThreshold: 0.20,  // Architect to calibrate
```

**Migration** (in `applyMigrations()`):
```sql
ALTER TABLE group_config ADD COLUMN sticker_first_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_config ADD COLUMN sticker_first_threshold REAL NOT NULL DEFAULT 0.20;
```

---

### 10.10 Permission Model

All four `/stickerfirst_*` commands are restricted to group admins and owner via the existing router-level gate. No member can invoke them. Non-admin invocations are silently ignored (fall through to chat pipeline) — consistent with all other slash commands.

---

### 10.11 Static System Prompt Invariant

Group message content MUST NOT be interpolated into the system prompt in any sticker-first code path. The sticker scoring query text is the **LLM's own output** (intendedText), not user input. This satisfies the existing prompt-injection defence policy.

---

### 10.12 V1 Non-Goals (future extension points)

- Sticker-first for proactive mood messages / silence breakers (excluded: no `generateReply` path)
- Sticker-first for mimic mode (excluded: breaks persona contract)
- Sticker-first for private chat path
- Market-face (mface) sticker support in sticker-first scoring (excluded: mface stickers have summaries but no `localPath` and no vision embeddings; they can be added to the candidate pool in v2 if the embedder learns to score them)
- Admin-configurable suppress window (currently hardcoded to 5 min)
- Combo reply (sticker + text together) — intentionally binary: sticker OR text, never both

---

### 10.13 Edge Test Cases (mandatory, SOUL RULE)

| ID | Scenario | Precondition | Expected result |
|---|---|---|---|
| EC-1 | Mode OFF: sticker-first never fires | `stickerFirstEnabled=false`, library non-empty, embedder ready | `generateReply` returns text; `_pickStickerForReply` is never called |
| EC-2 | Mode ON, library empty | `stickerFirstEnabled=true`, no rows in `local_stickers` for group | Returns text reply (fall-through) |
| EC-3 | Mode ON, library non-empty, all scores below threshold | `stickerFirstEnabled=true`, top sticker cosine=0.05, threshold=0.20 | Returns text reply |
| EC-4 | Mode ON, one sticker above threshold | cosine=0.35, threshold=0.20 | Returns sticker CQ code only; intendedText is discarded |
| EC-5 | Mode ON, multiple above threshold | stickers at cosine 0.4, 0.3, 0.25, threshold=0.20 | Returns the sticker with cosine=0.4 (highest score) |
| EC-6 | Mode ON, top sticker suppressed | Top sticker key in cooldown map; second-best cosine=0.28, threshold=0.20 | Returns second-best sticker's CQ code |
| EC-6b | Mode ON, all candidates suppressed | All stickers in cooldown map | Falls through to text reply |
| EC-7 | Threshold command: valid 0.0 | `/stickerfirst_threshold 0.0` | Accepted; `stickerFirstThreshold=0.0`; success response |
| EC-8 | Threshold command: valid 1.0 | `/stickerfirst_threshold 1.0` | Accepted; `stickerFirstThreshold=1.0`; success response |
| EC-9 | Threshold command: -0.1 | `/stickerfirst_threshold -0.1` | E030 error message |
| EC-10 | Threshold command: 1.5 | `/stickerfirst_threshold 1.5` | E030 error message |
| EC-11 | Threshold command: non-numeric | `/stickerfirst_threshold abc` | E030 error message |
| EC-12 | `/stickerfirst_on` when already on | `stickerFirstEnabled=true` | Idempotent: success message, no DB write if value unchanged |
| EC-13 | `/stickerfirst_off` when already off | `stickerFirstEnabled=false` | Idempotent: `已关着` message |
| EC-14 | Migration idempotency | Run `applyMigrations()` twice on live DB that already has both columns | No error; second run is a no-op (SQLite returns "duplicate column" which is caught and ignored) |
| EC-15 | Permission: non-admin `/stickerfirst_on` | `msg.role='member'` | E001: silently ignored at router gate (falls to chat pipeline) |
| EC-16 | `/stickerfirst_status` reflects current state | After `/stickerfirst_on` + `/stickerfirst_threshold 0.3` | Status shows ON, threshold 0.3, correct library size |
| EC-17 | Static system prompt invariant | sticker-first scoring path active | No user-supplied message content appears in any `system` block of any LLM call |
| EC-18 | Interaction with `/mimic_on` | mimic active + sticker-first ON | Mimic path runs; `generateReply` never called; no sticker-first intercept |
| EC-19 | Interaction with `/char` persona | char mode active + sticker-first ON | LLM generates char persona text → sticker-first scores it → sticker returned if above threshold |
| EC-20 | LLM returns `<skip>` | sticker-first ON, LLM explicitly skips | `generateReply` returns null; sticker-first never fires; zero output (correct) |
| EC-21 | Embedder not ready | `embedder.isReady=false`, sticker-first ON | Falls through to text; no error log; sticker not sent |
