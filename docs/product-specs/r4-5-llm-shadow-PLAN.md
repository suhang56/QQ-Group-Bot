# R4.5 LLM Shadow Classifier for utterance_act — PLANNER PHASE

**Phase**: 1 of 5 (Planner). **Worktree**: `.claude/worktrees/r4-5-llm-shadow/` on `feat/r4-5-llm-shadow-classifier` (master HEAD `3897126`).
**Status**: doc-only; no code edits in this phase. Hand-off to Designer.

---

## 0. Standing Rules (verbatim — Designer/Architect/Developer/Reviewer must observe)

- ASCII single quotes only in TS / SQL / TS-string literals. No U+2018/U+2019/U+201C/U+201D — they break `tsc` with `Invalid character`.
- No emojis in source, prompts, comments, or docs.
- No Co-Authored-By lines in commits. No `.claude/` paths in commits.
- Conventional Commit messages (`feat(r4-5): ...`, `test(r4-5): ...`, `chore(r4-5): ...`).
- DB schema changes ship BOTH `schema.sql` update AND a try/catch `ALTER TABLE` migration in `db.ts` for existing DBs (precedent: `R4-lite: add utterance_act column` at `db.ts:4351`).
- Helpers normalize input internally; do not push that responsibility to callers (memory `feedback_normalize_inside_helper`).
- Reviewer runs `tsc` + `npx vitest run` themselves before APPROVED — Developer self-test is necessary but not sufficient (memory `feedback_team_lead_self_verify_not_reviewer`).
- Bot is a groupmate, not an assistant — but R4.5 is observability only, no behavior change, so this only constrains gold-set authoring tone.
- Edge tests mandatory in Developer phase. Cover: empty content, image-only, undefined fact-hit, LLM timeout, malformed JSON, schema-violating enum, null-byte content.

---

## 1. Problem statement and trigger rationale

`docs/eval/metrics-baseline-runbook.md:172` lists R4.5 as the "LLM shadow classifier for utterance_act" with promotion gates: `一致率 ≥85% / 分布合理 / cost ≤5x rule-based / p99 ≤800ms`.

Current state (verified via `sqlite3 data/bot.db` against prod, captured 2026-05-05):

| utterance_act | rows | share |
|---|---|---|
| chime_in | 3428 | 95.6% |
| meta_admin_status | 83 | 2.3% |
| direct_chat | 72 | 2.0% |
| relay | 32 | 0.9% |
| bot_status_query | 6 | 0.2% |
| **conflict_handle** | **0** | 0% |
| **summarize** | **0** | 0% |
| **object_react** | **0** | 0% |

Three of eight enum labels are never produced by the rule-based classifier in prod. This is the smell R4.5 must validate or refute: either rule patterns are too narrow (`CONFLICT_RE` / `SUMMARIZE_RE` / `_isObjectReact` at `src/utils/strategy-preview.ts:9-45`), OR these acts genuinely don't occur in the target group at meaningful rate. An LLM shadow run on a labelled gold set is the cheapest way to find out.

The runbook explicitly defers R4.5-vs-R9 selection to "whichever gap real-LLM benchmark surfaces more strongly" (`metrics-baseline-runbook.md:178`). Task #5 indicates R4.5 is now greenlit; this PLAN proceeds.

**This PR DOES**: write LLM-classified label to a NEW shadow column alongside the existing rule-based column; add CLI tooling to compute the four gates from sampled `chat_decision_events` rows.
**This PR DOES NOT**: feed shadow label into the prompt path, change any guard, replace `classifyUtteranceAct`, retune the rule-based classifier, or flip behavior on cohort threshold.

---

## 2. Integration point in current code

The rule-based classifier `classifyUtteranceAct` (defined `src/utils/strategy-preview.ts:47`) is invoked at five call sites — three in router.ts, two in chat.ts:

