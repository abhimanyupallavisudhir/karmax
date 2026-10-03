import type { ProjectConfig, ProjectEnvironmentSpec, ProjectService } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { ProjectEnvironment } from '../store/project-environment.js';
import { ProjectServices } from '../store/project-services.js';
import { bootCommands, setupCommands } from './environment-build.js';
import type { ProjectResourceService } from './resources.js';
import { e2bTemplate } from './e2b-template.js';
import { launchWorldServices } from './services.js';
import { worldRepos, type World, type WorldHandle } from './types.js';

export interface ProjectEnvironmentSelection {
  spec?: ProjectEnvironmentSpec;
  digest?: string;
  built: boolean;
  environment?: ProjectConfig['environment'];
}

/** Resolve one accepted recipe to the provider artifact that should create a
 * world. The recipe may be checkpoint-pinned; provider images/snapshots remain
 * disposable accelerators selected by its stable digest. */
export async function selectProjectEnvironment(store: Store, projectId: string, provider: string,
  base: ProjectConfig['environment'], pinnedSpec?: ProjectEnvironmentSpec): Promise<ProjectEnvironmentSelection> {
  const environments = new ProjectEnvironment(store);
  const spec = pinnedSpec ?? (await environments.spec(projectId));
  if (!spec) return { built: false, environment: base };
  const digest = environments.digest(spec);
  const build = (await environments.readyBuild(projectId, provider, digest, await environmentBase(store, projectId, provider)));
  if (build?.ref && build.ref !== 'host') return {
    spec, digest, built: true,
    environment: { ...base, ...(provider === 'container' ? { image: build.ref } : { snapshot: build.ref }) },
  };
  // Container and Daytona can boot directly from an accepted image while setup
  // runs live. E2B image strings are template ids, so only a built snapshot is
  // portable there.
  const image = spec.image && (provider === 'container' || provider === 'daytona') ? spec.image : undefined;
  return { spec, digest, built: false, environment: image ? { ...base, image } : base };
}

/** The provider template a new environment build for this project would start
 * from (E2B only): the one its task worlds boot from without an environment. */
export async function environmentBase(store: Store, projectId: string, provider: string): Promise<string | undefined> {
  if (provider !== 'e2b') return undefined;
  const organizationId = (await store.getProject(projectId))?.organizationId;
  return e2bTemplate(organizationId ? (await store.getWorldProviderConnection(organizationId, 'e2b'))?.config.template : undefined);
}

export async function snapshotProjectRuntime(store: Store, projectId: string): Promise<{
  environment?: ProjectEnvironmentSpec;
  services?: ProjectService[];
}> {
  const environment = (await new ProjectEnvironment(store).spec(projectId));
  const services = (await new ProjectServices(store).list(projectId));
  return {
    ...(environment ? { environment } : {}),
    ...(services.length ? { services } : {}),
  };
}

/** Complete the runtime half of world creation after Git and resource
 * revisions exist. This is intentionally shared by fresh worlds and portable
 * checkpoint restore so a restored world cannot lose boot hooks or services. */
export async function activateProjectRuntime(args: {
  world: World;
  store: Store;
  projectId: string;
  taskId: string;
  selection: ProjectEnvironmentSelection;
  resources?: ProjectResourceService;
  services?: ProjectService[];
  runSetupIfUnbuilt?: boolean;
}): Promise<{ handle: WorldHandle; warnings: string[] }> {
  const warnings: string[] = [];
  const { world, selection } = args;
  if (selection.spec && !['worktree', 'memory'].includes(world.handle.kind)) {
    const setup = args.runSetupIfUnbuilt && !selection.built ? setupCommands(selection.spec) : [];
    if (setup.length)
      warnings.push('environment build is not ready; setup ran live (build it in Project Settings → Environment for faster worlds)');
    for (const command of [...setup, ...bootCommands(selection.spec)]) {
      const result = await world.exec('bash', ['-lc', command], { timeoutMs: 30 * 60_000 });
      if (result.code !== 0)
        warnings.push(`environment command "${command}" failed: ${(result.stderr || result.stdout).slice(-300)}`);
    }
  }
  // Dependency installs need the checkout, so no snapshot can hold them, and
  // running them here would delay every task (~45 s for a typical Node project)
  // though many never build or test. The agent runs them when it needs them.
  const repos = worldRepos(world.handle);
  const installs: Array<{ repository: string; root: string; commands: string[] }> = [];
  for (const [name, commands] of Object.entries(selection.spec?.install ?? {})) {
    const repo = repos.find((candidate) => candidate.name === name);
    if (repo) installs.push({ repository: name, root: repo.root, commands });
    else warnings.push(`environment install for "${name}" skipped: this world has no repository with that name`);
  }
  if (installs.length) world.handle.meta = { ...world.handle.meta, environmentInstall: installs };

  const declarations = args.services ?? (await new ProjectServices(args.store).list(args.projectId));
  const perWorld = declarations.filter((service) => service.kind === 'per-world');
  if (perWorld.length) {
    const resources = new Map((await args.store.listResourceAttachments(args.projectId))
      .map((resource) => [resource.id, resource]));
    const launched = await launchWorldServices(world, args.taskId, perWorld, resources);
    warnings.push(...launched.warnings);
    if (Object.keys(launched.env).length) {
      if (args.resources) world.handle = await args.resources.registerServiceEnvironment(world.handle, launched.env,
        (await args.store.getProject(args.projectId))?.organizationId ?? 'org_personal');
      else warnings.push('per-world service endpoints could not be injected because project resources are unavailable');
    }
    if (launched.containers.length)
      world.handle.meta = { ...world.handle.meta, serviceContainers: launched.containers };
  }
  return { handle: world.handle, warnings };
}
