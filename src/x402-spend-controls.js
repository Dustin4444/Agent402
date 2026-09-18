// Vendor spend controls on the x402 CLIENT, and why every client we build turns
// them off explicitly.
//
// @x402/core 2.23 gave x402Client a `spendControls` filter that is ON BY
// DEFAULT: an accept is refused unless its asset is one of the scheme's
// "default" (pegged) assets or is named in `allowedAssets`, and a default-asset
// accept is refused above `maxAmountPerPayment`, which defaults to "$1"
// (DEFAULT_MAX_AMOUNT_PER_PAYMENT in @x402/core/client). A refused offer throws
// from the selector, so a buyer built with `new x402Client()` on 2.23+ silently
// gained a ceiling nobody here configured.
//
// Our spend bounds live in our own code and are already checked against the
// accept actually signed: payX402 re-checks `maxAtomic`, route-execute books
// the tier cap through external-spend-guard, the canaries buy legs at known
// prices, and the published packages carry their own per-call / daily caps.
// The vendor default would have refused route-execute-pro's $3 underlying cap,
// every USDG leg (Robinhood's asset is not a "default" asset), and any
// non-default token a seller names - each as a client-side exception before
// anything was signed. So spend controls are DISABLED on every client we
// construct, and the pin (scripts/test-x402-spend-controls.js) requires every
// construction site to say so.
//
// Version-tolerant on purpose: the published packages (mcp/, openclaw/,
// adapters/*) float their @x402 peer range, and a 2.22 client has no
// setSpendControls at all - there the call is a no-op and the old (uncapped)
// behaviour stands, which is the same outcome.

/**
 * Disable the vendor's client-side spend controls on an x402Client. Returns the
 * client for chaining. A client without the method (pre-2.23) is returned as is.
 *
 * @param {object} client - an @x402/core x402Client
 * @returns {object} the same client
 */
export function disableVendorSpendControls(client) {
  if (client && typeof client.setSpendControls === "function") client.setSpendControls(false);
  return client;
}
