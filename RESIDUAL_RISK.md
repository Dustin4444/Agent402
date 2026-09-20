# Residual risk

After this pass, ranked by likelihood × damages. **No claim is made that anything is compliant
or safe.** These are the exposures that remain.

## 1. Outbound payment for others (F-13) - HIGHEST
Live in production. Unclear whether paying sellers from Havok wallets on a buyer's behalf is
transmission or procurement, and the FinCEN payment-processor exemption is unavailable on
public-chain rails regardless. Likelihood low near-term (tiny volume, no complainant);
damages high (state licensing is per-state, penalties are real). **Mitigation available and
not taken: one environment variable.**

## 2. Public self-audit documents (F-14)
Until the repo is private or the docs are removed, a dated admission of known issues is
public. Likelihood of being found: low today, permanent once indexed. Damages: raises the
floor on every other claim by removing "we didn't know."

## 3. Credential in public history (F-05)
Rotation UNKNOWN. If live, immediate; if dead, hygiene. Cheap to resolve, so the expected cost
is dominated by not checking.

## 4. Unreviewed third-party terms
~18 data providers whose terms were never read. Nasdaq was the one found by accident, which
suggests others exist. Likelihood of any single one acting: low. Aggregate: the most likely
place the next real finding comes from.

## 5. CAN-SPAM not yet live
Address variable set, rendering code unmerged. Every commercial email sent between now and the
merge lacks the required address.

## What would change this ranking
Volume. Every item above is currently protected mostly by being small - 5 buyers on the money
path, ~zero credits usage, no complainants. Growth removes that protection without changing
the underlying exposure.
