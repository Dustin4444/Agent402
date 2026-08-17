(function(){
  var f=document.getElementById('f'), t=document.getElementById('t'), e=document.getElementById('e');
  f.addEventListener('submit', function(ev){
    ev.preventDefault(); e.textContent='';
    fetch('/__operator/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t.value})})
      .then(function(r){ if(r.ok){ location.href='/__operator'; } else { e.textContent='Invalid token.'; } })
      .catch(function(){ e.textContent='Sign-in failed.'; });
  });
})();
