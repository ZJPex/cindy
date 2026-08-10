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
): Promise<string> {
  const ghostDir = path.join(ownerRoot, 'cindy-brain', ghostId);
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
    const ownerBSkill = path.join(ownerBRoot, 'cindy-brain', 'ghost-b', 'skills', 'profile-b');
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
    await writeSkill(path.dirname(ownerBSkill), path.basename(ownerBSkill));
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

  it('upgrades the legacy shared-root bridge to an owner-filtered projection', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    const ownerARoot = path.join(root, 'user-data-a', 'owners', 'owner-a');
    const ownerBRoot = path.join(root, 'user-data-b', 'owners', 'owner-b');
    const ownerASkill = path.join(ownerARoot, 'cindy-brain', 'ghost-a', 'skills', 'profile-a');
    const ownerBSkill = path.join(ownerBRoot, 'cindy-brain', 'ghost-b', 'skills', 'profile-b');
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');

    await writeSkill(agentsSkills, 'user-global');
    await writeSkill(path.dirname(ownerASkill), path.basename(ownerASkill));
    await writeSkill(path.dirname(ownerBSkill), path.basename(ownerBSkill));
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
    const ownerASkill = path.join(ownerARoot, 'cindy-brain', 'ghost-a', 'skills', 'profile-a');
    const ownerBSkill = path.join(ownerBRoot, 'cindy-brain', 'ghost-b', 'skills', 'profile-b');
    const ownerALink = path.join(agentsSkills, 'ghost-a--profile-a');
    const ownerBLink = path.join(agentsSkills, 'ghost-b--profile-b');

    await writeSkill(agentsSkills, 'user-global');
    await writeSkill(path.dirname(ownerASkill), path.basename(ownerASkill));
    await writeSkill(path.dirname(ownerBSkill), path.basename(ownerBSkill));
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
