# 抖音（douyin）

| | |
|---|---|
| id / 别名 | `douyin` · `dy` |
| `item` 是 | 作品（视频或图文） |
| 登录 | **扫码**（默认，写操作需要）· 短信 · cookie（只读够用） |

## 能做

- **读**：`item search` / `get` / `media` / `download` / `extract` / `summarize` / `list`（自己的）；`user get` / `search` / `items` / `likes` / `followers` / `following`；`comment list` / `replies`（也能列商品评价）；`feed list`（只有推荐）；`product get`；`live get` / `search` / `listen` / `history`（最近 15 条）/ `rank` / `products` / `media`；`notice list`；`msg listen`（收新私信）；`folder list` / `items` / `summarize`。
- **写**：`item like` / `unlike` / `collect` / `uncollect` / `publish`；`comment add`；`live send` / `like`；`msg send`；`media upload`。

**写操作目前基本跑不通**：发布、评论、点赞、收藏、私信要带设备风控头（dtrait），实测发布被拦下（报 `RISK_CONTROL`），点赞还可能让登录态失效、需要重新扫码。用户要做写操作时先把这个情况告诉他，不要在他的常用账号上反复尝试。

## 做不到

`msg list` / `history`（能发私信、能收新私信，但列不出会话和历史）、`user collects` / `follow`、`item delete` / `related`、`keyword hot` / `suggest`、`notice count`、`feed list --kind hot|following`。

## 参数

- 作品：`aweme_id`（纯数字）、`douyin.com/video/<id>`（也认 `/note/`、`?modal_id=`）、分享短链 `v.douyin.com/...`，或整段分享文案。
- 用户：`sec_uid`（`MS4wLjAB` 开头）、主页链接、分享短链或 `me`。
- 直播间：直播间号（web_rid）或 `live.douyin.com/<号>`。
- 商品评价：传商品链接，或纯 ID 加 `--product`；需要 `shop_id` 的场景传 `live products` 输出的 url。
- 收藏夹：`folder items` 接受当前账号的收藏夹 ID 或完整名称；结果按平台返回顺序，不能将作品的 `created_at` 当作收藏时间。
- 视频分析：`item extract` 提取音轨、抽样 PNG 和真实语音转写；`item summarize` 和 `folder summarize` 结合语音与画面总结。使用本地 WASM FFmpeg；Whisper 在 Apple Silicon 自动使用原生 Metal，其余系统保留 WASM，可在 transcription.runtime / device 配置；总结模型来自 `~/.catbus/ai.json` 或 `--ai-config`，不要读取或打印模型密钥。

## 筛选

`item search`：`--sort general|popular|latest`，`--time all|day|week|half_year`，`--type all|video|image`；私有选项 `--length all|short|medium|long`、`--range all|seen|unseen|following`。`--type video` 走视频频道，其余走综合频道。

`user search`：`--fans 0_1k|1k_1w|1w_10w|10w_100w|100w_`、`--user-type common|enterprise|personal`。

## 坑

- 作品没有标题，描述在 `text`，`title` 恒为 null；列表里 `stats.views` 恒为 null。
- 只导入 cookie 时写操作会在本地被拦下（`AUTH_REQUIRED`）：写操作需要扫码登录时拿到的 ticket 和私钥。
- `item publish --visibility` 支持 `public` / `private` / `friends`。
- 收藏夹总结默认 1 个视频，用户指定数量时用 `--limit`，仅明确要求全部时用 `--all`。模型调用可能收费，失败不自动换模型或重试；已有成功结果缓存。`--max-seconds` 会截取，汇报时必须说明范围，不能用作品描述代替视频内容。
- 总结默认紧凑笔记，`summary.style: "detailed"` 可改详细版；两者均发送完整转写和全部画面。gpt-6.1-sol 默认 low 推理和等尺寸 WebP，首字、生成、用量等见 `timings.summary`。流中断不写成功缓存；不要把首字等待直接解释为推理耗时，也不要把输出变短的收益都归因于流式。

## 示例

```bash
catbus douyin item search 猫 --type video --time week --limit 20
catbus douyin item get "https://v.douyin.com/xxxx/"
catbus douyin comment list <作品> --limit 100 -o jsonl
catbus douyin user items <sec_uid> --limit 50
catbus douyin folder items AI --limit 10
catbus douyin folder summarize AI --limit 3 -o jsonl
catbus douyin item extract "<视频链接>"
catbus douyin live listen <直播间号> --duration 10m
```
