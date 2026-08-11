import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  ownerScopeKey: 'cloud:owner-a:1',
  ownerRoot: '/data/owners/owner-a',
  userDataDir: '/tmp/cindy-codex-assets-owner-scope',
  homeDir: '/home/test-user',
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
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: harness.ownerScopeKey }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => harness.ownerRoot,
}));

describe('DesktopCodexAuthAdapter asset preparation single-flight', () => {
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
        .fn<(ownerRoot: string) => Promise<{ skillsProjectionEpoch: number }>>()
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
      expect(runEnsureGlobalCodexAssets).toHaveBeenLastCalledWith('/data/owners/owner-a');

      harness.ownerScopeKey = 'cloud:owner-b:2';
      harness.ownerRoot = '/data/owners/owner-b';
      const ownerB = adapter.ensureGlobalCodexAssets();
      expect(runEnsureGlobalCodexAssets).toHaveBeenCalledTimes(1);

      finishOwnerA();
      await Promise.all([firstOwnerA, secondOwnerA]);
      await vi.waitFor(() => expect(runEnsureGlobalCodexAssets).toHaveBeenCalledTimes(2));
      expect(runEnsureGlobalCodexAssets).toHaveBeenLastCalledWith('/data/owners/owner-b');

      finishOwnerB();
      await expect(ownerB).resolves.toEqual({ skillsProjectionEpoch: 0 });
    },
  );

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
      runEnsureGlobalCodexAssets: (ownerRoot: string) => Promise<{ skillsProjectionEpoch: number }>;
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
