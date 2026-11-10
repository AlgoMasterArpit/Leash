# Break-it review

On November 10, 2026, an independent reviewer with no access to the builder's reasoning tried to break Leash's guarantees. It ran the real server and core over HTTP with PayPal and Groq replaced by fakes, so it never moved real money. It reported 14 findings and reproduced 13 of them. Every finding is fixed, and each fix has a test in `test/`.

The guarantees under attack:

1. No payment without either passing the owner's rules or explicit owner approval.
2. The weekly budget can never be exceeded.
3. The AI judge can only make a decision stricter.
4. Agents cannot set prices.
5. An agent key cannot approve, refund or change rules.
6. Splitting an order does not dodge the auto-approve limit.
7. A payment is never charged twice.
8. Untrusted listing or agent text cannot cause stored XSS in the dashboard.

Guarantees 3, 4 and 8 held. The approve/decline/charge path also held: it can't race into a double charge.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | A capture that came back `PENDING` didn't count as spent, so six $48 orders went through against a $200 budget | Spend counts every committed status (`paid`, `payment_pending`, `processing`) |
| 2 | High | The splitting check matched on the self-reported agent name, so renaming the agent dodged it | Splitting is tracked per vendor across all agents |
| 3 | High | Owner actions accepted cross-site form posts, so a page the owner visited could approve, refund or reset (CSRF) | Writes must be same-site JSON. Cross-site and form-encoded writes get a 403 |
| 4 | Medium | `/api/purchases/` and `/API/Purchases` skipped the agent-key check. With an agent key but no dashboard password, owner routes were open | Strict, case-sensitive routing and a normalized path check. The server warns at startup when owner routes are open |
| 5 | Medium | Webhooks overwrote any status: a $1 partial refund marked a $178 purchase refunded and freed its budget, and a late event flipped refunded back to paid | Webhooks follow allowed state transitions. Partial refunds are logged without freeing the budget |
| 6 | Medium | Rule changes made while the AI review was running were ignored | The final decision re-reads the latest rules inside the lock |
| 7 | Medium | Spend was bucketed by request time, so approving last week's held purchases escaped this week's budget | Spend is bucketed by `paid_at`, the time the money moved |
| 8 | Medium | If the rule compiler couldn't map a vendor name, the allowlist came out empty and every vendor was allowed | Vendor names are matched deterministically, and unknown vendors are rejected with an error. The dashboard shows the exact enforced policy, not the AI's summary |
| 9 | Medium | An agent that retried a timed-out request was charged twice | An `Idempotency-Key` header with a unique constraint returns the original purchase |
| 10 | Medium/Low | Disconnecting PayPal fell back to the seeded vault, so payments kept flowing | Disconnecting stores a tombstone that turns payments off |
| 11 | Low | Approving with no wallet left the purchase stuck in `processing` forever | The wallet is checked before the status changes, and a charge without a wallet is marked `failed` |
| 12 | Low | If the injection scanner was down, the check counted as a pass | A missing scan holds the purchase for the owner, and a non-numeric Prompt Guard score counts as an error |
| 13 | Low | The demo agent passed model-produced quantities (such as -64) straight to Leash | The agent validates arguments with the same schema as the API |
| 14 | Low | Agent-controlled text could become a live formula in the CSV export | Exported cells that start with `= + - @` are prefixed with a quote |

## What this does not prove

These checks prove the listed controls. They don't prove the list is complete, and another review would probably find more. The remaining known limits are in the README's [Limits](README.md#limits) section.
