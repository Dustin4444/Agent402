// Checkout page (/reports) behavior. External file because the site-wide CSP
// drops 'unsafe-inline' from script-src, so an inline <script> can't run.
(function () {
  var sel = { research: "research", dossier: "dossier", fund: "fund-report", domain: "domain-audit" };
  var need = { dossier: "a ticker.", research: "a question.", fund: "a fund name, ticker, or CIK.", domain: "a domain, e.g. example.com" };
  document.querySelectorAll(".pcard").forEach(function (card) {
    card.querySelectorAll(".tierbtn").forEach(function (b) {
      b.addEventListener("click", function () {
        card.querySelectorAll(".tierbtn").forEach(function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
        sel[card.dataset.kind] = b.dataset.p;
      });
    });
  });
  document.querySelectorAll("[data-buy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var kind = btn.dataset.buy;
      var input = (document.getElementById("in-" + kind).value || "").trim();
      var errEl = document.getElementById("err-" + kind);
      errEl.textContent = "";
      if (!input) { errEl.textContent = "Please enter " + (need[kind] || "a value."); return; }
      btn.disabled = true;
      var label = btn.textContent;
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: sel[kind], input: input }) });
        var j = await r.json();
        if (j && j.url) { window.location = j.url; }
        else { errEl.textContent = (j && j.error) || "Could not start checkout."; btn.disabled = false; btn.textContent = label; }
      } catch (e) {
        errEl.textContent = "Network error, please try again.";
        btn.disabled = false; btn.textContent = label;
      }
    });
  });
})();
