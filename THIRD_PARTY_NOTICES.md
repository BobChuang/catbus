# 视频分析依赖说明

catbus 的自有代码沿用仓库 MIT 许可证。新增的视频分析依赖由 npm 独立分发，
各依赖适用其自身许可证及源代码中的第三方声明：

- `@ffmpeg/core@0.12.10`：FFmpeg 单线程 WebAssembly 构建，包声明
  `GPL-2.0-or-later`。源码与构建脚本：<https://github.com/ffmpegwasm/ffmpeg.wasm>。
  FFmpeg 源码：<https://ffmpeg.org/download.html>。
- `whisper.cpp@1.0.3`：Whisper 的 Node.js / WebAssembly 绑定，MIT。
  源码：<https://github.com/ggml-org/whisper.cpp/tree/master/bindings/javascript>。
- 本地语音模型来自官方 `ggerganov/whisper.cpp` 模型仓库，固定于
  `5359861c739e955e79d9a303bcbc70fb988958b1`，下载后核验文件大小和 SHA256。
  模型说明与许可证：<https://huggingface.co/ggerganov/whisper.cpp>。

原流程参考 `byjlw/video-analyzer` 的音轨提取、画面采样、语音与画面联合总结思路，
在 catbus 中独立用 TypeScript 实现；不复制其 Python 实现，不调用其运行环境。
项目源码：<https://github.com/byjlw/video-analyzer>。

## 可选原生 Whisper 加速包

`@fugood/node-whisper-darwin-arm64@1.2.0-rc.1`：MIT，预编译 Node-API 绑定，
使用 macOS 自带的 Metal / Accelerate 框架，无安装脚本。
源码及绑定说明：https://github.com/mybigday/whisper.node 。
上游完整源码亦包含于同版本 `@fugood/whisper.node` npm 源码包。

MIT License

Copyright (c) 2025 ggml / whisper.cpp contributors
Copyright (c) 2025 Jhen-Jie Hong <developer@jhen.me>
Copyright (c) 2025 Hans Chen <hans.chen@bricks.tools>
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
