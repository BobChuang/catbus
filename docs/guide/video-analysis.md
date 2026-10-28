# 用 CLI 提取和总结抖音视频

支持单个视频和收藏夹。先下载真实视频，再在本机提取音轨、采样画面、运行 Whisper
语音转写，最后将转写和画面发给你配置的模型服务生成中文总结。

运行时只需要 Node：FFmpeg 和 Whisper 的 WASM 随 npm 依赖安装，无需 Python、
系统 FFmpeg 或编译器。首次本地转写需要下载并校验 Whisper 模型，随后使用本地缓存。

Apple Silicon Mac 默认自动使用随 npm 安装的原生预编译包，通过 Metal 加速；
无需 Python、Homebrew、Xcode 命令行工具或现场编译。原生包不可用时明确报告并回退 WASM，
其他系统继续使用 WASM。音轨不会因启用 GPU 而上传。

## 模型配置

默认读取 `~/.catbus/ai.json`。可用 `--ai-config <文件>` 或 `CATBUS_AI_CONFIG`
指定其他文件；权限建议为 0600。示例中的地址和密钥需要换成你的服务配置：

```json
{
  "base_url": "https://your-api.example/v1",
  "api_key": "YOUR_API_KEY",
  "model": "gpt-6.1-sol",
  "timeout": 180,
  "max_output_tokens": 8192,
  "transcription": {
    "engine": "local",
    "model": "base"
  }
}
```

`--model` 覆盖总结模型；`CATBUS_AI_MODEL`、`CATBUS_AI_BASE_URL` 和
`CATBUS_AI_API_KEY` 分别覆盖文件里的模型、接口地址、密钥。密钥不会出现在命令结果、
分析文件或调试日志中。模型接口使用 `/chat/completions`，需要支持文字和图片输入。

默认总结使用 `standard` 风格，目标约 1000–1600 个中文字，合并重复观点，保留主要步骤、
必要数字和后半段结论。需要更长的笔记时，在模型 JSON 中添加：

```json
{"summary":{"style":"detailed"}}
```

两种风格都发送完整转写和全部抽样画面。转写以紧凑时间轴发送一次；如果旧转写的时间段
与全文不匹配，则保留全文。gpt-6.1-sol 默认使用 `reasoning_effort: "low"`、
等尺寸 WebP 上传副本（质量 92）和流式响应；原始 PNG 不变，不缩小画面。
`summary.reasoning_effort` 可显式设为 `default`（省略请求参数）、`low`、`medium`、
`high`、`xhigh`、`max`；`summary.image_format` 可设为 `png` 使用原图。
其他模型默认不加推理强度参数、使用 PNG。接口不支持流式时可配置 `summary.stream: false`；
服务直接返回 JSON 时也能在同一次请求中读取，不重新请求。

流式用于首字反馈及计时，stdout 仍只输出完整 JSON；不自动重试收费请求，不切换模型。
生成输出通常占主要耗时，详细笔记仍可能耗时较长。减少重复输入、降低推理强度和更紧凑的
输出共同优化默认流程，流式本身不保证缩短模型生成时间。

也接受原 video-analyzer 的模型 JSON，或包含 `MODEL_URL`、`MODEL_API_KEY`、`MODEL`
的 `.env` 文件：

```bash
catbus douyin item summarize "<视频链接>" --ai-config /path/to/video-analyzer/.env --model gpt-6.1-sol
```

本地 Whisper 默认 `base`（约 142 MiB），也支持 `tiny`（约 75 MiB），以及通过
`transcription.model_path` 指定兼容的本地 ggml 模型。相对路径相对配置文件解析。
缓存位于 `~/.catbus/cache/whisper/`，文件固定版本并校验 SHA256。

本地转写可在 `transcription` 中设置 `concurrency`（1–8，默认按机器资源）、
`max_retries`（0–3，默认 2）和 `chunk_timeout`（秒，30–1800，默认 300）。
只有本地进程暂时性失败或超时会重试，且只重试失败段；取消、无效模型和输入错误不重试。
远程转写和总结请求不自动重试。

`transcription.runtime` 支持 `auto`（默认）、`native`、`wasm`；
`device` 支持 `auto`（默认）、`metal`、`cpu`。macOS arm64 的 auto 优先 Metal，
可用原生 CPU 作为替代；显式 `device: "metal"` 不会静默使用 CPU，显式 `runtime: "native"`
不回退 WASM。原生后端在一条视频中复用模型，逐段串行推理，内部使用 4 个 CPU 线程；
`concurrency` 仅控制 WASM 分段并发。可使用以下设置进行对比：

```json
{"transcription":{"engine":"local","model":"base","runtime":"native","device":"metal"}}
```

改为 `device: "cpu"` 可测试原生 CPU；改为 `runtime: "wasm", device: "cpu"` 可测试 WASM。
不同运行时、设备和版本分别缓存。结果和计时中有 `runtime`、`backend`、`runtime_version`；
`timings.transcription.backend_evidence` 包含 Metal 实际选用后端的日志证据，设备枚举本身不代表 GPU 已启用。

单纯运行 `item extract` 时无需配置总结模型地址或密钥。

## 常用命令

