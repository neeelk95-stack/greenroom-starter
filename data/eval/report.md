# Agent eval scorecard

Updated 2026-11-22T18:48:58.220Z. 20 extraction cases (half real deal notes, half paraphrased), 29 two-readings cases, 12 in new wording.

| Model | Field accuracy | Citations verified | Two-readings recall | False flags on clear emails | p50 / p95 latency (extract) | Cost per 100 extractions |
|---|---|---|---|---|---|---|
| Rules (no AI) | 87.4% | 100% | 52.6% (10 of 19) | 0% (0 of 10) | 0 / 3 ms | $0.0000 |
| Gemma 4 12B (local) (first run (Nov 21), before the code checks; entered from its printed results) | 100% | 100% | 89.5% (17 of 19) | 60% (6 of 10) | 18564 / 31587 ms | $0.0000 |
| Claude Sonnet 5.5 | — | — | 94.7% (18 of 19) | 10% (1 of 10) | — | — |
| Claude Haiku 5.5 | 100% | 100% | 78.9% (15 of 19) | 0% (0 of 10) | 2096 / 2780 ms | $0.0285 |

Release gates: field accuracy ≥ 98%, citations 100%, two-readings recall ≥ 90%, false flags on clear emails ≤ 10%.

## Two readings: the model, then the checks

"Model" counts every flag whose quote is in the email. "After checks" is what the agent acts on (lib/agent/tasks/flagChecks.ts).

| Model | Recall: model → after checks | False flags on clear: model → after checks | New wording: recall | New wording: false flags | True flags the checks dropped | p50 / p95 per case | Cost per 100 cases | Run |
|---|---|---|---|---|---|---|---|---|
| Rules (no AI) | 52.6% → 52.6% | 0% (0 of 10) → 0% (0 of 10) | 0% (0 of 6) | 0% (0 of 6) | 0 | 0.0 / 0.0 s | $0.0000 | 2026-11-22 |
| Gemma 4 12B (local) | 89.5% | 60% (6 of 10) | — | — | — | — | $0.0000 | 2026-11-21 |
| Claude Sonnet 5.5 | 94.7% → 94.7% | 10% (1 of 10) → 10% (1 of 10) | 66.7% (4 of 6) | 0% (0 of 6) | 0 | 4.2 / 7.6 s | $0.7298 | 2026-11-22 |
| Claude Haiku 5.5 | 78.9% → 78.9% | 20% (2 of 10) → 0% (0 of 10) | 100% (6 of 6) | 0% (0 of 6) | 0 | 3.4 / 5.5 s | $0.0417 | 2026-11-22 |

**Rules (no AI), sample misses:**
- recoup-2: missed recoup_vs_cap
- door-1: missed door_fees
- walkout-1: missed walkout_amount
- walkout-2: missed walkout_amount
- ratchet-1: missed ratchet_scope
- changed-0: missed changed_after_booking
- changed-2: missed changed_after_booking
- missing-1: missed missing_terms
- missing-2: missed missing_terms
