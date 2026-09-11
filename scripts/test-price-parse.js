#!/usr/bin/env node
// priceToMicroUsd: what a seller published, or null. Never a number we invented.
//
// The old rule deleted every non-digit and parsed the remainder, so
// "$free (since 2026-09-02)" became 20260902 -> $20,260,902. Five live routes
// carried that price in the 2026-09-11 record while their seller was saying
// FREE. The number was not merely wrong, it was a DATE, and nothing downstream
// could tell it from a real quote: the index compares these micro-dollar values
// for drift and the router tiers on them.
//
// Two rules, both here because the data broke them:
//   - a string carrying more than one number is a sentence, not a price -> null
//   - a price published as an OBJECT is still a price the seller stated; 21
//     routes published null while carrying {"amountMinor":50,"currency":"USD"}
import { strict as assert } from "node:assert";
import { priceToMicroUsd } from "../src/x402-index.js";

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

// plain forms
eq(priceToMicroUsd("$0.005"), 5000, "dollar string");
eq(priceToMicroUsd("0.005"), 5000, "bare string");
eq(priceToMicroUsd(0.005), 5000, "number");
eq(priceToMicroUsd("1,000"), 1e9, "thousands separator");
eq(priceToMicroUsd("$0.01 USDC"), 10000, "currency suffix");
eq(priceToMicroUsd("$20000"), 2e10, "a seller really does advertise $20,000 - that is their price, not an error");

// the date-as-price class
eq(priceToMicroUsd("$free (since 2026-09-02)"), null, "a sentence with a date in it is NOT $20,260,902");
eq(priceToMicroUsd("2026-09-02"), null, "a bare date is not a price");
eq(priceToMicroUsd("FREE"), null, "a word is not a price");
eq(priceToMicroUsd("ask us"), null, "neither is an invitation");
eq(priceToMicroUsd("0.01 per 1000 tokens"), null, "two numbers is a rate sentence, not a scalar price");

// object forms the crawl actually carries
eq(priceToMicroUsd({ usd: 0.05 }), 50000, "{usd}");
eq(priceToMicroUsd({ amountMinor: 50, currency: "USD", display: "$0.50" }), 500000, "minor units are cents");
eq(priceToMicroUsd({ display: "$0.25" }), 250000, "display string as the fallback");
eq(priceToMicroUsd({ amountMinor: 50, currency: "EUR" }), null, "minor units in another currency are not USD micro-dollars");

// absences and nonsense
for (const v of [null, undefined, "", {}, [], -1, NaN, Infinity]) eq(priceToMicroUsd(v), null, `${JSON.stringify(v)} is null`);

console.log(`test-price-parse: ${n} assertions OK`);
