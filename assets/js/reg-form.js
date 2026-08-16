(function(){
  // Shared self-serve seller registration handler - was duplicated
  // byte-for-byte-ish between sell.js and market-page.js's per-chain pages
  // (CSP hardening, 2026-08-16). The two copies had drifted slightly: only
  // the market-page.js version pluralized "tool"/"tools" correctly, so that
  // behavior now applies everywhere rather than only on chain pages. The
  // trailing "appears on..." sentence differs by page (a chain page names
  // itself, /sell doesn't), so it rides a data-listed-note attribute on
  // #reg-out instead of being baked into the script per page.
  var btn = document.getElementById("reg-go");
  if (!btn) return;
  var out = document.getElementById("reg-out");
  btn.addEventListener("click", async function(){
    if (btn.disabled) return;
    btn.disabled = true;
    out.style.color = "var(--muted)";
    out.textContent = "probing…";
    var note = out.getAttribute("data-listed-note") || "Appears on /marketplace and any chain page it advertises.";
    try {
      var r = await fetch("/api/index/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: document.getElementById("reg-origin").value }) });
      var j = await r.json();
      var n = (j.seller && j.seller.toolCount) || 0;
      out.style.color = j.listed ? "var(--green)" : "var(--accent-lit)";
      out.textContent = j.listed
        ? ("Listed - " + ((j.seller && j.seller.displayName) || j.origin) + " (" + n + " tool" + (n === 1 ? "" : "s") + "). " + note)
        : ("Not listed: " + (j.error || "unknown error"));
    } catch (e) {
      out.style.color = "var(--accent-lit)";
      out.textContent = "submission failed - try again";
    } finally {
      btn.disabled = false;
    }
  });
})();
