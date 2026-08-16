(function(){
  var toggle=document.getElementById('ml-docs-mobile-toggle');
  var side=document.getElementById('ml-docs-side');
  if(!toggle||!side)return;
  toggle.addEventListener('click',function(){
    var open=side.classList.toggle('ml-docs-side-open');
    toggle.setAttribute('aria-expanded',open?'true':'false');
  });
})();
(function(){
  var input=document.getElementById('ml-docs-search-input');
  if(!input)return;
  var side=input.closest('.ml-docs-side');
  if(!side)return;
  input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase();
    var lists=side.querySelectorAll('.ml-docs-side-ul');
    lists.forEach(function(ul){
      var anyVisible=false;
      ul.querySelectorAll('li').forEach(function(li){
        var match=!q||(li.textContent||'').toLowerCase().indexOf(q)>-1;
        li.classList.toggle('ml-docs-side-hidden',!match);
        if(match)anyVisible=true;
      });
      var h=ul.previousElementSibling;
      if(h&&h.classList.contains('ml-docs-side-h'))h.classList.toggle('ml-docs-side-hidden',!anyVisible);
      ul.classList.toggle('ml-docs-side-hidden',!anyVisible);
    });
  });
})();
