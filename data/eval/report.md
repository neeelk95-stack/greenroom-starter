# Agent eval scorecard

Generated 2026-11-22T00:54:03.338Z. 50 extraction cases (half real deal notes, half paraphrased), 29 two-readings cases, 24 disputed settlements (9 involve a clause the engine or text can verify).

| Model | Field accuracy | Citations verified | Two-readings recall | False flags on clear emails | Disputed: recall | p50 / p95 latency (extract) | Cost per 100 extractions |
|---|---|---|---|---|---|---|---|
| Rules (no AI) | 90.7% | 100% | 52.6% | 0% | 90% | 0 / 1 ms | $0.0000 |

Release gates: field accuracy ≥ 98%, citations 100%, two-readings recall ≥ 90%, false flags on clear emails ≤ 10%.

**Rules (no AI), sample misses:**
- para:show_0052 expenseCap: expected 850, got null
- para:show_0418 hospitalityCap: expected 600, got null
- para:show_0386 dealType: expected vs, got percentage_of_net
- para:show_0386 guaranteeAmount: expected 3728, got null
- para:show_0386 expenseCap: expected 1850, got null
- para:show_0386 hospitalityCap: expected 500, got null
- para:show_0297 expenseCap: expected 1200, got null
- para:show_0370 hospitalityCap: expected 600, got null
- para:show_0161 guaranteeAmount: expected 1113, got null
- para:show_0288 guaranteeAmount: expected 648, got null
