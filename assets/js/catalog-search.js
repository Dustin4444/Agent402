(function() {
  var search = document.getElementById('cat-search');
  var rows = document.querySelectorAll('.cat-row');
  var empty = document.getElementById('cat-empty');
  var emptyQ = document.getElementById('cat-empty-q');
  function applyFilter() {
    var q = (search.value || '').toLowerCase().trim();
    var visible = 0;
    rows.forEach(function(row) {
      var label = row.querySelector('th a').textContent.toLowerCase();
      var blurb = row.querySelector('.cat-blurb').textContent.toLowerCase();
      var match = !q || label.indexOf(q) !== -1 || blurb.indexOf(q) !== -1;
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    empty.style.display = visible === 0 ? 'block' : 'none';
    if (visible === 0) emptyQ.textContent = search.value;
  }
  search.addEventListener('input', applyFilter);
  try {
    var params = new URLSearchParams(window.location.search);
    var q0 = params.get('q');
    if (q0) { search.value = q0; applyFilter(); }
  } catch (e) {}
})();
