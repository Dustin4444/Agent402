(function(){
  /* esc() HTML-escapes every user-controlled value before it reaches the
     syntax-highlighted snippet. This is the same sanitisation used in the
     pre-migration version of this page. */
  function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  var w=document.getElementById('wallet'), p=document.getElementById('price'), m=document.getElementById('mode'), out=document.getElementById('snip');
  function render(){
    var wallet=esc((w.value||'').trim()||'0xYourWalletHere');
    var price=esc((p.value||'').trim()||'$0.002');
    var mode=esc(m.value);
    var modeLine = mode==='observe'
      ? '<span class="kw">observe</span>: <span class="num">true</span>,                       <span class="com">// no 402s yet - watch first</span>'
      : '<span class="kw">mode</span>: <span class="str">"'+mode+'"</span>,                   <span class="com">// '+(mode==='bots'?'charge AI crawlers; humans pass':mode==='all'?'charge everything non-human':'paywall everyone')+'</span>';
    out.innerHTML =
      '<span class="kw">import</span> express <span class="kw">from</span> <span class="str">"express"</span>;\n' +
      '<span class="kw">import</span> { createTollbooth } <span class="kw">from</span> <span class="str">"agent402-tollbooth"</span>;\n\n' +
      '<span class="kw">const</span> app = <span class="kw">express</span>();\n' +
      'app.<span class="kw">use</span>(<span class="kw">createTollbooth</span>({\n' +
      '  <span class="kw">payTo</span>: <span class="str">"'+wallet+'"</span>,\n' +
      '  <span class="kw">price</span>: <span class="str">"'+price+'"</span>,\n' +
      '  ' + modeLine + '\n' +
      '  <span class="kw">statsToken</span>: process.env.<span class="kw">TOLLBOOTH_STATS_TOKEN</span>,\n' +
      '}));\n' +
      'app.<span class="kw">use</span>(yourExistingRoutes);\n' +
      'app.<span class="kw">listen</span>(<span class="num">3000</span>);';
  }
  w.addEventListener('input', render);
  p.addEventListener('input', render);
  m.addEventListener('change', render);
  render();

  document.querySelectorAll('.copy').forEach(function(btn){
    btn.addEventListener('click', function(){
      var el=document.getElementById(btn.getAttribute('data-target'));
      if(!el) return;
      var txt=el.innerText;
      if(navigator.clipboard) navigator.clipboard.writeText(txt);
      var old=btn.textContent; btn.textContent='copied'; setTimeout(function(){ btn.textContent=old; }, 1200);
    });
  });
})();
