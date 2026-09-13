import { expect, test, type Page } from '@playwright/test';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import {
  SESSION_DB_NAME,
  SESSION_SNAPSHOT_KEY,
  SESSION_SNAPSHOT_VERSION,
  SESSION_STORE_NAME,
} from '../src/lib/sessionStore';
import { buildTestPng, type Rgba } from './helpers/png';

const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

const TR = ZONES[1];

function inAnyZone(x: number, y: number): boolean {
  return ZONES.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
}

/**
 * 固定的不合格基准：右上区恰好 819 命中（按局部序末 205 像素置白），
 * 其余三个检测区满命中，检测区外全白。
 */
const failingBaselinePng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TR.x0 && x <= TR.x1 && y >= TR.y0 && y <= TR.y1) {
    const n = (y - TR.y0) * (TR.x1 - TR.x0 + 1) + (x - TR.x0);
    return n < 819 ? MAGENTA : WHITE;
  }
  return inAnyZone(x, y) ? MAGENTA : WHITE;
});

/** 满命中复检图：四个检测区全部命中（右上 205 个缺口全部修复） */
const improvedPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) =>
  inAnyZone(x, y) ? MAGENTA : WHITE,
);

/** 文件头是 PNG 签名但内容损坏（无法解码） */
const corruptPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('truncated-png-content'),
]);

async function uploadBaseline(page: Page, buffer: Buffer, name = 'baseline.png') {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

async function uploadRecheck(page: Page, buffer: Buffer, name = 'recheck.png') {
  await page.getByTestId('recheck-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

/** 统计差异图中各类颜色像素数（品红=均命中、白=均缺失、绿=恢复、红=新增缺失） */
async function diffColorCounts(page: Page) {
  return page.$eval('[data-testid="review-diff-crop"]', (el) => {
    const canvas = el as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, 32, 32).data;
    const counts = { magenta: 0, white: 0, green: 0, red: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r === 255 && g === 0 && b === 255) counts.magenta += 1;
      else if (r === 255 && g === 255 && b === 255) counts.white += 1;
      else if (r === 16 && g === 185 && b === 129) counts.green += 1;
      else if (r === 224 && g === 36 && b === 36) counts.red += 1;
    }
    return counts;
  });
}

/** 记录「正在恢复」提示是否出现过（刷新前后的导航都会重新安装观察器） */
async function watchRestoring(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __restoringSeen?: boolean };
    w.__restoringSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="session-restoring"]')) {
        w.__restoringSeen = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function restoringSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __restoringSeen?: boolean }).__restoringSeen ?? false,
  );
}

interface SnapshotProbe {
  dbName: string;
  storeName: string;
  key: string;
  want?: { comparePhase?: string; selectedZone?: string | null };
}

/** 等待 IndexedDB 中出现满足条件的会话快照（确认保存已落盘后再刷新） */
async function waitForSnapshot(
  page: Page,
  want: { comparePhase?: string; selectedZone?: string | null } = {},
) {
  await page.waitForFunction(
    async ({ dbName, storeName, key, want: expected }: SnapshotProbe) => {
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(dbName, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(storeName)) {
              req.result.createObjectStore(storeName);
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          if (!db.objectStoreNames.contains(storeName)) return false;
          const value = await new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (value === undefined || value === null || typeof value !== 'object') return false;
          const v = value as Record<string, unknown>;
          if (expected?.comparePhase !== undefined && v.comparePhase !== expected.comparePhase) {
            return false;
          }
          if (expected?.selectedZone !== undefined && v.selectedZone !== expected.selectedZone) {
            return false;
          }
          return true;
        } finally {
          db.close();
        }
      } catch {
        return false;
      }
    },
    {
      dbName: SESSION_DB_NAME,
      storeName: SESSION_STORE_NAME,
      key: SESSION_SNAPSHOT_KEY,
      want,
    } satisfies SnapshotProbe,
  );
}

/** 等待会话快照被删除（确认清理已落盘后再刷新） */
async function waitForSnapshotGone(page: Page) {
  await page.waitForFunction(
    async ({ dbName, storeName, key }: SnapshotProbe) => {
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(dbName, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(storeName)) {
              req.result.createObjectStore(storeName);
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          if (!db.objectStoreNames.contains(storeName)) return true;
          const value = await new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          return value === undefined;
        } finally {
          db.close();
        }
      } catch {
        return false;
      }
    },
    { dbName: SESSION_DB_NAME, storeName: SESSION_STORE_NAME, key: SESSION_SNAPSHOT_KEY },
  );
}

