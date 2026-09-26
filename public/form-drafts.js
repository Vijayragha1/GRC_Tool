/* Personal drafts never record a conclusion or advance a workflow. */
(function(){
  'use strict';
  const controllers=new Map();
  const token=()=>document.querySelector('meta[name="csrf-token"]')?.content || '';
  const uuid=()=>window.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payloadFields={
    assessment:['applicability','status','maturity','inclusion_justification','exclusion_justification','notes','scope_pct','diagnostic_set_id'],
    workpaper:['title','objective','procedure_performed','persons_interviewed','testing_period_start','testing_period_end','population_description','population_size','sample_method','sample_size','exceptions_count','exception_summary','internal_notes','management_claim','design_conclusion','implementation_conclusion','operating_effectiveness','evidence_sufficiency','conclusion_rationale','client_visible_summary','client_visible','requires_client_validation','client_validator_id','owner_id','reviewer_id','due_date','note'],
    'client-response':['response_note'],'client-comment':['body','internal_only'],'deliverable-comment':['body'],'deliverable-decision':['note'],'policy-decision':['reason']
  };
  payloadFields['assessment-iso42001']=payloadFields.assessment;
  function hidden(form,name,value){let field=form.querySelector(`input[name="${name}"]`);if(!field){field=document.createElement('input');field.type='hidden';field.name=name;form.appendChild(field);}field.value=String(value??'');}
  async function request(url,method,body){
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':token(),'Accept':'application/json'},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
    let data;try{data=await response.json();}catch(_){throw new Error('Your session may have expired. Keep this page open and sign in in another tab.');}
    if(!response.ok){const error=new Error(data.error||'Draft save failed. Keep this page open and retry.');error.status=response.status;throw error;}return data;
  }
  function attach(form){
    if(controllers.has(form)||!payloadFields[form.dataset.formDraft])return;
    const ws=location.pathname.match(/^\/workspaces\/(\d+)/)?.[1];if(!ws)return;
    const client=location.pathname.includes('/client-portal');
    const kind=form.dataset.formDraft;const isAssessment=['assessment','assessment-iso42001'].includes(kind);
    const url=`/workspaces/${ws}/${client?'client-portal/':''}form-drafts/${kind}/${encodeURIComponent(form.dataset.draftRecord)}`;
    const bar=document.createElement('div');bar.className='personal-draft-bar';
    const message=document.createElement('span');message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.textContent='Loading your private draft…';
    const retry=document.createElement('button');retry.type='button';retry.className='btn btn-secondary btn-xs';retry.textContent='Retry save';retry.hidden=true;
    const reload=document.createElement('button');reload.type='button';reload.className='btn btn-secondary btn-xs';reload.textContent='Compare saved draft';reload.hidden=true;
    const discard=document.createElement('button');discard.type='button';discard.className='btn btn-ghost btn-xs';discard.textContent='Discard draft';discard.hidden=true;
    const compare=document.createElement('details');compare.className='draft-comparison';compare.hidden=true;
    const summary=document.createElement('summary');summary.textContent='Compare your draft with the recorded version';compare.append(summary);
    const comparison=document.createElement('div');compare.append(comparison);
    const refreshRecord=document.createElement('button');refreshRecord.type='button';refreshRecord.className='btn btn-secondary';refreshRecord.textContent='Load the latest recorded version for comparison';compare.append(refreshRecord);
    const useSaved=document.createElement('button');useSaved.type='button';useSaved.className='btn btn-secondary';useSaved.textContent='Use this saved draft';useSaved.hidden=true;compare.append(useSaved);
    const rebase=document.createElement('button');rebase.type='button';rebase.className='btn btn-secondary';rebase.textContent='Keep my edits against this recorded version';compare.append(rebase);
    const previous=document.createElement('details');previous.className='draft-comparison';previous.hidden=true;const previousSummary=document.createElement('summary');previousSummary.textContent='Recover an earlier private draft';previous.append(previousSummary);
    bar.append(message,retry,reload,discard,compare,previous);form.prepend(bar);
    let draft=null,generation=0,contextKey='',baseVersion=String(form.dataset.draftVersion||0),timer=null,pending=null,dirty=false,ready=false,submitting=false,preparingSubmission=false,changeSerial=0,uploading=false,lastAttempt=null;
    const fieldsOf=target=>{const data=Object.fromEntries([...new FormData(target)].filter(([key,value])=>typeof value==='string'&&(payloadFields[kind].includes(key)||(isAssessment&&/^q_\d+$/.test(key)))));target.querySelectorAll('input[type=checkbox][name]').forEach(field=>{if(payloadFields[kind].includes(field.name))data[field.name]=field.checked?(field.value||'1'):'0';});return data;};
    const fields=()=>fieldsOf(form);
    const initial=fields();let recorded=initial;try{if(form.dataset.draftRecorded)recorded=JSON.parse(form.dataset.draftRecorded);}catch(_){}
    let currentVersion=String(form.dataset.draftVersion||0),comparedDraft=null;
    function showComparison(other=recorded,label='Recorded'){compare.hidden=false;comparison.replaceChildren();const table=document.createElement('table');table.className='table';const head=document.createElement('tr');for(const title of ['Field',label,'Your edits']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);const local=fields();for(const key of new Set([...Object.keys(other),...Object.keys(local)])){if(String(other[key]??'')===String(local[key]??''))continue;const row=document.createElement('tr');for(const value of [key.replaceAll('_',' '),other[key]??'Unavailable',local[key]??'']){const cell=document.createElement('td');cell.textContent=String(value);cell.style.whiteSpace='pre-wrap';row.append(cell);}table.append(row);}comparison.append(table);}
    function apply(values){const changedQuestions=isAssessment&&values.diagnostic_set_id&&initial.diagnostic_set_id&&values.diagnostic_set_id!==initial.diagnostic_set_id;for(const [key,value] of Object.entries(values)){if(changedQuestions&&(key==='diagnostic_set_id'||/^q_\d+$/.test(key)))continue;const field=form.elements.namedItem(key);if(!field)continue;if(typeof RadioNodeList!=='undefined'&&field instanceof RadioNodeList){for(const option of field)if(option.type==='radio')option.checked=String(option.value)===String(value);}else if(field.type==='checkbox')field.checked=value==='1'||value==='true'||value==='on';else if(field.value!==undefined)field.value=value;}
      form.querySelectorAll('[data-diagnostic-group]').forEach(group=>{const value=group.querySelector('[data-diagnostic-value]')?.value;group.querySelectorAll('[data-diagnostic-option]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.diagnosticOption===value));b.classList.toggle('selected',b.dataset.diagnosticOption===value);});});
      form.dispatchEvent(new CustomEvent('draftrestored',{bubbles:true}));
    }
    function showSaved(){message.textContent=draft?`Private draft saved at ${new Date(draft.savedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}. Not submitted.`:'Your edits are saved only as a private draft.';retry.hidden=true;discard.hidden=!draft;}
    async function flush(){
      clearTimeout(timer);if(uploading)return;if(!ready)await initialized;if(pending)await pending;if(!dirty)return;
      const data=fields();
      message.textContent='Saving private draft…';
      lastAttempt=lastAttempt||{serial:changeSerial,body:{payload:data,baseVersion,generation,expectedDraftVersion:draft?.version||0,clientSaveId:uuid(),contextKey}};
      const serial=lastAttempt.serial;
      pending=request(url,'PUT',lastAttempt.body).then(result=>{
        lastAttempt=null;draft=result.draft;generation=draft.generation;dirty=serial!==changeSerial;showSaved();
      }).catch(error=>{dirty=true;message.textContent=error.message;retry.hidden=false;reload.hidden=error.status!==409;throw error;}).finally(()=>pending=null);
      await pending;if(dirty)await flush();
    }
    function showPrevious(items){if(!items?.length)return;previous.hidden=false;for(const item of items){const entry=document.createElement('details');const title=document.createElement('summary');title.textContent=`${item.label} · ${new Date(item.savedAt).toLocaleString()}`;entry.append(title);const preview=document.createElement('div');entry.append(preview);const load=document.createElement('button');load.type='button';load.className='btn btn-secondary btn-xs';load.textContent='Preview earlier draft';entry.append(load);const recover=document.createElement('button');recover.type='button';recover.className='btn btn-secondary btn-xs';recover.textContent='Recover into the current pass';recover.hidden=true;entry.append(recover);let source=null;
      load.addEventListener('click',async()=>{try{const result=await request(url+'?contextKey='+encodeURIComponent(item.contextKey),'GET');source=result.draft;if(!source)throw new Error('This earlier draft is no longer active.');preview.replaceChildren();const list=document.createElement('dl');for(const [key,value]of Object.entries(source.payload)){const name=document.createElement('dt');name.textContent=key.replaceAll('_',' ');const text=document.createElement('dd');text.textContent=String(value);text.style.whiteSpace='pre-wrap';list.append(name,text);}preview.append(list);recover.hidden=false;}catch(error){message.textContent=error.message;}});
      recover.addEventListener('click',async()=>{try{if(draft||dirty||pending)throw new Error('Your current edits are preserved. Compare or discard the current draft before recovering an earlier one.');if(!source)return;const result=await request(url+'/recover','POST',{contextKey,sourceContextKey:item.contextKey,sourceDraftId:source.id,sourceGeneration:source.generation,sourceVersion:source.version,generation});draft=result.draft;generation=draft.generation;baseVersion=draft.baseVersion;apply(draft.payload);showSaved();message.textContent='The earlier draft was copied into this pass. Its original remains unchanged; review these edits before recording.';if(baseVersion!==currentVersion)showComparison();}catch(error){message.textContent=error.message;}});previous.append(entry);}}
    const initialized=request(url,'GET').then(result=>{
      contextKey=result.contextKey;generation=result.generation||0;draft=result.draft;showPrevious(result.previousDrafts);
      if(draft){baseVersion=draft.baseVersion;if(changeSerial===0&&form.dataset.draftRecovery!=='true')apply(draft.payload);else dirty=true;showSaved();if(isAssessment&&draft.payload.diagnostic_set_id&&draft.payload.diagnostic_set_id!==initial.diagnostic_set_id){dirty=true;message.textContent='The diagnostic questions changed. Your other edits are restored; answer the current questions before recording.';}
        if(String(result.recordVersion)!==String(baseVersion)){message.textContent='A newer version was recorded while this private draft was open. Your draft is preserved; compare it before recording.';showComparison();}
      }else message.textContent='Private draft autosave. Record or submit explicitly when ready.';
      ready=true;
    }).catch(error=>{message.textContent=error.message;retry.hidden=false;ready=true;});
    function changed(){if(submitting)return;dirty=true;changeSerial++;clearTimeout(timer);timer=setTimeout(()=>flush().catch(()=>{}),700);}
    form.addEventListener('input',changed);form.addEventListener('change',changed);
    form.addEventListener('click',event=>{if(event.target.closest('[data-diagnostic-option]'))changed();});
    retry.addEventListener('click',()=>flush().catch(()=>{}));
    reload.addEventListener('click',async()=>{try{if(pending)await pending.catch(()=>{});const result=await request(url,'GET');if(result.contextKey!==contextKey)throw new Error('The assessment pass changed. Keep this page open and reopen the current pass before transferring your edits.');comparedDraft=result;showComparison(result.draft?.payload||{},result.draft?'Saved in another tab':'No active saved draft');summary.textContent='Compare the saved draft with your edits';rebase.textContent='Keep my edits instead of this saved draft';compare.open=true;useSaved.hidden=!result.draft;message.textContent='Your edits are unchanged. Compare both drafts before choosing which version to keep.';}catch(error){message.textContent=error.message;}});
    refreshRecord.addEventListener('click',async()=>{try{const response=await fetch(location.href,{headers:{Accept:'text/html'},credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('The current recorded form is unavailable. Keep your edits on this screen.');const doc=new DOMParser().parseFromString(await response.text(),'text/html');const latest=[...doc.querySelectorAll('form[data-form-draft]')].find(f=>f.dataset.formDraft===kind&&f.dataset.draftRecord===form.dataset.draftRecord);if(!latest)throw new Error('This action is no longer available. Your private draft is retained.');const latestContext=latest.elements.namedItem('assessment_context')?.value;if(latestContext!==undefined&&latestContext!==contextKey)throw new Error('The assessment pass changed. Recover your older draft from the current pass before recording.');recorded=latest.dataset.draftRecorded?JSON.parse(latest.dataset.draftRecorded):fieldsOf(latest);currentVersion=String(latest.dataset.draftVersion||0);showComparison();compare.open=true;message.textContent='The latest recorded values are shown below. Compare them before keeping your edits.';}catch(error){message.textContent=error.message;}});
    useSaved.addEventListener('click',()=>{if(!comparedDraft?.draft)return;clearTimeout(timer);draft=comparedDraft.draft;generation=comparedDraft.generation;baseVersion=draft.baseVersion;apply({...initial,...recorded,...draft.payload});dirty=false;lastAttempt=null;comparedDraft=null;useSaved.hidden=true;reload.hidden=true;compare.hidden=true;showSaved();if(baseVersion!==currentVersion){showComparison();message.textContent='The saved draft was based on another recorded version. Load the latest recorded version and compare before recording.';}});
    rebase.addEventListener('click',async()=>{try{clearTimeout(timer);if(pending)await pending.catch(()=>{});const serial=changeSerial;const observed=comparedDraft;const result=await request(url,'PUT',{payload:fields(),baseVersion:currentVersion,rebase:true,generation:observed?observed.generation:generation,expectedDraftVersion:observed?(observed.draft?.version||0):(draft?.version||0),clientSaveId:uuid(),contextKey});draft=result.draft;generation=draft.generation;baseVersion=draft.baseVersion;dirty=serial!==changeSerial;lastAttempt=null;comparedDraft=null;compare.hidden=true;reload.hidden=true;useSaved.hidden=true;summary.textContent='Compare your draft with the recorded version';rebase.textContent='Keep my edits against this recorded version';showSaved();if(dirty)await flush();}catch(error){message.textContent=error.message;reload.hidden=error.status!==409;}});
    discard.addEventListener('click',async()=>{try{clearTimeout(timer);if(pending)await pending.catch(()=>{});const serial=changeSerial;const result=await request(url,'DELETE',{generation,expectedDraftVersion:draft?.version||0,contextKey});draft=null;lastAttempt=null;comparedDraft=null;generation=result.generation;dirty=serial!==changeSerial;clearTimeout(timer);if(!dirty)apply({...initial,...recorded});baseVersion=currentVersion;compare.hidden=true;reload.hidden=true;message.textContent=String(result.recordVersion)===currentVersion?'Draft discarded. Recorded values are unchanged.':'Draft discarded. The recorded version has changed; reload it before recording new edits.';discard.hidden=true;if(dirty)await flush();}catch(e){message.textContent=e.message;reload.hidden=e.status!==409;}});
    form.addEventListener('submit',async event=>{
      event.preventDefault();event.stopImmediatePropagation();const submitter=event.submitter;
      if(submitting||preparingSubmission)return;
      if(uploading || (kind==='client-response' && document.querySelector('[data-client-evidence-upload] input[type=file]')?.files.length)){message.textContent='Finish uploading the selected file before submitting your response.';window.AppPageLoader?.hide({immediate:true});return;}
      preparingSubmission=true;
      try{await flush();if(draft&&String(baseVersion)!==currentVersion&&submitter?.value!=='skip'){showComparison();message.textContent='Compare both versions and choose whether to keep your edits before recording.';compare.open=true;compare.scrollIntoView({block:'center'});return;}if(draft){hidden(form,'draft_id',draft.id);hidden(form,'draft_version',draft.version);hidden(form,'draft_generation',draft.generation);}
        hidden(form,'expected_record_version',baseVersion);if(form.elements.namedItem('private_draft_generation')){hidden(form,'private_draft_generation',generation);hidden(form,'private_draft_version',draft?.version||0);}hidden(form,'mutation_key',uuid());
        // Native submit() omits the pressed button. Retain its destination and
        // method as well as its value, especially for Request changes actions.
        if(submitter)for(const [attribute,property]of [['formaction','action'],['formmethod','method'],['formenctype','enctype'],['formtarget','target']])if(submitter.hasAttribute(attribute))form.setAttribute(property,submitter.getAttribute(attribute));
        submitting=true;if(submitter?.name)hidden(form,submitter.name,submitter.value);HTMLFormElement.prototype.submit.call(form);
      }catch(_){submitting=false;window.AppPageLoader?.hide({immediate:true});}finally{preparingSubmission=false;}
    },true);
    controllers.set(form,{flush,dirty:()=>dirty||!!pending,isSubmitting:()=>submitting,
      kind,recordId:form.dataset.draftRecord,
      beginUpload:async()=>{await flush();uploading=true;clearTimeout(timer);},
      endUpload:async(result)=>{uploading=false;if(result?.ok){currentVersion=String(result.requestVersion);form.dataset.draftVersion=currentVersion;hidden(form,'version',currentVersion);const saved=result.draft?.draft;if(saved){draft=saved;generation=saved.generation;baseVersion=saved.baseVersion;}else if(!draft)baseVersion=currentVersion;}if(dirty)await flush();}
    });
  }
  function scan(){document.querySelectorAll('form[data-form-draft]').forEach(attach);for(const form of controllers.keys())if(!form.isConnected)controllers.delete(form);}
  document.addEventListener('click',async event=>{
    const link=event.target.closest('a[href]');if(!link||event.defaultPrevented||event.metaKey||event.ctrlKey||link.target==='_blank'||link.hasAttribute('download'))return;
    const url=new URL(link.href,location.href);if(url.origin!==location.origin||url.href===location.href||(!url.pathname.startsWith('/workspaces/')&&!url.pathname.startsWith('/work')))return;
    const dirty=[...controllers.values()].filter(c=>c.dirty());if(!dirty.length)return;
    event.preventDefault();event.stopImmediatePropagation();try{await Promise.all(dirty.map(c=>c.flush()));location.assign(url.href);}catch(_){window.AppPageLoader?.hide({immediate:true});}
  },true);
  window.addEventListener('beforeunload',event=>{if([...controllers.values()].some(c=>c.dirty()&&!c.isSubmitting())){event.preventDefault();event.returnValue='';}});
  window.PersonalDrafts={flush:()=>Promise.all([...controllers.values()].map(c=>c.flush())),scan,
    beginUpload:id=>Promise.all([...controllers.values()].filter(c=>c.kind==='client-response'&&String(c.recordId)===String(id)).map(c=>c.beginUpload())),
    endUpload:(id,result)=>Promise.all([...controllers.values()].filter(c=>c.kind==='client-response'&&String(c.recordId)===String(id)).map(c=>c.endUpload(result)))
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan);else scan();
  new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
})();
