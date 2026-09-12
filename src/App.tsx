import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  analyzePixels,
  hasPngSignature,
  HIT_THRESHOLD,
  IMAGE_SIZE,
  type Analysis,
  type Zone,
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

export default function App() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<UploadError | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  // 单调递增序号，防止连续上传时旧异步结果覆盖新状态
  const requestSeq = useRef(0);

  const clearResult = () => {
    setAnalysis(null);
    setError(null);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  };

  const handleFile = async (file: File) => {
    const seq = ++requestSeq.current;
    // 任何新上传都先清除旧结果
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
      fail({ title: '环境异常', detail: '无法创建 Canvas 2D 上下文。' });
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;

    if (seq !== requestSeq.current) return;
    setAnalysis(analyzePixels(pixels, IMAGE_SIZE, IMAGE_SIZE));
    setPreviewUrl(URL.createObjectURL(file));
  };

  const missing = analysis?.zones.filter((z) => !z.present) ?? [];

  return (
    <main className="app">
      <h1>套准角标核验</h1>
      <p className="hint">
        上传一张恰为 1024×1024 的 PNG。系统检测四个角部 32×32 检测区（闭区间 x/y 各 16–47 与
        976–1007），每区 1024 个像素中至少 820 个命中（R≥240、G≤15、B≥240、A=255）视为角标存在，
        四区全部存在判定合格。采样基于原始像素，预览缩放不影响结果。
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
                    className={`zone-box ${z.present ? 'present' : 'absent'}`}
                    style={zoneBoxStyle(z.zone)}
                    data-testid={`zone-box-${z.zone.id}`}
                    title={z.zone.label}
                  />
                ))}
              </div>
            )}

            <ul className="zone-list">
              {analysis.zones.map((z) => (
                <li
                  key={z.zone.id}
                  className={`zone-card ${z.present ? 'present' : 'absent'}`}
                  data-testid={`zone-${z.zone.id}`}
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
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
