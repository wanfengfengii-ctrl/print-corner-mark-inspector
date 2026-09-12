# 套准角标核验页

纯前端页面，用于核验包装印刷图像四角的套准角标是否完整。操作员上传一张 PNG，
浏览器原生解码后在四个固定检测区内统计品红命中像素，四区全部达标判定「合格」。

## 实现说明

- 技术栈：TypeScript + React + Vite，全部检测在浏览器内完成，无后端依赖。
- 检测逻辑集中在 `src/lib/detect.ts`（纯函数，不依赖浏览器 API，便于单测）：
  - 仅接受 PNG：先校验 8 字节文件签名，再由 `createImageBitmap` 原生解码；
    非 PNG、解码失败、尺寸不符都会给出明确反馈并清除旧结果。
  - 图像必须恰为 1024×1024。
  - 四个检测区为固定闭区间（像素坐标，不随预览缩放改变）：
    x/y 各 16–47、x 976–1007 与 y 16–47、x 16–47 与 y 976–1007、x/y 各 976–1007。
  - 命中条件：`R≥240 且 G≤15 且 B≥240 且 A=255`。
  - 每区 32×32 共 1024 个像素，至少 820 个命中视为角标存在；四区全部存在才合格。
    区域外的品红像素不会计入任何检测区。
  - 命中规则与 820 阈值不变，检测结果在既有字段上兼容补充缺口定位数据：
    `misses`（未命中数）、`gapBounds`（全部未命中像素的最小包围范围，
    离散缺口仍只产生唯一范围；满命中为 `null`，不伪造坐标）与
    `edgeGaps`（上/下/左/右四条边的缺口计数，角点同时计入相邻两边）。
- 像素采样在原始 1024×1024 分辨率上进行（Canvas 2D `getImageData`）；
  页面上的四个检测框只是按百分比等比映射到预览图的可视化叠加层。
- 页面逐区展示命中数（`命中 n / 1024`）与失败原因，不合格时给出缺失角标的方位。
- 有效 PNG 完成分析后，点选任一检测卡片或预览框可在审阅区查看该区的像素级证据：
  直接复用上传时采样的像素缓冲，将检测区 32×32 原始像素写入画布并以最近邻
  （`image-rendering: pixelated`）放大显示，同时展示缺口包围范围与四边缺口计数；
  切换方位只更新审阅区，不重新解码文件。新上传（含错误上传）会清除选区与裁片，
  采样失败时显示明确的环境异常且不残留任何结果。

## 本地启动

```bash
npm install
npm run dev        # http://localhost:5173
```

生产构建与本地预览：

```bash
npm run build
npm run preview
```

## 测试

```bash
npm run test                          # Vitest：像素边界、检测区几何、820/819 阈值、区外不计数、缺口定位（单边/离散/无缺口）
npx playwright install chromium       # 首次运行端到端测试前安装浏览器
npm run e2e                           # Playwright：合格/819 不合格/各类上传错误/清除旧结果/点选审阅裁片与切换选区
npm run verify                        # 依次运行以上全部
```

## Docker

```bash
# 启动页面，发布端口由 WEB_PORT 覆盖（默认 5173）
WEB_PORT=8080 docker compose up --build web

# 一次性验收服务：构建镜像、等待 web 就绪后跑完全部测试并退出
docker compose up --build --exit-code-from verify verify
```

`verify` 服务使用与 `@playwright/test` 版本一致的官方 Playwright 镜像，
在 compose 网络内以 `BASE_URL=http://web:5173` 对真实构建产物执行端到端测试。

## 目录结构

```
src/lib/detect.ts      检测核心（检测区、命中条件、阈值、缺口包围范围与四边计数、PNG 签名校验）
src/App.tsx            上传、解码、采样与结果展示
src/test/detect.test.ts  Vitest 单元测试
e2e/upload.spec.ts     Playwright 端到端测试
e2e/helpers/png.ts     最小 PNG 编码器（生成真实测试图，走浏览器原生解码）
Dockerfile             web（构建托管）与 verify（一次性验收）两个构建目标
docker-compose.yml     WEB_PORT 端口覆盖与 verify 服务编排
```
