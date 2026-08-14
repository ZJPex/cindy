import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

import { GHOST_SKILL_MD_MAX_BYTES, type InstalledGhost } from '../../shared/ghost.js';

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

export interface CodexApprovedGhostSkillSource {
  ghosts: readonly InstalledGhost[];
  validateApprovedSkillSnapshot: (ghost: InstalledGhost) => Promise<boolean>;
}

interface OwnerGhostOptions {
  homeDir?: string;
  /** 当前登录 owner 的私有数据根；缺省时对 Ghost Skill 采取 fail-closed。 */
  ownerRoot?: string;
  /** 仅接受 GhostManager 从 receipt 投影出的批准快照，不读取可变安装目录。 */
  approvedGhostSkills?: CodexApprovedGhostSkillSource;
  /** owner 可能在异步文件操作期间切换；每个发布边界前都必须重新核对。 */
  assertOwnerStable?: () => void;
}

type PrepareOptions = OwnerGhostOptions;

interface ProjectionEntry {
  name: string;
  target: string;
}

function ghostIdFromLinkName(linkName: string | undefined): string | null {
  if (!linkName) return null;
  const separator = linkName.lastIndexOf('--');
  return separator > 0 ? linkName.slice(0, separator).toLowerCase() : null;
}

function sharedLegacyGhostRootsForOwnerRoot(ownerRoot: string | undefined): string[] {
  if (!ownerRoot) return [];
  const normalizedOwnerRoot = normalizeForCompare(ownerRoot);
  const ownersRoot = path.dirname(normalizedOwnerRoot);
  if (path.basename(ownersRoot).toLowerCase() !== 'owners') return [];
  const userDataRoot = path.dirname(ownersRoot);
  return ['cindy-brain', 'brain'].map((name) => normalizeForCompare(path.join(userDataRoot, name)));
}

function targetLooksSharedLegacyGhostManaged(
  target: string,
  linkName: string | undefined,
  sharedLegacyGhostRoots: readonly string[],
): boolean {
  const normalizedTarget = normalizeForCompare(target);
  const expectedGhostId = ghostIdFromLinkName(linkName);
  return sharedLegacyGhostRoots.some((legacyRoot) => {
    if (!isSameOrInside(normalizedTarget, legacyRoot)) return false;
    const actualGhostId = path
      .relative(legacyRoot, normalizedTarget)
      .split(path.sep)[0]
      ?.toLowerCase();
    return Boolean(actualGhostId) && (!expectedGhostId || actualGhostId === expectedGhostId);
  });
}

function targetLooksGhostRepositoryManaged(
  target: string,
  linkName?: string,
  sharedLegacyGhostRoots: readonly string[] = [],
): boolean {
  const segments = target.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const expectedGhostId = ghostIdFromLinkName(linkName);
  const ownerScopedOrApproved = segments.some((segment, index) => {
    // owner-scoped 旧安装目录只用于识别并隔离遗留链接，绝不再作为允许列表来源。
    if (segment === 'cindy-brain' || segment === 'brain') {
      if (segments[index - 2] !== 'owners' || !segments[index - 1]) return false;
      const actualGhostId = segments[index + 1];
      return Boolean(actualGhostId) && (!expectedGhostId || actualGhostId === expectedGhostId);
    }
    // 当前受管链接指向 receipt-backed 批准快照：
    // owners/<owner>/ghost-install-state/skill-snapshots/<id>/<revision>/...
    if (segment !== 'ghost-install-state') return false;
    if (segments[index - 2] !== 'owners' || !segments[index - 1]) return false;
    if (segments[index + 1] !== 'skill-snapshots') return false;
    const actualGhostId = segments[index + 2];
    const revision = segments[index + 3];
    return (
      Boolean(actualGhostId) &&
      Boolean(revision) &&
      (!expectedGhostId || actualGhostId === expectedGhostId)
    );
  });
  return (
    ownerScopedOrApproved ||
    targetLooksSharedLegacyGhostManaged(target, linkName, sharedLegacyGhostRoots)
  );
}

