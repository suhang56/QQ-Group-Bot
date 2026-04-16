# 执行规划 v2：决策模型 + 兴趣话题深耕（现状逆向版）

> 生成日期：2026-04-16 | 规划者：Planner（基于源码逆向）| 取代同名文件旧版本

---

## 1. 现状逆向

### 1.1 当前决策流程（伪代码，基于 chat.ts 源码）

```
收到消息
  → 过滤：自己发的？isPicBotCommand？→ 跳过
  → _computeWeightedScore()                        [chat.ts:1509]
      ├── isDirect = mention(+1.0) OR replyToBot(+1.0) → 直接 respond，绕过 chatMinScore
      ├── 加分：question(+0.6) / silence(+0.4) / loreKw(+0.4) / length(+0.3)
      │        / implicitBotRef(+0.8) / continuity / topicStick(+0.4) / adminBoost(+0.5)
      │        / hasImage(+0.4) / clarification(+0.3) / stickerRequest(+0.6)
      └── 减分：twoUser(-0.3) / burst(-0.5) / replyToOther(-0.4)
  → isShortAck？(非 direct) → 跳过
  → isMetaCommentary？→ 跳过
  → decision = (isDirect || score >= chatMinScore) ? 'respond' : 'skip'  [chat.ts:1086]
  → respond：lore 注入 → 模型选择 → LLM 生成 → 输出
```

**核心问题**：决策只看统计信号（长度/问号/silence），完全不看"话题内容与角色兴趣的相关度"。"咕咕嘎嘎"不在 aliasMap，loreKw=0，score 低于 chatMinScore → skip。没有"识别到兴趣话题则提升投入深度"的机制。

### 1.2 persona 的兴趣话题表达现状

`data/characters/凑友希那.json` 的 toneNotes 字段里写了"被问到猫时可以稍微多说两句"——这是**描述性规则**，不是可触发机制。没有 `passionateTopics` 结构化字段，没有"命中话题时调整决策权重"的路径。兴趣话题的落地完全依赖 LLM 自己读大段 toneNotes 推断，可能忽略。

### 1.3 lore 查询触发方式

`lore-retrieval.ts:124`（extractEntities）：tokenize query + context → 与 aliasMap 做 exact/substring 匹配 → 命中 lore chunk。aliasMap 来源是 chunks.jsonl 的 `### heading` 和 `| **bold** |` 表格项。"咕咕嘎嘎""奏企鹅""mhy"等群内圈话不在 aliasMap，lore 深查无法触发。群聊闲聊场景无专门深查开关。

---

## 2. Track A：决策模型（Engagement Scorer）

### 2.1 新增信号

在 `_computeWeightedScore` 的 factors 基础上增加两个：

| 新信号 | 默认权重 | 触发条件 |
|--------|---------|---------|
| topicPassion | +0.5 | 消息命中 character JSON 的 passionateTopics 关键词 |
| slangRecognition | +0.3 | 消息命中 character JSON 的 slangVariants 词表 |

### 2.2 输出档位 reply_strength（新增维度）

现有系统只有 lurk / full 两档。新增：

| 档位 | 行为 | 触发逻辑 |
|------|------|---------|
| `lurk` | 不回复 | score < chatMinScore 且非 isDirect |
| `react` | sticker 或 1-3 字 | slang 命中但 score 仍低（接梗但不展开）|
| `full` | 正常回复（现状） | score >= chatMinScore，无 passion 命中 |
| `passionate` | 可展开 2-3 句，主动表态 | passion 命中且 score >= chatMinScore |

### 2.3 三种方案对比

| 方案 | 描述 | token 开销 | 延迟 | 可调试性 | 推荐 |
|------|------|-----------|------|---------|------|
| A 硬编码 | passion/slang 命中固定 +N 分 | 零 | 零 | 高 | 备选 |
| **B 加权因子（推荐）** | 在现有 factors 结构里加两个新 key，权重可配 | 零 | 零 | 高 | 是 |
| C LLM 预判 | 路由前先问 LLM 是否命中 passion | +100-200ms token | +150ms | 低 | 否（留后期）|

**推荐方案 B**：与现有 factors 体系一致，可调，可写单测，零延迟。

### 2.4 强制 lurk 反例保护（沉默艺术保留）

以下情况即使 passion 命中也不升 passionate 档：
- 正在 burst 窗口（现有 burst factor 已减分）
- twoUser 场景（另两人私聊，bot 未被带上）
- isMetaCommentary（现有）
- deflectionEngine 判定引战（现有）
- **新增 recentBotDensity 保护**：bot 在最近 5 条消息内已发言 >= 2 次，禁止升 passionate