/** 直接向 IndexedDB 写入任意快照值（注入损坏/不识别快照） */
async function putRawSnapshot(page: Page, value: unknown) {
  await page.evaluate(
    async ({ dbName, storeName, key, snapshot }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) {
            req.result.createObjectStore(storeName);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(snapshot, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { dbName: SESSION_DB_NAME, storeName: SESSION_STORE_NAME, key: SESSION_SNAPSHOT_KEY, snapshot: value },
  );
}

/** 写入结构合法、携带 PNG 字节的快照（字节以数组传入，页面内重建 ArrayBuffer） */
async function putSnapshotWithImages(
  page: Page,
  snapshot: {
    comparePhase: 'awaiting' | 'compared';
    selectedZone: string | null;
    baselineName: string;
    baselinePng: number[];
    recheckName?: string;
    recheckPng?: number[];
  },
) {
  await page.evaluate(
    async ({ dbName, storeName, key, version, snapshot: raw }) => {
      const value = {
        version,
        comparePhase: raw.comparePhase,
        selectedZone: raw.selectedZone,
        baseline: { name: raw.baselineName, png: new Uint8Array(raw.baselinePng).buffer },
        recheck:
          raw.recheckName && raw.recheckPng
            ? { name: raw.recheckName, png: new Uint8Array(raw.recheckPng).buffer }
            : null,
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(storeName)) {
            req.result.createObjectStore(storeName);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    {
      dbName: SESSION_DB_NAME,
      storeName: SESSION_STORE_NAME,
      key: SESSION_SNAPSHOT_KEY,
      version: SESSION_SNAPSHOT_VERSION,
      snapshot,
    },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('误刷新后自动恢复不合格基准与已查看方位，恢复期间显示「正在恢复」', async ({ page }) => {
  await watchRestoring(page);

  // 首次访问：无快照，不出现任何恢复提示，既有核验流程不受阻
  await expect(page.getByTestId('session-restoring')).toHaveCount(0);
  await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);

  // 819 命中的不合格基准，点选右上方位查看缺口证据
  await uploadBaseline(page, failingBaselinePng);
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  await page.getByTestId('zone-top-right').click();
  await expect(page.getByTestId('review-gap-bounds')).toHaveText(
    '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
  );
  await waitForSnapshot(page, { comparePhase: 'awaiting', selectedZone: 'top-right' });

  // 误刷新：无需重新选择原图，会话自动恢复
  await page.reload();

  // 恢复期间显示过「正在恢复」
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  expect(await restoringSeen(page)).toBe(true);

  // 判定、命中数、对比阶段与所选方位全部恢复
  await expect(page.getByTestId('verdict')).toContainText('右上');
  await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
  const review = page.getByTestId('review');
  await expect(review).toBeVisible();
  await expect(review).toContainText('右上检测区');
  await expect(page.getByTestId('review-gap-bounds')).toHaveText(
    '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
  );
  await expect(page.getByTestId('review-crop')).toBeVisible();
  await expect(page.getByTestId('zone-top-right')).toHaveAttribute('aria-pressed', 'true');

  // 恢复后可继续正常操作：切换方位查看其他检测区
  await page.getByTestId('zone-top-left').click();
  await expect(page.getByTestId('review-gap-bounds')).toHaveText(
    '缺口范围：无缺口（1024 个像素全部命中）',
  );
});

test('完成前后对比后刷新，恢复两次判定、差异图与四类像素计数', async ({ page }) => {
  await uploadBaseline(page, failingBaselinePng);
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  await uploadRecheck(page, improvedPng);
  await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
  await page.getByTestId('zone-top-right').click();
  await expect(page.getByTestId('review-diff-crop')).toBeVisible();
  await waitForSnapshot(page, { comparePhase: 'compared', selectedZone: 'top-right' });

  await page.reload();

  // 恢复已完成的前后对比：两次判定与两张预览都在
  await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
  await expect(page.getByTestId('verdict')).toContainText('调整前基准');
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
  await expect(page.getByTestId('preview-tag-baseline')).toBeVisible();
  await expect(page.getByTestId('preview-tag-recheck')).toBeVisible();
  await expect(page.getByTestId('zone-top-right-hits')).toHaveText('基准命中 819 / 1024');
  await expect(page.getByTestId('zone-top-right-delta')).toHaveText('命中+205（1024 / 1024）');

  // 选中方位恢复：差异图直接可见，逐类计数与四类像素统计同刷新前一致
  await expect(page.getByTestId('review-diff-crop')).toBeVisible();
  await expect(page.getByTestId('review-diff-recovered')).toHaveText('恢复命中：205 像素');
  await expect(page.getByTestId('review-diff-newgaps')).toHaveText('新增缺失：0 像素');
  await expect(page.getByTestId('review-diff-unchanged-hit')).toHaveText('两次均命中：819 像素');
  await expect(page.getByTestId('review-diff-unchanged-miss')).toHaveText('两次均缺失：0 像素');
  expect(await diffColorCounts(page)).toEqual({ magenta: 819, white: 0, green: 205, red: 0 });
});

test('快照版本不识别：说明无法恢复、清理快照并降级到上传页', async ({ page }) => {
  // 注入版本号不识别的快照（结构其余部分合法也不被信任）
  await putRawSnapshot(page, {
    version: SESSION_SNAPSHOT_VERSION + 1,
    comparePhase: 'awaiting',
    selectedZone: null,
    baseline: null,
    recheck: null,
  });
  await page.reload();

  // 页面说明无法恢复，并降级到初始上传态
  const failure = page.getByTestId('session-restore-failed');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('无法恢复');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('zone-top-right')).toHaveCount(0);

  // 损坏快照已被清理
  await waitForSnapshotGone(page);

  // 随后允许正常上传
  await uploadBaseline(page, failingBaselinePng);
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);

  // 新会话已重新保存：再次刷新按新快照恢复，不再出现无法恢复提示
  await waitForSnapshot(page, { comparePhase: 'awaiting' });
  await page.reload();
  await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
  await expect(page.getByTestId('verdict')).toContainText('不合格');
});

test('快照缺图：说明无法恢复、清理快照并允许正常上传', async ({ page }) => {
  // compared 阶段却缺复检图（基准图也缺少 PNG 字节）
  await putRawSnapshot(page, {
    version: SESSION_SNAPSHOT_VERSION,
    comparePhase: 'compared',
    selectedZone: null,
    baseline: { name: 'baseline.png' },
    recheck: null,
  });
  await page.reload();

  const failure = page.getByTestId('session-restore-failed');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('无法恢复');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await waitForSnapshotGone(page);

  await uploadBaseline(page, improvedPng);
  await expect(page.getByTestId('verdict')).toHaveText('合格');
});

test('快照内 PNG 损坏：说明无法恢复并降级到上传页', async ({ page }) => {
  // 结构合法但基准 PNG 字节损坏（签名完好、内容无法解码）
  await putSnapshotWithImages(page, {
    comparePhase: 'awaiting',
    selectedZone: 'top-left',
    baselineName: 'corrupt.png',
    baselinePng: Array.from(corruptPng),
  });
  await page.reload();

  const failure = page.getByTestId('session-restore-failed');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('无法恢复');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('zone-top-left')).toHaveCount(0);
  await waitForSnapshotGone(page);

  // 降级后允许正常上传
  await uploadBaseline(page, improvedPng);
  await expect(page.getByTestId('verdict')).toHaveText('合格');
});

test('清除已保存会话后回到初始上传态，再次刷新不出现旧结果', async ({ page }) => {
  await watchRestoring(page);

  await uploadBaseline(page, failingBaselinePng);
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  await page.getByTestId('zone-top-right').click();
  await expect(page.getByTestId('review')).toBeVisible();
  await waitForSnapshot(page, { comparePhase: 'awaiting', selectedZone: 'top-right' });

  // 主动清除：删除快照并回到初始上传态
  await page.getByTestId('session-clear').click();
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('zone-top-right')).toHaveCount(0);
  await expect(page.getByTestId('review')).toHaveCount(0);
  await expect(page.getByTestId('recheck-bar')).toHaveCount(0);
  await expect(page.getByTestId('session-clear')).toHaveCount(0);
  await waitForSnapshotGone(page);

  // 再次刷新：不出现旧结果，也不进入恢复
  await page.reload();
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await restoringSeen(page)).toBe(false);

  // 既有核验流程不受影响，可重新上传
  await uploadBaseline(page, improvedPng);
  await expect(page.getByTestId('verdict')).toHaveText('合格');
});

test('浏览器存储不可用时既有核验流程不受阻', async ({ page }) => {
  // 模拟浏览器禁用 IndexedDB
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });
  await page.reload();

  // 单图核验流程不受影响
  await uploadBaseline(page, failingBaselinePng);
  await expect(page.getByTestId('verdict')).toContainText('不合格');
  await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  await page.getByTestId('zone-top-right').click();
  await expect(page.getByTestId('review-gap-bounds')).toHaveText(
    '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
  );

  // 复检对比流程同样不受影响
  await uploadRecheck(page, improvedPng);
  await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
  await expect(page.getByTestId('verdict-recheck')).toContainText('合格');

  // 不出现恢复提示或失败提示
  await expect(page.getByTestId('session-restoring')).toHaveCount(0);
  await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
});
