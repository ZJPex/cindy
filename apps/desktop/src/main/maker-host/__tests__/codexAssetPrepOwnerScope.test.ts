import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  ownerId: 'owner-a',
  ownerScopeKey: 'cloud:owner-a:1',
  ownerGeneration: 1,
  ownerRoot: '/data/owners/owner-a',
  userDataDir: '/tmp/cindy-codex-assets-owner-scope',
  homeDir: '/home/test-user',
  sharedMutationOwners: [] as Array<string | null>,
  sharedMutationDepth: 0,
  sharedPrepDepths: [] as number[],
  codexPrepDepths: [] as number[],
  codexProjectionIdentity: 'agents-a' as string | null,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => harness.userDataDir,
    getAppPath: () => harness.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => harness.homeDir,
    },
    homedir: () => harness.homeDir,
  };
});

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => harness.ownerScopeKey,
  getActiveAppSession: () => ({
    mode: 'cloud',
    dataOwnerId: harness.ownerId,
    generation: harness.ownerGeneration,
  }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => harness.ownerRoot,
}));

vi.mock('../../authBoundaryQuarantine.js', () => ({
  assertGhostSkillProjectionBoundaryStableForOwner: vi.fn(),
  withSharedGlobalSkillProjectionMutation: vi.fn(
    async <T>(ownerId: string | null, mutation: () => Promise<T>): Promise<T> => {
      harness.sharedMutationOwners.push(ownerId);
      harness.sharedMutationDepth += 1;
      try {
        return await mutation();
      } finally {
        harness.sharedMutationDepth -= 1;
      }
    },
  ),
}));

vi.mock('../shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: vi.fn(async () => {
    harness.sharedPrepDepths.push(harness.sharedMutationDepth);
    return { warnings: [] };
  }),
}));

vi.mock('../codex-global-skills.js', () => ({
  prepareCodexGlobalSkillsLinks: vi.fn(async () => {
    harness.codexPrepDepths.push(harness.sharedMutationDepth);
    return {
      changed: false,
      warnings: [],
      agentsProjectionIdentity: harness.codexProjectionIdentity,
    };
  }),
}));

vi.mock('../codex-global-rules.js', () => ({
  prepareCodexGlobalRulesCopy: vi.fn(async () => ({ warnings: [] })),
}));

vi.mock('../codex-global-plugins.js', () => ({
  prepareCodexGlobalPluginsBridge: vi.fn(async () => ({
    warnings: [],
    routingFailures: [],
  })),
}));