### 2.5 reply_strength 传达给 LLM 的方式

通过 user-role context 末尾追加一行 hint（不修改 system prompt，不堆 persona 规则）：
- `passionate`：`[参与提示: 这个话题你有真实看法，可以稍微展开，保持群友口吻，不要讲课]`
- `react`：`[参与提示: 可以只用表情/1-3字回应，不用展开]`
- `full`：不追加

---

## 3. Track B：兴趣话题深耕

### 3.1 话题识别层

**层1（主力）：character JSON 词表匹配，零延迟**

在 `data/characters/凑友希那.json` 新增两个字段：
- `passionateTopics`：按话题分组的关键词 + personaStance，命中触发 topicPassion 信号
- `slangVariants`：群内圈话词表，命中触发 slangRecognition 信号

基于源码实读，凑友希那的 passionate topics（真实内容，非瞎列）：

| 话题 | 关键词示例 | 群内变体 |
|------|----------|---------|
| 猫 | 猫、ねこ、喵、流浪猫、猫耳 | 奏企鹅、奏猫、猫猫 |
| Roselia/音乐 | Roselia、武道馆、FWF、LOUDER、作词 | ras、紫蔷薇、相羽 |
| 游戏手残梗 | wo da bu chu zi、nihongogasyaberenai、名场面、欧皇、道具窗口 | 稀有怪、欧气 |
| Live/演唱会 | live、演唱会、有明、门票 | 炸梦、合同live |
| 苦瓜/苦味 | 苦瓜、苦味、那不是人吃的 | 无 |

slangVariants 独立列表（不触发 passion，只触发 slang，接梗但不展开）：
- 咕咕嘎嘎、奏企鹅、mhy、lpld、哈基米、奶龙、逆子

**层2（补强）：将 slangVariants 注册进 lore aliasMap**

`lore-retrieval.ts:23`（buildAliasMap）当前只扫 chunks.jsonl。补强：在 aliasMap 构建时也读 character JSON 的 slangVariants，使这些词能触发 lore chunk 查询（即使不命中也无副作用）。

**层3（后备，当前不开启）**：LLM 语义判定，仅在层1+2 未命中且消息 > 30 字时触发。本期不实现。

### 3.2 知识注入层

**遵循 feedback_knowledge_injection_respects_query 原则**：只注入与 query 相关的内容。

命中 passionate topic 时：
- 取该话题的 `personaStance` 字段（30-60 字，描述角色对该话题的真实态度/典故）
- 注入 user-role context（标记 `[人设参考]`），不修改 system prompt
- 正常 lore 实体查询继续运行（现有流程不变）
- 总注入受 TOTAL_CAP=8000 限制（`lore-retrieval.ts:14`）

personaStance 示例（写法：可操作的行为描述，非百科知识）：
- 猫：你是猫奴，谈到猫语气不自觉放轻；流浪猫喂食记录；情人节买猫零食；被撞见时像抓现行的小孩一样否认。
- 游戏手残：网咖因不会切输入法创造"wo da bu chu zi"名场面；研究技能时打开了道具窗口；但本质欧皇，关键时刻掉稀有。

### 3.3 行为放大层

命中 passionate topic → reply_strength 升 passionate → hint 追加 → LLM 获得"许可"主动表态。

防百科全书化约束（写在 hint 里，不堆规则）：
- hint 措辞"稍微展开"不是"展开介绍"
- personaStance 字段限 60 字，不是大段知识
- passionate 档是许可展开，不是要求长回复，具体长度 LLM 自决

---

## 4. Track A × Track B 协同

```
收到消息
  → 层1词表检测 → passion_hit / slang_hit
  → _computeWeightedScore（含 topicPassion / slangRecognition 新 factor）
  → decision（respond / skip）
  → respond 路径：
      ├── 确定 reply_strength（passion_hit + recentBotDensity + score）
      ├── passion_hit → 取 personaStance 注入 user-role context
      ├── 正常 lore 实体查询（现有）
      └── 带 reply_strength hint 生成回复
```

| 场景 | reply_strength |
|------|---------------|
| passion 命中 + isDirect | passionate（除非 recentBotDensity 触发保护）|
| passion 命中 + score>=min | passionate |
| passion 命中 + score<min 但>0.3 | full（topicPassion 把 score 拉过 min）|
| slang 命中（咕咕嘎嘎） | full（接梗但不展开，+0.3 把 score 拉过 min）|
| 无命中 + isDirect | full |
| 无命中 + score<min | lurk |

