// Report INPUT sufficiency, round 2 (2026-08-26 cross-report review): the
// recall feeds and the domain audit. Each assertion here is a defect a paying
// reader would have been misled by, verified live before it was fixed.
import { recallRow, fdaDate } from "../src/tools/gov-kit.js";
import { tlsScoreOf, certCoversHost } from "../src/tools/domain-audit-kit.js";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// ---- openFDA rows -----------------------------------------------------------
{
  const long = "x".repeat(1200);
  const r = { recalling_firm: "Acme", classification: "Class I", status: "Ongoing", reason_for_recall: `Devices could poten${long}tially connect`, product_description: `${"Losartan ".repeat(30)}NDC 00591-3746-00`, distribution_pattern: "Nationwide", recall_initiation_date: "20240507", recall_number: "D-1-2024", event_id: "94001", termination_date: "20250101", code_info: "Lots A1, A2", product_quantity: "2,924,000 tablets", voluntary_mandated: "Voluntary: Firm initiated" };
  const pub = recallRow(r, false);
  ok(pub.reason.length === 220 && pub.product.length === 180 && pub.lots === undefined, "public $0.004 tool keeps its small caps (220/180) and no lot list");
  ok(pub.eventId === "94001" && pub.terminated === "2025-01-01", "event id and termination date ride on the public row too (zero cost)");
  const full = recallRow(r, true);
  ok(full.reason.endsWith("tially connect") && /NDC 00591-3746-00$/.test(full.product), "full rows keep the whole reason and the NDC at the end of the product description");
  ok(full.lots === "Lots A1, A2" && full.quantity === "2,924,000 tablets" && full.voluntary === "Voluntary: Firm initiated", "full rows carry lots, quantity and voluntary/mandated");
  ok(fdaDate("20240507") === "2024-05-07" && fdaDate(undefined) === null, "FDA dates render ISO; missing stays null");
}

// ---- TLS grade --------------------------------------------------------------
{
  const good = { chainTrusted: true, daysRemaining: 200, subject: "github.com", altNames: ["github.com", "www.github.com"] };
  ok(tlsScoreOf(good, "github.com") === 100, "trusted, matching, long-lived -> 100");
  ok(tlsScoreOf({ ...good, chainTrusted: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "github.com") === 0, "an untrusted chain scores 0 however many days remain (self-signed.badssl.com graded 100 before)");
  ok(tlsScoreOf({ ...good, subject: "badssl.com", altNames: ["badssl.com"] }, "wrong.host.badssl.com") === 0, "a certificate for a different host scores 0 (wrong.host.badssl.com graded 100 before)");
  ok(tlsScoreOf({ chainTrusted: true, daysRemaining: 20, subject: "*.example.com", altNames: ["*.example.com"] }, "www.example.com") === 60, "wildcard covers one label; 20 days -> 60");
  ok(certCoversHost({ subject: "*.example.com", altNames: [] }, "a.b.example.com") === false, "wildcard does not cover two labels");
  ok(certCoversHost({ subject: null, altNames: [] }, "example.com") === null && tlsScoreOf({ chainTrusted: true, daysRemaining: 100 }, "example.com") === 100, "no names seen -> unknown, never penalised");
  ok(tlsScoreOf({ chainTrusted: true, daysRemaining: 0 }) === 0 && tlsScoreOf(null) === null, "expired -> 0; no probe -> null (unassessed)");
}
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