| File | Line | Phase | Context |
|---|---|---|---|
| `src/core/router.ts` | 829 | Router pre-generate timing gate | non-direct path; `hasRealFactHit: undefined` |
| `src/core/router.ts` | 1249 | DeferQueue recheck | non-direct re-eval after defer drain |
| `src/core/router.ts` | 1449 | `_cancelDefersByDirect` | logs cancel-by-direct silent reason |
| `src/modules/chat.ts` | 1747 | R4-lite hoist (early in `generateReply`) | `metaBuilder.setUtteranceAct(...)` — `hasRealFactHit: undefined` |
| `src/modules/chat.ts` | 2830 | Post-fact-retrieval reclassify | `metaBuilder.setUtteranceAct(...)` — `hasKnownFactTerm` + `hasRealFactHit` real |

The label that ends up persisted to `chat_decision_events.utterance_act` (via `src/modules/chat-decision-tracker.ts:83`) comes from `meta.utteranceAct` set by either:
- The metaBuilder (chat.ts paths — last write wins between L1747 hoist and L2830 reclassify; final = L2830 when reached),
- An inline `meta: { decisionPath: ..., utteranceAct }` literal (router.ts paths).

**Shadow integration site for R4.5**: ONE site, gating on group + cost — the chat.ts L2830 reclassify, which has the richest signal (post-fact-retrieval, `hasKnownFactTerm` and `hasRealFactHit` known). Router.ts paths skip the shadow because:
1. they fire on guard-exit (defer/silent) which already has cheap rule-based labels and adding LLM cost to silenced paths inflates cost-per-rule-based-label ratio (gate #3),
2. the only acts that matter for gate validation are ones that REACH chat.ts, since chime_in dominance comes from non-direct paths the router already filters,
3. router.ts:1449 fires inside an event loop iteration that should not block on a Gemini call.

**Concretely**: insert the shadow call directly after `metaBuilder.setUtteranceAct(classifyUtteranceAct(utteranceCtx))` at chat.ts:2830, gated on a group-level config flag (default false). Result is appended to `meta.utteranceActShadow` (NEW field on BaseResultMeta — Designer to confirm shape) and persisted to NEW DB column `utterance_act_shadow`.

---

## 3. Classifier prompt template — strict JSON schema

### 3.1 Enum (frozen against `src/utils/utterance-act.ts:7-15`)

```
direct_chat
chime_in
conflict_handle
summarize
bot_status_query
relay
meta_admin_status
object_react
```

The shadow classifier MUST output exactly one of these eight strings. No fallback `unknown`, no `none` (Designer phase: enforce via JSON schema `enum` constraint + post-parse validator that rejects out-of-set strings to a NULL persisted shadow value rather than crashing — see Section 6 fallback contract).

### 3.2 Prompt structure (Designer phase finalizes wording)

System prompt (cache=true, persona-free):

```
你是分类器,不是聊天 bot。读群聊片段后,把 trigger 消息归为以下八类之一:

direct_chat       群友直接对 bot 说话(@bot / 回复 bot 消息),期待 bot 回应
chime_in          bot 旁观时插一句,trigger 不是冲着 bot 来的
conflict_handle   群里在吵架/冲突/约架,trigger 是冲突相关
summarize         有人请求总结/复述群里近况
bot_status_query  trigger 直接关心 bot 自身状态(被禁/重启/在不在)
relay             trigger 是接龙/扣 1/+1/收到 等参与式短回应
meta_admin_status 群里讨论管理/禁言/被踢/群规等,trigger 涉及但不直接 @bot
object_react      trigger 是图片/表情包(可带 12 字以内非提问短 caption),无事实点

只输出 JSON,无其它文字:
{"act":"<one of the eight>","confidence":0.0-1.0}
```

User content shape:

```
<recent5>
[user_id_1] msg1
[user_id_2] msg2
[user_id_3] msg3
[user_id_4] msg4
[user_id_5] msg5
</recent5>
<trigger user_id="...">trigger content (CQ codes preserved)</trigger>
<bot_user_id>{botUserId}</bot_user_id>
```

**No persona, no banter, no fact block, no sticker context.** This is a classifier; mixing in chat context inflates token cost and biases the model toward "聊天 bot wants to reply" framing.

### 3.3 Model + decoding

- Model: `gemini-2.5-flash-lite` if available (cost #1 priority for shadow), else `gemini-2.5-flash` with `reasoning_effort: 'none'` (memory `feedback_gemini_thinking_budget`, `feedback_gemini_reasoning_effort_eos`).
- `maxTokens`: 64 (covers a 30-char JSON, leaves margin for the rare 0.99 confidence float).
- No streaming. Single call. No retries on JSON parse failure — log + persist NULL shadow (preserves p99 budget).
- Cache: system prompt is `cache: true` so the breakpoint hits on every shadow call across a group.

### 3.4 Output parsing + validation

- Strip `[mock:...]` sentinel prefix if present (precedent: `scripts/eval/classify-utterance.ts:24`).
- `JSON.parse` inside try/catch; on throw → persist NULL shadow + log warn.
- Validate `act` ∈ enum (use `ALL_UTTERANCE_ACTS` from `src/utils/utterance-act.ts:17`); on miss → NULL shadow + log warn.
- `confidence` is informational; persisted in a paired `utterance_act_shadow_conf` column for downstream confidence-thresholded analysis (Architect to decide if confidence column ships in this PR or is deferred).

---

## 4. Gold set source

### 4.1 Existing assets (verified at `D:/QQ-Group-Bot/data/eval/gold/`)

| File | Rows | Use |
|---|---|---|
| `gold-1027.jsonl` | 1027 | Master gold; consensus labels from R6 extension |
| `benchmark-merged-1027.jsonl` | 1027 | Paired benchmark (input prompts) for replay-runner |
| `benchmark-original-781.jsonl` | 781 | Earlier subset; 04-30 baseline used this |

These DO NOT currently carry an `utterance_act` gold label (the gold schema is built around silent/defer/reply + reasonCode, not act classification). R4.5 must either:

**Option A — extend existing 1027 gold** (preferred): add `utterance_act_gold` field by sampling and human-labelling. This is consistent with the runbook's gold-extension precedent (`metrics-baseline-runbook.md:118-123` describes the same shape for alias regression set).

**Option B — curate a fresh smaller gold**: sample N=200 rows from `chat_decision_events` stratified by current rule-based label (with intentional oversample of the three zero-rows acts), human-label the gold. Smaller; faster; produces a head-to-head where rule-based and LLM both label the same input.

### 4.2 Recommendation: **Option B + reuse Option A inputs**

Reason: gates #1 (一致率) and #2 (分布合理) need a label that does NOT itself come from either classifier — otherwise the comparison is circular. The 1027 gold was labelled for silent/defer/reply correctness, not for the eight-act enum, so even if we extend it the labelling effort is the same. A fresh stratified sample makes the gold-set effort match what the gates measure.

**Proposed sampling plan** (Architect to validate):

| Stratum (rule-based) | Sample N | Rationale |
|---|---|---|
| chime_in | 80 | dominant; need spread |
| direct_chat | 30 | guard-bypass cohort |
| meta_admin_status | 25 | rule-based fired but rare |
| relay | 15 | participation signals |
| bot_status_query | 10 | small but meaningful |
| **OVERSAMPLE candidates from chime_in** with image-only / `[CQ:image,` / `[CQ:mface,` content | 20 | catches `object_react` LLM-discovers |
| **OVERSAMPLE candidates from chime_in** with `CONFLICT_RE` near-misses (吵 / 怼 / 杠) | 10 | catches `conflict_handle` LLM-discovers |
| **OVERSAMPLE candidates from chime_in** with summary near-misses (前情 / 复盘 / 啥情况) | 10 | catches `summarize` LLM-discovers |
| **TOTAL** | **200** | |

Source query (Architect to confirm exact SQL):
```
SELECT id, group_id, trigger_msg_id, trigger_user_id, utterance_act, captured_at_sec
  FROM chat_decision_events
 WHERE captured_at_sec >= unixepoch('2026-04-15')
   AND utterance_act IS NOT NULL
 ORDER BY RANDOM()
 LIMIT 200
```

Joining `messages` for `content` + `recent5` reconstruction is needed to feed the LLM prompt — this is straightforward via `trigger_msg_id` → `messages.source_id`.

Gold file: `data/eval/gold/r4-5-utterance-act-gold-200.jsonl`. Schema:
```
{"event_id":..., "trigger_content":"...", "recent5":[{...}], "rule_based":"chime_in", "gold":"<human label>", "notes":"<optional>"}
```

Human-labelling of 200 rows is ~2 hours one-pass; a same-day re-label of disagreements is the lightweight inter-annotator pass.

### 4.3 Re-curate cadence

Once. The gold set is frozen for this PR. If post-merge the gates are borderline, R4.5b can extend; we don't want gold drift mid-evaluation.

---

## 5. Gate measurement methodology

The PR ships ONE CLI script: `scripts/eval/r4-5-shadow-gates.ts`. It reads recent rows from `chat_decision_events` (or a JSONL replay of them), invokes the LLM shadow classifier offline (NOT live in the bot), and writes a gate-report JSON.

### 5.1 Gate #1 — 一致率 ≥ 85% (rule vs LLM agreement)

NOT measured against gold. This gate measures rule-vs-shadow agreement on the production stream — high agreement means LLM is at least replicating rule-based decisions; low agreement means we DO need the LLM (or rule has a bug, or LLM has a bug — the next gates discriminate).

```sql
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN utterance_act = utterance_act_shadow THEN 1 ELSE 0 END) AS agreed
  FROM chat_decision_events
 WHERE utterance_act_shadow IS NOT NULL
   AND captured_at_sec >= ?  -- last 24h or shadow-rollout window
```

**Pass threshold**: `agreed / total >= 0.85`.

### 5.2 Gate #2 — 分布合理 (LLM produces all eight labels)

Compare shadow-label histogram against gold-set histogram on the 200-row sample. "合理" measured by:

- Each enum label appears at least once in shadow-on-gold output (i.e., LLM IS willing to emit `conflict_handle` / `summarize` / `object_react`).
- KL-divergence(shadow_dist || gold_dist) < 0.5 on the 200-row gold (loose threshold; Architect may tighten).
- Per-label precision (shadow=L when gold=L) and recall (gold=L → shadow=L) computed; report all 8x8 confusion matrix in JSON.

**Pass threshold**: all 8 labels emitted ≥1 + KL < 0.5 + no single-label recall = 0 (i.e., LLM doesn't completely miss any class that gold contains).

### 5.3 Gate #3 — cost ≤ 5x rule-based

Rule-based: $0 marginal (pure-sync function call, no I/O).
LLM shadow: cost-per-row × shadow-fire-rate × daily-event-rate.

**Measured as**:
```
cost_per_day_usd = (gemini_input_tok_per_call * $0.075/M
                  + gemini_output_tok_per_call * $0.30/M)
                  * events_per_day
                  * shadow_sample_rate
```

5x of $0 is undefined; runbook's intent is "LLM shadow cost stays below an acceptable absolute bound". Architect to formalize as **absolute USD/month cap** rather than ratio. PLAN proposes: `<= $1.00/month at 100% sample rate on current 3.6k-events-per-day rate` → at Gemini Flash Lite pricing roughly $0.30-0.50/month, headroom for spike. Achievable only if shadow gates on the chat.ts:2830 path (see Section 2) — calling on every router silent/defer event would 10x the row count.

**Pass threshold**: shadow-on-events-that-reach-chat.ts < $1.00/month at 100% sample, projected from a 24h shadow run.

### 5.4 Gate #4 — p99 latency ≤ 800ms

Shadow runs in-band on chat.ts (synchronous wait would block reply by the gemini call duration), so latency MUST be:
- Awaited on a Promise.race with 800ms cap, OR
- Fire-and-forget (kicked off async, label stamped onto a deferred-update path).

PLAN proposal: **fire-and-forget**. Chat.ts already produces the rule-based label inline; the shadow call kicks off but reply path doesn't await it. When shadow resolves, it issues an UPDATE on the just-inserted `chat_decision_events` row by `id`. This decouples shadow latency from reply latency completely — gate #4 then measures the shadow Promise resolution time histogram via shadow-call-internal telemetry, not user-perceived latency.

**Pass threshold**: shadow Promise resolution p99 ≤ 800ms over 24h window, measured by per-call timer logged into a NEW table or stamped on the row via a `shadow_latency_ms INTEGER` column.

Architect MUST also rule on: what happens if reply path completes + row is inserted, then shadow promise rejects? Answer: shadow stays NULL forever. Gate #1 denominator filters `WHERE utterance_act_shadow IS NOT NULL`; rejected/timed-out shadows simply don't contribute, which is the correct semantic — "we didn't get a shadow opinion".

### 5.5 Gate-report output

`data/eval/snapshots/r4-5-gates-<UTC-yymmdd>.json`:
```
{
  "window": {"from_sec":..., "to_sec":...},
  "n_events": ...,
  "n_shadowed": ...,
  "gate_1_agreement": {"agreed": ..., "total": ..., "rate": ..., "pass": true},
  "gate_2_distribution": {"shadow_hist": {...}, "gold_hist": {...}, "kl": ..., "missing_labels": [], "confusion": [[...]], "pass": ...},
  "gate_3_cost": {"projected_monthly_usd": ..., "pass": ...},
  "gate_4_latency": {"p50_ms": ..., "p99_ms": ..., "pass": ...},
  "all_pass": true|false
}
```

Promotion to "use shadow label in production" is a SEPARATE PR, gated on `all_pass` and an observation window. R4.5 itself ships only the shadow + gate report.

---

## 6. DB persistence — schema delta

### 6.1 Columns to add

ON `chat_decision_events`:
- `utterance_act_shadow TEXT` — nullable; LLM-emitted enum value or NULL on parse fail/timeout/disabled.
- `utterance_act_shadow_conf REAL` — nullable; 0.0-1.0 LLM confidence.
- `utterance_act_shadow_latency_ms INTEGER` — nullable; clock time from shadow promise start to resolve/reject. NULL on dispatch failure.

(Names match existing snake_case + `utterance_act` prefix; column ordering at end of table to keep existing INSERT signature valid until repository updates.)

### 6.2 Migration shape

Mirror the precedent at `db.ts:4351` exactly. After the existing `idx_cde_group_ts` index creation (around `db.ts:4347`), add:

```ts
try { this._db.exec(`ALTER TABLE chat_decision_events ADD COLUMN utterance_act_shadow TEXT`); } catch { /* already exists */ }
try { this._db.exec(`ALTER TABLE chat_decision_events ADD COLUMN utterance_act_shadow_conf REAL`); } catch { /* already exists */ }
try { this._db.exec(`ALTER TABLE chat_decision_events ADD COLUMN utterance_act_shadow_latency_ms INTEGER`); } catch { /* already exists */ }
```

`schema.sql:667-684` also gets the three columns appended after `captured_at_sec INTEGER NOT NULL` (with a comma added before `captured_at_sec`).

### 6.3 Repository surface change

`IChatDecisionEventRepository` (`db.ts:593-596`) gains:
```ts
updateShadow(id: number, shadow: {
  utterance_act_shadow: string | null;
  utterance_act_shadow_conf: number | null;
  utterance_act_shadow_latency_ms: number | null;
}): void;
```

Implementation in `ChatDecisionEventRepository` (`db.ts:3457`): a fresh prepared statement; UPDATE WHERE id=?.

The original `insert(row)` signature stays unchanged (shadow columns NULL by default). This means `ChatDecisionEventRow` interface (`db.ts:547-564`) gains the three new optional/nullable fields — Designer to confirm field naming against existing snake/camel conventions in `chat-decision-tracker.ts:73-89`.

### 6.4 No new index

The shadow columns are filtered in aggregate queries that the gate-report runs offline; not in any hot path. Adding an index now is premature.

---

## 7. Behavior contract — what changes at runtime

| Path | Before R4.5 | After R4.5 |
|---|---|---|
| Reply latency on chat.ts | unchanged | unchanged (fire-and-forget shadow) |
| `utterance_act` column write | unchanged | unchanged |
| `utterance_act_shadow` column | does not exist | written async ~50-800ms after row insert when `chat_prompt_shadow_classifier_v1` group config flag is `true`; NULL otherwise |
| Prompt content / persona / guards | unchanged | unchanged |
| Sticker / fallback / silent / defer paths | unchanged | unchanged (router.ts paths NOT shadowed in this PR) |
| Cost | unchanged | +$0.00-0.50/month at 100% on default group when flag flipped |

### 7.1 Group config flag

NEW key: `chat_prompt_shadow_classifier_v1` (boolean, default `false`). Mirrors the R5 canary flag pattern (`isLayeringV2Enabled` referenced at `chat.ts:3016`). PR ships flag plumbing and OFF default. Manual flip via group-config admin command authorizes shadow on a single group for the observation window.

**Why a flag**: lets us flip shadow on for `958751334` only (the eval target group) without touching cost on other groups, and lets us turn it off instantly if Gemini outage blows the timeout budget.

---

## 8. Out-of-scope (for Architect / Designer / Developer to NOT do)

1. Promotion of LLM shadow label to the prompt-assembler / guard / metaBuilder primary slot. The shadow column is observability ONLY.
2. Behavior change on any reply / silent / defer / sticker path.
3. Prompt-tuning iterations on the classifier. Designer ships ONE prompt; iteration happens in R4.5b after observation.
4. Re-tuning of rule-based `classifyUtteranceAct` patterns. Even if shadow surfaces patterns the rule-based misses, a rule-tune is a separate PR.
5. Shadow on router.ts paths (silent/defer/cancelled-by-direct). Out-of-scope until cost gate proves headroom.
6. New `bot_replies` / `messages` / `chat_decision_effects` writes. R4.5 only writes `chat_decision_events.utterance_act_shadow`.
7. A confidence-thresholded "abstain" label. NULL is the abstain signal; no `unknown` enum addition.
8. Replay-runner integration. The shadow runs in the live bot path only (gated by config flag). The gate-report CLI reads from the live DB or a JSONL dump; it does NOT extend `replay-runner.ts`.
9. Gemini Flash Lite vs Flash decision finalization. Designer phase resolves; PLAN documents both as candidates.
10. UI surfacing of shadow disagreements. CLI output is the only interface in this PR.

---

## 9. Hand-off to Designer (Phase 2)

Designer must produce, in order, in the same worktree:

1. Final classifier system + user prompt wording (Section 3 outline → byte-exact text). Validate that the LLM never emits `none` / `unknown` (the rule-based has these via `classify-utterance.ts` legacy script, but the runtime `UtteranceAct` type does not).
2. Final group-config flag name (PLAN proposes `chat_prompt_shadow_classifier_v1`; Designer confirms against existing `group_config` JSON schema).
3. Final fire-and-forget orchestration shape: where the Promise is created, how the row id is plumbed to the resolve handler, error/timeout/cancellation contract.
4. Final BaseResultMeta extension (does shadow live ON `meta` or ONLY in DB? PLAN recommends DB only — keeps `ChatResult` + `meta` invariant).
5. Final gold-set JSONL schema and seed-curation plan (Architect can co-own the SQL but Designer owns the column naming + tooling).
6. Final cost+latency telemetry shape (separate columns? embedded in a JSON `shadow_meta`?). PLAN recommends three separate columns.
7. The byte-exact list of edge cases for Developer test plan (PLAN baseline at Section 0).

When Designer's deliverable hits disk at `docs/product-specs/r4-5-llm-shadow-DESIGN.md`, mark task #12 complete and ping team-lead.

---

## 10. Summary table for downstream phases

| Field | Value |
|---|---|
| Worktree | `.claude/worktrees/r4-5-llm-shadow/` |
| Branch | `feat/r4-5-llm-shadow-classifier` |
| Master HEAD | `3897126` |
| Integration site | `src/modules/chat.ts:2830` (single shadow fire) |
| LLM | Gemini 2.5 Flash Lite (preferred) or Flash w/ `reasoning_effort: 'none'` |
| DB delta | 3 cols on `chat_decision_events`: `utterance_act_shadow TEXT`, `utterance_act_shadow_conf REAL`, `utterance_act_shadow_latency_ms INTEGER` |
| Migration pattern | try/catch ALTER + schema.sql update (precedent `db.ts:4351`) |
| Group flag | `chat_prompt_shadow_classifier_v1`, default false |
| Gold set | NEW `data/eval/gold/r4-5-utterance-act-gold-200.jsonl`, stratified-200 sample |
| Gate CLI | NEW `scripts/eval/r4-5-shadow-gates.ts` — emits `data/eval/snapshots/r4-5-gates-<date>.json` |
| Behavior change | NONE (observability layer only) |
| Cost ceiling | ~$0.50/month at 100% on target group |
| Edge tests | empty content, image-only, undefined hasRealFactHit, LLM timeout, malformed JSON, schema-violating enum, null-byte content, flag=false no-op |
