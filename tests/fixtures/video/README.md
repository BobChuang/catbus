`tone.mp4` 是测试自制的 2 秒 MP4：160×120、4 fps 的 FFmpeg `testsrc` 画面，
加 440 Hz 正弦波音轨，H.264 / AAC 编码，不含真人声音、平台内容或凭证。

由 npm `@ffmpeg/core@0.12.10` 的 WASM 版本使用以下参数生成：

```text
-f lavfi -i testsrc=duration=2:size=160x120:rate=4
-f lavfi -i sine=frequency=440:duration=2
-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest tone.mp4
```

`fullhd.mp4` 是同一 WASM 构建生成的无音轨 1080p 样本，用于高分辨率画面导出回归：

```text
-f lavfi -i testsrc=size=1920x1080:duration=1:rate=2
-c:v libx264 -pix_fmt yuv420p -preset ultrafast fullhd.mp4
```
