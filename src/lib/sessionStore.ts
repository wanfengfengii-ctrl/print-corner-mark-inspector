/**
 * 套准角标核验会话快照的 IndexedDB 持久化。
 *
 * 工位核验常因浏览器误刷新中断：每次基准或复检分析成功后，核验页把
 * 原始 PNG 字节、当前对比阶段与选中方位写入带结构版本的快照；
 * 页面重新加载时读取快照，并重新走既有解码、取样与分析函数重建结果，
 * 不直接信任旧判定。照明校准状态不纳入保存。
 *
 * 存储不可用（隐私模式、浏览器禁用 IndexedDB 等）时所有操作静默降级，
 * 不阻断既有核验流程。本模块在模块顶层不访问任何浏览器 API，
 * 纯校验函数 parseSessionSnapshot 可在 Vitest 中直接测试。
 */

import { ZONES, type ZoneId } from './detect';

/** IndexedDB 数据库名 */
export const SESSION_DB_NAME = 'register-mark-verifier';
/** 对象仓库名 */
export const SESSION_STORE_NAME = 'verify-session';
/** 当前会话快照的记录键（单条记录） */
export const SESSION_SNAPSHOT_KEY = 'current';
/** 快照结构版本；结构变更时递增，旧版本快照视为不可识别 */
export const SESSION_SNAPSHOT_VERSION = 1;

/** 快照中保存的一张原始 PNG 图像 */
export interface StoredSessionImage {
  /** 原始文件名，用于恢复后回显 */
  name: string;
  /** PNG 文件原始字节（结构化克隆按 ArrayBuffer 存取） */
  png: ArrayBuffer;
}

/** 带结构版本的核验会话快照 */
export interface SessionSnapshot {
  /** 结构版本，恒为 SESSION_SNAPSHOT_VERSION */
  version: number;
  /** 保存时的对比阶段：awaiting 已固定基准待复检 / compared 已完成前后对比 */
  comparePhase: 'awaiting' | 'compared';
  /** 保存时选中的方位；未选中为 null */
  selectedZone: ZoneId | null;
  /** 基准图（调整前）原始 PNG */
  baseline: StoredSessionImage;
  /** 复检图原始 PNG；仅 compared 阶段存在 */
  recheck: StoredSessionImage | null;
}

/**
 * 快照读取结果：
 * - unavailable：浏览器存储不可用（含读写异常），调用方按无快照处理且不提示；
 * - empty：存储可用但没有已保存的快照（首次访问）；
 * - ok：读到结构可识别的快照；
 * - invalid：存在快照但版本或结构不识别（含缺图），调用方应说明无法恢复并清理。
 */
export type SessionSnapshotLoad =
  | { status: 'unavailable' }
  | { status: 'empty' }
  | { status: 'ok'; snapshot: SessionSnapshot }
  | { status: 'invalid' };

/** 校验值是否为合法检测区方位 id */
export function isZoneId(value: unknown): value is ZoneId {
  return typeof value === 'string' && ZONES.some((z) => z.id === value);
}

function isStoredImage(value: unknown): value is StoredSessionImage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && v.png instanceof ArrayBuffer && v.png.byteLength > 0;
}

/**
 * 校验并解析 IndexedDB 中读出的快照。
 * 版本不识别、阶段非法、缺图（基准缺失或 compared 阶段缺复检图）均返回 null；
 * 选中方位非法时宽容地置为 null（不影响其余字段恢复）。
 */
export function parseSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== SESSION_SNAPSHOT_VERSION) return null;
  if (v.comparePhase !== 'awaiting' && v.comparePhase !== 'compared') return null;
  if (!isStoredImage(v.baseline)) return null;
  let recheck: StoredSessionImage | null = null;
  if (v.comparePhase === 'compared') {
    if (!isStoredImage(v.recheck)) return null;
    recheck = v.recheck;
  }
  return {
    version: SESSION_SNAPSHOT_VERSION,
    comparePhase: v.comparePhase,
    selectedZone: isZoneId(v.selectedZone) ? v.selectedZone : null,
    baseline: v.baseline,
    recheck,
  };
}

/** 打开（必要时创建）会话数据库与对象仓库 */
function openSessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SESSION_STORE_NAME)) {
        req.result.createObjectStore(SESSION_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(req.error ?? new Error('IndexedDB 打开被阻塞'));
  });
}

/** 读取当前会话快照；存储不可用或读异常均不抛出 */
export async function loadSessionSnapshot(): Promise<SessionSnapshotLoad> {
  if (typeof indexedDB === 'undefined') return { status: 'unavailable' };
  let db: IDBDatabase;
  try {
    db = await openSessionDb();
  } catch {
    return { status: 'unavailable' };
  }
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE_NAME, 'readonly');
      const req = tx.objectStore(SESSION_STORE_NAME).get(SESSION_SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (raw === undefined) return { status: 'empty' };
    const snapshot = parseSessionSnapshot(raw);
    return snapshot ? { status: 'ok', snapshot } : { status: 'invalid' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    db.close();
  }
}

/** 写入（覆盖）当前会话快照；返回是否成功，存储不可用时静默返回 false */
export async function saveSessionSnapshot(snapshot: SessionSnapshot): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const db = await openSessionDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE_NAME, 'readwrite');
        tx.objectStore(SESSION_STORE_NAME).put(snapshot, SESSION_SNAPSHOT_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** 删除当前会话快照；存储不可用时静默忽略 */
export async function clearSessionSnapshot(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openSessionDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE_NAME, 'readwrite');
        tx.objectStore(SESSION_STORE_NAME).delete(SESSION_SNAPSHOT_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // 存储不可用：没有可清理的快照，静默忽略
  }
}
