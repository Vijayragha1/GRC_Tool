(function(){
  'use strict';
  document.addEventListener('submit',async event=>{
    const form=event.target.closest('form[data-client-evidence-upload]');if(!form)return;
    event.preventDefault();event.stopImmediatePropagation();if(form.dataset.uploading==='true')return;
    const feedback=form.querySelector('[data-upload-feedback]'), button=form.querySelector('button[type=submit],button:not([type])');
    const responseButtons=[...document.querySelectorAll('[data-submit-response]')];
    const previous=responseButtons.map(b=>b.disabled);const requestId=form.dataset.requestId;
    let successful=false;
    try{
      form.dataset.uploading='true';button.disabled=true;responseButtons.forEach(b=>b.disabled=true);
      feedback.textContent='Saving your response draft…';await window.PersonalDrafts?.beginUpload(requestId);
      feedback.textContent='Uploading… 0%';
      const result=await new Promise((resolve,reject)=>{
        const xhr=new XMLHttpRequest();xhr.open('POST',form.action);xhr.setRequestHeader('Accept','application/json');
        xhr.upload.addEventListener('progress',e=>{feedback.textContent=e.lengthComputable?`Uploading… ${Math.round(e.loaded/e.total*100)}%`:'Uploading…';});
        xhr.addEventListener('error',()=>reject(new Error('Upload failed. Your response draft is safe. Retry the upload.')));
        xhr.addEventListener('load',()=>{let value;try{value=JSON.parse(xhr.responseText);}catch(_){reject(new Error('Upload could not complete. Keep this page open and check your session.'));return;}if(xhr.status<200||xhr.status>=300||!value.ok)reject(new Error(value.error||'Upload failed. Please retry.'));else resolve(value);});
        xhr.send(new FormData(form));
      });
      await window.PersonalDrafts?.endUpload(requestId,result);successful=true;
      const panel=document.querySelector('#request-evidence-panel');
      const receipt=document.createElement('div');receipt.className='panel-pad upload-receipt';
      const title=document.createElement('strong');title.textContent=result.evidence.filename;
      const description=document.createElement('p');description.textContent=result.evidence.description||'File uploaded successfully.';
      const download=document.createElement('a');download.className='btn btn-secondary btn-xs';download.textContent='Download';download.href=result.evidence.downloadUrl;download.dataset.noSpa='1';
      receipt.append(title,description,download);panel.insertBefore(receipt,form);
      const count=panel.querySelector('[data-evidence-count]');if(count)count.textContent=String(Number(count.textContent||0)+1);
      form.reset();feedback.textContent='Upload complete. Your response is ready to submit.';
    }catch(error){feedback.textContent=error.message;await window.PersonalDrafts?.endUpload(requestId,null).catch(()=>{});}
    finally{form.dataset.uploading='false';button.disabled=false;responseButtons.forEach((b,i)=>b.disabled=successful?false:previous[i]);window.AppPageLoader?.hide({immediate:true});}
  },true);
})();
