// Schema-safety layer for the three x402 facilitator responses.
//
// @x402/core's HTTPFacilitatorClient (the reference client, and what our own
// seller code eventually talks to) only parses a 2xx response against its
// success schema - a non-2xx response is never read as "payment rejected",
// it's thrown as an exception instead. So every business outcome (valid,
// invalid, malformed-but-classifiable) has to come back as HTTP 200 with a
// schema-shaped body. These helpers exist so that guarantee holds even on
// paths where we never got a real result object back from the scheme (a
// malformed request, or an exception the scheme itself didn't catch).
//
// transaction: "" is the failure placeholder, not an arbitrary choice -
// ExactStellarScheme.settle() itself already returns transaction: "" on
// every one of its own internal failure branches (nothing was ever broadcast
// for that attempt). Using anything else here would be an inconsistency a
// caller has to special-case.

export function invalidVerify(reason, payer, message) {
  return {
    isValid: false,
    invalidReason: reason,
    invalidMessage: message,
    payer,
  };
}

export function invalidSettle(reason, network, message) {
  return {
    success: false,
    errorReason: reason,
    errorMessage: message,
    transaction: "",
    network: typeof network === "string" && network ? network : "unknown",
  };
}

// Defense-in-depth normalization of whatever the scheme DID return, so a
// future @x402/stellar version can't silently break wire compliance by
// omitting a required field.
export function normalizeVerify(result) {
  if (!result || typeof result !== "object") {
    return invalidVerify("facilitator_returned_no_result");
  }
  return {
    ...result,
    isValid: result.isValid === true,
  };
}

export function normalizeSettle(result, fallbackNetwork) {
  if (!result || typeof result !== "object") {
    return invalidSettle("facilitator_returned_no_result", fallbackNetwork);
  }
  return {
    ...result,
    success: result.success === true,
    transaction: typeof result.transaction === "string" ? result.transaction : "",
    network: typeof result.network === "string" && result.network
      ? result.network
      : (typeof fallbackNetwork === "string" && fallbackNetwork ? fallbackNetwork : "unknown"),
  };
}
