import { describe, expect, it } from 'vitest';
import { RESPOND_PROMPT_DEFAULT, renderRespondPrompt } from '../src/domain/respond-prompt.js';

describe('Responder prompt', () => {
  it('renders the default task, question, and working transcript context', () => {
    const rendered = renderRespondPrompt(undefined, {
      title: 'Choose a color', prompt: 'Build the theme', question: 'Blue or green?', transcript: 'I need a decision.',
    });
    expect(rendered).toContain('Choose a color');
    expect(rendered).toContain('Build the theme');
    expect(rendered).toContain('Blue or green?');
    expect(rendered).toContain('I need a decision.');
  });

  it('supports the same editable-template model as the Review route', () => {
    expect(RESPOND_PROMPT_DEFAULT).toContain('{{question}}');
    expect(renderRespondPrompt('Answer {{question}} for {{title}}', {
      title: 'T', prompt: 'P', question: 'Q', transcript: 'X',
    })).toBe('Answer Q for T');
  });
});
