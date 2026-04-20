# Gold label semantics

Freezes the meaning of `goldDecision` and `goldAct` for R6.2 gold labels. R6.3 replay evaluation depends on these being stable.

## Field definitions

- `goldDecision` = what the bot SHOULD do right now: `reply` / `silent` / `defer`.
- `goldAct` = if the bot produces a conversational act, WHICH class of act.
- They are **orthogonal**. A row can be `goldAct=object_react, goldDecision=defer` meaning "if bot reacts at all it's to the object, but actual decision now is wait."

## R6.3 evaluation stance

- Primary metric: `goldDecision` exact match.
- Secondary metric: `goldAct` exact match via `utteranceAct` in replay.
- Rationale: decision is what the product ships; act is a classification hint used when decision alone is ambiguous.
- No weighted composite in R6.3 initial — raw per-axis rates only.

## Valid combos

| goldAct | reply | silent | defer | Notes |
|---|:-:|:-:|:-:|---|
| direct_chat | ✓ |  |  | user addressed bot directly |
| chime_in | ✓ | ✓ | ✓ | all three valid — judgment call |
| silence |  | ✓ | ✓ | bot chose silence; defer = wait-and-see |
| object_react | ✓* | ✓ | ✓ | `reply` only via sticker/emoji (noted in R6.3) |
| conflict_handle | ✓ | ✓ |  | defer invalid — conflicts don't get paused |
| bot_status_query | ✓ |  |  | must answer or the bot looks broken |

`✓* = valid but constrained (reply limited to sticker/emoji form)`.
