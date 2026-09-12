import { describe, expect, it } from 'vitest';
import {
  analyzePixels,
  countZoneHits,
  hasPngSignature,
  HIT_THRESHOLD,
  IMAGE_SIZE,
  isHitPixel,
  PNG_SIGNATURE,
  ZONE_PIXELS,
  ZONES,
} from '../lib/detect';

type Rgba = [number, number, number, number];
const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

/** 按像素回调生成 1024×1024 RGBA 像素缓冲 */
function makePixels(paint: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const px = new Uint8ClampedArray(IMAGE_SIZE * IMAGE_SIZE * 4);
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * IMAGE_SIZE + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
  return px;
}

function inZone(x: number, y: number, zoneIndex: number): boolean {
  const z = ZONES[zoneIndex];
  return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
}

/** 生成指定检测区内恰好 hits 个品红像素、其余全白的图像 */
function pixelsWithZoneHits(zoneIndex: number, hits: number): Uint8ClampedArray {
  const z = ZONES[zoneIndex];
  return makePixels((x, y) => {
    if (inZone(x, y, zoneIndex)) {
      const n = (y - z.y0) * (z.x1 - z.x0 + 1) + (x - z.x0);
      return n < hits ? MAGENTA : WHITE;
    }
    return WHITE;
  });
}

describe('命中像素边界（R≥240、G≤15、B≥240、A=255）', () => {
  it('边界值 (240, 15, 240, 255) 命中', () => {
    expect(isHitPixel(240, 15, 240, 255)).toBe(true);
  });

  it('典型品红 (255, 0, 255, 255) 命中', () => {
    expect(isHitPixel(255, 0, 255, 255)).toBe(true);
  });

  it.each([
    [239, 15, 240, 255, 'R 低于下限'],
    [240, 16, 240, 255, 'G 高于上限'],
    [240, 15, 239, 255, 'B 低于下限'],
    [240, 15, 240, 254, 'A 非 255'],
    [255, 0, 255, 0, '完全透明'],
  ])('越界值 (%d, %d, %d, %d) 不命中：%s', (r, g, b, a) => {
    expect(isHitPixel(r, g, b, a)).toBe(false);
  });
});

describe('检测区几何', () => {
  it('四个检测区为规定的闭区间', () => {
    expect(ZONES.map(({ x0, y0, x1, y1 }) => [x0, y0, x1, y1])).toEqual([
      [16, 16, 47, 47],
      [976, 16, 1007, 47],
      [16, 976, 47, 1007],
      [976, 976, 1007, 1007],
    ]);
  });

  it('每区 32×32 共 1024 像素', () => {
    expect(ZONE_PIXELS).toBe(1024);
    for (const z of ZONES) {
      expect((z.x1 - z.x0 + 1) * (z.y1 - z.y0 + 1)).toBe(1024);
    }
  });

  it('四个检测区互不重叠', () => {
    for (let i = 0; i < ZONES.length; i += 1) {
      for (let j = i + 1; j < ZONES.length; j += 1) {
        const a = ZONES[i];
        const b = ZONES[j];
        const overlap = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('阈值判定（每区 1024 像素至少 820 命中）', () => {
  it('819 个命中 → 角标缺失', () => {
    const res = analyzePixels(pixelsWithZoneHits(0, HIT_THRESHOLD - 1), IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[0].hits).toBe(819);
    expect(res.zones[0].present).toBe(false);
    expect(res.passed).toBe(false);
  });

  it('820 个命中 → 角标存在', () => {
    const res = analyzePixels(pixelsWithZoneHits(0, HIT_THRESHOLD), IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[0].hits).toBe(820);
    expect(res.zones[0].present).toBe(true);
  });

  it('区域外的品红像素不计入区内命中', () => {
    // 整图品红，仅左上区全部置白：左上必须计 0，其余区计满 1024
    const px = makePixels((x, y) => (inZone(x, y, 0) ? WHITE : MAGENTA));
    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[0].hits).toBe(0);
    expect(res.zones[0].present).toBe(false);
    expect(res.zones[1].hits).toBe(1024);
    expect(res.zones[2].hits).toBe(1024);
    expect(res.zones[3].hits).toBe(1024);
    expect(res.passed).toBe(false);
  });

  it('countZoneHits 只统计闭区间内的像素', () => {
    // 紧贴上边界的区外像素（x=15、x=48、y=15、y=48）均为品红，区内全白
    const z = ZONES[0];
    const px = makePixels((x, y) => {
      const ring =
        (x === z.x0 - 1 || x === z.x1 + 1 || y === z.y0 - 1 || y === z.y1 + 1) &&
        x >= z.x0 - 1 &&
        x <= z.x1 + 1 &&
        y >= z.y0 - 1 &&
        y <= z.y1 + 1;
      return ring ? MAGENTA : WHITE;
    });
    expect(countZoneHits(px, IMAGE_SIZE, z)).toBe(0);
  });
});

describe('整体判定', () => {
  it('四区全部命中 → 合格', () => {
    const px = makePixels((x, y) =>
      ZONES.some((_, i) => inZone(x, y, i)) ? MAGENTA : WHITE,
    );
    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones.every((z) => z.hits === 1024 && z.present)).toBe(true);
    expect(res.passed).toBe(true);
  });

  it('任一区缺失 → 不合格并保留方位信息', () => {
    // 右上区 819 命中，其余区满命中
    const px = makePixels((x, y) => {
      if (inZone(x, y, 1)) {
        const z = ZONES[1];
        const n = (y - z.y0) * (z.x1 - z.x0 + 1) + (x - z.x0);
        return n < 819 ? MAGENTA : WHITE;
      }
      return ZONES.some((_, i) => i !== 1 && inZone(x, y, i)) ? MAGENTA : WHITE;
    });
    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.passed).toBe(false);
    expect(res.zones.filter((z) => !z.present).map((z) => z.zone.label)).toEqual(['右上']);
  });

  it('尺寸不符时抛出异常', () => {
    expect(() => analyzePixels(new Uint8ClampedArray(4), 1, 1)).toThrow(/1024×1024/);
  });
});

describe('PNG 文件头校验', () => {
  it('合法 PNG 签名通过', () => {
    expect(hasPngSignature(new Uint8Array(PNG_SIGNATURE))).toBe(true);
  });

  it('文件头不符或长度不足均拒绝', () => {
    expect(hasPngSignature(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false);
    expect(hasPngSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false);
    expect(hasPngSignature(new Uint8Array(0))).toBe(false);
  });
});
