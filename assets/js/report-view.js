// Report delivery page (/r/:sessionId) behavior. External file (CSP: no inline
// script). The session id comes from the #app element's data-session attribute.
// On completion it renders a branded, print-ready report plus a data appendix:
// Download PDF (window.print with a print stylesheet), one CSV per structured
// table (financials, insider trades), and the full bundle as JSON. Downloads are
// built client-side from the delivered record (this is our own origin, not a
// sandboxed artifact, so Blob downloads work).
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  if (!id) { if (app) app.innerHTML = notFound(); return; }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function notFound() { return '<div class="status"><h2>Report not found</h2><p><a href="/reports">Start a new report</a></p></div>'; }

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

  function productLabel(kind) { return kind === "dossier" ? "Company Due-Diligence Dossier" : "Deep Research Report"; }
  function fmtDate(iso) {
    try { var d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }); }
    catch (e) { return ""; }
  }
  function slugify(s) { return String(s || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "report"; }

  function toCSV(columns, rows) {
    var esc2 = function (v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var out = [columns.map(esc2).join(",")];
    for (var i = 0; i < rows.length; i++) out.push(rows[i].map(esc2).join(","));
    return out.join("\r\n");
  }
  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1200);
    } catch (e) { /* download best-effort */ }
  }

  function renderDone(s) {
    var base = slugify(s.title);
    var tables = Array.isArray(s.tables) ? s.tables : [];
    var sources = Array.isArray(s.sources) ? s.sources : [];

    // Header / letterhead (prints too).
    var head =
      '<div class="rpt-head">' +
        '<div class="rpt-brand"><span class="n">agent402</span><span class="s">Report</span></div>' +
        '<h1 class="rpt-title">' + esc(s.title || "Report") + "</h1>" +
        '<div class="rpt-meta">' + esc(productLabel(s.kind)) + (s.at ? " · " + esc(fmtDate(s.at)) : "") + "</div>" +
      "</div>";

    // Action bar (never printed).
    var dl = tables.map(function (t, i) {
      return '<button class="btn btn-ghost dl-csv" data-i="' + i + '">Download ' + esc(t.label) + " (CSV)</button>";
    }).join("");
    var included = [];
    if (sources.length) included.push(sources.length + " cited sources");
    tables.forEach(function (t) { included.push((t.rows ? t.rows.length : 0) + " " + esc(t.label.toLowerCase()) + " rows"); });
    var actions =
      '<div class="report-actions no-print">' +
        '<button class="btn btn-primary" id="dl-pdf">Download PDF</button>' +
        dl +
        '<button class="btn btn-ghost" id="dl-json">Download all data (JSON)</button>' +
        '<a class="btn btn-ghost" id="copy-link" href="#">Copy link</a>' +
      "</div>" +
      (included.length ? '<div class="keep-hint no-print">Includes ' + included.join(" · ") + ". This page is yours to keep, bookmark it or use the link we emailed you.</div>"
                       : '<div class="keep-hint no-print">This page is yours to keep, bookmark it or use the link we emailed you.</div>');

    app.innerHTML = actions + '<div class="report" id="report-body">' + head + mdToHtml(s.report || "") + "</div>";

    var pdf = document.getElementById("dl-pdf");
    if (pdf) pdf.addEventListener("click", function () { window.print(); });

    var csvBtns = app.querySelectorAll(".dl-csv");
    for (var i = 0; i < csvBtns.length; i++) {
      csvBtns[i].addEventListener("click", function (e) {
        var t = tables[Number(e.currentTarget.getAttribute("data-i"))];
        if (t) download(base + "-" + slugify(t.name || t.label) + ".csv", toCSV(t.columns || [], t.rows || []), "text/csv;charset=utf-8");
      });
    }
    var json = document.getElementById("dl-json");
    if (json) json.addEventListener("click", function () {
      var bundle = { title: s.title, product: productLabel(s.kind), generatedAt: s.at, report: s.report, sources: sources, tables: tables };
      download(base + "-bundle.json", JSON.stringify(bundle, null, 2), "application/json");
    });
    var cl = document.getElementById("copy-link");
    if (cl) cl.addEventListener("click", function (e) {
      e.preventDefault();
      try { navigator.clipboard.writeText(location.href); cl.textContent = "Copied ✓"; setTimeout(function () { cl.textContent = "Copy link"; }, 1500); } catch (x) {}
    });
    return true;
  }

  function render(s) {
    if (s.status === "done") return renderDone(s);
    if (s.status === "error") { app.innerHTML = '<div class="status"><h2>Something went wrong</h2><p>' + esc(s.error || "We couldn't complete this report.") + '</p><p><a href="/reports">Try another report</a></p></div>'; return true; }
    if (s.status === "unpaid") { app.innerHTML = '<div class="status"><h2>Payment not completed</h2><p>This report hasn\'t been paid for yet. <a href="/reports">Start over</a></p></div>'; return true; }
    if (s.status === "not_found" || s.status === "invalid") { app.innerHTML = notFound(); return true; }
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