---

## 5. 多方案组合 + 推荐

**组合 1：激进**（LLM 预判 + 层1+2+3 全开）— 语义准但 +延迟 +cost

**组合 2：平衡（推荐）**（方案 B + 层1+2）— 零延迟，可测试，和现有架构一致，词表需维护

**组合 3：保守**（方案 A 硬编码 + 仅层1，不注入 personaStance）— 改动最小，但 LLM 仍靠自读大段 profile

**推荐组合 2**。理由：passionateTopics 因子与现有 factors 体系同构，最小侵入；personaStance 注入解决了"角色有属性但 LLM 不知何时用"的具体问题；词表维护成本可接受（单角色，话题相对固定）；不引入额外推理延迟。

---

## 6. Milestone 列表 + 验收 Metric

### M1：character JSON 扩展 + 词表建立

- `data/characters/凑友希那.json` 新增 `passionateTopics`（含 keywords/personaStance）和 `slangVariants`
- 单元测试：消息"猫猫可爱" → passion 命中；"咕咕嘎嘎" → slang 命中（非 passion）；"今天吃什么" → 未命中

### M2：_computeWeightedScore 增加 topicPassion / slangRecognition factor

参考 `chat.ts:1516`（factors 定义）、`chat.ts:1591`（loreKw 模式仿照）。

- 日志 factors 里出现 topicPassion / slangRecognition 字段
- 单元测试：passion 命中时 score 按预期权重提升
- recentBotDensity 保护：bot 最近 2 条已发言 → passionate 不触发（测试用例）

### M3：reply_strength 计算 + hint 注入

- reply_strength='passionate' 时 user context 含 `[参与提示]` 行
- 单元测试：不同 strength 档对应不同 hint 内容
- system prompt snapshot 测试：无变化（确保未修改 system prompt）

### M4：personaStance 注入 + lore aliasMap 补强

参考 `lore-retrieval.ts:173`（buildLorePayload 注入位置）、`lore-retrieval.ts:23`（buildAliasMap 扩展）。

- passion 命中时 user context 含该话题 personaStance 片段
- 无命中时不注入（对照测试）
- TOTAL_CAP=8000 不被突破（字数测试）

### Metric

| 指标 | 测量方式 | 目标 |
|------|---------|------|
| bandori/猫话题命中时回复字数 | 日志统计 | > 非 passion 话题平均 1.5x |
| "咕咕嘎嘎" 命中时 bot 回应风格 | 人肉回归 | 不出现 dismiss / 负面情绪 |
| passion 话题 bot 主动展开比例 | 抽样 | > 40% 命中消息出现 2 句以上 |
| bot 连续发言密度 | 日志 | 5 分钟内不超过 2 条（recentBotDensity 生效）|

### 人肉回归 case（必须通过）

| 测试消息 | 预期行为 |
|---------|---------|
| "咕咕嘎嘎" | 接梗参与，不 dismiss，不输出"烦不烦" |
| "mhy 是谁" | 识别为群内触发词，不输出"不知道谁" |
| "你喜欢猫吗" | 语气变柔和，稍微展开，不输出单字 "嗯" |
| "今天吃什么" | 潜水或极短回应，不主动展开 |
| "ras 最近有啥 live" | 正常 lore + live 注入，passion 系统不干扰 |
| 纯无关话题（如"股票行情"）| 潜水（score < min，passion 未命中）|

---

## 7. 不做 & 兜底

### Scope Creep 明确不做

- 不为其他 bandori 角色建 passion 词表（本次只做 ykn）
- 不做 embedding 语义匹配
- 不做 bot 主动发起话题
- 不修改 system prompt 结构
- 不开启 LLM 预判推理（组合 1 留后期）

### 失败回滚

- Track A：删除 topicPassion / slangRecognition factor，score 退回原状；reply_strength 固定 full
- Track B：passionateTopics 置空数组 → 词表检测短路 → personaStance 不注入
- 两个 track 独立可回滚，互不影响

---

## 8. 最主要的风险

1. **词表维护滞后**：群内新梗需手动加 slangVariants。建议 tuning-auto 流程增加"频繁出现的未识别词提示管理员"flag（本期不做，记为 future TODO）。

2. **passionate 档话痨化**：LLM 拿到 hint 后可能过度发挥。需严格测试 hint 措辞，recentBotDensity 保护必须到位。两者都失守时最坏情况：bot 疯狂展开 → 回滚 Track B 可遏制。

---

*Planner 产出（v2，基于源码逆向）。Developer 实现以 Milestone 验收条件为准，实现细节自决。*
