(function(){
  var tabs=document.querySelectorAll(".qs-tab");
  var panels=document.querySelectorAll(".qs-panel");
  tabs.forEach(function(t){
    t.addEventListener("click",function(){
      tabs.forEach(function(b){b.classList.remove("active");b.setAttribute("aria-selected","false")});
      panels.forEach(function(p){p.classList.remove("active")});
      t.classList.add("active");
      t.setAttribute("aria-selected","true");
      var id="panel-"+t.getAttribute("data-tab");
      document.getElementById(id).classList.add("active");
    });
  });
})();
