import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

function extractFunction(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`${name} is unterminated`);
}

function extractConst(name: string): string {
  const start = app.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`${name} not found`);
  const end = app.indexOf('\n];', start);
  if (end < 0) throw new Error(`${name} is unterminated`);
  return app.slice(start, end + 3);
}

const context = vm.createContext({});
vm.runInContext([
  extractConst('CARD_NUMBER_GROUPS'),
  extractFunction('formatCardNumber'),
  extractFunction('formatExpiry'),
  extractFunction('formatCvc'),
  extractFunction('caretAfterDigits'),
  extractFunction('applyDigitFormat'),
  extractFunction('separatorDeletion'),
  extractFunction('wireCardField'),
  extractFunction('parseExpiry'),
].join('\n'), context);

const formatCardNumber = context.formatCardNumber as (raw: string) => string;
const formatExpiry = context.formatExpiry as (raw: string) => string;
const formatCvc = context.formatCvc as (raw: string) => string;
const parseExpiry = context.parseExpiry as (raw: string) => { expMonth: number; expYear: number } | null;

/** Minimal stand-in for a text <input>: value, caret, and the two listeners. */
class FakeInput {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  private handlers: Record<string, ((e: any) => void)[]> = {};
  addEventListener(type: string, fn: (e: any) => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  private emit(type: string, event: any = {}): any {
    for (const fn of this.handlers[type] || []) fn(event);
    return event;
  }
  /** Type text at the caret, the way a browser would before firing `input`. */
  type(text: string): this {
    const { value, selectionStart: start, selectionEnd: end } = this;
    this.value = value.slice(0, start) + text + value.slice(end);
    this.setSelectionRange(start + text.length, start + text.length);
    this.emit('input', { inputType: 'insertText' });
    return this;
  }
  paste(text: string): this {
    const { value, selectionStart: start, selectionEnd: end } = this;
    this.value = value.slice(0, start) + text + value.slice(end);
    this.setSelectionRange(start + text.length, start + text.length);
    this.emit('input', { inputType: 'insertFromPaste' });
    return this;
  }
  backspace(): this {
    let prevented = false;
    this.emit('beforeinput', { inputType: 'deleteContentBackward', preventDefault: () => { prevented = true; } });
    if (prevented) return this;
    const { value, selectionStart: start, selectionEnd: end } = this;
    const from = start === end ? Math.max(0, start - 1) : start;
    this.value = value.slice(0, from) + value.slice(end);
    this.setSelectionRange(from, from);
    this.emit('input', { inputType: 'deleteContentBackward' });
    return this;
  }
  /** Move the caret, as a click or an arrow key would. */
  caretTo(index: number): this {
    this.setSelectionRange(index, index);
    return this;
  }
  get state(): string {
    return `${this.value.slice(0, this.selectionStart)}|${this.value.slice(this.selectionStart)}`;
  }
}

function field(format: (raw: string) => string): FakeInput {
  const input = new FakeInput();
  (context.wireCardField as (el: unknown, fn: unknown) => void)(input, format);
  return input;
}

describe('formatCardNumber', () => {
  it('groups a 16-digit number in fours', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
  });

  it('regroups whatever separators were pasted', () => {
    expect(formatCardNumber('4242-4242-4242-4242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('  4242 42 4242424242  ')).toBe('4242 4242 4242 4242');
  });

  it('uses the 4-6-5 grouping American Express prints on the card', () => {
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
  });

  it('uses the 4-6-4 grouping for Diners Club', () => {
    expect(formatCardNumber('30569309025904')).toBe('3056 930902 5904');
  });

  it('groups a 19-digit number and refuses a 20th digit', () => {
    expect(formatCardNumber('6759649826438453123')).toBe('6759 6498 2643 8453 123');
    expect(formatCardNumber('67596498264384531234')).toBe('6759 6498 2643 8453 123');
  });

  it('caps Amex at its own length rather than the generic one', () => {
    expect(formatCardNumber('3782822463100051234')).toBe('3782 822463 10005');
  });

  it('leaves a partial number partially grouped, with no trailing separator', () => {
    expect(formatCardNumber('4242')).toBe('4242');
    expect(formatCardNumber('42424')).toBe('4242 4');
    expect(formatCardNumber('')).toBe('');
  });

  it('drops anything that is not a digit', () => {
    expect(formatCardNumber('4242abc4242')).toBe('4242 4242');
  });
});

describe('formatExpiry', () => {
  it('inserts the slash once the month is complete', () => {
    expect(formatExpiry('1')).toBe('1');
    expect(formatExpiry('12')).toBe('12/');
    expect(formatExpiry('122')).toBe('12/2');
    expect(formatExpiry('1226')).toBe('12/26');
  });

  it('pads a month that cannot be the start of a two-digit month', () => {
    expect(formatExpiry('5')).toBe('05/');
    expect(formatExpiry('526')).toBe('05/26');
  });

  it('pads a month the user closed with a separator themselves', () => {
    expect(formatExpiry('1/')).toBe('01/');
    expect(formatExpiry('1/26')).toBe('01/26');
  });

  it('accepts a four-digit year and keeps the last two', () => {
    expect(formatExpiry('12/2026')).toBe('12/26');
    expect(formatExpiry('122026')).toBe('12/26');
  });

  it('normalizes whatever separator was pasted', () => {
    expect(formatExpiry('12 - 26')).toBe('12/26');
    expect(formatExpiry('12/26')).toBe('12/26');
  });

  it('round-trips through parseExpiry', () => {
    expect(parseExpiry(formatExpiry('526'))).toEqual({ expMonth: 5, expYear: 2026 });
    expect(parseExpiry(formatExpiry('12/2031'))).toEqual({ expMonth: 12, expYear: 2031 });
  });
});

describe('formatCvc', () => {
  it('keeps digits only, up to four', () => {
    expect(formatCvc('1a2b3')).toBe('123');
    expect(formatCvc('12345')).toBe('1234');
  });
});

describe('wireCardField — typing feels like a real card form', () => {
  it('inserts group separators as digits are typed', () => {
    const input = field(formatCardNumber);
    for (const digit of '4242424242424242') input.type(digit);
    expect(input.state).toBe('4242 4242 4242 4242|');
  });

  it('keeps the caret at the end of a pasted number', () => {
    const input = field(formatCardNumber);
    input.paste('4242-4242-4242-4242');
    expect(input.state).toBe('4242 4242 4242 4242|');
  });

  it('backspacing over a separator removes the digit behind it', () => {
    const input = field(formatCardNumber);
    input.paste('42424242');            // "4242 4242"
    input.backspace().backspace().backspace().backspace();
    expect(input.state).toBe('4242|');   // the stranded "4242 " never appears
    input.backspace();
    expect(input.state).toBe('424|');
  });

  it('keeps the caret glued to its digit when editing mid-number', () => {
    const input = field(formatCardNumber);
    input.paste('424242424242424');      // "4242 4242 4242 424"
    input.caretTo(2).type('9');           // a digit inserted after "42"
    expect(input.state).toBe('429|4 2424 2424 2424');
  });

  it('deletes the digit before a separator when the caret sits mid-number', () => {
    const input = field(formatCardNumber);
    input.paste('42424242');             // "4242 4242"
    input.caretTo(5).backspace();         // caret just after the separator
    expect(input.state).toBe('424|4 242');
  });

  it('adds the expiry slash while typing and eats it on backspace', () => {
    const input = field(formatExpiry);
    input.type('1').type('2');
    expect(input.state).toBe('12/|');
    input.type('2').type('6');
    expect(input.state).toBe('12/26|');
    input.backspace().backspace();
    expect(input.state).toBe('12/|');
    input.backspace();
    expect(input.state).toBe('1|');
  });

  it('pads a single-digit month as soon as it cannot be a two-digit one', () => {
    const input = field(formatExpiry);
    input.type('5');
    expect(input.state).toBe('05/|');
    input.type('2').type('6');
    expect(input.state).toBe('05/26|');
  });

  it('normalizes a pasted expiry', () => {
    const input = field(formatExpiry);
    input.paste('3 / 2029');
    expect(input.state).toBe('03/29|');
  });

  it('ignores non-digits typed into the CVC', () => {
    const input = field(formatCvc);
    input.type('1').type('a').type('2').type('3');
    expect(input.state).toBe('123|');
  });
});
