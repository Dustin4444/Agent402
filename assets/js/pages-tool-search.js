(function(){
  var input=document.getElementById('tool-search'), count=document.getElementById('tool-search-count');
  if(!input) return;
  // Moved off inline onfocus/onblur attributes (CSP hardening, 2026-08-16) -
  // same visual behavior, just wired via addEventListener instead.
  input.addEventListener('focus', function(){ input.style.borderColor = '#4ade80'; });
  input.addEventListener('blur', function(){ input.style.borderColor = '#1e2638'; });
  input.addEventListener('input', function(){
    var q = this.value.toLowerCase().trim();
    var cards = document.querySelectorAll('.card');
    var sections = document.querySelectorAll('h2');
    var shown = 0;
    cards.forEach(function(c){
      var text = (c.textContent || '').toLowerCase();
      var match = !q || text.indexOf(q) !== -1;
      c.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    sections.forEach(function(s){
      if (!q) { s.style.display = ''; return; }
      var next = s.nextElementSibling;
      while (next && !next.matches('h2')) {
        if (next.classList && next.classList.contains('grid')) {
          var vis = next.querySelectorAll('.card:not([style*="display: none"])');
          s.style.display = vis.length ? '' : 'none';
          break;
        }
        if (next.classList && next.classList.contains('cat-blurb')) {
          next.style.display = s.style.display;
          next = next.nextElementSibling;
          continue;
        }
        next = next.nextElementSibling;
      }
    });
    count.textContent = q ? shown + ' match' + (shown === 1 ? '' : 'es') : '';
  });
})();
