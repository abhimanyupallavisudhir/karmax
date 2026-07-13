import type { ConfirmConfig, ConfirmLayer } from './types.js';

/**
 * Normalize a confirm config into the ordered layer list the Review gate plays
 * (SPEC §5.2). Pure, so workflows can call it inside the deterministic sandbox.
 *
 * `layers` wins when present. Otherwise the legacy single-gate shape maps to its
 * layer equivalent: auto ⇒ [] (zero layers), agent ⇒ one agent layer (carrying the
 * config's agent knobs + prompt template), human/absent ⇒ one human layer. The
 * `legacyAutoConfirm` flag is the pre-ConfirmConfig `autoConfirm` boolean on goal
 * tasks and applies only when the config says nothing at all.
 */
export function confirmLayersOf(c: ConfirmConfig | undefined, legacyAutoConfirm = false): ConfirmLayer[] {
  if (c?.layers) return c.layers;
  const mode = c?.mode ?? (legacyAutoConfirm ? 'auto' : 'human');
  if (mode === 'auto') return [];
  if (mode === 'agent') {
    const { mode: _mode, layers: _layers, ...rest } = c ?? {};
    return [{ kind: 'agent', ...rest }];
  }
  return [{ kind: 'human' }];
}
