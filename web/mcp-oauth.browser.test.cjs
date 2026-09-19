const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const editor = source.slice(source.indexOf('async function openMcpEditor('), source.indexOf('async function finishMcpCallback('));
const panel = source.slice(source.indexOf('async function hydrateNativeConnections('), source.indexOf('async function hydrateConnections('));
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
      const paneError = (_,error) => {throw error;};
      let saved = [], failSearch = true; window.requests = [];
      async function api(url, options={}) {
        requests.push({url,...options});
        if (url.startsWith('/api/connections')) throw new Error('Native MCP must not depend on Composio');
        if (url.startsWith('/api/mcp/oauth-info')) return {redirectUri:'https://configured.example/mcp-callback'};
        if (url.startsWith('/api/mcp/registry')) return {servers:[{title:'Example',name:'example/server',version:'1',description:'Fixture',options:[{transport:{type:'http',url:'https://resource.example/mcp'},fields:[]}]}]};
        if (url.includes('/authorize')) return {authorizationUrl:'https://auth.example/authorize?state=fixture-state'};
        if (options.method === 'POST') { const data=JSON.parse(options.body); saved=[{...data,id:'mcp_fixture',connected:false}]; return saved[0]; }
        return saved;
      }
      ${editor}
      ${panel}
      hydrateNativeConnections('org');
    ` });
    await page.getByRole('textbox',{name:'Search MCP servers'}).fill('Example');
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.getByRole('button',{name:'Connect Example',exact:true}).click();
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
    await page.getByRole('button',{name:'Add server URL or local process'}).click();
    await page.locator('.mcp-type').selectOption('stdio');
    assert.equal(await page.locator('.mcp-oauth-client').isVisible(),false);
    assert.equal(await page.locator('.mcp-auth').inputValue(),'secrets');
    assert.deepEqual(errors,[]);
    console.log('Native MCP discovery, shared scope, preregistration, canonical callback, secret clearing and OAuth popup passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
