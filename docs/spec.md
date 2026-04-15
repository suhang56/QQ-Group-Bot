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

## 11. Sticker-First Mode

### 11.1 Overview

**User request (verbatim):** "给 bot 加一个表情包权重的功能 就是按照它想说的话发表情包 如果有合适的表情包就发 不发文字 如果没有就发文字"

**Interpretation:** A per-group toggle that changes *how* the bot delivers replies. When enabled, the bot runs its full normal reply pipeline and produces the text it **would have sent**. That intended text is then used as the embedding query against the local sticker library. If the best-matching sticker scores at or above the configured threshold, the bot sends the sticker only (the text is discarded). If no sticker qualifies, the text is sent as normal. The feature is additive and never causes a silent drop — if sticker search fails or yields no match, text always wins.

---

### 11.2 User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-1 | group admin | turn sticker-first mode ON for my group | the bot replies with stickers when context matches, feeling more like a real member |
| US-2 | group admin | turn sticker-first mode OFF | the bot reverts to text-only replies immediately |
| US-3 | group admin | set a custom match threshold | I can tune how picky the bot is (different groups have different sticker libraries) |
| US-4 | group admin | see the current mode status | I can confirm the mode without guessing |
| US-5 | group member | receive a contextually appropriate sticker reply | the bot feels natural, not mechanical |
| US-6 | group member | receive a text reply when no sticker fits | the bot never goes silent unexpectedly |

---

### 11.3 Commands

All four commands are restricted to group admins and owner via the existing router-level gate. Non-admin invocations are silently ignored (fall through to chat pipeline) — consistent with all other slash commands.

#### `/stickerfirst_on`
- **Syntax**: `/stickerfirst_on`
- **Permission**: admins and owner only (`E001` if member)
- **Effect**: Sets `group_config.sticker_first_enabled = 1` for this group
- **Response**: `表情包优先模式已开启。当我有话说时，会优先找合适的表情包代替文字发送。`
- **Edge cases**:
  1. Mode already ON → idempotent, respond: `表情包优先模式本来就是开着的。`
  2. Local sticker library empty for this group → enable anyway, warn: `已开启，但本群暂无本地表情包记录，暂时只能发文字。`
  3. Non-admin sends command → silently ignored at router gate

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
- **Effect**: Sets `group_config.sticker_first_threshold` to `<value>`
- **Response**: `表情包匹配阈值已设为 <value>。`
- **Validation**: `parseFloat()` must succeed AND result must satisfy `0.0 <= value <= 1.0`. Non-numeric strings, empty string, `NaN`, `Infinity` all trigger E030.
- **Error cases** (all → `E030`):
  1. Value not a valid float → `无效的阈值格式，必须是 0 到 1 之间的数字（如 /stickerfirst_threshold 0.3）。`
  2. Value < 0.0 → same message
  3. Value > 1.0 → same message
  4. No argument given → `用法：/stickerfirst_threshold <0到1之间的数字>（如 /stickerfirst_threshold 0.3）`
- **Rationale**: The default threshold will almost certainly need per-group tuning because sticker library quality, size, and style varies significantly across groups. Without a runtime command, every tuning attempt requires a code change and redeploy. The default value is TBD by the Architect (see §11.9).

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

### 11.4 Scoring Pipeline

#### Background: the local sticker library

The `local_stickers` table stores image stickers captured passively from the group. Each row has:
- `key`: SHA-256 hash of the image (first 16 hex chars)
- `summary`: a 2–6 character Chinese description generated by the vision model (e.g. "笑哭", "摆烂", "震惊")
- `context_samples`: JSON array of up to 3 text strings from messages that appeared near this sticker when it was observed in the wild
- `count`: how many times observed in the group
- `usage_positive` / `usage_negative`: explicit feedback signal
- `cq_code`: `[CQ:image,file=file:///...]` code to send

#### The key design decision: score against the bot's intended reply, not the trigger

The user's request is "**按照它想说的话**发表情包" — send a sticker *based on what the bot would have said*. This means the embedding query must be the **bot's intended reply text**, generated by the LLM. Scoring against the trigger message or context is the wrong direction.

The sticker-first intercept is a **post-LLM, post-processing filter** inserted in the reply-assembly path — right before `_recordOwnReply`. It cannot fire before the LLM runs because the intended text does not exist yet.

