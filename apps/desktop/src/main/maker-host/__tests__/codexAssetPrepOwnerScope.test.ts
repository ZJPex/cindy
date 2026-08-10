import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  ownerScopeKey: 'cloud:owner-a:1',
  ownerRoot: '/data/owners/owner-a',
  userDataDir: '/tmp/cindy-codex-assets-owner-scope',
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
        .fn<(ownerRoot: string) => Promise<void>>()
        .mockReturnValueOnce(ownerARun)
        .mockReturnValueOnce(ownerBRun);
      Object.defineProperties(adapter, {
        pendingAssetsPrep: { configurable: true, writable: true, value: null },
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
      await expect(ownerB).resolves.toBeUndefined();
    },
  );
});
