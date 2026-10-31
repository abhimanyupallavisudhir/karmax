import { describe, expect, it } from 'vitest';
import { canonicalRepositoryIdentity, githubRepositoryOf, projectRepositorySource, sameRepository } from '../src/world/repository-identity.js';

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

  it('reads a GitHub repository from any address people paste', () => {
    for (const text of ['acme/widgets', ' acme/widgets ', 'acme/widgets.git', 'github.com/acme/widgets/', 'www.github.com/acme/widgets',
      'https://github.com/acme/widgets', 'https://github.com/acme/widgets.git', 'https://www.github.com/acme/widgets/',
      'https://github.com/acme/widgets/tree/main/src', 'https://github.com/acme/widgets/pull/3?tab=files#diff',
      'https://github.com/acme/widgets?tab=readme-ov-file', 'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git', 'ssh://git@ssh.github.com:443/acme/widgets.git', 'git://github.com/acme/widgets.git'])
      expect(githubRepositoryOf(text), text).toBe('acme/widgets');
    expect(githubRepositoryOf('https://github.com/acme/my.site.git')).toBe('acme/my.site');
    for (const text of ['', 'widgets', 'acme/widgets/tree/main', '/srv/acme/widgets', './acme/widgets', '../widgets',
      '~/acme/widgets', 'https://gitlab.com/acme/widgets', 'git@gitlab.com:acme/widgets.git', 'https://github.com/acme', 'acme/..'])
      expect(githubRepositoryOf(text), text).toBeUndefined();
  });

  it('keeps the catalog repository a pasted address names, else a clonable source', () => {
    const catalog = [{ owner: 'Acme', name: 'Web', sshUrl: 'git@github.com:Acme/Web.git' }];
    for (const text of ['acme/web', 'https://github.com/acme/web', 'https://github.com/Acme/Web/tree/main', 'git@github.com:acme/web.git'])
      expect(projectRepositorySource(text, catalog), text).toBe('git@github.com:Acme/Web.git');
    // A page of someone else's repository clones from its https address; clone URLs and paths stay as given.
    expect(projectRepositorySource('https://github.com/other/lib/blob/main/README.md', catalog)).toBe('https://github.com/other/lib.git');
    expect(projectRepositorySource('other/lib', catalog)).toBe('https://github.com/other/lib.git');
    for (const text of ['https://github.com/other/lib', 'git@github.com:other/lib.git', '/srv/code/tools', 'https://gitlab.com/acme/legacy.git'])
      expect(projectRepositorySource(text, catalog), text).toBe(text);
  });
});