#### Full pipeline (when sticker-first mode is ON)

```
generateReply() runs as normal:
  1. LLM call → raw reply text
  2. sentinelCheck (+ hardened regen if needed)
  3. postProcess (strip <skip>, "...", etc.)
  4. Echo-drop, self-dedup checks
     → if any of the above yields null / <skip> / empty: return null immediately
        (sticker-first intercept never fires on a null reply)

  ── STICKER-FIRST INTERCEPT (new, inserted here) ──
  5. config = db.groupConfig.get(groupId)
     if !config.stickerFirstEnabled → skip to step 9 (text path)
  6. sticker = await _pickStickerForReply(groupId, processedText)
     a. Query local_stickers.getTopByGroup(groupId, 20)
        Filter: summary != null, usagePositive - usageNegative >= stickerMinScoreFloor
     b. If embedder.isReady:
          embed processedText → queryVec
          for each candidate: embed each context_sample → compute cosine(queryVec, sampleVec)
          score[sticker] = max cosine across its context_samples
        Else:
          fall through to text (step 9) — no scoring without embedder
     c. Apply repeat-suppression filter: remove keys in per-group cooldown map
     d. Sort by score descending; take top-1
     e. If top-1 score >= config.stickerFirstThreshold AND localPath file exists:
          return that sticker
        Else:
          return null
  7. If sticker != null:
       _recordOwnReply(groupId, sticker.cqCode)   // track for rotation cooldown
       _recordStickerSent(groupId, sticker.key)    // update repeat-suppression map
       return sticker.cqCode                        // text is discarded
  ──────────────────────────────────────────────────

  8. (sticker null) fall through:
  9. _recordOwnReply(groupId, processedText)
     return processedText
```

#### Cosine similarity in practice

With the MiniLM-L6 embedder used in this project, cosine scores against short Chinese text cluster roughly:
- `< 0.10`: essentially unrelated
- `0.10 – 0.25`: loosely related (same domain, not the same emotion)
- `0.25 – 0.45`: contextually relevant match
- `> 0.45`: strong semantic overlap

