import { describe, expect, it } from 'vitest';
import {
  isZoneId,
  parseSessionSnapshot,
  SESSION_SNAPSHOT_VERSION,
} from '../lib/sessionStore';

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

function validAwaitingSnapshot() {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    comparePhase: 'awaiting',
    selectedZone: 'top-right',
    baseline: { name: 'baseline.png', png: pngBytes },
    recheck: null,
  };
}

function validComparedSnapshot() {
  return {
    ...validAwaitingSnapshot(),
    comparePhase: 'compared',
    recheck: { name: 'recheck.png', png: pngBytes },
  };
}

describe('isZoneId', () => {
  it('接受四个固定方位', () => {
    for (const id of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      expect(isZoneId(id)).toBe(true);
    }
  });

  it('拒绝其他值', () => {
    for (const value of ['top', '', 'TOP-LEFT', 1, null, undefined, {}, []]) {
      expect(isZoneId(value)).toBe(false);
    }
  });
});

describe('parseSessionSnapshot', () => {
  it('解析待复检阶段的合法快照，保留选中方位', () => {
    const snapshot = parseSessionSnapshot(validAwaitingSnapshot());
    expect(snapshot).not.toBeNull();
    expect(snapshot!.version).toBe(SESSION_SNAPSHOT_VERSION);
    expect(snapshot!.comparePhase).toBe('awaiting');
    expect(snapshot!.selectedZone).toBe('top-right');
    expect(snapshot!.baseline.name).toBe('baseline.png');
    expect(snapshot!.baseline.png).toBe(pngBytes);
    expect(snapshot!.recheck).toBeNull();
  });

  it('解析完成对比阶段的合法快照，保留复检图', () => {
    const snapshot = parseSessionSnapshot(validComparedSnapshot());
    expect(snapshot).not.toBeNull();
    expect(snapshot!.comparePhase).toBe('compared');
    expect(snapshot!.recheck).not.toBeNull();
    expect(snapshot!.recheck!.name).toBe('recheck.png');
  });

  it('未选中方位（null）合法保留', () => {
    const snapshot = parseSessionSnapshot({ ...validAwaitingSnapshot(), selectedZone: null });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.selectedZone).toBeNull();
  });

  it('选中方位非法时宽容地置为 null，其余字段仍恢复', () => {
    const snapshot = parseSessionSnapshot({ ...validAwaitingSnapshot(), selectedZone: '顶部' });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.selectedZone).toBeNull();
  });

  it('版本不识别时返回 null', () => {
    expect(parseSessionSnapshot({ ...validAwaitingSnapshot(), version: 9999 })).toBeNull();
    expect(parseSessionSnapshot({ ...validAwaitingSnapshot(), version: '1' })).toBeNull();
    expect(parseSessionSnapshot({ ...validAwaitingSnapshot(), version: undefined })).toBeNull();
  });

  it('对比阶段非法时返回 null', () => {
    expect(parseSessionSnapshot({ ...validAwaitingSnapshot(), comparePhase: 'idle' })).toBeNull();
    expect(parseSessionSnapshot({ ...validAwaitingSnapshot(), comparePhase: 'done' })).toBeNull();
  });

  it('缺基准图或基准图结构非法时返回 null', () => {
    const missing = validAwaitingSnapshot() as Record<string, unknown>;
    delete missing.baseline;
    expect(parseSessionSnapshot(missing)).toBeNull();
    expect(parseSessionSnapshot({ ...validAwaitingSnapshot(), baseline: null })).toBeNull();
    expect(
      parseSessionSnapshot({ ...validAwaitingSnapshot(), baseline: { name: 'a.png' } }),
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        ...validAwaitingSnapshot(),
        baseline: { name: 'a.png', png: 'not-a-buffer' },
      }),
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        ...validAwaitingSnapshot(),
        baseline: { name: 'a.png', png: new ArrayBuffer(0) },
      }),
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        ...validAwaitingSnapshot(),
        baseline: { name: 42, png: pngBytes },
      }),
    ).toBeNull();
  });

  it('完成对比阶段缺复检图时返回 null', () => {
    expect(parseSessionSnapshot({ ...validComparedSnapshot(), recheck: null })).toBeNull();
    const missing = validComparedSnapshot() as Record<string, unknown>;
    delete missing.recheck;
    expect(parseSessionSnapshot(missing)).toBeNull();
    expect(
      parseSessionSnapshot({ ...validComparedSnapshot(), recheck: { name: 'r.png', png: 1 } }),
    ).toBeNull();
  });

  it('待复检阶段忽略残留的复检图字段', () => {
    const snapshot = parseSessionSnapshot({
      ...validAwaitingSnapshot(),
      recheck: { name: 'stale.png', png: pngBytes },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.comparePhase).toBe('awaiting');
    expect(snapshot!.recheck).toBeNull();
  });

  it('非对象输入返回 null', () => {
    for (const value of [null, undefined, 42, 'snapshot', true, []]) {
      expect(parseSessionSnapshot(value)).toBeNull();
    }
  });
});
