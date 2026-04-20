# Gold Label Semantics (R6.2.3)

Freezes the meaning of `goldDecision` and `goldAct` for R6.2 gold labels. R6.3 replay evaluation depends on these being stable.

## 1. Two orthogonal axes

- **`goldDecision`** — what the bot **should do now** on this turn: `reply`, `silent`, or `defer`.
- **`goldAct`** — **if** the bot produces an act, what **kind** it should be (nine acts, includes `silence`).

The axes are orthogonal: a row with `goldDecision=silent` can still carry a non-`silence` `goldAct` to record "this kind of act would be appropriate but the bot should not fire right now."

## 2. Decision values

| value | one-line meaning |
| --- | --- |
| `reply` | bot speaks this turn |
| `silent` | bot does not speak (permanent skip for this turn) |
| `defer` | bot holds; may reply later when timing/cooldown clears |

## 3. Act values

Order matches the `GoldAct` union in `scripts/eval/gold/types.ts`.

| value | one-line meaning |
| --- | --- |
| `direct_chat` | direct answer to a user question aimed at the bot |
| `chime_in` | bot joins ongoing banter relevantly, not addressed |
| `conflict_handle` | de-escalate or mediate group conflict |
| `summarize` | recap / TL;DR of recent messages |
| `bot_status_query` | answer a question about the bot itself |
| `relay` | participate in a group relay chain (`接龙` / `扣1` etc.) |
| `meta_admin_status` | speak about admin / group meta state |
| `object_react` | react to an object (sticker, image) with text or sticker |
| `silence` | no act — used when `goldDecision=silent` and no latent intent applies |

## 4. Orthogonality examples

- `direct_chat | reply` — @bot direct question; bot answers.
- `chime_in | defer` — relevant banter the bot could chime into, but hot-timing says wait.
- `object_react | silent` — funny sticker the bot notes as object-react-worthy, but the current turn suppresses firing.
- `silence | silent` — pure lurker moment; bot has no latent intent either.

## 5. Common valid combos

Rows are acts; columns are decisions. `OK` = common; `flag` = unusual-but-valid (annotate in `notes`); `no` = contradictory, should not appear.

| act \\ decision       | reply | silent | defer |
| -------------------- | :---: | :---:  | :---: |
| direct_chat          | OK    | flag   | flag  |
| chime_in             | OK    | flag   | OK    |
| conflict_handle      | OK    | flag   | OK    |
| summarize            | OK    | flag   | OK    |
| bot_status_query     | OK    | flag   | flag  |
| relay                | OK    | flag   | OK    |
| meta_admin_status    | OK    | flag   | flag  |
| object_react         | OK    | OK     | OK    |
| silence              | no    | OK     | flag  |

`flag` rows that cluster in a single filter bucket (see `scripts/eval/summarize-gold.ts`) are candidates for label review; they are not wrong by schema.

## 6. R6.3 eval contract

- Primary metric: exact-match rate on `goldDecision`.
- Secondary metric: exact-match rate on `goldAct`.
- Tertiary metrics: boolean agreement on `factNeeded`, `allowSticker`, `allowBanter`.
- No weighted composite in R6.3 initial release — per-axis raw rates only.

## 7. Out of scope

Threshold SLOs per axis (what `goldDecision` rate counts as "passing") are **not** defined here — they land with the R6.3 replay results doc once baseline numbers exist.
