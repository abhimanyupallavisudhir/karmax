import { MANIFESTS, WorkflowManifest, UiContribution, CommandDecl, EventSchemaDecl, manifest, resolveRequires } from './manifests.js';

/**
 * The contribution system (SPEC §10.1). The host implements a protocol, not a
 * catalog of anticipated workflows: workflows contribute typed slot
 * contributions, commands, and event schemas into named host extension points.
 * The registry aggregates the active set the UI binds to.
 */
export class ContributionRegistry {
  /** Active workflow names (a project may enable a subset; defaults to all bundled). */
  private active = new Set<string>(MANIFESTS.filter((m) => m.kind !== 'coordinator').map((m) => m.name));

  setActive(names: string[]) {
    this.active = new Set(resolveRequires(names));
  }

  activeManifests(): WorkflowManifest[] {
    return MANIFESTS.filter((m) => this.active.has(m.name) || m.kind === 'coordinator');
  }

  slots(slot?: UiContribution['slot']): { workflow: string; contribution: UiContribution }[] {
    const out: { workflow: string; contribution: UiContribution }[] = [];
    for (const m of this.activeManifests()) {
      for (const c of m.ui) if (!slot || c.slot === slot) out.push({ workflow: m.name, contribution: c });
    }
    return out;
  }

  /** The command/keymap registry — the substrate for keyboard navigation (§10.1). */
  commands(): (CommandDecl & { workflow: string })[] {
    const seen = new Map<string, CommandDecl & { workflow: string }>();
    // core commands first
    for (const c of CORE_COMMANDS) seen.set(c.id, { ...c, workflow: 'core' });
    for (const m of this.activeManifests()) {
      for (const c of m.commands) if (!seen.has(c.id)) seen.set(c.id, { ...c, workflow: m.name });
    }
    return [...seen.values()];
  }

  eventSchemas(): (EventSchemaDecl & { workflow: string })[] {
    const out: (EventSchemaDecl & { workflow: string })[] = [];
    for (const m of this.activeManifests()) for (const e of m.events) out.push({ ...e, workflow: m.name });
    return out;
  }

  manifest = manifest;
}

/** Core commands the host registers (keyboard navigation; SPEC §10.1, §10.3). */
export const CORE_COMMANDS: CommandDecl[] = [
  { id: 'nav.newTask', title: 'New task (quick add)', keybinding: 'n' },
  { id: 'nav.newTaskForm', title: 'New task (full form)', keybinding: 'N' },
  { id: 'nav.search', title: 'Search', keybinding: '/' },
  { id: 'nav.tasks', title: 'Go to tasks', keybinding: 'g t' },
  { id: 'nav.queue', title: 'Go to queues', keybinding: 'g q' },
  { id: 'nav.activity', title: 'Go to activity', keybinding: 'g a' },
  { id: 'nav.dashboard', title: 'Go to dashboard', keybinding: 'g d' },
  { id: 'nav.settings', title: 'Go to project settings', keybinding: 'g s' },
  { id: 'nav.global', title: 'Go to global settings', keybinding: 'g g' },
  { id: 'nav.projects', title: 'Go to projects', keybinding: 'g p' },
  { id: 'nav.notifications', title: 'Go to notifications', keybinding: 'g n' },
  { id: 'nav.close', title: 'Close panel', keybinding: 'Escape' },
  { id: 'nav.commandPalette', title: 'Command palette', keybinding: 'meta+k' },
  { id: 'nav.globalSearch', title: 'Search everything', keybinding: 'meta+shift+F' },
  { id: 'help.keyboard', title: 'Keyboard shortcuts', keybinding: '?' },
];
