# Reader Sync By 🐟

让本地剧集视频、外挂字幕和 `aim-read.top` 阅读页在浏览器里真正联动起来。

这是一个面向英语剧集精读场景的 Chrome Manifest V3 扩展。你只需要：

1. 打开一个已经登录的 `aim-read` 阅读页
2. 在扩展里拖入本地视频
3. 再拖入字幕文件
4. 从“阅读页绑定”下拉框里手动选择目标页面

扩展就会自动抓取全文、基于字幕做运行时对齐，并把播放器与阅读页双向同步。

## 亮点

- 原生浏览器 `<video>` 播放，不依赖本地桌面程序
- 直接支持 `.ass` `.ssa` `.srt` `.vtt` 字幕文件拖入
- 自动抓取真实 `aim-read` 页面全文，不使用模拟数据
- 支持字幕到段落的运行时匹配与平滑补段
- 支持阅读页与播放器双向控制
- 内置 FFmpeg WASM，可在扩展里做本地媒体兼容检测与选择性预处理
- 多个阅读页同时打开时，可通过下拉框手动绑定目标页面

## 适合谁

- 想一边看剧一边精读台词的人
- 已经在 `aim-read` 上做分段阅读、解析和跟读的人
- 想把“本地片源 + 外挂字幕 + 阅读页”合成一个统一工作流的人

## 当前支持

- 浏览器：Chrome / Chromium 系列，建议 `120+`
- 阅读站点：`https://aim-read.top/*`
- 本地视频：常见 `mp4 / mkv / mov / webm / avi`
- 字幕：`ass / ssa / srt / vtt`

## 快速开始

### 1. 安装发布版扩展

本仓库 `releases/` 目录会提供已经打包好的扩展 ZIP。

解压后，在 Chrome 中打开：

`chrome://extensions`

然后：

1. 打开“开发者模式”
2. 点击“加载已解压的扩展程序”
3. 选择解压后的扩展目录

### 2. 使用流程

1. 先在浏览器里打开并登录 `aim-read`
2. 打开你要同步的剧集阅读页
3. 打开扩展页
4. 拖入本地视频文件
5. 拖入字幕文件
6. 在“阅读页绑定”下拉框里手动选择当前阅读页
7. 点击“绑定所选页面”
8. 等待全文抓取与运行时匹配完成

之后你可以：

- 在播放器里播放、拖动进度、切换倍速
- 在阅读页里使用快捷键控制播放器
- 点击阅读页段落反向跳转视频

## 从源码构建

```bash
npm install
npm run check
npm run build
```

构建完成后，扩展产物会出现在：

`dist/`

## 目录结构

```text
src/
  background/    MV3 service worker
  content/       aim-read 页面注入与段落控制
  player/        扩展播放器页面与 FFmpeg 兼容处理
  shared/        协议、对齐逻辑、字幕解析
public/
  manifest.json
scripts/
  build.mjs
```

## 隐私与数据说明

- 扩展只处理你当前浏览器里已经登录的 `aim-read` 页面
- 视频和字幕都在本地浏览器环境中处理
- 运行时预处理依赖打包进扩展内的 FFmpeg WASM 资源
- 本公开仓库已去除作者本地测试档案、登录状态、实验素材和私有运行痕迹

## 已知边界

- `aim-read` 页面如果站点本身加载很慢，同步初始化也会跟着变慢
- 某些 `mkv` / 音频编码组合可能无法直接播放，需要先走扩展内预处理
- 当前目标站点结构发生较大变更时，页面抓取逻辑可能需要同步调整

## 许可证

本仓库采用 **PolyForm Noncommercial 1.0.0**。

这意味着：

- 欢迎个人学习、研究、非商业试用和二次修改
- 不允许将本项目或其衍生版本用于商业用途

详细条款见根目录的 [LICENSE.md](LICENSE.md)。

## 致谢

- `aim-read` 提供阅读页承载环境
- `@ffmpeg/ffmpeg` / `@ffmpeg/core`
- `esbuild`
- 所有帮助测试和提出实际工作流反馈的人

## 项目链接

- GitHub: [https://github.com/LCYLYM/lqreadervideosync](https://github.com/LCYLYM/lqreadervideosync)