function targetLooksGhostManaged(
  target: string,
  linkName: string,
  sharedLegacyGhostRoots: readonly string[],
): boolean {
  // 与 skillSlot 使用同一归属思路：链接名提供 ghost id，目标只需落在
  // cindy-brain/<id> 或 legacy brain/<id> 下，不假设插件内部一定使用 skills/。
  return (
    ghostIdFromLinkName(linkName) !== null &&
    targetLooksGhostRepositoryManaged(target, linkName, sharedLegacyGhostRoots)
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

async function collectOwnerApprovedGhostSkills(
  opts: OwnerGhostOptions,
): Promise<ProjectionEntry[]> {
  const entries = new Map<string, ProjectionEntry>();
  const source = opts.approvedGhostSkills;
  if (!opts.ownerRoot || !source) return [];
  opts.assertOwnerStable?.();
  const ownerRootReal = await fsp.realpath(opts.ownerRoot).catch(() => null);
  opts.assertOwnerStable?.();
  if (!ownerRootReal) return [];
  const ownerRootCompare = normalizeForCompare(ownerRootReal);

  const ghosts = [...source.ghosts].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  for (const ghost of ghosts) {
    if (
      !ghost.enabled ||
      ghost.approval.state !== 'approved' ||
      !ghost.approvedSkillRoot ||
      !ghost.manifest.slots.includes('skill') ||
      !ghost.manifest.skill
    ) {
      continue;
    }
    try {
      opts.assertOwnerStable?.();
      if (!(await source.validateApprovedSkillSnapshot(ghost))) continue;
      opts.assertOwnerStable?.();

      const snapshotRoot = await fsp.realpath(ghost.approvedSkillRoot).catch(() => null);
      if (!snapshotRoot || !isSameOrInside(normalizeForCompare(snapshotRoot), ownerRootCompare)) {
        continue;
      }
      const snapshotRootCompare = normalizeForCompare(snapshotRoot);
      for (const item of ghost.manifest.skill.items) {
        const targetPath = path.join(ghost.approvedSkillRoot, ...item.dir.split('/'));
        const target = await realPathOrNull(targetPath);
        if (
          !target ||
          !isSameOrInside(target, snapshotRootCompare) ||
          !(await isDirectory(targetPath))
        ) {
          continue;
        }
        const skillMdBytes = await readBoundedFileNoFollow(
          path.join(targetPath, 'SKILL.md'),
          GHOST_SKILL_MD_MAX_BYTES,
          { containWithin: snapshotRoot },
        );
        if (!skillMdBytes || checkSkillMdConsistency(skillMdBytes.toString('utf8'), item)) {
          continue;
        }
        const name = `${ghost.manifest.id}--${item.name}`;
        if (!entries.has(name)) entries.set(name, { name, target });
      }
    } catch {
      // 批准快照缺失、校验失败或 owner 切换都不能退回可变安装目录。
      opts.assertOwnerStable?.();
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
  opts: OwnerGhostOptions = {},
): Promise<string[]> {
  opts.assertOwnerStable?.();
  const sharedLegacyGhostRoots = sharedLegacyGhostRootsForOwnerRoot(opts.ownerRoot);
  const allowedByLinkName = new Map<string, string>();
  const allowedTargets = new Set<string>();
  for (const entry of await collectOwnerApprovedGhostSkills(opts)) {
    const skillMdTarget = await realPathOrNull(path.join(entry.target, 'SKILL.md'));
    opts.assertOwnerStable?.();
    if (!skillMdTarget) continue;
    allowedByLinkName.set(entry.name, skillMdTarget);
    allowedTargets.add(skillMdTarget);
  }
  const disabled: string[] = [];

  for (const skill of skills) {
    opts.assertOwnerStable?.();
    const target = (await realPathOrNull(skill.path)) ?? normalizeForCompare(skill.path);
    const linkName = managedLinkNameFromSkillPath(skill.path);
    const lexicalTarget = await lexicalManagedLinkTarget(skill.path, linkName);
    opts.assertOwnerStable?.();
    if (
      !targetLooksGhostRepositoryManaged(target, linkName, sharedLegacyGhostRoots) &&
      !(
        lexicalTarget &&
        targetLooksGhostRepositoryManaged(lexicalTarget, linkName, sharedLegacyGhostRoots)
      )
    ) {
      continue;
    }
    const allowedTarget = linkName ? allowedByLinkName.get(linkName) : undefined;
    if (allowedTarget !== target && !(linkName === undefined && allowedTargets.has(target))) {
      disabled.push(skill.path);
    }
  }
  opts.assertOwnerStable?.();
  return disabled.sort();
}

/**
 * 全局普通 Skill 对所有 Profile 可见；Ghost Skill 只投影当前 owner 的目标。
 * owner 缺失时不猜测归属，直接排除全部 Ghost Skill。
 */
async function collectOwnerVisibleAgentSkills(
  sharedSkillsDir: string,
  opts: OwnerGhostOptions,
): Promise<ProjectionEntry[]> {
  const entries = await fsp.readdir(sharedSkillsDir, { withFileTypes: true });
  const visible = new Map<string, ProjectionEntry>();
  const sharedLegacyGhostRoots = sharedLegacyGhostRootsForOwnerRoot(opts.ownerRoot);

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(sharedSkillsDir, entry.name);
    const target = await realPathOrNull(sourcePath);
    if (!target || !(await isDirectory(sourcePath))) continue;

    const lexicalTarget = entry.isSymbolicLink()
      ? await lexicalManagedLinkTarget(path.join(sourcePath, 'SKILL.md'), entry.name)
      : null;
    const isGhostLink =
      entry.isSymbolicLink() &&
      (targetLooksGhostManaged(target, entry.name, sharedLegacyGhostRoots) ||
        Boolean(
          lexicalTarget &&
          targetLooksGhostManaged(lexicalTarget, entry.name, sharedLegacyGhostRoots),
        ));
    // 受管 Ghost 链接不能从共享根直接进入投影：它们必须在下方从当前运行时仓库根
    // 重新收集，并通过 manifest 与受限 SKILL.md 的一致性校验。
    if (isGhostLink) continue;
    visible.set(entry.name, { name: entry.name, target });
  }

  for (const ownerEntry of await collectOwnerApprovedGhostSkills(opts)) {
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
  opts: OwnerGhostOptions,
): Promise<string> {
  const entries = await collectOwnerVisibleAgentSkills(sharedSkillsDir, opts);
  const projectionRoot = path.join(codexHome, 'skill-projections');
  const projectionDir = path.join(projectionRoot, `agents-${projectionSignature(entries)}`);
  if (await isDirectory(projectionDir)) return projectionDir;

  // 内容寻址目录 + 临时目录 rename，避免 Codex 扫到只建了一半的投影。
  opts.assertOwnerStable?.();
  await fsp.mkdir(projectionRoot, { recursive: true });
  opts.assertOwnerStable?.();
  const stagingDir = await fsp.mkdtemp(path.join(projectionRoot, '.agents-'));
  try {
    for (const entry of entries) {
      opts.assertOwnerStable?.();
      const result = await ensureDirectoryLink(path.join(stagingDir, entry.name), entry.target);
      if (result.status !== 'linked' && result.status !== 'kept') {
        throw new Error(`cannot project ${entry.name}: ${result.reason ?? result.status}`);
      }
    }
    try {
      opts.assertOwnerStable?.();
      await fsp.rename(stagingDir, projectionDir);
    } catch (err) {
      if (!(await isDirectory(projectionDir))) throw err;
    }
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
  return projectionDir;
}

async function cleanupStaleAgentsProjections(
  codexHome: string,
  currentDir: string,
  assertOwnerStable?: () => void,
): Promise<void> {
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
      assertOwnerStable?.();
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
  opts.assertOwnerStable?.();
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
      opts.assertOwnerStable?.();
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
        linkTarget = await ensureAgentsProjection(paths.codexHome, sourceDef.source, opts);
      } catch (err) {
        opts.assertOwnerStable?.();
        changed = (await removeManagedLink(sourceDef.link)) || changed;
        const reason = `cannot build owner-filtered projection: ${(err as Error).message}`;
        sources.push({ ...sourceDef, status: 'error', reason });
        warnings.push(`cannot link Codex agents skills from ${sourceDef.source}: ${reason}`);
        continue;
      }
    }

    opts.assertOwnerStable?.();
    const result = await ensureDirectoryLink(sourceDef.link, linkTarget);
    changed = changed || result.changed;
    sources.push({ ...sourceDef, status: result.status, reason: result.reason });
    if (result.status === 'conflict' || result.status === 'error') {
      warnings.push(
        `cannot link Codex ${sourceDef.name} skills from ${sourceDef.source}: ${result.reason ?? result.status}`,
      );
    }
    if (sourceDef.name === 'agents' && (result.status === 'linked' || result.status === 'kept')) {
      await cleanupStaleAgentsProjections(
        paths.codexHome,
        linkTarget,
        opts.assertOwnerStable,
      ).catch((err: Error) => {
        opts.assertOwnerStable?.();
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
