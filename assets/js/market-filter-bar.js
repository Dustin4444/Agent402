document.addEventListener('DOMContentLoaded',function(){
  var rows=Array.prototype.slice.call(document.querySelectorAll('[data-mfb-row]'));
  if(!rows.length)return;
  var parent=rows[0].parentNode;
  var num=function(el,k){var v=Number(el.getAttribute('data-'+k));return isFinite(v)?v:0;};
  var sortSel=document.querySelector('select[data-mfb-sort]');
  if(sortSel)sortSel.addEventListener('change',function(){
    var k=sortSel.value;
    rows.slice().sort(function(a,b){
      if(k==='health'&&num(a,'health')!==num(b,'health'))return num(b,'health')-num(a,'health');
      var m=k==='health'?'calls':k;
      return num(b,m)-num(a,m);
    }).forEach(function(r){parent.appendChild(r);});
  });
  var searchIn=document.querySelector('input[data-mfb-search]');
  if(searchIn)searchIn.addEventListener('input',function(){
    var q=searchIn.value.trim().toLowerCase();
    rows.forEach(function(r){r.style.display=!q||(r.textContent||'').toLowerCase().indexOf(q)>-1?'':'none';});
  });
});
