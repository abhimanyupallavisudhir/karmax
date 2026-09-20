// Read-only observer of the deployed console using the task's own scoped token.
// Never writes the token, websocket URLs, or unrelated task content to output.
const fs = require('node:fs');
const { chromium } = require('playwright');
const [taskId, output] = process.argv.slice(2);
if (!taskId || !output || !process.env.KARMAX_TOKEN) throw Error('task id, output path and scoped token required');
(async () => {
 const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  await page.addInitScript(({taskId}) => {
   window.latencyObservations=[];
   const Native=window.WebSocket;
   window.WebSocket=class extends Native {
    constructor(...args) {
     super(...args);
     this.addEventListener('message', event => {
      let e; try {e=JSON.parse(event.data);} catch {return;}
      if(e.taskId!==taskId || e.type!=='agent.activity' || e.payload?.kind!=='message') return;
      const marker=e.payload.title?.trim();
      if(!/^(CLAUDE_READY|CLAUDE_FOLLOWUP|CLAUDE_ACTIVE_ACK)$/.test(marker)) return;
      const row={marker,receivedMonoMs:performance.now(),receivedWallMs:Date.now(),visible:document.visibilityState};
      window.latencyObservations.push(row);
      const find=()=>{
       if(!document.querySelector('#ck-thread')?.textContent.includes(marker)) return false;
       row.domMonoMs=performance.now();
       requestAnimationFrame(()=>requestAnimationFrame(()=>{row.frameMonoMs=performance.now();}));
       return true;
      };
      if(!find()) {const observer=new MutationObserver(()=>{if(find()) observer.disconnect();});observer.observe(document.body,{childList:true,subtree:true,characterData:true});setTimeout(()=>observer.disconnect(),15000);}
     });
    }
   };
  },{taskId});
  await page.route('https://tavya.io/app.js', async route => {
   const response=await route.fetch();
   const body=await response.text();
   // A module-local test entry point only; retain deployed rendering/delivery code.
   const hook=`\nglobalThis.startLatencyObserver=async(token,taskId)=>{
    S.token=token;await loadOrganizations();await loadProjects();
    S.projectId='proj_mslcziw9448362c77d';S.organizationId='org_personal';
    S.tasks=[{id:taskId,projectId:S.projectId,title:'Read-only E2B latency pilot'}];
    renderShell();await openTask(taskId,'checkin');connectWs();
   };`;
   await route.fulfill({response,body:body+hook});
  });
  await page.goto('https://tavya.io/',{waitUntil:'networkidle'});
  await page.evaluate(async ({token,taskId}) => {
   await window.startLatencyObserver(token,taskId);
  },{token:process.env.KARMAX_TOKEN,taskId});
  console.log(JSON.stringify({attached:true,taskId,consoleUrl:'https://tavya.io',browser:browser.version(),visibility:await page.evaluate(()=>document.visibilityState)}));
  const deadline=Date.now()+8*60000;
  while(Date.now()<deadline){
   const rows=await page.evaluate(()=>window.latencyObservations);
   fs.writeFileSync(output,JSON.stringify({taskId,browser:browser.version(),observer:'headless Chromium in collector E2B; scoped-token bootstrap of deployed console',rows},null,2));
   if(rows.some(r=>r.marker==='CLAUDE_ACTIVE_ACK'&&r.frameMonoMs!=null))break;
   await new Promise(r=>setTimeout(r,1000));
  }
  const screenshot=output.replace(/\.json$/,'.png');
  await page.screenshot({path:screenshot});
  console.log(JSON.stringify({observations:await page.evaluate(()=>window.latencyObservations),screenshot}));
 } finally {await browser.close();}
})().catch(e=>{console.error(String(e.message).replaceAll(process.env.KARMAX_TOKEN,'[redacted]'));process.exitCode=1;});
