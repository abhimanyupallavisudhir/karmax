const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const editor = source.slice(source.indexOf('async function openMcpEditor('), source.indexOf('async function finishMcpCallback('));
const picker = source.slice(source.indexOf('function mcpPickerHtml('), source.indexOf('async function openMcpEditor('));
const actions = source.slice(source.indexOf('function connectionRows('), source.indexOf('async function wireInstallationComposioCard('));
const panel = source.slice(source.indexOf('async function hydrateNativeConnections('), source.indexOf('function passwordsCard('));
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://fixture.example/**', route => route.fulfill({contentType:'text/html',body:'<div id="native-connections"></div>'}));
    await page.context().route('https://auth.example/**', route => route.fulfill({contentType:'text/html',body:'Fixture authorization page'}));
    await page.goto('https://fixture.example');
    await page.addScriptTag({ content: `
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const mcpScope = (_,org) => '?organizationId='+org;
      const S = {user:{id:'alice'}, organizationId:'org', projects:[{id:'project',name:'Project',organizationId:'org'}]};
      const beginAsyncElementRender = el => () => el.isConnected;
      const toast = message => {throw new Error(message);};
      const paneError = (_,error) => {throw error;};
      let saved = [], failComposio = true, account; window.failComposio = true; window.requests = [];
      async function api(url, options={}) {
        requests.push({url,...options});
        if (url.startsWith('/api/connections')) {
          if (window.failComposio) throw new Error('Composio unavailable');
          if (url.includes('/catalog')) return [{slug:'gmail',name:'Gmail'}];
          if (url.includes('/connect?')) { account={id:'conn_demo',label:'Gmail',status:'connecting',ownerId:'alice',organizationId:'org',projectIds:[]}; return {connection:account,url:'https://auth.example/composio'}; }
          if (url.includes('/refresh')) { account.status='active'; return account; }
          if (url.includes('/access')) { account.projectIds=JSON.parse(options.body).projectIds; return account; }
          if (url.includes('/disconnect')) { account.status='disconnected'; return account; }
          return account ? [account] : [];
        }
        if (url.startsWith('/api/mcp/oauth-info')) return {redirectUri:'https://configured.example/mcp-callback'};
        if (url.startsWith('/api/mcp/registry')) return {servers:[{title:'Example',name:'example/server',version:'1',description:'Fixture',options:[{transport:{type:'http',url:'https://resource.example/mcp'},fields:[]}]}]};
        if (url.includes('/authorize')) return {authorizationUrl:'https://auth.example/authorize?state=fixture-state'};
        if (options.method === 'POST') { const data=JSON.parse(options.body); saved=[{...data,id:'mcp_fixture',connected:false}]; return saved[0]; }
        return saved;
      }
      ${editor}
      ${panel}
      ${picker}
      ${actions}
      hydrateNativeConnections('org');
    ` });
    await page.getByRole('combobox',{name:'Search MCPs and connectors'}).fill('Example');
    await page.locator('[data-registry]').click();
    assert.match(await page.locator('.mcp-editor').innerText(), /shared with this organization/);
    assert.equal(await page.locator('.mcp-auth').inputValue(), 'oauth');
    await page.getByText('Advanced OAuth setup',{exact:true}).click();
    await page.locator('.mcp-oauth-client code').getByText('https://configured.example/mcp-callback',{exact:true}).waitFor();
    await page.locator('.mcp-registration').selectOption('manual');
    await page.locator('.mcp-client-id').fill('registered-id');
    await page.locator('.mcp-client-method').selectOption('client_secret_basic');
    await page.locator('.mcp-client-secret').fill('fixture-secret');
    const opened=page.waitForEvent('popup');
    await page.getByRole('button',{name:'Save and add',exact:true}).click();
    const popup=await opened; await popup.waitForURL('https://auth.example/**');
    const request=await page.evaluate(()=>requests.find(r=>r.url==='/api/mcp?organizationId=org' && r.method==='POST'));
    assert.deepEqual(JSON.parse(request.body).oauthClient,{clientId:'registered-id',tokenEndpointAuthMethod:'client_secret_basic',clientSecret:'fixture-secret'});
    assert.equal(await page.locator('.mcp-client-secret').inputValue(), '');
    assert.equal(await popup.evaluate(()=>window.opener), null);
    await popup.close();
    await page.getByRole('button',{name:'Close MCP form'}).click();
    await page.locator('.mcp-caret').click();
    await page.locator('.mcp-custom').click();
    await page.locator('.mcp-type').selectOption('stdio');
    assert.equal(await page.locator('.mcp-oauth-client').isVisible(),false);
    assert.equal(await page.locator('.mcp-auth').inputValue(),'secrets');
    await page.getByRole('button',{name:'Close MCP form'}).click();
    await page.evaluate(() => { window.failComposio=false; document.getElementById('native-connections').innerHTML=mcpPickerHtml([],[]); return wireMcpPicker(document.querySelector('.mcp-picker'), '?projectId=project'); });
    await page.locator('.mcp-filter').fill('Gmail');
    await page.locator('[data-connector-app]').click();
    assert.equal(await page.locator('.mcp-connection-form').count(), 0);
    const composioOpened=page.waitForEvent('popup');
    await page.locator('.connector-signin').click();
    const composioPopup=await composioOpened; await composioPopup.waitForURL('https://auth.example/composio');
    assert.equal(await composioPopup.evaluate(()=>window.opener),null);
    assert.equal(await page.locator('.connector-use').isVisible(),false);
    await page.locator('.connector-check').click();
    await page.locator('.connector-use').click();
    await page.locator('.connector-use').waitFor({state:'detached'});
    assert.match(await page.locator('.mcp-chips').innerText(),/Gmail/);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(document.querySelector('.mcp-picker').dataset.value)),['composio:conn_demo']);
    const sharing=await page.evaluate(()=>requests.find(r=>r.url.includes('/access') && r.method==='PUT'));
    assert.deepEqual(JSON.parse(sharing.body).projectIds,['project']);
    await composioPopup.close();
    assert.deepEqual(errors,[]);
    console.log('Native MCP discovery, shared scope, preregistration, canonical callback, secret clearing and OAuth popup, unified Composio search, project sharing and automatic selection passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
