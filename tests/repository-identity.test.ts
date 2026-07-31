import { describe, expect, it } from 'vitest';
import { canonicalRepositoryIdentity, sameRepository } from '../src/world/repository-identity.js';

describe('repository identity', () => {
  it('recognizes GitHub SSH endpoint aliases as one enrolled repository', () => {
    expect(sameRepository(
      'git@github.com:abhimanyupallavisudhir/karmax-wiki-561ff6de.git',
      'ssh://git@ssh.github.com:443/abhimanyupallavisudhir/karmax-wiki-561ff6de.git',
    )).toBe(true);
    expect(canonicalRepositoryIdentity('https://github.com/OpenAI/Karmax.git/'))
      .toBe('github.com/openai/karmax');
  });

  it('does not collapse different hosts or repository paths', () => {
    expect(sameRepository('git@github.com:openai/one.git', 'git@github.com:openai/two.git')).toBe(false);
    expect(sameRepository('git@example.com:openai/one.git', 'git@github.com:openai/one.git')).toBe(false);
  });
});
