'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const puppeteer=require('puppeteer-core');
let browser;
const script=fs.readFileSync(require.resolve('../public/form-drafts.js'),'utf8');
const makeDraft=(overrides={})=>({id:'private-id',generation:1,version:1,baseVersion:'1',savedAt:new Date().toISOString(),payload:{notes:'Private draft',client_visible:'0'},...overrides});
const pagePath='http://draft.fixture/workspaces/1/workpapers/7';
function html(version=1,notes='Recorded notes') {return `<!doctype html><meta name="csrf-token" content="fixture"><form method="POST" action="/record" data-form-draft="workpaper" data-draft-record="7" data-draft-version="${version}" data-draft-recorded='${JSON.stringify({notes,client_visible:'0'}).replaceAll("'",'&#39;')}'><textarea name="notes">${notes}</textarea><textarea name="internal_notes"></textarea><input type="checkbox" name="client_visible" value="1"><button name="intent" value="save">Save</button></form><script src="/form-drafts.js"></script>`;}
async function fixture(options={}) {
  const page=await browser.newPage();let state={draft:makeDraft(options.draft),recordVersion:options.recordVersion||1,pageVersion:1,pageNotes:'Recorded notes',generation:1,posts:[],putCount:0};
  await page.setRequestInterception(true);page.on('dialog',d=>d.accept());
  page.on('request',async r=>{
    const u=new URL(r.url());let body;try{body=JSON.parse(r.postData()||'{}');}catch(_){}
    const json=(status,data)=>r.respond({status,contentType:'application/json',body:JSON.stringify(data)});
    if(u.pathname==='/form-drafts.js')return r.respond({status:200,contentType:'text/javascript',body:script});
    if(u.pathname.includes('/form-drafts/')){
      if(r.method()==='GET')return json(200,{draft:state.draft,generation:state.generation,contextKey:'',recordVersion:state.recordVersion});
      if(r.method()==='DELETE'){state.draft=null;state.generation++;return json(200,{draft:null,generation:state.generation,contextKey:'',recordVersion:state.recordVersion});}
      if(r.method()==='PUT'){
        state.putCount++;if(options.beforePut)await options.beforePut(body,state);
        if(body.expectedDraftVersion!==(state.draft?.version||0)||body.generation!==state.generation)return json(409,{error:'This draft changed in another tab.'});
        if(body.rebase&&String(body.baseVersion)!==String(state.recordVersion))return json(409,{error:'The recorded version changed.'});
        state.draft=makeDraft({version:(state.draft?.version||0)+1,generation:state.generation,baseVersion:body.baseVersion,payload:body.payload});return json(200,{draft:state.draft,contextKey:'',recordVersion:state.recordVersion});
      }
    }
    if(u.pathname==='/record'||u.pathname==='/request-changes'){state.posts.push({...Object.fromEntries(new URLSearchParams(r.postData())),destination:u.pathname});return r.respond({status:200,contentType:'text/html',body:'Recorded test request'});}
    return r.respond({status:200,contentType:'text/html',body:html(state.pageVersion,state.pageNotes)});
  });
  await page.goto(pagePath,{waitUntil:'load'});await page.waitForFunction(()=>document.querySelector('[name=notes]')?.value==='Private draft');
  return {page,state};
}
async function edit(page,name,value){await page.$eval(`[name="${name}"]`,(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},value);}
async function button(page,label){await page.evaluate(label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label).click(),label);}
test.before(async()=>{
  const macChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath=process.env.CHROME_PATH||(fs.existsSync(macChrome)?macChrome:null);
  const args=['--no-sandbox','--disable-dev-shm-usage'];
  // Without a local Chrome (CI), use the headless shell CI installs, as lib/audit-pack.js does.
  browser=executablePath?await puppeteer.launch({executablePath,headless:true,args}):await require('puppeteer').launch({headless:'shell',args});
});
test.after(async()=>{await browser?.close();});
test('same-actor tab conflicts offer an explicit comparison and preserve local edits when rebasing',async()=>{
  const {page,state}=await fixture();try{
    state.draft=makeDraft({version:2,payload:{internal_notes:'Other tab notes',client_visible:'1'}});
    await edit(page,'internal_notes','My edits');await page.evaluate(()=>window.PersonalDrafts.flush().catch(()=>{}));
    await button(page,'Compare saved draft');await page.waitForFunction(()=>document.querySelector('.draft-comparison')?.textContent.includes('Other tab notes'));
    assert.equal(await page.$eval('[name=internal_notes]',e=>e.value),'My edits');
    await button(page,'Keep my edits instead of this saved draft');await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('Private draft saved'));
    assert.equal(state.draft.payload.internal_notes,'My edits');assert.equal(state.draft.version,3);
  }finally{await page.close();}
});
test('discard does not promote old displayed fields to a newer unseen recorded version',async()=>{
  const {page,state}=await fixture();try{
    state.recordVersion=2;await button(page,'Discard draft');await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('recorded version has changed'));
    await Promise.all([page.waitForNavigation(),button(page,'Save')]);assert.equal(state.posts[0].expected_record_version,'1');
  }finally{await page.close();}
});
test('edits made during a rebase remain dirty and are saved after its response',async()=>{
  let release,started;const waiting=new Promise(r=>started=r);let first=true;
  const {page,state}=await fixture({draft:{baseVersion:'0'},beforePut:async body=>{if(first&&body.rebase){first=false;started();await new Promise(r=>release=r);}}});try{
    await button(page,'Keep my edits against this recorded version');await waiting;await edit(page,'internal_notes','Edited during rebase');release();
    await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('Private draft saved'));
    await page.evaluate(()=>window.PersonalDrafts.flush());assert.equal(state.draft.payload.internal_notes,'Edited during rebase');assert.ok(state.putCount>=2);
  }finally{release?.();await page.close();}
});
test('comparison can load the current recorded fields before an explicit rebase',async()=>{
  const {page,state}=await fixture({draft:{baseVersion:'0'}});try{
    state.recordVersion=2;state.pageVersion=2;state.pageNotes='A newer recorded conclusion';
    await button(page,'Load the latest recorded version for comparison');await page.waitForFunction(()=>document.querySelector('.draft-comparison')?.textContent.includes('A newer recorded conclusion'));
    await button(page,'Keep my edits against this recorded version');await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('Private draft saved'));assert.equal(state.draft.baseVersion,'2');
  }finally{await page.close();}
});

test('Request changes retains its submitter destination and cannot double-submit while a draft is saving',async()=>{
  let release,started;const waiting=new Promise(resolve=>started=resolve);
  const {page,state}=await fixture({beforePut:async()=>{started();await new Promise(resolve=>release=resolve);}});
  try{
    await page.evaluate(()=>{const button=document.createElement('button');button.type='submit';button.textContent='Request changes';button.name='intent';button.value='changes';button.setAttribute('formaction','/request-changes');document.querySelector('form').append(button);});
    await edit(page,'internal_notes','Please update the evidence basis.');
    const navigation=page.waitForNavigation();await button(page,'Request changes');await waiting;
    await button(page,'Save');release();await navigation;
    assert.equal(state.posts.length,1);assert.equal(state.posts[0].destination,'/request-changes');assert.equal(state.posts[0].intent,'changes');assert.ok(state.posts[0].draft_id);
  }finally{release?.();await page.close();}
});
