// #367 review item 14: amounts show in their own currency, and a budget is
// entered in major units of its currency, whatever its minor unit (JPY has
// none, KWD three).
// Run: node web/payment-currency.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
eval(src.match(/^const usd = .*$/m)[0].replace('const usd', 'global.usd'));
for (const name of ['currencyDigits', 'money', 'toMinorUnits', 'fromMinorUnits', 'spendRequestRow', 'readTaskPayments']) eval(`global.${name} = ${extractFn(name)}`);

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const format = (amount, currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);

ok(currencyDigits('usd') === 2 && currencyDigits('jpy') === 0 && currencyDigits('kwd') === 3, 'minor-unit digits follow ISO 4217');
ok(money(1234, 'usd') === '$12.34', 'dollars keep their format');
ok(money(1234, 'eur') === format(12.34, 'eur'), 'euros are cents');
ok(money(1234, 'jpy') === format(1234, 'jpy'), 'yen have no minor unit');
ok(money(1234, 'kwd') === format(1.234, 'kwd'), 'dinars have three decimals');
ok(toMinorUnits('1000', 'jpy') === 1000 && toMinorUnits('7.5', 'eur') === 750 && toMinorUnits('1.25', 'kwd') === 1250, 'budgets convert by the currency exponent');
ok(fromMinorUnits(1000, 'jpy') === '1000' && fromMinorUnits(750, 'eur') === '7.50', 'budgets display by the currency exponent');

const row = spendRequestRow({ id: 'r1', amount: 5000, currency: 'jpy', merchant: 'shop.example.jp', status: 'pending_approval' });
ok(row.includes(esc(format(5000, 'jpy'))) && !row.includes('$'), 'an approval shows the request\'s own currency');
ok(spendRequestRow({ id: 'r2', amount: 250, status: 'pending_approval' }).includes('$2.50'), 'a request without a currency is dollars');

const box = { dataset: { policy: JSON.stringify({ cardIds: ['c1'] }) }, querySelector: (selector) => selector === '.payment-budget'
  ? { value: '1000', checkValidity: () => true } : { value: 'jpy' } };
ok(JSON.stringify(readTaskPayments(box)) === JSON.stringify({ cardIds: ['c1'], budget: 1000, currency: 'jpy' }), 'a yen budget is not multiplied by 100');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