The default threshold is **TBD by the Architect** based on actual score distribution against live `local_stickers` data. The Architect must sample at least 10–20 (intendedText, sticker) pairs from the live DB, compute real cosine scores, and pick a value that hits the right sensitivity/precision trade-off. Document the chosen value and justification in the Iteration Contract (task #3).

#### When embedder is not ready

If `embedder.isReady === false`, sticker-first falls through to text. A random or count-ranked sticker sent without semantic validation would be worse (jarring, off-context) than sending the text. Sticker-first is semantically gated.

---

### 11.5 Repeat Suppression

The bot must not send the same sticker twice within a short window, as repeated identical stickers feel broken.

**Requirement**: After a sticker is sent via sticker-first mode, that sticker's `key` is excluded from consideration for the next **5 minutes** in the same group.

**Mechanism** (implementation detail left to Developer, direction for Architect):
- An in-memory `Map<groupId, Map<stickerKey, expiresAtMs>>` owned by `ChatModule`
- Before scoring: filter out candidates whose key is in the cooldown map (not yet expired)
- After sticker send: insert `key → Date.now() + 5 * 60_000`
- Cap per group at 50 entries — evict oldest on overflow
- If top-1 is suppressed: try next-best candidate above threshold
- If all candidates are suppressed OR next-best is below threshold: fall through to text
- Map is in-memory only (resets on restart) — acceptable for a 5-minute window

---

### 11.6 Mode Interaction Matrix

| Concurrent mode | sticker-first ON | Behaviour |
|---|---|---|
| Normal reactive chat | Yes | Intercept fires in `generateReply` after LLM produces intended text |
| `/mimic_on` active | Yes — **does NOT apply** | Router dispatches to `MimicModule.generateMimic` first; `ChatModule.generateReply` is not called. Sticker-first has no hook into the mimic path. Rationale: mimic replicates a specific user's textual register; injecting a sticker silently breaks that persona contract. |
| `/char` persona active | Yes — **applies** | `/char` injects a persona into the system prompt but still runs through `ChatModule.generateReply`. The LLM generates the char's intended reply; sticker-first scores that text. The sticker represents the char's emotional intent — behaviorally correct. |
| Proactive mood messages (`_moodProactiveTick`, silence breakers) | Yes — **does NOT apply** | Proactive messages are sent directly by the mood subsystem, bypassing `generateReply`. No hook point exists in v1. Non-goal: see §11.12. |
| Deflections (identity probe, task, memory-inject shortcuts) | Yes — **does NOT apply** | Deflections short-circuit before the LLM call (`return this._generateDeflection(...)`). The intercept hook is after the LLM; deflections never reach it. |

**Invariant**: sticker-first is a post-LLM filter inside `generateReply`. It does not and cannot affect any code path that bypasses `generateReply`.

---

### 11.7 Fail-Safe Guarantees

sticker-first mode MUST satisfy these invariants at all times:

| Condition | Required result |
|---|---|
| Local sticker library empty for group | Fall through to text — never silent drop |
| Embedder not ready (`isReady === false`) | Fall through to text |
| All candidate stickers below threshold | Fall through to text |
| All candidate stickers in repeat-suppression cooldown | Fall through to text |
| `localPath` file does not exist on disk | Exclude that sticker from candidates; fall through if no valid sticker remains |
| LLM returns `<skip>` or null or empty | Intercept never fires; `generateReply` returns null as normal |
| DB read error during sticker query | Log warning at WARN level; fall through to text |
| Any unhandled exception in `_pickStickerForReply` | Catch, log at ERROR; fall through to text |

**Non-negotiable**: sticker-first can only **replace** a text reply with a sticker. It must never convert a non-null reply into null, and must never produce zero output when the LLM intended to reply.

---

### 11.8 Error Codes (new)

Appended to §3 Error Code Table:

| Code | Name | Cause | Bot response |
|---|---|---|---|
| E030 | STICKER_THRESHOLD_INVALID | `/stickerfirst_threshold` value is not a float in [0.0, 1.0] | `无效的阈值格式，必须是 0 到 1 之间的数字（如 /stickerfirst_threshold 0.3）。` |

---

### 11.9 Schema Changes

**`group_config` new columns** — added via `ALTER TABLE` in `applyMigrations()` only. Do NOT add to `CREATE TABLE` in `schema.sql` (existing DBs skip schema.sql re-runs; ALTER is the only safe migration path per project convention).

| Column | Type | Default | Description |
|---|---|---|---|
| `sticker_first_enabled` | INTEGER | `0` | 1 = sticker-first mode ON for this group |
| `sticker_first_threshold` | REAL | TBD by Architect | Min cosine similarity for a sticker match to win over text |

**Default threshold note**: `0.20` is a placeholder here. The Architect (task #3) must measure real cosine score distributions from the live `local_stickers` table before selecting a default. Document the chosen number and justification in the Iteration Contract.

**`GroupConfig` TypeScript interface** (additions to `db.ts`):
```typescript
stickerFirstEnabled: boolean;
stickerFirstThreshold: number;
```

**`defaultGroupConfig()` additions** (`config.ts`):
```typescript
stickerFirstEnabled: false,
stickerFirstThreshold: <architect-chosen value>,
```

**`applyMigrations()` additions** (`db.ts`):
```sql
ALTER TABLE group_config ADD COLUMN sticker_first_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_config ADD COLUMN sticker_first_threshold REAL NOT NULL DEFAULT <architect-chosen value>;
```

The migration must be wrapped in a try/catch that silently ignores `"duplicate column"` errors (SQLite's error on re-running `ALTER TABLE` on a column that already exists).

---

### 11.10 Static System Prompt Invariant

The sticker scoring query text is the **LLM's own output** (`processedText`), not user-supplied group message content. No user message content is interpolated into any system prompt in this feature. This satisfies the existing prompt-injection defence policy documented in §9.

---

### 11.11 Files Changed

| File | Change |
|---|---|
| `src/storage/schema.sql` | Document the two new columns in a comment (for reference); actual migration is via ALTER only |
| `src/storage/db.ts` | `GroupConfig` interface additions; `applyMigrations()` ALTER statements; upsert/get mapping for both new fields |
| `src/config.ts` | `defaultGroupConfig()` additions |
| `src/modules/chat.ts` | `_pickStickerForReply()` private method; sticker-first intercept block in `generateReply`; repeat-suppression map |
| `src/core/router.ts` | Register `stickerfirst_on`, `stickerfirst_off`, `stickerfirst_threshold`, `stickerfirst_status` commands |
| `src/utils/errors.ts` | Add `STICKER_THRESHOLD_INVALID = 'E030'` to `BotErrorCode` enum |
| `test/sticker-first.test.ts` | Unit tests covering all EC-1 through EC-21 cases |
| `test/router.test.ts` | Command registration + permission + E030 validation tests |

---

### 11.12 V1 Non-Goals

- Sticker-first for proactive mood messages / silence breakers (no `generateReply` hook point)
- Sticker-first for mimic mode (breaks persona contract)
- Sticker-first for private chat (`generatePrivateReply` path)
- Market-face (mface) sticker support in scoring (no `localPath`/vision embeddings in v1)
- Admin-configurable suppress window (hardcoded 5 min)
- Combo reply (sticker + text simultaneously) — intentional binary: sticker OR text, never both

---

### 11.13 Edge Test Cases (mandatory — SOUL RULE, 21 cases)

| ID | Scenario | Precondition | Expected result |
|---|---|---|---|
| EC-1 | Mode OFF: intercept never fires | `stickerFirstEnabled=false`, library non-empty, embedder ready | `generateReply` returns text; `_pickStickerForReply` never called |
| EC-2 | Mode ON, library empty | `stickerFirstEnabled=true`, no `local_stickers` rows for group | Returns text reply (fall-through) |
| EC-3 | Mode ON, all scores below threshold | Top sticker cosine=0.05, threshold=0.25 | Returns text reply |
| EC-4 | Mode ON, one sticker above threshold | cosine=0.35, threshold=0.25 | Returns sticker CQ code only; `processedText` is discarded |
| EC-5 | Mode ON, multiple above threshold | Stickers at cosine 0.4, 0.3, 0.25; threshold=0.20 | Returns sticker with cosine=0.4 (highest score wins) |
| EC-6 | Top sticker suppressed, next-best above threshold | Top key in cooldown; second-best cosine=0.28, threshold=0.20 | Returns second-best sticker's CQ code |
| EC-6b | All candidates suppressed | All sticker keys in cooldown map | Falls through to text reply |
| EC-7 | `/stickerfirst_threshold 0.0` | Valid boundary | Accepted; `stickerFirstThreshold=0.0`; success response |
| EC-8 | `/stickerfirst_threshold 1.0` | Valid boundary | Accepted; `stickerFirstThreshold=1.0`; success response |
| EC-9 | `/stickerfirst_threshold -0.1` | Below range | E030 error response |
| EC-10 | `/stickerfirst_threshold 1.5` | Above range | E030 error response |
| EC-11 | `/stickerfirst_threshold abc` | Non-numeric | E030 error response |
| EC-12 | `/stickerfirst_on` already on | `stickerFirstEnabled=true` | Idempotent: already-on response; DB not dirtied unnecessarily |
| EC-13 | `/stickerfirst_off` already off | `stickerFirstEnabled=false` | Idempotent: already-off response |
| EC-14 | Migration idempotency | `applyMigrations()` called twice on DB that already has both columns | Second call is no-op; no crash; "duplicate column" error swallowed |
| EC-15 | Non-admin `/stickerfirst_on` | `msg.role='member'` | Silently ignored at router gate; message falls to chat pipeline |
| EC-16 | `/stickerfirst_status` accuracy | After `/stickerfirst_on` + `/stickerfirst_threshold 0.3` | Status shows ON, threshold 0.3, correct library count |
| EC-17 | Static system prompt invariant | Sticker-first scoring active | Zero user-supplied content in any `system` block of any LLM call in this path |
| EC-18 | Interaction with `/mimic_on` | `mimicActiveUserId` set, sticker-first ON | Router calls `MimicModule`; `generateReply` never invoked; no sticker-first intercept |
| EC-19 | Interaction with `/char` persona | `/char` active, sticker-first ON | LLM generates char's intended text → sticker-first scores it → sticker returned if above threshold |
| EC-20 | LLM returns `<skip>` | sticker-first ON | `generateReply` returns null before intercept; no sticker sent; zero output is correct |
| EC-21 | Embedder not ready | `embedder.isReady=false`, sticker-first ON | Falls through to text; no error thrown; sticker not sent |
