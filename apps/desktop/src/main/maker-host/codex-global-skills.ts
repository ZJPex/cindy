import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp, type Dirent } from 'node:fs';

import {
  GHOST_INSTALL_MANIFEST_MAX_BYTES,
  GHOST_MANIFEST_FILE,
  GHOST_SKILL_MD_MAX_BYTES,
  validateGhostManifest,
} from '../../shared/ghost.js';

import { checkSkillMdConsistency } from '../cindy-brain/skillSlot.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';

import {
  ensureDirectoryLink,
  isDirectory,
  isSameOrInside,
  normalizeForCompare,
  realPathOrNull,
  removeManagedLink,
  type ManagedLinkStatus,
} from './managed-dir-links.js';

export const CODEX_LEGACY_CODEX_SKILLS_LINK_NAME = 'xdt-codex';
export const CODEX_SHARED_AGENTS_SKILLS_LINK_NAME = 'xdt-agents';

type SourceName = 'codex' | 'agents';
type LinkStatus = ManagedLinkStatus;

export interface CodexGlobalSkillSourceResult {
  name: SourceName;
  source: string;
  link: string;
  status: LinkStatus;
  reason?: string;
}

export interface CodexGlobalSkillsPrepareResult {
  codexHome: string;
  skillsDir: string;
  changed: boolean;
  sources: CodexGlobalSkillSourceResult[];
  warnings: string[];
}

interface PrepareOptions {
  homeDir?: string;
  /** 当前登录 owner 的私有数据根；缺省时对 Ghost Skill 采取 fail-closed。 */
  ownerRoot?: string;
}

interface ProjectionEntry {
  name: string;
  target: string;
}

const GHOST_DISABLED_MARKER_FILE = '.disabled';

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fsp.access(pathname);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function runtimeRepositoryRootForOwner(ownerRoot?: string): Promise<string | null> {
  if (!ownerRoot) return null;
  const activeRepositoryRoot = path.join(ownerRoot, 'cindy-brain');
  try {
    if (await pathExists(activeRepositoryRoot)) return activeRepositoryRoot;
    const legacyRepositoryRoot = path.join(ownerRoot, 'brain');
    return (await pathExists(legacyRepositoryRoot)) ? legacyRepositoryRoot : null;
  } catch {
    // 无法确定运行时仓库根时不能放行任何 Ghost Skill。
    return null;
  }
}

function ghostIdFromLinkName(linkName: string | undefined): string | null {
  if (!linkName) return null;
  const separator = linkName.lastIndexOf('--');
  return separator > 0 ? linkName.slice(0, separator).toLowerCase() : null;
}

function targetLooksGhostRepositoryManaged(target: string, linkName?: string): boolean {
  const segments = target.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const expectedGhostId = ghostIdFromLinkName(linkName);
  return segments.some((segment, index) => {
    if (segment !== 'cindy-brain' && segment !== 'brain') return false;
    // 仅目录名相同不能证明是 Cindy 插件安装根：普通用户 Skill 完全可能位于
    // /work/brain/<name>/...。插件安装根必须属于 owner 命名空间，避免把这类
    // 全局 Skill 误投影为 Ghost 后对所有 Profile 禁用。
    if (segments[index - 2] !== 'owners' || !segments[index - 1]) return false;
    const actualGhostId = segments[index + 1];
    return Boolean(actualGhostId) && (!expectedGhostId || actualGhostId === expectedGhostId);
  });
}

function targetLooksGhostManaged(target: string, linkName: string): boolean {
  // 与 skillSlot 使用同一归属思路：链接名提供 ghost id，目标只需落在
  // cindy-brain/<id> 或 legacy brain/<id> 下，不假设插件内部一定使用 skills/。
  return (
    ghostIdFromLinkName(linkName) !== null &&
    targetLooksGhostRepositoryManaged(target, linkName)
  );
}

function managedLinkNameFromSkillPath(skillPath: string): string | undefined {
  const segments = skillPath.split(/[\\/]/).filter(Boolean);
  const normalized = segments.map((segment) => segment.toLowerCase());

  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const isSharedAgentsBridge =
      normalized[index] === CODEX_SHARED_AGENTS_SKILLS_LINK_NAME.toLowerCase();
    const isNativeAgentsRoot =
      normalized[index] === 'skills' && normalized[index - 1] === '.agents';
    if (!isSharedAgentsBridge && !isNativeAgentsRoot) continue;

    const candidate = segments[index + 1];
    if (ghostIdFromLinkName(candidate) !== null) return candidate;
  }

  return undefined;
}

