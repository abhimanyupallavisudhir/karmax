const { chromium } = require(require('path').join(__dirname, '../../../../node_modules/playwright'));
const path = require('path');
(async () => {
  const work = process.argv[2]; const fails = [];
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto('file://' + path.join(work, 'index.html'));
    const add = async (n) => { await page.fill('#person-name', n); await page.click('#add-person'); };
    for (const n of ['Alice', 'Bob', 'Cara', '  ', 'Bob']) await add(n);
    const people = await page.$$eval('#balances li[data-person]', (els) => els.map((e) => e.dataset.person));
    if (JSON.stringify(people) !== '["Alice","Bob","Cara"]') fails.push('people ' + JSON.stringify(people));
    const expense = async (payer, amount, desc) => {
      await page.selectOption('#payer', { label: payer }).catch(async () => page.selectOption('#payer', payer));
      await page.fill('#amount', String(amount)); await page.fill('#description', desc); await page.click('#add-expense');
    };
    await expense('Alice', 90, 'Hotel');
    await expense('Bob', 30, 'Dinner');
    await expense('Cara', -5, 'bad');
    await expense('Cara', 0, 'bad');
    const bal = async () => Object.fromEntries(await page.$$eval('#balances li[data-person]', (els) => els.map((e) => [e.dataset.person, (e.textContent.match(/[+-]?\d+\.\d\d/) || [''])[0]])));
    const want = { Alice: '+50.00', Bob: '-10.00', Cara: '-40.00' };
    const b1 = await bal();
    for (const [k, v] of Object.entries(want)) if (b1[k] !== v) fails.push(`balance ${k}=${b1[k]} want ${v}`);
    await page.click('#settle');
    const t1 = (await page.$$eval('#transfers li', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' '))));
    if (JSON.stringify(t1) !== JSON.stringify(['Cara pays Alice 40.00', 'Bob pays Alice 10.00'])) fails.push('transfers ' + JSON.stringify(t1));
    await page.reload();
    const b2 = await bal();
    for (const [k, v] of Object.entries(want)) if (b2[k] !== v) fails.push(`after reload ${k}=${b2[k]}`);
    await add('Dan');
    await expense('Dan', 40, 'Taxi');  // split among 4: Dan +30, others -10
    const b3 = await bal();
    const w3 = { Alice: '+40.00', Bob: '-20.00', Cara: '-50.00', Dan: '+30.00' };
    for (const [k, v] of Object.entries(w3)) if (b3[k] !== v) fails.push(`with Dan ${k}=${b3[k]} want ${v}`);
    await page.click('#settle');
    const t2 = (await page.$$eval('#transfers li', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' '))));
    if (JSON.stringify(t2) !== JSON.stringify(['Cara pays Alice 40.00', 'Bob pays Dan 20.00', 'Cara pays Dan 10.00'])) fails.push('transfers2 ' + JSON.stringify(t2));
    await page.click('#reset');
    const after = await page.$$eval('#balances li[data-person]', (els) => els.length);
    if (after !== 0) fails.push('reset left ' + after);
    await page.reload();
    if ((await page.$$eval('#balances li[data-person]', (els) => els.length)) !== 0) fails.push('reset not persisted');
  } catch (e) { fails.push('error ' + String(e.message || e).split('\n')[0]); }
  await browser.close();
  console.log(fails.length ? 'FAIL' : 'PASS', JSON.stringify(fails)); process.exit(fails.length ? 1 : 0);
})();