describe('DesktopCodexAuthAdapter asset preparation single-flight', () => {
  beforeEach(() => {
    harness.ownerId = 'owner-a';
    harness.ownerScopeKey = 'cloud:owner-a:1';
    harness.ownerGeneration = 1;
    harness.ownerRoot = '/data/owners/owner-a';
    harness.sharedMutationOwners = [];
    harness.sharedMutationDepth = 0;
    harness.sharedPrepDepths = [];
    harness.codexPrepDepths = [];
    harness.codexProjectionIdentity = 'agents-a';
  });

  it('advances the local epoch when another process publishes a new projection identity', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as {
      skillsProjectionEpoch: number;
      observedAgentsProjectionIdentity: string | null | undefined;
    };
    Object.defineProperties(adapter, {
      skillsProjectionEpoch: { configurable: true, writable: true, value: 0 },
      observedAgentsProjectionIdentity: {
        configurable: true,
        writable: true,
        value: undefined,
      },
    });
    const runEnsureGlobalCodexAssets = (
      DesktopCodexAuthAdapter.prototype as unknown as {
        runEnsureGlobalCodexAssets(owner: {
          ownerId: string;
          ownerRoot: string;
          ownerScopeKey: string;
        }): Promise<{ skillsProjectionEpoch: number }>;
      }
    ).runEnsureGlobalCodexAssets;
    const owner = {
      ownerId: 'owner-a',
      ownerRoot: '/data/owners/owner-a',
      ownerScopeKey: 'cloud:owner-a:1',
    };

    await expect(runEnsureGlobalCodexAssets.call(adapter, owner)).resolves.toEqual({
      skillsProjectionEpoch: 0,
    });

    harness.codexProjectionIdentity = 'agents-b';
    await expect(runEnsureGlobalCodexAssets.call(adapter, owner)).resolves.toEqual({
      skillsProjectionEpoch: 1,
    });
    await expect(runEnsureGlobalCodexAssets.call(adapter, owner)).resolves.toEqual({
      skillsProjectionEpoch: 1,
    });
  });

  it('keeps Codex projection publication and stale cleanup inside the shared mutation lock', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as {
      skillsProjectionEpoch: number;
    };
    Object.defineProperty(adapter, 'skillsProjectionEpoch', {
      configurable: true,
      writable: true,
      value: 0,
    });
    const runEnsureGlobalCodexAssets = (
      DesktopCodexAuthAdapter.prototype as unknown as {
        runEnsureGlobalCodexAssets(owner: {
          ownerId: string;
          ownerRoot: string;
          ownerScopeKey: string;
        }): Promise<{ skillsProjectionEpoch: number }>;
      }
    ).runEnsureGlobalCodexAssets;

    await expect(
      runEnsureGlobalCodexAssets.call(adapter, {
        ownerId: 'owner-a',
        ownerRoot: '/data/owners/owner-a',
        ownerScopeKey: 'cloud:owner-a:1',
      }),
    ).resolves.toEqual({ skillsProjectionEpoch: 0 });

    expect(harness.sharedMutationOwners).toEqual(['owner-a', 'owner-a']);
    expect(harness.sharedPrepDepths).toEqual([1]);
    expect(harness.codexPrepDepths).toEqual([1]);
  });

  it(
    'coalesces one owner but queues a new preparation after an owner switch',
    { timeout: 30_000 },
    async () => {
      const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
      const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
        typeof DesktopCodexAuthAdapter
      >;
      let finishOwnerA!: () => void;
      let finishOwnerB!: () => void;
      const ownerARun = new Promise<void>((resolve) => {
        finishOwnerA = resolve;
      });
      const ownerBRun = new Promise<void>((resolve) => {
        finishOwnerB = resolve;
      });
      const runEnsureGlobalCodexAssets = vi
        .fn<
          (owner: {
            ownerId: string | null;
            ownerRoot: string;
            ownerScopeKey: string;
          }) => Promise<{ skillsProjectionEpoch: number }>
        >()
        .mockImplementationOnce(async () => {
          await ownerARun;
          return { skillsProjectionEpoch: 0 };
        })
        .mockImplementationOnce(async () => {
          await ownerBRun;
          return { skillsProjectionEpoch: 0 };
        });
      Object.defineProperties(adapter, {
        pendingAssetsPrep: { configurable: true, writable: true, value: null },
        skillsProjectionEpoch: { configurable: true, writable: true, value: 0 },
        skillsListReloadedEpochByCwd: {
          configurable: true,
          writable: true,
          value: new Map<string, number>(),
        },
        runEnsureGlobalCodexAssets: {
          configurable: true,
          value: runEnsureGlobalCodexAssets,
        },
      });

      const firstOwnerA = adapter.ensureGlobalCodexAssets();
      const secondOwnerA = adapter.ensureGlobalCodexAssets();
      expect(runEnsureGlobalCodexAssets).toHaveBeenCalledTimes(1);
      expect(runEnsureGlobalCodexAssets).toHaveBeenLastCalledWith({
        ownerId: 'owner-a',
        ownerRoot: '/data/owners/owner-a',
        ownerScopeKey: 'cloud:owner-a:1',
      });

      harness.ownerId = 'owner-b';
      harness.ownerScopeKey = 'cloud:owner-b:2';
      harness.ownerGeneration = 2;
      harness.ownerRoot = '/data/owners/owner-b';
      const ownerB = adapter.ensureGlobalCodexAssets();
      expect(runEnsureGlobalCodexAssets).toHaveBeenCalledTimes(1);

      finishOwnerA();
      await Promise.all([firstOwnerA, secondOwnerA]);
      await vi.waitFor(() => expect(runEnsureGlobalCodexAssets).toHaveBeenCalledTimes(2));
      expect(runEnsureGlobalCodexAssets).toHaveBeenLastCalledWith({
        ownerId: 'owner-b',
        ownerRoot: '/data/owners/owner-b',
        ownerScopeKey: 'cloud:owner-b:2',
      });

      finishOwnerB();
      await expect(ownerB).resolves.toEqual({ skillsProjectionEpoch: 0 });
    },
  );

  it('rejects a queued owner capture after a later Profile becomes active', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;
    const runEnsureGlobalCodexAssets = (
      DesktopCodexAuthAdapter.prototype as unknown as {
        runEnsureGlobalCodexAssets(owner: {
          ownerId: string;
          ownerRoot: string;
          ownerScopeKey: string;
        }): Promise<{ skillsProjectionEpoch: number }>;
      }
    ).runEnsureGlobalCodexAssets;

    const queuedOwnerB = {
      ownerId: 'owner-b',
      ownerRoot: '/data/owners/owner-b',
      ownerScopeKey: 'cloud:owner-b:2',
    };
    harness.ownerId = 'owner-c';
    harness.ownerScopeKey = 'cloud:owner-c:3';
    harness.ownerGeneration = 3;
    harness.ownerRoot = '/data/owners/owner-c';

    await expect(runEnsureGlobalCodexAssets.call(adapter, queuedOwnerB)).rejects.toThrow(
      'owner changed before projection publish',
    );
  });

  it('keeps per-cwd skills/list dirty sticky across projection epochs', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as {
      skillsProjectionEpoch: number;
      skillsListReloadedEpochByCwd: Map<string, number>;
      pendingAssetsPrep: unknown;
      ensureGlobalCodexAssets: () => Promise<{ skillsProjectionEpoch: number }>;
      codexSkillsListReloadEpoch: (workingDir?: string | null) => number | null;
      markCodexSkillsListCacheReloaded: (
        workingDir: string | null | undefined,
        reloadedEpoch: number,
      ) => void;
      codexSkillsListCacheKey: (workingDir?: string | null) => string;
      runEnsureGlobalCodexAssets: (owner: {
        ownerId: string | null;
        ownerRoot: string;
        ownerScopeKey: string;
      }) => Promise<{ skillsProjectionEpoch: number }>;
    };
    Object.defineProperties(adapter, {
      pendingAssetsPrep: { configurable: true, writable: true, value: null },
      skillsProjectionEpoch: { configurable: true, writable: true, value: 0 },
      skillsListReloadedEpochByCwd: {
        configurable: true,
        writable: true,
        value: new Map<string, number>(),
      },
      ensureGlobalCodexAssets: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.ensureGlobalCodexAssets,
      },
      codexSkillsListReloadEpoch: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.codexSkillsListReloadEpoch,
      },
      markCodexSkillsListCacheReloaded: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.markCodexSkillsListCacheReloaded,
      },
      codexSkillsListCacheKey: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.codexSkillsListCacheKey,
      },
      runEnsureGlobalCodexAssets: {
        configurable: true,
        value: async () => {
          adapter.skillsProjectionEpoch += 1;
          return { skillsProjectionEpoch: adapter.skillsProjectionEpoch };
        },
      },
    });

    await expect(adapter.ensureGlobalCodexAssets()).resolves.toEqual({ skillsProjectionEpoch: 1 });
    expect(adapter.codexSkillsListReloadEpoch('/repo-a')).toBe(1);
    expect(adapter.codexSkillsListReloadEpoch('/repo-b')).toBe(1);

    adapter.markCodexSkillsListCacheReloaded('/repo-a', 1);
    expect(adapter.codexSkillsListReloadEpoch('/repo-a')).toBeNull();
    expect(adapter.codexSkillsListReloadEpoch('/repo-b')).toBe(1);

    Object.defineProperty(adapter, 'runEnsureGlobalCodexAssets', {
      configurable: true,
      value: async () => ({ skillsProjectionEpoch: adapter.skillsProjectionEpoch }),
    });
    await expect(adapter.ensureGlobalCodexAssets()).resolves.toEqual({ skillsProjectionEpoch: 1 });
    expect(adapter.codexSkillsListReloadEpoch('/repo-a')).toBeNull();
    expect(adapter.codexSkillsListReloadEpoch('/repo-b')).toBe(1);

    adapter.markCodexSkillsListCacheReloaded('/repo-b', 1);
    expect(adapter.codexSkillsListReloadEpoch('/repo-b')).toBeNull();
    expect(adapter.codexSkillsListReloadEpoch(undefined)).toBe(1);
    expect(adapter.codexSkillsListCacheKey(undefined)).toBe(harness.homeDir);
  });

  it('marks only the projection epoch captured before forceReload', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as {
      skillsProjectionEpoch: number;
      skillsListReloadedEpochByCwd: Map<string, number>;
      codexSkillsListReloadEpoch: (workingDir?: string | null) => number | null;
      markCodexSkillsListCacheReloaded: (
        workingDir: string | null | undefined,
        reloadedEpoch: number,
      ) => void;
      codexSkillsListCacheKey: (workingDir?: string | null) => string;
    };
    Object.defineProperties(adapter, {
      skillsProjectionEpoch: { configurable: true, writable: true, value: 1 },
      skillsListReloadedEpochByCwd: {
        configurable: true,
        writable: true,
        value: new Map<string, number>(),
      },
      codexSkillsListReloadEpoch: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.codexSkillsListReloadEpoch,
      },
      markCodexSkillsListCacheReloaded: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.markCodexSkillsListCacheReloaded,
      },
      codexSkillsListCacheKey: {
        configurable: true,
        value: DesktopCodexAuthAdapter.prototype.codexSkillsListCacheKey,
      },
    });

    const requestedEpoch = adapter.codexSkillsListReloadEpoch('/repo');
    expect(requestedEpoch).toBe(1);

    adapter.skillsProjectionEpoch = 2;
    adapter.markCodexSkillsListCacheReloaded('/repo', requestedEpoch!);
    expect(adapter.codexSkillsListReloadEpoch('/repo')).toBe(2);

    adapter.markCodexSkillsListCacheReloaded('/repo', 2);
    adapter.markCodexSkillsListCacheReloaded('/repo', 1);
    expect(adapter.codexSkillsListReloadEpoch('/repo')).toBeNull();
  });
});
