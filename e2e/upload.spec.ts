import { expect, test } from '@playwright/test';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import { buildTestPng, type Rgba } from './helpers/png';

const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function zoneIndexAt(x: number, y: number): number {
  return ZONES.findIndex((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
}

/** 合格图：四个检测区全部品红，其余白色 */
const validPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) =>
  zoneIndexAt(x, y) >= 0 ? MAGENTA : WHITE,
);

/**
 * 右上区恰好 819 个命中；图像其余所有像素（含检测区外）均为品红。
 * 若实现错误地把区外像素计入，右上区命中数会超过 819。
 */
const TR = ZONES[1];
const almostPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TR.x0 && x <= TR.x1 && y >= TR.y0 && y <= TR.y1) {
    const n = (y - TR.y0) * (TR.x1 - TR.x0 + 1) + (x - TR.x0);
    return n < 819 ? MAGENTA : WHITE;
  }
  return MAGENTA;
});

/** 尺寸不符的 PNG（512×512） */
const wrongSizePng = buildTestPng(512, 512, () => MAGENTA);

/** 文件头是 PNG 签名但内容损坏（无法解码） */
const corruptPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('truncated-png-content'),
]);

/** 完全不是 PNG 的文件 */
const notPng = Buffer.from('<!doctype html><p>not an image</p>');

async function upload(page: import('@playwright/test').Page, name: string, buffer: Buffer) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('合格的 1024×1024 PNG 显示合格与四区命中数', async ({ page }) => {
  await upload(page, 'ok.png', validPng);

  await expect(page.getByTestId('verdict')).toHaveText('合格');
  await expect(page.getByTestId('upload-error')).toHaveCount(0);

  for (const zone of ZONES) {
    await expect(page.getByTestId(`zone-${zone.id}-hits`)).toHaveText('命中 1024 / 1024');
    await expect(page.getByTestId(`zone-box-${zone.id}`)).toBeVisible();
  }
});

test('任一区恰为 819 时显示不合格及对应方位，区外品红不补足计数', async ({ page }) => {
  await upload(page, 'almost.png', almostPng);

  const verdict = page.getByTestId('verdict');
  await expect(verdict).toContainText('不合格');
  await expect(verdict).toContainText('右上');

  await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  await expect(page.getByTestId('zone-top-right-reason')).toContainText('819');
  await expect(page.getByTestId('zone-top-right-reason')).toContainText('820');

  // 其余三区虽然被整图品红包围，仍只统计各自闭区间内的 1024 个像素
  await expect(page.getByTestId('zone-top-left-hits')).toHaveText('命中 1024 / 1024');
  await expect(page.getByTestId('zone-bottom-left-hits')).toHaveText('命中 1024 / 1024');
  await expect(page.getByTestId('zone-bottom-right-hits')).toHaveText('命中 1024 / 1024');
});

test('非 PNG 文件给出明确反馈且无检测结果', async ({ page }) => {
  await upload(page, 'fake.png', notPng);

  await expect(page.getByTestId('upload-error')).toContainText('格式不支持');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('尺寸不符的 PNG 给出明确反馈', async ({ page }) => {
  await upload(page, 'small.png', wrongSizePng);

  const error = page.getByTestId('upload-error');
  await expect(error).toContainText('尺寸不符');
  await expect(error).toContainText('512×512');
  await expect(error).toContainText('1024×1024');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('无法解码的 PNG 给出明确反馈', async ({ page }) => {
  await upload(page, 'corrupt.png', corruptPng);

  await expect(page.getByTestId('upload-error')).toContainText('解码失败');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('上传错误后清除旧结果', async ({ page }) => {
  await upload(page, 'ok.png', validPng);
  await expect(page.getByTestId('verdict')).toHaveText('合格');

  await upload(page, 'small.png', wrongSizePng);
  await expect(page.getByTestId('upload-error')).toContainText('尺寸不符');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('zone-top-left')).toHaveCount(0);
});