async function lexicalManagedLinkTarget(
  skillPath: string,
  linkName: string | undefined,
): Promise<string | null> {
  if (!linkName) return null;
  const linkPath = path.dirname(skillPath);
  if (path.basename(linkPath) !== linkName) return null;
  try {
    // realpath 会抹掉 relocated brainRoot 的受管目录段；readlink 保留宿主创建
    // 链接时的词法目标，供 `<id>--<name>` 与 cindy-brain/<id> 双重核验。
    const target = await fsp.readlink(linkPath);
    return normalizeForCompare(path.resolve(path.dirname(linkPath), target));
  } catch {
    return null;
  }
}

async function collectOwnerInstalledGhostSkills(ownerRoot?: string): Promise<ProjectionEntry[]> {
  const entries = new Map<string, ProjectionEntry>();
  // 与 Ghost 运行时的迁移结果保持一致：新旧目录并存时只认新目录；只有旧目录时
  // 继续兼容迁移失败后的 legacy 根，不能把两个安装清单合并成一个可见集合。
  const repositoryRoot = await runtimeRepositoryRootForOwner(ownerRoot);
  if (!repositoryRoot) return [];
  const repositoryRootReal = await fsp.realpath(repositoryRoot).catch(() => null);
  if (!repositoryRootReal) return [];
  const repositoryRootCompare = normalizeForCompare(repositoryRootReal);
  let ghostDirs: Dirent[];
  try {
    ghostDirs = await fsp.readdir(repositoryRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  for (const ghostEntry of ghostDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ghostEntry.isDirectory() || ghostEntry.name.startsWith('.')) continue;
    const ghostDir = path.join(repositoryRoot, ghostEntry.name);
    const manifestPath = path.join(ghostDir, GHOST_MANIFEST_FILE);
    try {
      if (await pathExists(path.join(ghostDir, GHOST_DISABLED_MARKER_FILE))) continue;
      const manifestBytes = await readBoundedFileNoFollow(
        manifestPath,
        GHOST_INSTALL_MANIFEST_MAX_BYTES,
        { containWithin: repositoryRootReal },
      );
      if (!manifestBytes) continue;
      const validation = validateGhostManifest(JSON.parse(manifestBytes.toString('utf8')));
      if (!validation.ok || validation.manifest.id !== ghostEntry.name) continue;
      const manifest = validation.manifest;
      if (!manifest.slots.includes('skill') || !manifest.skill) continue;

      for (const item of manifest.skill.items) {
        const targetPath = path.join(ghostDir, ...item.dir.split('/'));
        const target = await realPathOrNull(targetPath);
        if (
          !target ||
          !isSameOrInside(target, repositoryRootCompare) ||
          !(await isDirectory(targetPath))
        ) {
          continue;
        }
        const skillMdBytes = await readBoundedFileNoFollow(
          path.join(targetPath, 'SKILL.md'),
          GHOST_SKILL_MD_MAX_BYTES,
          { containWithin: repositoryRootReal },
        );
        if (!skillMdBytes || checkSkillMdConsistency(skillMdBytes.toString('utf8'), item)) {
          continue;
        }
        const name = `${manifest.id}--${item.name}`;
        if (!entries.has(name)) entries.set(name, { name, target });
      }
    } catch {
      // A damaged installed Ghost must not make the projection fail open.
      continue;
    }
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Codex 会绕过 CODEX_HOME，原生扫描用户主目录的 `.agents/skills`。根据它实际
 * 上报的 SKILL.md 路径再次核对 owner，返回必须在 thread 配置中禁用的外来 Ghost。
 */
export async function codexDisabledSkillPathsForOwner(
  skills: ReadonlyArray<{ path: string }>,
  ownerRoot?: string,
): Promise<string[]> {
  const allowedByLinkName = new Map<string, string>();
  const allowedTargets = new Set<string>();
  for (const entry of await collectOwnerInstalledGhostSkills(ownerRoot)) {
    const skillMdTarget = await realPathOrNull(path.join(entry.target, 'SKILL.md'));
    if (!skillMdTarget) continue;
    allowedByLinkName.set(entry.name, skillMdTarget);
    allowedTargets.add(skillMdTarget);
  }
  const disabled: string[] = [];

  for (const skill of skills) {
    const target = (await realPathOrNull(skill.path)) ?? normalizeForCompare(skill.path);
    const linkName = managedLinkNameFromSkillPath(skill.path);
    const lexicalTarget = await lexicalManagedLinkTarget(skill.path, linkName);
    if (
      !targetLooksGhostRepositoryManaged(target, linkName) &&
      !(lexicalTarget && targetLooksGhostRepositoryManaged(lexicalTarget, linkName))
    ) {
      continue;
    }
    const allowedTarget = linkName ? allowedByLinkName.get(linkName) : undefined;
    if (allowedTarget !== target && !(linkName === undefined && allowedTargets.has(target))) {
      disabled.push(skill.path);
    }
  }
  return disabled.sort();
}

/**
 * 全局普通 Skill 对所有 Profile 可见；Ghost Skill 只投影当前 owner 的目标。
 * owner 缺失时不猜测归属，直接排除全部 Ghost Skill。
 */
async function collectOwnerVisibleAgentSkills(
  sharedSkillsDir: string,
  ownerRoot?: string,
): Promise<ProjectionEntry[]> {
  const entries = await fsp.readdir(sharedSkillsDir, { withFileTypes: true });
  const visible = new Map<string, ProjectionEntry>();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(sharedSkillsDir, entry.name);
    const target = await realPathOrNull(sourcePath);
    if (!target || !(await isDirectory(sourcePath))) continue;

    const lexicalTarget = entry.isSymbolicLink()
      ? await lexicalManagedLinkTarget(path.join(sourcePath, 'SKILL.md'), entry.name)
      : null;
    const isGhostLink =
      entry.isSymbolicLink() &&
      (targetLooksGhostManaged(target, entry.name) ||
        Boolean(lexicalTarget && targetLooksGhostManaged(lexicalTarget, entry.name)));
    // 受管 Ghost 链接不能从共享根直接进入投影：它们必须在下方从当前运行时仓库根
    // 重新收集，并通过 manifest 与受限 SKILL.md 的一致性校验。
    if (isGhostLink) continue;
    visible.set(entry.name, { name: entry.name, target });
  }

  for (const ownerEntry of await collectOwnerInstalledGhostSkills(ownerRoot)) {
    // 共享根里的受管 Ghost 已在上方统一跳过；若仍有同名条目，它就是不应覆盖的
    // 普通用户目录或外来链接，继续遵守 skillSlot 的 no-clobber 规则。
    if (!visible.has(ownerEntry.name)) visible.set(ownerEntry.name, ownerEntry);
  }

  return [...visible.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function projectionSignature(entries: ProjectionEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries)
    hash.update(entry.name).update('\0').update(entry.target).update('\0');
  return hash.digest('hex').slice(0, 20);
}

async function ensureAgentsProjection(
  codexHome: string,
  sharedSkillsDir: string,
  ownerRoot?: string,
): Promise<string> {
  const entries = await collectOwnerVisibleAgentSkills(sharedSkillsDir, ownerRoot);
  const projectionRoot = path.join(codexHome, 'skill-projections');
  const projectionDir = path.join(projectionRoot, `agents-${projectionSignature(entries)}`);
  if (await isDirectory(projectionDir)) return projectionDir;

  // 内容寻址目录 + 临时目录 rename，避免 Codex 扫到只建了一半的投影。
  await fsp.mkdir(projectionRoot, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(projectionRoot, '.agents-'));
  try {
    for (const entry of entries) {
      const result = await ensureDirectoryLink(path.join(stagingDir, entry.name), entry.target);
      if (result.status !== 'linked' && result.status !== 'kept') {
        throw new Error(`cannot project ${entry.name}: ${result.reason ?? result.status}`);
      }
    }
    try {
      await fsp.rename(stagingDir, projectionDir);
    } catch (err) {
      if (!(await isDirectory(projectionDir))) throw err;
    }
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
  return projectionDir;
}

async function cleanupStaleAgentsProjections(codexHome: string, currentDir: string): Promise<void> {
  const projectionRoot = path.join(codexHome, 'skill-projections');
  let entries: string[];
  try {
    entries = await fsp.readdir(projectionRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const currentName = path.basename(currentDir);
  for (const entry of entries) {
    if (!entry.startsWith('agents-') || entry === currentName) continue;
    const entryPath = path.join(projectionRoot, entry);
    const stat = await fsp.lstat(entryPath).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      await fsp.rm(entryPath, { recursive: true, force: true });
    }
  }
}

async function cleanupLegacyAggregate(codexHome: string): Promise<void> {
  const legacyScanEntry = path.join(codexHome, 'skills', 'xdt-global');
  await removeManagedLink(legacyScanEntry);

  const legacyAggregateDir = path.join(codexHome, 'global_skills');
  let entries: string[];
  try {
    entries = await fsp.readdir(legacyAggregateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const removableNames = new Set(['codex', 'agents']);
  for (const entry of entries) {
    if (!removableNames.has(entry)) return;
    const entryPath = path.join(legacyAggregateDir, entry);
    try {
      const stat = await fsp.lstat(entryPath);
      if (!stat.isSymbolicLink()) return;
    } catch {
      return;
    }
  }

  for (const entry of entries) {
    await fsp.rm(path.join(legacyAggregateDir, entry), { recursive: true, force: true });
  }
  await fsp.rmdir(legacyAggregateDir).catch(() => undefined);
}

export function codexGlobalSkillsPaths(codexHome: string, homeDir = os.homedir()) {
  const skillsDir = path.join(codexHome, 'skills');
  return {
    codexHome,
    skillsDir,
    legacyCodexSkillsLink: path.join(skillsDir, CODEX_LEGACY_CODEX_SKILLS_LINK_NAME),
    sharedAgentsSkillsLink: path.join(skillsDir, CODEX_SHARED_AGENTS_SKILLS_LINK_NAME),
    legacyCodexSkillsDir: path.join(homeDir, '.codex', 'skills'),
    sharedAgentsSkillsDir: path.join(homeDir, '.agents', 'skills'),
  };
}

export async function prepareCodexGlobalSkillsLinks(
  codexHome: string,
  opts: PrepareOptions = {},
): Promise<CodexGlobalSkillsPrepareResult> {
  const paths = codexGlobalSkillsPaths(codexHome, opts.homeDir);
  await fsp.mkdir(paths.codexHome, { recursive: true });
  await fsp.mkdir(paths.skillsDir, { recursive: true });

  const warnings: string[] = [];
  let changed = false;
  await cleanupLegacyAggregate(paths.codexHome);

  const skillsDirReal = await realPathOrNull(paths.skillsDir);
  const sourceDefs: Array<{ name: SourceName; source: string; link: string }> = [
    { name: 'codex', source: paths.legacyCodexSkillsDir, link: paths.legacyCodexSkillsLink },
    { name: 'agents', source: paths.sharedAgentsSkillsDir, link: paths.sharedAgentsSkillsLink },
  ];

  const sources: CodexGlobalSkillSourceResult[] = [];
  for (const sourceDef of sourceDefs) {
    if (!(await isDirectory(sourceDef.source))) {
      changed = (await removeManagedLink(sourceDef.link)) || changed;
      sources.push({ ...sourceDef, status: 'missing', reason: 'source directory does not exist' });
      continue;
    }

    const sourceReal = await realPathOrNull(sourceDef.source);
    if (sourceReal && skillsDirReal && isSameOrInside(sourceReal, skillsDirReal)) {
      sources.push({ ...sourceDef, status: 'skipped', reason: 'source would create a scan cycle' });
      continue;
    }

    let linkTarget = sourceDef.source;
    if (sourceDef.name === 'agents') {
      try {
        linkTarget = await ensureAgentsProjection(
          paths.codexHome,
          sourceDef.source,
          opts.ownerRoot,
        );
      } catch (err) {
        changed = (await removeManagedLink(sourceDef.link)) || changed;
        const reason = `cannot build owner-filtered projection: ${(err as Error).message}`;
        sources.push({ ...sourceDef, status: 'error', reason });
        warnings.push(`cannot link Codex agents skills from ${sourceDef.source}: ${reason}`);
        continue;
      }
    }

    const result = await ensureDirectoryLink(sourceDef.link, linkTarget);
    changed = changed || result.changed;
    sources.push({ ...sourceDef, status: result.status, reason: result.reason });
    if (result.status === 'conflict' || result.status === 'error') {
      warnings.push(
        `cannot link Codex ${sourceDef.name} skills from ${sourceDef.source}: ${result.reason ?? result.status}`,
      );
    }
    if (sourceDef.name === 'agents' && (result.status === 'linked' || result.status === 'kept')) {
      await cleanupStaleAgentsProjections(paths.codexHome, linkTarget).catch((err: Error) => {
        warnings.push(`cannot clean stale Codex agents projections: ${err.message}`);
      });
    }
  }

  return {
    codexHome: paths.codexHome,
    skillsDir: paths.skillsDir,
    changed,
    sources,
    warnings,
  };
}
