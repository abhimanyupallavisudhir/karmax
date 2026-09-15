// Full task-opening regression with the real app and mocked HTTP responses.
// Requires Chromium exposing CDP at http://127.0.0.1:9222.
// Run: node scripts/test-resource-review-browser.cjs
// Optional: RESOURCE_TEST_BASELINE=<git-ref> to reproduce against older code;
// RESOURCE_TEST_SCREENSHOT=/tmp/resource-checkin.png to capture the final pane.
const fs = require('node:fs');
const http = require('node:http');
const root = require('node:path').resolve(__dirname, '../web');
let socket, pageId;
const app = (process.env.RESOURCE_TEST_BASELINE ? require('node:child_process').execFileSync('git',['show',process.env.RESOURCE_TEST_BASELINE+':web/app.js'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024}) : fs.readFileSync(root+'/app.js','utf8')).replace(/\nboot\(\)\.catch\([\s\S]*$/, '\nwindow.resourceTest = { S, openTask, renderTaskPage };');
const server = http.createServer((req,res)=>{
  if(req.url === '/') {res.setHeader('content-type','text/html');res.end('<link rel="stylesheet" href="/styles.css"><div id="app"><main id="main"></main></div><div id="overlay-root"></div><div id="modal-root"></div><div id="toasts"></div><script>globalThis.TotpQr={};</script><script type="module" src="/app.js"></script>');return;}
  if(req.url === '/app.js'){res.setHeader('content-type','text/javascript');res.end(app);return;}
  if(req.url === '/styles.css'){res.setHeader('content-type','text/css');res.end(fs.readFileSync(root+'/styles.css'));return;}
  res.statusCode=404;res.end();
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const page=await (await fetch('http://127.0.0.1:9222/json/new?'+encodeURIComponent(url),{method:'PUT'})).json();
  pageId=page.id;
  const ws=socket=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(); ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
  const send=(method,params)=>new Promise(r=>{const n=++id;pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression)=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
  await evaluate(`new Promise((resolve,reject)=>{let tries=0; const tick=()=>window.resourceTest?resolve():++tries>100?reject(Error('app not loaded')):setTimeout(tick,20);tick();})`);
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  const result=await evaluate(`(async()=>{
    const {S,openTask,renderTaskPage}=window.resourceTest;
    const v={taskId:'fixture',num:2,title:'Resource decision first-open test',workflow:'software-dev',stage:'review',status:'waiting',updatedAt:1,
      waitingFor:{kind:'human',detail:'1 staged project resource candidate must be Adopted or Discarded before this proposal can continue.'},
      actions:[{name:'followUp',kind:'signal',label:'Send follow-up',enabled:true,args:[]}],
      messages:[{id:'a1',role:'agent',text:'Checkpoint ready for review.',ts:1}], reviewInfo:{caption:'Test candidate',completion:'finished'}};
    let items=[{resource:{name:'Expanded study ready checkpoint',target:{kind:'path',path:'study-ready'},access:'read'},candidate:{id:'c1',state:'pending',sourceKind:'path',sourcePath:'study-ready-candidate',worldGeneration:1},revision:{bytes:256968692,files:3}}];
    const staged = items[0];
    let inventoryFinish; let resourceReads=0,inventoryReads=0,posts=[];
    window.confirm=()=>true;
    window.fetch=async(path,opts={})=>{
      path=String(path);let data=[];
      if(path.includes('/resource-candidates/')) {posts.push(path);items=[];data={};}
      else if(path.endsWith('/resources/inventory')) {inventoryReads++;return new Promise(r=>{inventoryFinish=()=>r(new Response(JSON.stringify({entries:[{path:'ignored.log',bytes:10}]}),{headers:{'content-type':'application/json'}}));});}
      else if(path.endsWith('/resources')) {resourceReads++;data=items;await new Promise(r=>setTimeout(r,30));}
      else if(path==='/api/tasks/fixture') data=v;
      else if(path.includes('/events')) data=[];
      else if(path.endsWith('/sessions')) data={};
      else if(path.endsWith('/attempts')) data=null;
      else if(path.includes('explanation-settings')) data={effective:{enabled:false}};
      return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    };
    S.selected=null;S.tasks=[{id:'fixture',num:2,projectId:'p1',params:{},workflow:'software-dev',title:v.title}];
    S.projects=[{id:'p1',name:'solib',organizationId:'o1',config:{}}];S.projectId='p1';S.organizationId='o1';S.organizations=[{id:'o1',name:'Test'}];
    S.meta={workflows:[],hosted:true};
    await openTask('fixture','overview');
    await new Promise(r=>setTimeout(r,100));
    const require=(condition,message)=>{if(!condition)throw Error(message);};
    require(document.querySelector('[data-tab="overview"]'),'Overview did not open');
    require(document.querySelector('.candidate-adopt'),'first Overview open has no Adopt button: '+document.body.innerText);
    require(inventoryReads===1,'first open repeated inventory request '+inventoryReads);
    require(resourceReads===1,'first open repeated resource request '+resourceReads);
    require(document.querySelector('#review-resource-inventory').innerText.includes('Inspecting'),'inventory unexpectedly finished');
    inventoryFinish();await new Promise(r=>setTimeout(r,100));
    require(document.querySelector('#review-resource-inventory').innerText.includes('ignored.log'),'inventory did not hydrate: '+document.querySelector('#review-resource-inventory').innerHTML);
    S.taskTab='checkin';renderTaskPage();await new Promise(r=>setTimeout(r,100));
    require(document.querySelector('.input-request .candidate-adopt'),'Adopt is not inside Input requested');
    require(!document.querySelector('#review-resource-inventory'),'inventory leaked into conversation');
    document.querySelector('.candidate-adopt').click();await new Promise(r=>setTimeout(r,80));
    require(posts.at(-1)?.endsWith('/adopt'),'Adopt did not submit');
    require(!document.querySelector('.candidate-adopt'),'resolved controls remain');
    items=[staged];S.view={...S.view};S.taskTab='overview';renderTaskPage();await new Promise(r=>setTimeout(r,100));
    document.querySelector('.candidate-discard').click();await new Promise(r=>setTimeout(r,100));
    require(posts.at(-1)?.endsWith('/discard'),'Discard did not submit');
    S.taskTab='approvals';renderTaskPage();require(!document.querySelector('#review-resources'),'resources leaked into approvals');
    S.taskTab='parameters';renderTaskPage();require(!document.querySelector('#review-resources'),'resources leaked into parameters');
    items=[staged];S.view={...S.view};S.taskTab='checkin';renderTaskPage();await new Promise(r=>setTimeout(r,100));

    return {firstOpen:'passed with inventory blocked',inputRequested:'passed',adopt:'passed',discard:'passed',resourceReads,inventoryReads};
  })()`);
  console.log(result);
  if (process.env.RESOURCE_TEST_SCREENSHOT) {
    const screenshot=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(process.env.RESOURCE_TEST_SCREENSHOT,Buffer.from(screenshot.result.data,'base64'));
  }

})().catch(e=>{console.error(String(e).slice(0,1000));process.exitCode=1;}).finally(async()=>{
  socket?.close();
  if (pageId) await fetch('http://127.0.0.1:9222/json/close/'+pageId).catch(()=>{});
  server.closeAllConnections();
  await new Promise(r=>server.close(r));
});
