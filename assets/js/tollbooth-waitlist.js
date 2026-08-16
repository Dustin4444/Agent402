(function(){
  var form = document.getElementById('wl');
  var doneEl = document.getElementById('wl_done');
  var errEl = document.getElementById('wl_err');
  var btn = document.getElementById('wl_submit');
  var originalBtnText = btn.textContent;
  var kind = form.getAttribute('data-kind') || 'waitlist';
  function fields(){
    return {
      kind: kind,
      name: (document.getElementById('f_name').value||'').trim(),
      email: (document.getElementById('f_email').value||'').trim(),
      org: (document.getElementById('f_org').value||'').trim(),
      sites: (document.getElementById('f_sites').value||'').trim(),
      plan: document.getElementById('f_plan').value,
      message: (document.getElementById('f_msg').value||'').trim(),
      website: (document.getElementById('f_hp').value||'')
    };
  }
  function showError(msg){
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    errEl.style.display = 'none';
    var f = fields();
    if (!f.name || !f.email) { showError('Name and email are required.'); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      var r = await fetch('/api/tollbooth/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(f),
      });
      if (r.ok) {
        form.style.display = 'none';
        doneEl.style.display = 'block';
        return;
      }
      // F10 (privacy): fail CLOSED. We never place the lead's name/email/org/
      // message in a URL (GitHub issue pre-fill, or anything else) - that would
      // leak PII into browser history, referrers, and endpoint logs and break
      // the private-storage promise above. On any failure we show an honest
      // retry error and keep the form so the user can resubmit; no success is
      // shown and no data leaves the page.
      if (r.status === 503) { showError('Our signup service is briefly unavailable. Please try again in a few minutes.'); }
      else if (r.status === 429) { showError('Too many submissions - please try again in a minute.'); }
      else if (r.status === 400) { showError('Please double-check your name and email.'); }
      else { showError('Something went wrong. Please try again.'); }
    } catch (_) {
      showError('Could not reach the server. Please check your connection and try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = originalBtnText;
    }
  });
})();