```bash
# 提取完整视频的音轨、语音文本和 8 张抽样画面
catbus douyin item extract "<视频链接>"

# 根据真实口播和画面总结一个完整视频
catbus douyin item summarize "<视频链接>"

# 总结 AI 收藏夹前 10 个视频；一行输出一个结果
catbus douyin folder summarize AI --limit 10 -o jsonl > ai-summaries.jsonl 2> ai-progress.log

# 指定产物目录
catbus douyin folder summarize AI --limit 3 --dir ./video-notes

# 先分析首个视频的前 20 秒试运行
catbus douyin folder summarize AI --limit 1 --max-seconds 20 --max-frames 3
```

收藏夹接受 ID 或完整名称，按平台顺序读取并跳过图文。默认只总结 **1 个视频**，
`--limit N` 指定数量，`--all` 才处理整个收藏夹。逐条处理，按需调用模型，
不会先分析一整页再截断结果。模型服务的调用按该服务规则计费。

`--max-frames` 默认 8、最多 32。`--max-seconds` 显式限制视频范围；不传时处理完整视频。
截取范围同时写入结果和 Markdown，不能把片段总结当成完整视频总结。

## 产物与缓存

每段视频保留：

- 下载的视频、16 kHz 单声道 `audio.wav`（无音轨时为空）及抽样 PNG 画面。
- `transcript.txt`：本地 Whisper 转写文本。
- `content.json`：转写时间段、画面路径、原视频时长和实际处理范围。
- `analysis.json`：结构化总结结果；`summary.md`：可直接阅读的中文笔记。
- `runs/<run-id>.json`：本次调用的阶段耗时、缓存命中、分段耗时、尝试次数和总体耗时；失败也保留记录。

默认放在 `~/.catbus/cache/douyin/analysis/`。设置 `--dir` 后放在该目录下的
`douyin_<id>/`，其中 `media/` 缓存原视频、`extractions/` 缓存音轨和画面、
`transcripts/` 缓存转写及独立分段、`contents/` 保存提取结果、`summaries/` 保存总结。
总结结果的 `files`、提取结果的 `files` 给出准确路径；`files.metrics` 和 `timings` 总是属于本次调用。

已完成的提取、转写和总结会复用，`cached: true` 表示命中了总结缓存。
更换总结模型只重做总结；调整画面数量不重新下载视频，音轨内容相同则复用转写；
更换转写模型或语言不重新下载或抽帧。缓存绑定实际媒体、音轨、模型内容哈希及相关参数。
缺失、损坏或不匹配时只重做受影响阶段。`--refresh` 重新下载、提取、转写和总结。
本地长音轨按 30 秒分段。WASM 每段在独立 Node 子进程中单线程推理，
按 CPU 和内存最多并发 8 段；原生后端在常驻 Node 子进程中复用模型，避免反复加载和 GPU 争抢。
每个完成段立即原子写入 `chunks/<index>.json`，包含乱序完成的段落；中断或失败后只补缺失段，
最终按原始时间顺序合并。旧版目录保留，新分层缓存不覆盖旧产物。

每次调用的 `timings.stages` 包含解析、下载、提取、转写、总结和保存的毫秒耗时及缓存标志。
`timings.transcription` 提供本次各段的耗时、尝试次数、缓存数和重试数，计时用单调时钟。
`timings.summary` 提供请求准备、响应头、首事件、首个可见字、后续生成、模型请求总耗时、
请求字节、画面数、转写字数和输出字数；服务提供时记录 token 用量及响应模型。
首字等待包含上传、网络、服务排队、输入处理等，不能单独当作推理耗时。
JSON 兼容响应无法测量首字，相关字段为 null；总结缓存命中时不复制上次的网络耗时。
风格、推理、编码、流式设置与提示词版本参与总结缓存键，只改变这些设置不会重新转写。
流中断、取消、空输出或长度截断均不写成功总结缓存；重跑复用已完成的提取和转写。
同一命令重跑时，业务结果可命中缓存，但会生成独立的本次计时文件。
原生输出时间戳会裁剪到真实音轨范围，避免解码窗口补零造成越界；不改写识别文本。
运行时版本升级可能改变转写文字，自动转写仍需根据用途校对。

批量结果的 `page.cursor` 可用于继续：

```bash
catbus douyin folder summarize AI --limit 10 --cursor "<上次的 page.cursor>" -o jsonl
```

游标绑定收藏夹，原样复制即可。JSONL 模式的摘要信封在 stderr 最后一行，
已有成功条目先行输出；错误时停止后续处理，避免继续产生费用。

## 读取依据与限制

- 本地转写时，音轨不上传。总结服务接收转写文本和抽样画面；不会收到抖音 Cookie、
  视频下载鉴权或模型密钥以外的平台凭证。
- 没有音轨或没有识别到语音时，总结明确标记为仅依据抽样画面。提取失败直接报错，
  不使用作品描述冒充视频内容。Whisper 转写仍可能出现识别错误，可对照 `transcript.txt` 校对。
- 当前本地 WASM 提取支持不超过 256 MiB 的视频文件。长视频的本地转写耗时随长度增长，
  本地处理连续 30 分钟没有进度时超时；可用 `--max-seconds` 选择片段。
- 模型不可用、额度不足、响应为空或输出被截断时，返回错误，不自动改用其他模型或服务。
- 可显式配置 `transcription.engine: "api"`，并独立提供转写服务的 `base_url`、`api_key`、
  `model`。此时音轨将上传该配置的服务，每段最多 10 分钟，并恢复段落时间偏移。
- FFmpeg WASM 及其他依赖的许可证与来源见仓库 `THIRD_PARTY_NOTICES.md`。
