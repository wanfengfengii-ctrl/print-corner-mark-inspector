import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  analyzePixels,
  hasPngSignature,
  HIT_THRESHOLD,
  IMAGE_SIZE,
  ZONE_SIZE,
  type Analysis,
  type Zone,
  type ZoneId,
  type ZoneResult,
} from './lib/detect';
import './App.css';

interface UploadError {
  title: string;
  detail: string;
}

/**
 * 叠加框按原始像素坐标等比映射到预览图，仅作可视化。
 * 采样始终发生在原始 1024×1024 像素上，预览缩放不影响采样坐标。
 */
function zoneBoxStyle(zone: Zone): CSSProperties {
  return {
    left: `${(zone.x0 / IMAGE_SIZE) * 100}%`,
    top: `${(zone.y0 / IMAGE_SIZE) * 100}%`,
    width: `${((zone.x1 - zone.x0 + 1) / IMAGE_SIZE) * 100}%`,
    height: `${((zone.y1 - zone.y0 + 1) / IMAGE_SIZE) * 100}%`,
  };
}

/**
 * 审阅裁片：把检测区 32×32 原始像素逐块复制到一张 32×32 画布，
 * 再由 CSS 以最近邻（image-rendering: pixelated）放大。
 * 数据直接取自上传时已采样的像素缓冲，切换选区不会重新解码文件。
 */
