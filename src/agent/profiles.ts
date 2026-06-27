import { AgentProfile, AgentRole, Provider } from '../domain/types.js';
import { Store } from '../store/db.js';

/** The standard per-role profiles shipped with v1. */
export function makeDefaultProfiles(provider: Provider): AgentProfile[] {
  const model = defaultModel(provider);
  return [
    {
      id: 'do-default',
      name: 'Do agent',
      provider,
      ...(model ? { model } : {}),
      role: 'do',
      capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill'],
      maxTurns: 24,
    },
    {
      id: 'merge-default',
      name: 'Merge agent',
      provider,
      ...(model ? { model } : {}),
      role: 'merge',
      capabilities: ['merge-into:*', 'signal-completion'],
      maxTurns: 24,
    },
    {
      id: 'resolve-default',
      name: 'Resolve agent',
      provider,
      ...(model ? { model } : {}),
      role: 'resolve',
      capabilities: ['signal-completion', 'save-skill'],
      maxTurns: 16,
    },
  ];
}

export function defaultModel(provider: Provider): string | undefined {
  if (provider === 'codex') return process.env.KARMAX_OPENAI_MODEL ?? 'gpt-4.1';
  if (provider === 'claude') return process.env.KARMAX_CLAUDE_MODEL ?? 'claude-sonnet-4-5';
  return undefined;
}

/** Resolves the profile for a role, honoring explicit/task/default precedence. */
export class ProfileResolver {
  constructor(
    private store: Store,
    private fallbackProvider: Provider,
  ) {}

  resolve(role: AgentRole, taskProfiles?: Record<string, string>, explicitId?: string): AgentProfile {
    const id = explicitId ?? taskProfiles?.[role];
    if (id) {
      const p = this.store.getProfile(id);
      if (p) return p;
    }
    const def = this.store.getProfile(`${role}-default`);
    if (def) return def;
    // Synthesize a minimal default if the store has no profile yet.
    const model = defaultModel(this.fallbackProvider);
    return {
      id: `${role}-default`,
      name: `${role} agent`,
      provider: this.fallbackProvider,
      ...(model ? { model } : {}),
      role,
      capabilities: ['signal-completion'],
      maxTurns: 24,
    };
  }
}

/** Seed the store with the default profiles for a provider (idempotent overwrite). */
export function seedProfiles(store: Store, provider: Provider) {
  for (const p of makeDefaultProfiles(provider)) {
    if (!store.getProfile(p.id)) store.upsertProfile(p);
  }
}
