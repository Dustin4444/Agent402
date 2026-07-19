# F13 — "charged then 503" on browser-queue saturation: options

**The problem.** The browser pool admits 3 active + 24 queued renders. Payment
settles *before* the handler tries to take a slot, so a 28th concurrent paid
render can settle payment and then get a 503. The idempotency store only caches
HTTP 200 responses, so that 503 is not replayable as a completed purchase — the
buyer paid and got nothing.

**How real is it.** It needs **more than 27 concurrent renders** at once. Today
render is ~15 paid calls in its entire lifetime (~$0.30). So this is an edge that
essentially cannot fire at current volume, the amount at stake is a few cents,
and there is no attacker upside (they'd only be hurting themselves by paying).
Assessed severity: **Low**. That said, "we charge and don't deliver" is a trust
issue worth closing before browser volume ever grows. Pick one:

---

## Option A — Pre-settlement capacity reservation (cleanest correctness)

Reserve a browser slot **before** payment settles. Bind the reservation to the
payment attempt with a short expiry; consume it on successful settlement; release
it on any failure. If a slot can't be reserved, return a **402/503 before
settlement** so the buyer is never charged for a render we can't run.

- **Pros:** correct by construction — a buyer is charged only when a slot is
  guaranteed. No refund/credit machinery.
- **Cons:** most invasive. The x402 payment middleware settles ahead of the
  handler today; this requires threading a capacity check *into* that ordering
  (a pre-settle hook), which touches the payment path — exactly the code we've
  been most careful with. Higher blast radius if done wrong.
- **Effort:** M–L. Needs a small reservation table keyed by the payment nonce,
  and a hook in the paywall before settle.

## Option B — Idempotent credit on saturation (least settlement risk)

Let payment settle as it does now. If the queue is saturated, instead of a bare
503, record a **durable payer credit** (keyed by the signed payment nonce /
payer) that a retry can spend to get the render **without paying again**.

- **Pros:** does not touch settlement ordering at all — the risky payment path is
  untouched. Turns "charged, got nothing" into "charged, retry is free."
- **Cons:** needs a small credit ledger (payer → credits) and a redemption path
  the render route checks before charging. New state to persist (on the /data
  volume, like memory/stats).
- **Effort:** M. Self-contained; no payment-middleware surgery.

## Option C — Accept + document (do nothing in code)

Formally accept the edge: it needs >27 concurrent renders, costs the buyer a few
cents, and an `Idempotency-Key` retry already replays a *successful* render.
Document it in the audit response as **accepted (Low, current volume)** and
revisit if browser volume grows.

- **Pros:** zero code, zero risk. Honest given the numbers.
- **Cons:** the "charged then 503" window technically remains for the rare storm.

---

## Recommendation

At current volume, **Option C** is the honest call — the edge effectively cannot
fire and the fix touches revenue-critical code for a few-cents, near-zero-
probability case. If you'd rather close it in code without going near the payment
path, **Option B** is the safe build (no settlement-ordering change). I'd only
reach for **Option A** if browser rendering becomes a high-volume paid product,
where guaranteeing "charged ⇒ delivered" up front is worth touching the paywall.

**My pick: C now, B when browser volume justifies it. A only if it becomes a
flagship paid path.**