function ZoneCrop({ pixels, zone }: { pixels: Uint8ClampedArray; zone: Zone }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(ZONE_SIZE, ZONE_SIZE);
    for (let y = 0; y < ZONE_SIZE; y += 1) {
      for (let x = 0; x < ZONE_SIZE; x += 1) {
        const src = ((zone.y0 + y) * IMAGE_SIZE + (zone.x0 + x)) * 4;
        const dst = (y * ZONE_SIZE + x) * 4;
        imageData.data[dst] = pixels[src];
        imageData.data[dst + 1] = pixels[src + 1];
        imageData.data[dst + 2] = pixels[src + 2];
        imageData.data[dst + 3] = pixels[src + 3];
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [pixels, zone]);

  return (
    <canvas
      ref={canvasRef}
      width={ZONE_SIZE}
      height={ZONE_SIZE}
      className="review-crop"
      data-testid="review-crop"
      aria-label={`${zone.label}检测区 32×32 原始像素裁片（最近邻放大）`}
    />
  );
}

function GapReview({ result }: { result: ZoneResult }) {
  const { gapBounds, edgeGaps, misses } = result;
  return (
    <div className="review-detail">
      <div className="review-bounds" data-testid="review-gap-bounds">
        {gapBounds
          ? `缺口范围：x ${gapBounds.minX}–${gapBounds.maxX}，y ${gapBounds.minY}–${gapBounds.maxY}（未命中 ${misses} 像素）`
          : '缺口范围：无缺口（1024 个像素全部命中）'}
      </div>
      <ul className="edge-counts">
        <li data-testid="review-edge-top">上边缺口：{edgeGaps.top}</li>
        <li data-testid="review-edge-bottom">下边缺口：{edgeGaps.bottom}</li>
        <li data-testid="review-edge-left">左边缺口：{edgeGaps.left}</li>
        <li data-testid="review-edge-right">右边缺口：{edgeGaps.right}</li>
      </ul>
    </div>
  );
}

export default function App() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<UploadError | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [selectedId, setSelectedId] = useState<ZoneId | null>(null);
  // 当前分析所用的原始 RGBA 像素缓冲；切换审阅选区时直接复用，不重新解码
  const pixelsRef = useRef<Uint8ClampedArray | null>(null);
  // 单调递增序号，防止连续上传时旧异步结果覆盖新状态
  const requestSeq = useRef(0);
  // 审阅区容器：键盘打开证据后把焦点移入，让键盘与读屏用户感知新内容出现
  const reviewRef = useRef<HTMLElement | null>(null);
  // 单调递增的聚焦请求序号；键盘激活选区时递增，渲染完成后由副作用执行聚焦
  const [reviewFocusTick, setReviewFocusTick] = useState(0);

  // 键盘打开/切换证据后，待审阅区渲染完成再把焦点移入（鼠标点选不抢焦点）
  useEffect(() => {
    if (reviewFocusTick === 0) return;
    reviewRef.current?.focus();
  }, [reviewFocusTick]);

  const clearResult = () => {
    setAnalysis(null);
    setError(null);
    setSelectedId(null);
    pixelsRef.current = null;
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  };

  const handleFile = async (file: File) => {
    const seq = ++requestSeq.current;
    // 任何新上传都先清除旧结果（含上一次选区与裁片）
    clearResult();
    setFileName(file.name);

    const fail = (e: UploadError) => {
      if (seq === requestSeq.current) setError(e);
    };

    // 1) 文件头校验：仅接受 PNG
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!hasPngSignature(head)) {
      fail({ title: '格式不支持', detail: '仅接受 PNG 文件，所选文件的文件头不是 PNG。' });
      return;
    }

    // 2) 浏览器原生解码
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    } catch {
      fail({ title: '解码失败', detail: '浏览器无法解码该 PNG，文件可能已损坏。' });
      return;
    }

    // 3) 尺寸必须恰为 1024×1024
    if (bitmap.width !== IMAGE_SIZE || bitmap.height !== IMAGE_SIZE) {
      const { width, height } = bitmap;
      bitmap.close();
      fail({
        title: '尺寸不符',
        detail: `图像尺寸为 ${width}×${height}，要求恰为 ${IMAGE_SIZE}×${IMAGE_SIZE}。`,
      });
      return;
    }

    // 4) 在原始分辨率上采样像素（不随预览缩放改变坐标）
    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_SIZE;
    canvas.height = IMAGE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      fail({ title: '环境异常', detail: '无法创建 Canvas 2D 上下文，无法读取原始像素。' });
      return;
    }
    let pixels: Uint8ClampedArray;
    try {
      ctx.drawImage(bitmap, 0, 0);
    } catch {
      bitmap.close();
      fail({ title: '环境异常', detail: 'Canvas 像素采样失败，当前浏览器环境不允许绘制该图像。' });
      return;
    }
    bitmap.close();
    try {
      pixels = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
    } catch {
      fail({ title: '环境异常', detail: 'Canvas 像素采样失败，当前浏览器环境不允许读取图像像素。' });
      return;
    }

    if (seq !== requestSeq.current) return;
    pixelsRef.current = pixels;
    setAnalysis(analyzePixels(pixels, IMAGE_SIZE, IMAGE_SIZE));
    setPreviewUrl(URL.createObjectURL(file));
  };

  const missing = analysis?.zones.filter((z) => !z.present) ?? [];
  const selected = analysis?.zones.find((z) => z.zone.id === selectedId) ?? null;

  // 粘性选中：再次点选同一检测区保持选中，当前方位证据继续可见
  const selectZone = (id: ZoneId) => setSelectedId(id);

  // 键盘打开证据：更新选区并请求在渲染完成后把焦点移入审阅区
  const openZoneFromKeyboard = (id: ZoneId) => {
    selectZone(id);
    setReviewFocusTick((n) => n + 1);
  };

  return (
    <main className="app">
      <h1>套准角标核验</h1>
      <p className="hint">
        上传一张恰为 1024×1024 的 PNG。系统检测四个角部 32×32 检测区（闭区间 x/y 各 16–47 与
        976–1007），每区 1024 个像素中至少 820 个命中（R≥240、G≤15、B≥240、A=255）视为角标存在，
        四区全部存在判定合格。采样基于原始像素，预览缩放不影响结果。点选任一检测卡片或预览框，
        可查看该区 32×32 原始像素裁片、未命中像素包围范围与四边缺口计数。
      </p>

      <div className="upload">
        <label htmlFor="png-upload">上传 PNG 图像</label>
        <input
          id="png-upload"
          data-testid="file-input"
          type="file"
          accept="image/png"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // 允许重复选择同一文件再次触发检测
            e.target.value = '';
            if (file) void handleFile(file);
          }}
        />
        {fileName && <span className="file-name">{fileName}</span>}
      </div>

      {error && (
        <div className="banner error" role="alert" data-testid="upload-error">
          <strong>{error.title}</strong>
          <span>{error.detail}</span>
        </div>
      )}

      {analysis && (
        <section className="result">
          <div className={`banner ${analysis.passed ? 'pass' : 'fail'}`} data-testid="verdict">
            {analysis.passed ? '合格' : '不合格'}
            {!analysis.passed && missing.length > 0 && (
              <span className="missing" data-testid="missing-zones">
                缺失角标：{missing.map((z) => z.zone.label).join('、')}
              </span>
            )}
          </div>

          <div className="panels">
            {previewUrl && (
              <div className="preview" data-testid="preview">
                <img src={previewUrl} alt="待检图像预览" />
                {analysis.zones.map((z) => (
                  <div
                    key={z.zone.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看${z.zone.label}检测区原始像素`}
                    aria-pressed={selectedId === z.zone.id}
                    className={`zone-box ${z.present ? 'present' : 'absent'} ${
                      selectedId === z.zone.id ? 'selected' : ''
                    }`}
                    style={zoneBoxStyle(z.zone)}
                    data-testid={`zone-box-${z.zone.id}`}
                    title={`点选查看${z.zone.label}原始像素`}
                    onClick={() => selectZone(z.zone.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openZoneFromKeyboard(z.zone.id);
                      }
                    }}
                  />
                ))}
              </div>
            )}

            <ul className="zone-list">
              {analysis.zones.map((z) => (
                <li
                  key={z.zone.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedId === z.zone.id}
                  className={`zone-card ${z.present ? 'present' : 'absent'} ${
                    selectedId === z.zone.id ? 'selected' : ''
                  }`}
                  data-testid={`zone-${z.zone.id}`}
                  onClick={() => selectZone(z.zone.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openZoneFromKeyboard(z.zone.id);
                    }
                  }}
                >
                  <header>
                    <span className="zone-label">{z.zone.label}</span>
                    <span className="zone-status">{z.present ? '存在' : '缺失'}</span>
                  </header>
                  <div className="zone-hits" data-testid={`zone-${z.zone.id}-hits`}>
                    命中 {z.hits} / {z.total}
                  </div>
                  {!z.present && (
                    <div className="zone-reason" data-testid={`zone-${z.zone.id}-reason`}>
                      未达标：命中 {z.hits} 低于阈值 {HIT_THRESHOLD}
                    </div>
                  )}
                  <div className="zone-hint">点选查看原始像素裁片</div>
                </li>
              ))}
            </ul>
          </div>

          {selected && pixelsRef.current && (
            <section
              className="review"
              data-testid="review"
              ref={reviewRef}
              tabIndex={-1}
              aria-live="polite"
            >
              <h2>{selected.zone.label}检测区 · 像素级证据</h2>
              <div className="review-body">
                <figure className="review-crop-wrap">
                  <ZoneCrop pixels={pixelsRef.current} zone={selected.zone} />
                  <figcaption>
                    32×32 原始像素裁片（坐标 x {selected.zone.x0}–{selected.zone.x1}，y{' '}
                    {selected.zone.y0}–{selected.zone.y1}），最近邻放大显示
                  </figcaption>
                </figure>
                <GapReview result={selected} />
              </div>
            </section>
          )}
        </section>
      )}
    </main>
  );
}
