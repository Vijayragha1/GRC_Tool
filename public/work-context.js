(function(){
  'use strict';
  // Only navigation metadata is retained; no form values enter browser storage.
  const actor=document.body.dataset.actorId||'anonymous';
  const storageKey=`work-navigation:${actor}`;
  const safeQueue=value=>typeof value==='string'&&/^\/(?:work(?:\?|\/|$)|workspaces\/\d+\/work(?:\?|\/|$))/.test(value)&&!value.includes('\\');
  const address=href=>new URL(href||location.href,location.href);
  const scope=url=>url.pathname.match(/^\/workspaces\/(\d+)/)?.[1]||'firm';
  function read(){try{const value=JSON.parse(sessionStorage.getItem(storageKey)||'{}');return{positions:value?.positions&&typeof value.positions==='object'?value.positions:{},returns:value?.returns&&typeof value.returns==='object'?value.returns:{}};}catch(_){return{positions:{},returns:{}};}}
  function write(data){try{data.positions=Object.fromEntries(Object.entries(data.positions).slice(-30));sessionStorage.setItem(storageKey,JSON.stringify(data));}catch(_){}}
  function capture(href){const url=address(typeof href==='string'?href:undefined),data=read(),key=url.pathname+url.search;delete data.positions[key];data.positions[key]={window:window.scrollY,main:document.querySelector('.main')?.scrollTop||0};write(data);}
  function mount(href){
    const url=address(href),key=url.pathname+url.search,data=read();
    const requested=url.searchParams.get('return_to');
    if(safeQueue(requested)){data.returns[scope(url)]=requested;write(data);}
    const back=safeQueue(requested)?requested:data.returns[scope(url)];
    if(!safeQueue(key)&&safeQueue(back)&&!document.querySelector('.queue-return')){
      const link=document.createElement('a');link.className='queue-return';link.href=back;link.textContent='← Return to your work queue';document.querySelector('#mainContent .main-inner')?.prepend(link);
    }
    const position=data.positions[key];
    if(position&&safeQueue(key)&&!url.hash){window.scrollTo(0,position.window||0);const main=document.querySelector('.main');if(main)main.scrollTop=position.main||0;}
  }
  window.WorkNavigation={capture,mount};window.addEventListener('pagehide',capture);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>requestAnimationFrame(()=>mount()));else requestAnimationFrame(()=>mount());
})();
