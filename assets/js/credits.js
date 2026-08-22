// /credits behavior: start a Stripe Checkout for a credit pack. External file
// (site CSP drops inline script).
(function () {
  document.querySelectorAll("[data-pack-buy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var pack = btn.dataset.packBuy;
      var errEl = document.getElementById("err-" + pack);
      if (errEl) errEl.textContent = "";
      btn.disabled = true; var old = btn.textContent; btn.textContent = "Opening checkout…";
      try {
        var r = await fetch("/api/credits/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: pack }) });
        var j = await r.json();
        if (!r.ok || !j.url) throw new Error(j.error || "Could not start checkout");
        location.href = j.url;
      } catch (e) {
        if (errEl) errEl.textContent = e.message || "Something went wrong.";
        btn.disabled = false; btn.textContent = old;
      }
    });
  });
})();
