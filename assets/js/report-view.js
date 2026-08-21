// Report delivery page (/r/:sessionId) behavior. External file (CSP: no inline
// script). The session id comes from the #app element's data-session attribute,
// not an inline literal.
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  if (!id) { if (app) app.innerHTML = '<div class="status"><h2>Report not found</h2><p><a href="/reports">Start a new report</a></p></div>'; return; }

  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function mdToHtml(md) {
    var lines = esc(md).split(/\r?\n/), out = [], inList = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      l = l.replace(/\[(\d+)\]/g, '<span class="cite">[$1]</span>');
      l = l.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      l = l.replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      if (/^### /.test(l)) { out.push("<h3>" + l.slice(4) + "</h3>"); continue; }
      if (/^## /.test(l)) { out.push("<h2>" + l.slice(3) + "</h2>"); continue; }
      if (/^# /.test(l)) { out.push("<h1>" + l.slice(2) + "</h1>"); continue; }
      if (/^\s*[-*] /.test(l)) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + l.replace(/^\s*[-*] /, "") + "</li>"); continue; }
      if (inList) { out.push("</ul>"); inList = false; }
      if (l.trim() === "") continue;
      out.push("<p>" + l + "</p>");
    }
    if (inList) out.push("</ul>");
    return out.join("\n");
  }
  function render(s) {
    if (s.status === "done") {
      app.innerHTML = '<div class="report-actions no-print"><button class="btn btn-primary" id="dl-pdf">Download PDF</button><a class="btn btn-ghost" id="copy-link" href="#">Copy link</a><span class="keep-hint">This page is yours to keep — bookmark it or use the link we emailed you.</span></div><div class="report" id="report-body">' + mdToHtml(s.report || "") + "</div>";
      var b = document.getElementById("dl-pdf");
      if (b) b.addEventListener("click", function () { window.print(); });
      var cl = document.getElementById("copy-link");
      if (cl) cl.addEventListener("click", function (e) { e.preventDefault(); try { navigator.clipboard.writeText(location.href); cl.textContent = "Copied ✓"; setTimeout(function () { cl.textContent = "Copy link"; }, 1500); } catch (x) {} });
      return true;
    }
    if (s.status === "error") { app.innerHTML = '<div class="status"><h2>Something went wrong</h2><p>' + esc(s.error || "We couldn't complete this report.") + '</p><p><a href="/reports">Try another report</a></p></div>'; return true; }
    if (s.status === "unpaid") { app.innerHTML = '<div class="status"><h2>Payment not completed</h2><p>This report hasn\'t been paid for yet. <a href="/reports">Start over</a></p></div>'; return true; }
    if (s.status === "not_found" || s.status === "invalid") { app.innerHTML = '<div class="status"><h2>Report not found</h2><p><a href="/reports">Start a new report</a></p></div>'; return true; }
    return false; // generating -> keep polling
  }
  async function poll() {
    try {
      var r = await fetch("/api/r/" + encodeURIComponent(id));
      var s = await r.json();
      if (render(s)) return;
    } catch (e) { /* transient; keep polling */ }
    setTimeout(poll, 3000);
  }
  poll();
})();
