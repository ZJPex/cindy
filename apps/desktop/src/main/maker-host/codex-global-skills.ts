import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

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

function targetLooksGhostRepositoryManaged(target: string): boolean {
  const segments = target.split(/[\\/]/).map((segment) => segment.toLowerCase());
  return segments.some(
    (segment, index) =>
      (segment === 'cindy-brain' || segment === 'brain') && segments[index + 2] === 'skills',
  );
}

function targetLooksGhostManaged(target: string, linkName: string): boolean {
  // 与 skillSlot 的保守判据保持一致，避免把普通用户链接误判成 Ghost 托管链接。
  if (!linkName.includes('--')) return false;
  return targetLooksGhostRepositoryManaged(target);
}

/**
 * Codex 会绕过 CODEX_HOME，原生扫描用户主目录的 `.agents/skills`。根据它实际
 * 上报的 SKILL.md 路径再次核对 owner，返回必须在 thread 配置中禁用的外来 Ghost。
 */
export async function codexDisabledSkillPathsForOwner(
  skills: ReadonlyArray<{ path: string }>,
  ownerRoot?: string,
): Promise<string[]> {
  const ownerRootCompare = ownerRoot
    ? ((await realPathOrNull(ownerRoot)) ?? normalizeForCompare(ownerRoot))
    : null;
  const disabled: string[] = [];

  for (const skill of skills) {
    const target = (await realPathOrNull(skill.path)) ?? normalizeForCompare(skill.path);
    if (!targetLooksGhostRepositoryManaged(target)) continue;
    if (!ownerRootCompare || !isSameOrInside(target, ownerRootCompare)) {
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
  const ownerRootCompare = ownerRoot
    ? ((await realPathOrNull(ownerRoot)) ?? normalizeForCompare(ownerRoot))
    : null;
  const entries = await fsp.readdir(sharedSkillsDir, { withFileTypes: true });
  const visible: ProjectionEntry[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(sharedSkillsDir, entry.name);
    const target = await realPathOrNull(sourcePath);
    if (!target || !(await isDirectory(sourcePath))) continue;

    const isGhostLink = entry.isSymbolicLink() && targetLooksGhostManaged(target, entry.name);
    if (isGhostLink && (!ownerRootCompare || !isSameOrInside(target, ownerRootCompare))) continue;
    visible.push({ name: entry.name, target });
  }

  return visible;
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
