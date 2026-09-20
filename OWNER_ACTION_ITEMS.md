# Owner action items

Only you can do these. In priority order.

## 1. Decide on `route-execute` external routing (F-13) - money, live, unclear
`SOR_EXTERNAL_ENABLED=true` in production means Agent402 pays third-party sellers from Havok
hot wallets on four chains. The conservative option is one command, fully reversible:

```sh
railway variables -s agent402 -e production --set SOR_EXTERNAL_ENABLED=false
```

Cost: 276 calls from 5 buyers over 90 days lose the external path; the local catalogue is
unaffected. I did not flip it - it is live revenue and your call.

## 2. Take the repository private (F-14)
Before merging either remediation branch. Steps in `REPO_STRATEGY.md`.

## 3. Rotate the exposed credential (F-05)
The Stellar facilitator bearer in `.remember/` history. Ask the issuer to confirm the **old**
token no longer authenticates, not that a new one exists. Status today: **UNKNOWN**, not
verified rotated.

## 4. Merge the two remediation branches
`legal-risk-remediation` (F-01, F-02, F-03, F-04, F-06) and `final-liability-remediation`.
CAN-SPAM compliance is not live until the first one merges - the address variable is set but
the code that renders it is not deployed.

## 5. Review `seller-dossier` and the leaderboards (F-15)
They publish commercial assessments of named third parties. Defensible if accurate and
non-disparaging; the copy rewrite this session moved in that direction. Decide whether you want
to be in that business at all.

## Questions worth asking if a lawyer ever becomes available
1. Agent402 accepts a buyer payment, then pays a seller **it chooses** from its own wallet, and
   eats the loss if the seller fails. Is that money transmission in NC, or procurement by a
   reseller? (Primary sources in `FINAL_LIABILITY_AUDIT.md` F-13.)
2. Is a closed-loop prepaid balance, redeemable only for our own API calls and never cashed
   out, exempt from NC money-transmitter licensing?
3. Does publishing measured commercial assessments of named competitors' endpoints create
   trade-libel exposure if every number is accurate?
4. AGPL server plus MIT SDKs - does that combination do what we intend for integrators?
