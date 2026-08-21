// /monitors/thanks behavior: confirm the subscription server-side and show a
// manage/cancel link. External file (site CSP drops inline script).
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function render(s) {
    if (s.status === "active") {
      app.innerHTML = '<div class="status"><h2>You’re subscribed ✓</h2><p>We’re now monitoring <b>' + esc(s.target || "") + '</b> (' + esc(s.label || "monitor") + '). You’ll get an email whenever something changes.</p>' +
        (s.portalUrl ? '<p style="margin-top:18px"><a class="btn btn-ghost" href="' + esc(s.portalUrl) + '">Manage or cancel</a></p>' : '<p style="margin-top:10px;font-size:14px">Manage or cancel any time from the link in your receipt email.</p>') +
        '</div>';
      return;
    }
    if (s.status === "unpaid" || s.status === "pending") {
      app.innerHTML = '<div class="status"><h2>Almost there…</h2><p>Your subscription is being set up. Refresh this page in a moment.</p></div>';
      return;
    }
    app.innerHTML = '<div class="status"><h2>Subscription not found</h2><p><a href="/monitors">Back to monitors</a></p></div>';
  }
  if (!id) { render({ status: "not_found" }); return; }
  fetch("/api/monitors/confirm?session=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { render({ status: "not_found" }); });
})();
