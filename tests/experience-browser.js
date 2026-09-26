'use strict';
// Real-browser checks use only a fresh temporary fixture. No live database copy.
process.env.ISMS_DISABLE_JOBS='1';process.env.EMAIL_DELIVERY_DISABLED='1';process.env.EXPERIENCE_ENABLED='1';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Database=require('better-sqlite3'),bcrypt=require('bcrypt'),puppeteer=require('puppeteer-core');
const {bootClient}=require('./helpers');
const layoutsOnly=process.env.EXPERIENCE_BROWSER_LAYOUTS==='1';
const output=path.resolve(__dirname,'../reports/experience-browser');fs.mkdirSync(output,{recursive:true});
const report={startedAt:new Date().toISOString(),fixture:'fresh temporary database',checks:[],layouts:[],programmeMatrix:[],accessibility:[],errors:[]};
let boot,db,browser;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,run){try{await run();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:error.message});throw error;}}
async function main(){
  boot=await bootClient();db=new Database(boot.dbPath);const base=await boot.client.baseUrl();
  const manager=db.prepare("SELECT * FROM users WHERE email='sec-test@example.com'").get();
  const password=crypto.randomBytes(24).toString('hex'),hash=bcrypt.hashSync(password,4);
  const ws=Number(db.prepare(`INSERT INTO workspaces(firm_id,client_name,frameworks) VALUES (?,'Experience browser client','["iso27001"]')`).run(manager.firm_id).lastInsertRowid);
  const actors=[];
  for(const [persona,type,role]of [['contributor','client','contributor'],['sponsor','client','client_owner'],['coordinator','client','isms_manager'],['junior_consultant','firm','consultant'],['experienced_consultant','firm','senior_consultant'],['manager','firm','manager']]){
    const id=Number(db.prepare('INSERT INTO users(email,name,password_hash,firm_id,user_type,firm_role,active) VALUES (?,?,?,?,?,?,1)').run(`${persona}@browser.example.test`,persona.replaceAll('_',' '),hash,manager.firm_id,type,type==='firm'?role:null).lastInsertRowid);
    db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)').run(ws,id,role);actors.push({persona,id,type,role,email:`${persona}@browser.example.test`});
  }
  const contributor=actors.find(a=>a.persona==='contributor');
  const requestId=Number(db.prepare(`INSERT INTO client_requests(workspace_id,request_type,title,description,created_by,assignee_id,released_at,status,due_date)
    VALUES (?,'evidence','Provide the access-review sample','Purpose: verify access reviews. Acceptance: include the sampled review and approval date.',?,?,CURRENT_TIMESTAMP,'open','2026-09-30')`).run(ws,manager.id,contributor.id).lastInsertRowid);
  const iso=db.prepare("SELECT id FROM iso_items WHERE type='control' ORDER BY sort_order LIMIT 1").get().id;
  const fixtureFile=path.join(boot.tmpDir,'access-review.txt');fs.writeFileSync(fixtureFile,'Synthetic test evidence: Quarterly access review completed; reviewer approved sampled accounts.');
  const programmes=[{code:'iso27001',workspaceId:ws,progress:`/workspaces/${ws}/gap-assessment`}];
  for(const code of ['csf','iso42001','dpdpa','tprm','vciso']){
    const workspaceId=Number(db.prepare('INSERT INTO workspaces(firm_id,client_name,frameworks,scope) VALUES (?,?,?,?)').run(manager.firm_id,`${code.toUpperCase()} programme browser client`,JSON.stringify(['tprm','vciso'].includes(code)?[]:[code]),'Synthetic programme boundaries for navigation verification.').lastInsertRowid);
    for(const actor of actors)db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId,actor.id,actor.role);
    let progress=`/workspaces/${workspaceId}/${code}`;
    if(code==='csf'){
      const id=Number(db.prepare("INSERT INTO csf_engagements(workspace_id,catalog_version,name,status,assigned_lead_id,visible_in_portal,created_by) VALUES (?,'2.0','Browser governed CSF assessment','Draft',?,1,?)").run(workspaceId,manager.id,manager.id).lastInsertRowid);
      const engagement=db.prepare('SELECT * FROM csf_engagements WHERE id=?').get(id);require('../lib/csf-policy-practice').ensureAssessmentRows(db,engagement);
      db.prepare('INSERT INTO csf_profile_contexts(engagement_id,workspace_id,prepared_by) VALUES (?,?,?)').run(id,workspaceId,manager.id);
      progress=`/workspaces/${workspaceId}/csf/${id}/assessment`;
    }else if(code==='dpdpa'){
      const assessment=require('../lib/dpdpa-gap-domain').createAssessment(require('../db').db,{logAction:require('../db').logAction,workspaceId,createdBy:manager.id,title:'Browser DPDPA assessment',scopeStatement:'The defined digital personal data processing boundary for this synthetic browser fixture.',asOfDate:'2026-09-05',applicabilityProfile:{organisation_roles:['Data Fiduciary'],exemptions_or_public_data_assumptions:'No exemptions are assumed within this controlled navigation fixture.',scope_limitations:'Only synthetic records support this browser navigation check.'}});
      progress=`/workspaces/${workspaceId}/dpdpa/assessments/${assessment.id}`;
    }else if(code==='tprm'){
      db.prepare("INSERT INTO tprm_modules(workspace_id,service_model,status,activation_reason,created_by) VALUES (?,'managed_lifecycle','active','Contracted synthetic managed TPRM service',?)").run(workspaceId,manager.id);
      db.prepare("INSERT INTO suppliers(workspace_id,name,service_provided,tier,lifecycle_stage) VALUES (?,'Browser provider','Managed hosting','tier_2','active')").run(workspaceId);
    }else if(code==='vciso'){
      require('../lib/vciso-service').enableService(db,{workspaceId,actorId:manager.id,reason:'Contracted synthetic vCISO governance service.'});progress=`/workspaces/${workspaceId}/delivery`;
    }else progress=`/workspaces/${workspaceId}/iso42001/gap-assessment`;
    programmes.push({code,workspaceId,progress});
  }
  for(const programme of programmes){
    const workspace=db.prepare('SELECT * FROM workspaces WHERE id=?').get(programme.workspaceId);
    const engagement=require('../lib/consulting-delivery').ensureEngagement(db,workspace,manager.id);
    db.prepare("INSERT INTO tasks(workspace_id,title,status,assignee_id,created_by) VALUES (?,?,'todo',?,?)").run(workspace.id,`${programme.code} programme action`,actors.find(a=>a.persona==='junior_consultant').id,manager.id);
    if(workspace.id!==ws)db.prepare("INSERT INTO client_requests(workspace_id,request_type,title,created_by,assignee_id,released_at,status) VALUES (?,'evidence',?,?,?,CURRENT_TIMESTAMP,'open')").run(workspace.id,`${programme.code} client input`,manager.id,contributor.id);
    const payload=JSON.stringify({fixture:true,programme:programme.code,title:`${programme.code} published summary`});
    db.prepare("INSERT INTO consulting_report_snapshots(workspace_id,engagement_id,report_type,title,version_number,status,snapshot_json,snapshot_hash,generated_by,approved_by,published_by) VALUES (?,?,'assessment',?,1,'published',?,?,?,?,?)").run(workspace.id,engagement.id,`${programme.code} published summary`,payload,crypto.createHash('sha256').update(payload).digest('hex'),manager.id,actors.find(a=>a.persona==='manager').id,manager.id);
  }
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],userDataDir:path.join(boot.tmpDir,'chrome')});
  const page=await browser.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  async function login(actor){await page.goto(base+'/logout',{waitUntil:'networkidle0'}).catch(()=>{});await page.goto(base+'/login',{waitUntil:'networkidle0'});await page.type('input[name=email]',actor.email);await page.type('input[name=password]',password);await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('button[type=submit]')]);}
  async function go(url){const r=await page.goto(base+url,{waitUntil:'networkidle0'});assert.ok(r.status()<400,`${url}: HTTP ${r.status()}`);await page.waitForFunction(()=>!document.querySelector('#pageLoader.is-active'),{timeout:5000}).catch(()=>{});await pause(120);}
  for(const actor of process.env.EXPERIENCE_BROWSER_FOCUSED==='1'?[]:actors){
    const context=await browser.createBrowserContext();const actorPage=await context.newPage();
    await actorPage.goto(base+'/login',{waitUntil:'networkidle0'});await actorPage.type('input[name=email]',actor.email);await actorPage.type('input[name=password]',password);await Promise.all([actorPage.waitForNavigation({waitUntil:'networkidle0'}),actorPage.click('button[type=submit]')]);
    const home=actor.type==='client'?`/workspaces/${ws}/client-portal`:actor.persona==='manager'?'/work/overview':'/work';
    for(const width of [390,768,1440]){
      await actorPage.setViewport({width,height:900});await actorPage.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}]);await actorPage.goto(base+home,{waitUntil:'networkidle0'});await pause(180);
      const result=await actorPage.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,heading:document.querySelector('main h1')?.textContent?.trim(),campaignPrompt:!!document.querySelector('#cookieConsent'),focusable:document.querySelectorAll('main a[href],main button,main input,main select').length}));
      report.layouts.push({persona:actor.persona,width,theme:'light',...result});assert.equal(result.overflow,false,`${actor.persona} ${width}px horizontal overflow`);assert.ok(result.heading,`${actor.persona} needs a page heading`);assert.equal(result.campaignPrompt,false);
      if(width===390||width===1440)await actorPage.screenshot({path:path.join(output,`${actor.persona}-${width}.png`),fullPage:true});
    }
    await actorPage.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await actorPage.screenshot({path:path.join(output,`${actor.persona}-dark.png`),fullPage:true});
    await actorPage.evaluate(()=>document.documentElement.style.zoom='2');report.layouts.push({persona:actor.persona,width:1440,zoom:200,overflow:await actorPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1||(document.querySelector('main')?.scrollWidth||0)>(document.querySelector('main')?.clientWidth||0)+1)});
    if(layoutsOnly){await context.close();continue;}
    await actorPage.evaluate(()=>document.documentElement.style.zoom='1');await actorPage.setViewport({width:actor.type==='client'?390:1440,height:900});
    const accessibilitySession=await actorPage.target().createCDPSession();
    for(const programme of programmes){
      const prefix=`/workspaces/${programme.workspaceId}`;
      const destinations=actor.type==='client'?[['home',`${prefix}/client-portal`],['progress',`${prefix}/client-portal?view=progress`],['reports',`${prefix}/client-portal?view=reports`],['work',`${prefix}/client-portal?view=actions`]]:
        [['home',`${prefix}/work/overview`],['progress',programme.progress],['reports',`${prefix}/work/reports?scope=team`],['work',`${prefix}/work?scope=mine`]];
      for(const [journey,url]of destinations){
        const response=await actorPage.goto(base+url,{waitUntil:'domcontentloaded'});await actorPage.waitForFunction(()=>!document.querySelector('#pageLoader.is-active'),{timeout:5000}).catch(()=>{});
        const state=await actorPage.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,heading:document.querySelector('main h1')?.textContent?.trim(),text:document.querySelector('main')?.innerText||''}));
        const result={persona:actor.persona,programme:programme.code,journey,width:actor.type==='client'?390:1440,status:response.status(),overflow:state.overflow,heading:state.heading,url};report.programmeMatrix.push(result);
        assert.ok(response.status()<400,`${actor.persona} ${programme.code} ${journey}: ${response.status()}`);assert.ok(state.heading,`${actor.persona} ${programme.code} ${journey} has no heading`);assert.equal(state.overflow,false,`${actor.persona} ${programme.code} ${journey} overflow`);
        if(journey==='reports')assert.ok(state.text.includes(`${programme.code} published summary`),`${actor.persona} ${programme.code} report is not discoverable`);
        const tree=await accessibilitySession.send('Accessibility.getFullAXTree');
        const unnamed=tree.nodes.filter(node=>!node.ignored&&['textbox','searchbox','combobox','spinbutton','checkbox','radio','slider'].includes(node.role?.value)&&!String(node.name?.value||'').trim());
        const missingNames=[];
        for(const node of unnamed){const detail=await accessibilitySession.send('DOM.describeNode',{backendNodeId:node.backendDOMNodeId});const attrs=detail.node.attributes||[],attributes={};for(let i=0;i<attrs.length;i+=2)if(['id','name','type'].includes(attrs[i]))attributes[attrs[i]]=attrs[i+1];missingNames.push({role:node.role.value,...attributes});}
        await actorPage.keyboard.press('Tab');
        await actorPage.waitForFunction(()=>{const box=document.activeElement.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;},{timeout:1000}).catch(()=>{});
        const focus=await actorPage.evaluate(()=>{const el=document.activeElement,style=getComputedStyle(el),box=el.getBoundingClientRect();return{tag:el.tagName,visible:box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth,indicator:el.matches(':focus-visible')&&((style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>0)||style.boxShadow!=='none')};});
        report.accessibility.push({persona:actor.persona,programme:programme.code,journey,missingNames,focus});
      }
    }
    await context.close();
  }
  if(process.env.EXPERIENCE_BROWSER_FOCUSED!=='1'){
    report.checks.push({name:'Six persona role homes at 390, 768 and 1440px; dark theme and 200% zoom',passed:report.layouts.every(r=>!r.overflow)});
    if(!layoutsOnly){
      report.checks.push({name:'Six personas across six programme home, progress, report and work destinations (144 checks)',passed:report.programmeMatrix.length===144&&report.programmeMatrix.every(row=>row.status<400&&!row.overflow)});
      report.checks.push({name:'Keyboard focus is visible and AX tree form fields have accessible names across the programme matrix',passed:report.accessibility.every(row=>!row.missingNames.length&&row.focus.visible&&row.focus.indicator)});
    }
  }
  if(layoutsOnly){assert.ok(report.layouts.length===24&&report.layouts.every(row=>!row.overflow));assert.deepEqual(report.errors,[]);return;}
  await login(actors.find(a=>a.persona==='junior_consultant'));
  await check('Opening a work item and returning retains the queue filters and scroll position',async()=>{
    const junior=actors.find(a=>a.persona==='junior_consultant');
    const add=db.prepare("INSERT INTO client_requests(workspace_id,request_type,title,created_by,consultant_owner_id,assignee_id,released_at,status) VALUES (?,'evidence',?,?,?,?,CURRENT_TIMESTAMP,'open')");
    db.transaction(()=>{for(let i=0;i<35;i++)add.run(ws,`Queue context sample ${String(i).padStart(2,'0')}`,junior.id,junior.id,contributor.id);})();
    const queue=`/workspaces/${ws}/work?scope=team&type=client_request&q=Queue+context&status=all`;
    await go(queue);
    const before=await page.evaluate(()=>{const main=document.querySelector('.main');main.scrollTo({top:1100,behavior:'instant'});window.scrollTo({top:1100,behavior:'instant'});return{main:main.scrollTop,window:scrollY};});
    assert.ok(before.main>400||before.window>400,'fixture must exercise a scrolled queue');
    const link=await page.$eval('main a[href*="/client-portal/requests/"][href*="return_to="]',el=>el.getAttribute('href'));
    assert.equal(new URL(link,base).searchParams.get('return_to'),queue);
    // DOM activation keeps the current scroll position while exercising the shared router.
    await page.evaluate(href=>document.querySelector(`main a[href="${CSS.escape(href)}"]`).click(),link);
    await page.waitForFunction(()=>!!document.querySelector('.queue-return'));
    assert.equal(await page.$eval('.queue-return',el=>el.getAttribute('href')),queue);
    await page.waitForFunction(()=>!document.querySelector('#pageLoader.is-active'));
    await page.focus('.queue-return');await page.keyboard.press('Enter');
    await page.waitForFunction(expected=>location.pathname+location.search===expected,{timeout:5000},queue).catch(async error=>{report.queueContext=await page.evaluate(()=>({url:location.href,heading:document.querySelector('main h1')?.textContent,returnHref:document.querySelector('.queue-return')?.href,stored:sessionStorage.getItem(`work-navigation:${document.body.dataset.actorId}`)}));throw error;});
    await page.waitForFunction(position=>Math.abs((document.querySelector('.main')?.scrollTop||0)-position.main)<4&&Math.abs(scrollY-position.window)<4,{},before);
    assert.equal(await page.$eval('input[name=q]',el=>el.value),'Queue context');
    const stored=await page.evaluate(()=>sessionStorage.getItem(`work-navigation:${document.body.dataset.actorId}`));
    assert.ok(stored&&!stored.includes('Synthetic test evidence'),'navigation storage contains only URL and scroll metadata');
  });
  await check('Assessment draft survives reload and Skip creates no canonical conclusion',async()=>{
    await go(`/workspaces/${ws}/controls/assess/${iso}`);await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('Private draft autosave'));
    await page.type('#assessForm textarea[name=notes]','Private browser recovery note');await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('Private draft saved'));
    await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#assessForm textarea[name=notes]')?.value==='Private browser recovery note');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM control_state_history WHERE workspace_id=?').get(ws).n,0);
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('#assessForm button[value=skip]')]);assert.equal(db.prepare('SELECT COUNT(*) n FROM control_state_history WHERE workspace_id=?').get(ws).n,0);
    await go(`/workspaces/${ws}/controls/assess/${iso}`);await page.waitForFunction(()=>document.querySelector('#assessForm textarea[name=notes]')?.value==='Private browser recovery note');
  });
  await check('Failed autosave retains input, retries and records selected draft exactly once',async()=>{
    let fail=true;await page.setRequestInterception(true);page.on('request',r=>{if(fail&&r.method()==='PUT'&&r.url().includes('/form-drafts/'))r.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'Injected transient save failure'})});else r.continue();});
    await page.type('#assessForm textarea[name=notes]',' after retry');await page.waitForFunction(()=>document.querySelector('.personal-draft-bar')?.textContent.includes('Injected transient'));
    assert.match(await page.$eval('#assessForm textarea[name=notes]',e=>e.value),/after retry/);fail=false;await page.evaluate(()=>window.PersonalDrafts.flush());
    await page.select('#assessForm select[name=status]','Partially Implemented');await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('#assessForm button[value=save]')]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM control_state_history WHERE workspace_id=?').get(ws).n,1);
    assert.match(db.prepare('SELECT notes FROM v_control_states WHERE workspace_id=? AND iso_item_id=?').get(ws,iso).notes,/after retry/);
  });
  await check('Report changes return to the author, link a replacement and preserve the original before independent approval and publication',async()=>{
    const author=actors.find(actor=>actor.persona==='junior_consultant'),reviewer=actors.find(actor=>actor.persona==='manager');
    const workspace=db.prepare('SELECT * FROM workspaces WHERE id=?').get(ws),engagement=db.prepare('SELECT * FROM consulting_engagements WHERE workspace_id=? ORDER BY id LIMIT 1').get(ws);
    const requirement=db.prepare("SELECT r.* FROM requirements r JOIN frameworks f ON f.id=r.framework_id WHERE f.code='iso27001' ORDER BY r.id LIMIT 1 OFFSET 10").get();
    const workpaper=Number(db.prepare("INSERT INTO consultant_workpapers(workspace_id,engagement_id,requirement_id,workpaper_ref,title,owner_id,reviewer_id,status,created_by) VALUES (?,?,?,'BROWSER-REPORT','Retained report source',?,?,'frozen',?)").run(ws,engagement.id,requirement.id,author.id,reviewer.id,author.id).lastInsertRowid);
    const retained=JSON.stringify({workpaper:{workpaper_ref:'BROWSER-REPORT',title:'Retained report source',framework_code:'iso27001',requirement_ref:requirement.ref,requirement_title:requirement.title,design_conclusion:'adequate',implementation_conclusion:'implemented',operating_effectiveness:'not_tested',evidence_sufficiency:'limited'}});
    db.prepare('INSERT INTO consultant_workpaper_snapshots(workpaper_id,version_number,snapshot_json,snapshot_hash,frozen_by) VALUES (?,1,?,?,?)').run(workpaper,retained,crypto.createHash('sha256').update(retained).digest('hex'),reviewer.id);
    const original=require('../lib/consulting-delivery').generateReport(db,workspace,author.id,engagement.id,{report_type:'assessment',basis_type:'manual_workpapers',title:'Browser report revision handoff'});
    const originalBytes=db.prepare('SELECT snapshot_json,snapshot_hash FROM consulting_report_snapshots WHERE id=?').get(original);
    await login(reviewer);await page.setViewport({width:390,height:900});await go(`/workspaces/${ws}/delivery/reports/${original}`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1||(document.querySelector('main')?.scrollWidth||0)>(document.querySelector('main')?.clientWidth||0)+1),false,'report preview must fit at 390px');
    await page.screenshot({path:path.join(output,'report-review-390.png'),fullPage:true});
    await page.type('#report-decision-note','Clarify the source basis before this report is approved.');
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('button[formaction$="/request-changes"]')]);
    assert.equal(db.prepare('SELECT status FROM consulting_report_snapshots WHERE id=?').get(original).status,'superseded');
    assert.ok(db.prepare('SELECT id FROM consulting_report_revision_requests WHERE report_id=? AND replacement_report_id IS NULL').get(original));
    await login(author);await go(`/workspaces/${ws}/work?scope=mine&type=report_revision`);
    assert.match(await page.$eval('main',el=>el.innerText),/Browser report revision handoff/);
    const reportHref=await page.$eval(`main a[href*="/delivery/reports/${original}?"]`,el=>el.getAttribute('href'));
    await go(reportHref);assert.match(await page.$eval('main',el=>el.innerText),/Clarify the source basis/);
    const replaceHref=await page.$eval('a[href*="replacesReportId="]',el=>el.getAttribute('href'));await go(replaceHref);
    assert.equal(await page.$eval('input[name=replaces_report_id]',el=>el.value),String(original));
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('form[action$="/delivery/reports"] button')]);
    const replacement=db.prepare('SELECT replacement_report_id FROM consulting_report_revision_requests WHERE report_id=?').get(original).replacement_report_id;assert.ok(replacement);
    assert.match(await page.$eval('main',el=>el.innerText),/This version replaces/);
    assert.deepEqual(db.prepare('SELECT snapshot_json,snapshot_hash FROM consulting_report_snapshots WHERE id=?').get(original),originalBytes);
    await go(`/workspaces/${ws}/work?scope=mine&type=report_revision`);assert.match(await page.$eval('main',el=>el.innerText),/0 matching records/);
    await login(reviewer);await go(`/workspaces/${ws}/delivery/reports/${replacement}`);await page.type('#report-decision-note','Reviewed the retained sources and the report basis.');
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('.rpt-decision button.btn-primary')]);
    assert.equal(db.prepare('SELECT status FROM consulting_report_snapshots WHERE id=?').get(replacement).status,'approved');
    await page.type('#report-decision-note','Approved report is ready to share with the client.');
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('.rpt-decision button.btn-primary')]);
    assert.equal(db.prepare('SELECT status FROM consulting_report_snapshots WHERE id=?').get(replacement).status,'published');
    await login(contributor);await go(`/workspaces/${ws}/client-portal?view=reports`);
    const publishedHref=await page.$eval(`main a[href$="/client-portal/reports/${replacement}"]`,el=>el.getAttribute('href'));await go(publishedHref);assert.match(await page.$eval('main',el=>el.innerText),/Retained report source/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1||(document.querySelector('main')?.scrollWidth||0)>(document.querySelector('main')?.clientWidth||0)+1),false,'published client report must fit at 390px');
    assert.deepEqual(db.prepare('SELECT snapshot_json,snapshot_hash FROM consulting_report_snapshots WHERE id=?').get(original),originalBytes);
  });
  // Separate context avoids any possibility of carrying firm authentication.
  await page.close();const clientContext=await browser.createBrowserContext();const clientPage=await clientContext.newPage();
  await clientPage.goto(base+'/login',{waitUntil:'networkidle0'});await clientPage.type('input[name=email]',contributor.email);await clientPage.type('input[name=password]',password);await Promise.all([clientPage.waitForNavigation({waitUntil:'networkidle0'}),clientPage.click('button[type=submit]')]);
  await clientPage.setViewport({width:390,height:900});
  await check('Mobile client uploads with retained response, submits and moves to waiting',async()=>{
    await clientPage.goto(`${base}/workspaces/${ws}/client-portal/requests/${requestId}`,{waitUntil:'networkidle0'});
    await clientPage.type('#response-note','Here is the requested sample and approval date.');await clientPage.evaluate(()=>window.PersonalDrafts.flush());
    await (await clientPage.$('[data-client-evidence-upload] input[type=file]')).uploadFile(fixtureFile);
    await clientPage.click('[data-client-evidence-upload] button');await clientPage.waitForFunction(()=>document.querySelector('[data-upload-feedback]')?.textContent.includes('Upload complete'),{timeout:15000});
    assert.match(await clientPage.$eval('#response-note',e=>e.value),/requested sample/);
    await Promise.all([clientPage.waitForNavigation({waitUntil:'networkidle0'}),clientPage.click('[data-submit-response]')]);
    assert.equal(db.prepare('SELECT status FROM client_requests WHERE id=?').get(requestId).status,'submitted');
    await clientPage.goto(`${base}/workspaces/${ws}/client-portal?view=actions`,{waitUntil:'networkidle0'});
    assert.match(await clientPage.$eval('main',e=>e.innerText),/Waiting/i);
  });
  await check('Native client form remains usable without JavaScript',async()=>{
    await clientPage.setJavaScriptEnabled(false);await clientPage.goto(`${base}/workspaces/${ws}/client-portal/requests/${requestId}`,{waitUntil:'networkidle0'});
    await clientPage.type('form[action$="/comments"] textarea[name=body]','Native form clarification.');await Promise.all([clientPage.waitForNavigation({waitUntil:'networkidle0'}),clientPage.click('form[action$="/comments"] button')]);assert.match(await clientPage.$eval('main',e=>e.innerText),/Native form clarification/);
  });
  await clientContext.close();
  await check('Mobile policy decision keeps the named approval order, recovers a sponsor draft and supports a coordinator without JavaScript',async()=>{
    const sponsor=actors.find(actor=>actor.persona==='sponsor'),coordinator=actors.find(actor=>actor.persona==='coordinator');
    const docId=Number(db.prepare("INSERT INTO generated_docs(workspace_id,name,category,content,status,version,created_by) VALUES (?,'Browser approval policy','Policy','<p>Mutable draft should not be reviewed</p>','in_review',1,?)").run(ws,manager.id).lastInsertRowid);
    const version=Number(db.prepare("INSERT INTO doc_versions(workspace_id,document_id,version,name,content,content_hash,status,created_by) VALUES (?,?,1,'Browser approval policy','<p>Frozen policy version for named approvers</p>','browser-policy-hash','in_review',?)").run(ws,docId,manager.id).lastInsertRowid);
    db.prepare('UPDATE generated_docs SET current_version_id=? WHERE id=?').run(version,docId);
    const insert=db.prepare('INSERT INTO doc_approvers(workspace_id,document_id,version_id,sequence,user_id) VALUES (?,?,?,?,?)');insert.run(ws,docId,version,1,sponsor.id);insert.run(ws,docId,version,2,coordinator.id);
    async function policyPage(actor,noJs=false){const context=await browser.createBrowserContext(),policyPage=await context.newPage();await policyPage.setViewport({width:390,height:900});if(noJs)await policyPage.setJavaScriptEnabled(false);await policyPage.goto(base+'/login',{waitUntil:'networkidle0'});await policyPage.type('input[name=email]',actor.email);await policyPage.type('input[name=password]',password);await Promise.all([policyPage.waitForNavigation({waitUntil:'networkidle0'}),policyPage.click('button[type=submit]')]);await policyPage.goto(`${base}/workspaces/${ws}/client-portal/policies/${docId}`,{waitUntil:'networkidle0'});return{context,policyPage};}
    const waiting=await policyPage(coordinator,true);assert.equal(await waiting.policyPage.$('form[data-form-draft="policy-decision"]'),null,'later approver cannot act out of order');await waiting.context.close();
    const first=await policyPage(sponsor);assert.match(await first.policyPage.$eval('main',el=>el.innerText),/Frozen policy version/);assert.equal(await first.policyPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await first.policyPage.type('#policy-decision-note','Sponsor reviewed the exact frozen policy.');await first.policyPage.evaluate(()=>window.PersonalDrafts.flush());await first.policyPage.reload({waitUntil:'networkidle0'});await first.policyPage.waitForFunction(()=>document.querySelector('#policy-decision-note')?.value==='Sponsor reviewed the exact frozen policy.');
    await Promise.all([first.policyPage.waitForNavigation({waitUntil:'networkidle0'}),first.policyPage.click('button[name=decision][value=approve]')]);assert.equal(db.prepare('SELECT decision FROM doc_approvers WHERE version_id=? AND user_id=?').get(version,sponsor.id).decision,'approved');await first.context.close();
    const second=await policyPage(coordinator,true);await second.policyPage.type('#policy-decision-note','Coordinator signed the same frozen version.');await Promise.all([second.policyPage.waitForNavigation({waitUntil:'networkidle0'}),second.policyPage.click('button[name=decision][value=approve]')]);assert.equal(db.prepare('SELECT decision FROM doc_approvers WHERE version_id=? AND user_id=?').get(version,coordinator.id).decision,'approved');await second.context.close();
    assert.equal(db.prepare('SELECT content FROM doc_versions WHERE id=?').get(version).content,'<p>Frozen policy version for named approvers</p>');
  });
  assert.deepEqual(report.errors,[]);
  assert.ok(report.accessibility.every(row=>!row.missingNames.length&&row.focus.visible&&row.focus.indicator),'Review AX field names and keyboard focus failures in results.json; human screen-reader testing remains separate.');
}
main().catch(error=>{report.failure=error.stack;console.error(error.stack);process.exitCode=1;}).finally(async()=>{report.finishedAt=new Date().toISOString();const resultFile=path.join(output,layoutsOnly?'layout-results.json':'results.json');fs.writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');await browser?.close();db?.close();await boot?.client.close();console.log(JSON.stringify({checks:report.checks,layouts:report.layouts.length,errors:report.errors,report:resultFile}));});
