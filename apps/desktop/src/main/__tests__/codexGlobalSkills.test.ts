import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_LEGACY_CODEX_SKILLS_LINK_NAME,
  CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
  codexDisabledSkillPathsForOwner,
  codexGlobalSkillsPaths,
  prepareCodexGlobalSkillsLinks,
} from '../maker-host/codex-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
}

async function writeInstalledGhostSkill(
  ownerRoot: string,
  ghostId: string,
  item: { dir: string; name: string },
  repositoryName: 'cindy-brain' | 'brain' = 'cindy-brain',
): Promise<string> {
  const ghostDir = path.join(ownerRoot, repositoryName, ghostId);
  const skillDir = path.join(ghostDir, ...item.dir.split('/'));
  await writeSkill(path.dirname(skillDir), path.basename(skillDir));
  await fs.writeFile(
    path.join(ghostDir, 'ghost.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: ghostId,
      name: ghostId,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['skill'],
      skill: {
        items: [{ ...item, description: 'test skill' }],
      },
    }),
    'utf8',
  );
  return skillDir;
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

async function linkDirectory(target: string, link: string): Promise<void> {
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalSkillsLinks', () => {
  it('disables foreign Ghost paths reported through Codex native global discovery', async () => {
    const root = await makeTmpDir();
    const agentsSkills = path.join(root, 'home', '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const ownerASkill = path.join(ownerARoot, 'cindy-brain', 'ghost-a', 'skills', 'profile-a');
    const ownerBSkill = await writeInstalledGhostSkill(ownerBRoot, 'ghost-b', {
      dir: 'skills/profile-b',
      name: 'profile-b',
    });
    const ownerALegacySkill = path.join(ownerARoot, 'brain', 'ghost-old', 'skills', 'legacy-a');
    const ownerANonstandardSkill = path.join(
      ownerARoot,
      'cindy-brain',
      'ghost-custom',
      'agent-skills',
      'custom-a',
    );
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');
    const ownerALegacyLink = path.join(agentsSkills, 'ghost-old--legacy-a');
    const ownerANonstandardLink = path.join(agentsSkills, 'ghost-custom--custom-a');
    const globalSkill = path.join(agentsSkills, 'humanizer-zh');

    await writeSkill(path.dirname(ownerASkill), path.basename(ownerASkill));
    await writeSkill(path.dirname(ownerALegacySkill), path.basename(ownerALegacySkill));
    await writeSkill(path.dirname(ownerANonstandardSkill), path.basename(ownerANonstandardSkill));
    await writeSkill(agentsSkills, 'humanizer-zh');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);
    await linkDirectory(ownerALegacySkill, ownerALegacyLink);
    await linkDirectory(ownerANonstandardSkill, ownerANonstandardLink);

    const reportedSkills = [
      { path: path.join(ownerALink, 'SKILL.md') },
      { path: path.join(ownerBLink, 'SKILL.md') },
      { path: path.join(ownerALegacyLink, 'SKILL.md') },
      { path: path.join(ownerANonstandardLink, 'SKILL.md') },
      { path: path.join(globalSkill, 'SKILL.md') },
    ];
    await expect(codexDisabledSkillPathsForOwner(reportedSkills, ownerBRoot)).resolves.toEqual(
      [ownerALink, ownerALegacyLink, ownerANonstandardLink]
        .map((link) => path.join(link, 'SKILL.md'))
        .sort(),
    );
    await expect(codexDisabledSkillPathsForOwner(reportedSkills)).resolves.toEqual(
      [ownerALink, ownerALegacyLink, ownerANonstandardLink, ownerBLink]
        .map((link) => path.join(link, 'SKILL.md'))
        .sort(),
    );
  });

  it('keeps ordinary global Skills whose paths merely contain a brain segment', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const ownerASkill = await writeInstalledGhostSkill(ownerARoot, 'ghost-a', {
      dir: 'skills/profile-a',
      name: 'profile-a',
    });
    const ordinarySkill = path.join(root, 'work', 'brain', 'acme', 'deploy');
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ordinaryLink = path.join(agentsSkills, 'acme--deploy');
    await writeSkill(path.dirname(ordinarySkill), path.basename(ordinarySkill));
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ordinarySkill, ordinaryLink);

    const reportedSkills = [ownerALink, ordinaryLink].map((link) => ({
      path: path.join(link, 'SKILL.md'),
    }));
    await expect(codexDisabledSkillPathsForOwner(reportedSkills, ownerBRoot)).resolves.toEqual([
      path.join(ownerALink, 'SKILL.md'),
    ]);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
    });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    expect(result.warnings).toEqual([]);
    expect(
      await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'acme--deploy'), ordinarySkill),
    ).toBe(true);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'ghost-a--profile-a')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps owner isolation when Ghost repository roots are relocated links', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const ownerARepository = path.join(root, 'relocated', 'owner-a-repository');
    const ownerBRepository = path.join(root, 'relocated', 'owner-b-repository');
    await fs.mkdir(ownerARepository, { recursive: true });
    await fs.mkdir(ownerBRepository, { recursive: true });
    await linkDirectory(ownerARepository, path.join(ownerARoot, 'cindy-brain'));
    await linkDirectory(ownerBRepository, path.join(ownerBRoot, 'cindy-brain'));

    const ownerASkill = await writeInstalledGhostSkill(ownerARoot, 'ghost-a', {
      dir: 'agent-skills/profile-a',
      name: 'profile-a',
    });
    const ownerBSkill = await writeInstalledGhostSkill(ownerBRoot, 'ghost-b', {
      dir: 'agent-skills/profile-b',
      name: 'profile-b',
    });
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');
    await writeSkill(agentsSkills, 'humanizer-zh');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
    });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'ghost-a--profile-a')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'ghost-b--profile-b'),
        ownerBSkill,
      ),
    ).toBe(true);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'humanizer-zh'),
        path.join(agentsSkills, 'humanizer-zh'),
      ),
    ).toBe(true);

    await expect(
      codexDisabledSkillPathsForOwner(
        [ownerALink, ownerBLink].map((link) => ({ path: path.join(link, 'SKILL.md') })),
        ownerBRoot,
      ),
    ).resolves.toEqual([path.join(ownerALink, 'SKILL.md')]);
  });

  it('ignores unrelated ancestor directories containing a managed-link separator', async () => {
    const root = await makeTmpDir();
    const misleadingHome = path.join(root, 'home--not-a-ghost-link');
    const agentsSkills = path.join(misleadingHome, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const ownerASkill = path.join(
      ownerARoot,
      'cindy-brain',
      'ghost-a',
      'agent-skills',
      'profile-a',
    );
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const projectedOwnerALink = path.join(
      misleadingHome,
      'codex-home',
      'skills',
      CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
      'ghost-a--profile-a',
    );
    await writeSkill(path.dirname(ownerASkill), path.basename(ownerASkill));
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerASkill, projectedOwnerALink);

    await expect(
      codexDisabledSkillPathsForOwner(
        [ownerALink, projectedOwnerALink].map((link) => ({
          path: path.join(link, 'SKILL.md'),
        })),
        ownerBRoot,
      ),
    ).resolves.toEqual(
      [ownerALink, projectedOwnerALink].map((link) => path.join(link, 'SKILL.md')).sort(),
    );
  });

  it('only allows Ghost paths from the runtime-selected repository root', async () => {
    const root = await makeTmpDir();
    const agentsSkills = path.join(root, 'home', '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const activeSkill = await writeInstalledGhostSkill(ownerRoot, 'active-ghost', {
      dir: 'skills/active',
      name: 'active',
    });
    const legacySkill = await writeInstalledGhostSkill(
      ownerRoot,
      'legacy-ghost',
      { dir: 'skills/legacy', name: 'legacy' },
      'brain',
    );
    const activeLink = path.join(agentsSkills, 'active-ghost--active');
    const legacyLink = path.join(agentsSkills, 'legacy-ghost--legacy');

    await linkDirectory(activeSkill, activeLink);
    await linkDirectory(legacySkill, legacyLink);

    await expect(
      codexDisabledSkillPathsForOwner(
        [activeLink, legacyLink].map((link) => ({ path: path.join(link, 'SKILL.md') })),
        ownerRoot,
      ),
    ).resolves.toEqual([path.join(legacyLink, 'SKILL.md')]);

    const legacyOnlyOwnerRoot = path.join(root, 'legacy-only-user-data', 'owners', 'owner-b');
    const legacyOnlySkill = await writeInstalledGhostSkill(
      legacyOnlyOwnerRoot,
      'legacy-only-ghost',
      { dir: 'skills/legacy-only', name: 'legacy-only' },
      'brain',
    );
    const legacyOnlyLink = path.join(agentsSkills, 'legacy-only-ghost--legacy-only');
    await linkDirectory(legacyOnlySkill, legacyOnlyLink);

    await expect(
      codexDisabledSkillPathsForOwner(
        [{ path: path.join(legacyOnlyLink, 'SKILL.md') }],
        legacyOnlyOwnerRoot,
      ),
    ).resolves.toEqual([]);
  });

  it('upgrades the legacy shared-root bridge to an owner-filtered projection', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const ownerASkill = await writeInstalledGhostSkill(ownerARoot, 'ghost-a', {
      dir: 'skills/profile-a',
      name: 'profile-a',
    });
    const ownerBSkill = await writeInstalledGhostSkill(ownerBRoot, 'ghost-b', {
      dir: 'skills/profile-b',
      name: 'profile-b',
    });
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');

    await writeSkill(agentsSkills, 'user-global');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await linkDirectory(agentsSkills, paths.sharedAgentsSkillsLink);

    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerARoot,
    });

    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(paths.sharedAgentsSkillsLink, agentsSkills)).toBe(false);
    expect(await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'user-global'), path.join(agentsSkills, 'user-global'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'ghost-a--profile-a'), ownerASkill)).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'ghost-b--profile-b'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(ownerALink, ownerASkill)).toBe(true);
    expect(await sameRealPath(ownerBLink, ownerBSkill)).toBe(true);
  });

  it('rebuilds the projection on owner switch without deleting either owner source', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const ownerASkill = await writeInstalledGhostSkill(ownerARoot, 'ghost-a', {
      dir: 'skills/profile-a',
      name: 'profile-a',
    });
    const ownerBSkill = await writeInstalledGhostSkill(ownerBRoot, 'ghost-b', {
      dir: 'skills/profile-b',
      name: 'profile-b',
    });
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');

    await writeSkill(agentsSkills, 'user-global');
    await linkDirectory(ownerASkill, ownerALink);
    await linkDirectory(ownerBSkill, ownerBLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot: ownerARoot });
    const projectionA = await fs.realpath(paths.sharedAgentsSkillsLink);
    expect(await sameRealPath(path.join(projectionA, 'ghost-a--profile-a'), ownerASkill)).toBe(true);

    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot: ownerBRoot });
    const projectionB = await fs.realpath(paths.sharedAgentsSkillsLink);
    expect(projectionB).not.toBe(projectionA);
    await expect(fs.lstat(path.join(projectionB, 'ghost-a--profile-a'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(path.join(projectionB, 'ghost-b--profile-b'), ownerBSkill)).toBe(true);
    await expect(fs.lstat(projectionA)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(ownerALink, ownerASkill)).toBe(true);
    expect(await sameRealPath(ownerBLink, ownerBSkill)).toBe(true);

    const repeated = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot: ownerBRoot });
    expect(repeated.changed).toBe(false);
  });

  it('rebuilds the projection when the owner gains a newly installed Ghost Skill', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-b');
    const firstItem = { dir: 'agent-skills/first', name: 'first' };
    const secondItem = { dir: 'agent-skills/second', name: 'second' };
    const ghostDir = path.join(ownerRoot, 'cindy-brain', 'same-ghost');
    const firstSkill = await writeInstalledGhostSkill(ownerRoot, 'same-ghost', firstItem);
    await writeSkill(agentsSkills, 'user-global');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const initial = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });
    expect(initial.warnings).toEqual([]);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'same-ghost--first'),
        firstSkill,
      ),
    ).toBe(true);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'same-ghost--second')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const secondSkill = path.join(ghostDir, ...secondItem.dir.split('/'));
    await writeSkill(path.dirname(secondSkill), path.basename(secondSkill));
    await fs.writeFile(
      path.join(ghostDir, 'ghost.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'same-ghost',
        name: 'same-ghost',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        slots: ['skill'],
        skill: {
          items: [
            { ...firstItem, description: 'test skill' },
            { ...secondItem, description: 'test skill' },
          ],
        },
      }),
      'utf8',
    );

    const refreshed = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });
    expect(refreshed.warnings).toEqual([]);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'same-ghost--second'),
        secondSkill,
      ),
    ).toBe(true);
  });

  it('projects the current owner copy when another Profile occupies the shared link name', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const item = { dir: 'agent-skills/shared', name: 'shared' };
    const ownerASkill = await writeInstalledGhostSkill(ownerARoot, 'same-ghost', item);
    const ownerBSkill = await writeInstalledGhostSkill(ownerBRoot, 'same-ghost', item);
    const sharedLink = path.join(agentsSkills, 'same-ghost--shared');
    await linkDirectory(ownerASkill, sharedLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      ownerRoot: ownerBRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(sharedLink, ownerASkill)).toBe(true);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'same-ghost--shared'),
        ownerBSkill,
      ),
    ).toBe(true);
  });

  it('does not project installed Ghost Skills with untrusted or inconsistent SKILL.md', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const inconsistentItem = { dir: 'agent-skills/inconsistent', name: 'inconsistent' };
    const oversizedItem = { dir: 'agent-skills/oversized', name: 'oversized' };
    const inconsistentSkill = await writeInstalledGhostSkill(
      ownerRoot,
      'inconsistent-ghost',
      inconsistentItem,
    );
    const oversizedSkill = await writeInstalledGhostSkill(
      ownerRoot,
      'oversized-ghost',
      oversizedItem,
    );
    await fs.writeFile(
      path.join(inconsistentSkill, 'SKILL.md'),
      '---\nname: tampered\ndescription: test skill\n---\n\nbody\n',
      'utf8',
    );
    await fs.appendFile(path.join(oversizedSkill, 'SKILL.md'), 'x'.repeat(64 * 1024), 'utf8');
    const inconsistentLink = path.join(agentsSkills, 'inconsistent-ghost--inconsistent');
    const oversizedLink = path.join(agentsSkills, 'oversized-ghost--oversized');
    await linkDirectory(inconsistentSkill, inconsistentLink);
    await linkDirectory(oversizedSkill, oversizedLink);

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });

    expect(result.warnings).toEqual([]);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'inconsistent-ghost--inconsistent')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'oversized-ghost--oversized')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(inconsistentLink, inconsistentSkill)).toBe(true);
    expect(await sameRealPath(oversizedLink, oversizedSkill)).toBe(true);
    await expect(
      codexDisabledSkillPathsForOwner(
        [inconsistentLink, oversizedLink].map((link) => ({
          path: path.join(link, 'SKILL.md'),
        })),
        ownerRoot,
      ),
    ).resolves.toEqual(
      [inconsistentLink, oversizedLink].map((link) => path.join(link, 'SKILL.md')).sort(),
    );
  });

  it('uses only cindy-brain when the active and legacy install roots coexist', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const activeItem = { dir: 'agent-skills/active', name: 'active' };
    const legacyItem = { dir: 'agent-skills/legacy', name: 'legacy' };
    const activeSkill = await writeInstalledGhostSkill(ownerRoot, 'active-ghost', activeItem);
    await writeInstalledGhostSkill(ownerRoot, 'legacy-ghost', legacyItem, 'brain');
    await writeSkill(agentsSkills, 'user-global');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });

    expect(result.warnings).toEqual([]);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'active-ghost--active'),
        activeSkill,
      ),
    ).toBe(true);
    await expect(
      fs.lstat(path.join(paths.sharedAgentsSkillsLink, 'legacy-ghost--legacy')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps legacy-only installed Ghost Skills available before root migration succeeds', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerRoot = path.join(root, 'user-data', 'owners', 'owner-a');
    const item = { dir: 'agent-skills/legacy', name: 'legacy' };
    const legacySkill = await writeInstalledGhostSkill(ownerRoot, 'legacy-ghost', item, 'brain');
    await writeSkill(agentsSkills, 'user-global');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir, ownerRoot });

    expect(result.warnings).toEqual([]);
    expect(
      await sameRealPath(
        path.join(paths.sharedAgentsSkillsLink, 'legacy-ghost--legacy'),
        legacySkill,
      ),
    ).toBe(true);
  });

  it('links legacy Codex skills and projects shared agent skills under custom CODEX_HOME', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');
    await writeSkill(agentsSkills, 'shared-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(path.basename(paths.legacyCodexSkillsLink)).toBe(CODEX_LEGACY_CODEX_SKILLS_LINK_NAME);
    expect(path.basename(paths.sharedAgentsSkillsLink)).toBe(CODEX_SHARED_AGENTS_SKILLS_LINK_NAME);
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(await sameRealPath(paths.sharedAgentsSkillsLink, agentsSkills)).toBe(false);
    expect(await sameRealPath(path.join(paths.sharedAgentsSkillsLink, 'shared-skill'), path.join(agentsSkills, 'shared-skill'))).toBe(true);
  });

  it('skips missing source roots without failing the scan-entry setup', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(result.sources.find((source) => source.name === 'codex')?.status).toMatch(/linked|kept/);
    expect(result.sources.find((source) => source.name === 'agents')?.status).toBe('missing');
  });

  it('removes a stale managed link when its source root disappears', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);

    await fs.rm(legacySkills, { recursive: true, force: true });
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('missing');
    await expect(fs.lstat(paths.legacyCodexSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a non-managed directory at a source link path', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const conflictingDir = paths.legacyCodexSkillsLink;
    await fs.mkdir(conflictingDir, { recursive: true });
    await fs.writeFile(path.join(conflictingDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('conflict');
    await expect(fs.readFile(path.join(conflictingDir, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(result.warnings.some((warning) => warning.includes('cannot link Codex codex skills'))).toBe(true);
  });

  it('removes the old aggregate scan link without deleting non-managed files', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const oldAggregateDir = path.join(codexHome, 'global_skills');
    const oldScanEntry = path.join(codexHome, 'skills', 'xdt-global');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    await fs.mkdir(oldAggregateDir, { recursive: true });
    await fs.symlink(oldAggregateDir, oldScanEntry, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(oldAggregateDir, 'keep.txt'), 'do not remove', 'utf8');

    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    await expect(fs.lstat(oldScanEntry)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(oldAggregateDir, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
  });
});
