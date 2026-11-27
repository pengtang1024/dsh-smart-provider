# 发布指南（Release Guide）

本文件说明 `dsh-smart-provider` 的发布渠道与操作步骤。**当前上架 PR 已提交（[#19362](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/19362)，OPEN，待审核，尚未合并/收录）**。当前版本以 `package.json` 为准（`2.10.1`），本文不修改任何版本号。

## 一、两套机制，不要混淆

| 机制 | 收录入口 | 写入方式 |
|---|---|---|
| 社区市场 | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的 `data/plugins/<owner>__<repo>.yml` | 向该仓库提 PR 新增 YAML；站点/市场自动收录（通常一天内）。不要向市场应用仓库提条目。 |
| 官方 format-1 索引 | `@deepseek-ai/dsh-plugin-market` / Web Discover 页 / `plugin_market` 工具 | 无中央条目仓库，默认零索引源，工具只读；本节 PR 不会生成 format-1 条目。Discover 页仅可用作查看入口。 |

安装来源优先级：**npm 包 → 作者在 GitHub Release 提供的 `.tgz` 预构建包 → GitHub 源码归档**。本包已按公共 npm 包配置/发布流程（`dsh-smart-provider`、`publishConfig.access=public`；npm 首发正在 staging 审批中，不宣称已上架指定版本），市场条目按 npm-first 填写；`tarball` 只在 Release 附件上传成功后填写，未上传时保持注释、不写占位 URL。

## 二、打 GitHub Release 与 `.tgz` 预构建包

1. 在仓库 `https://github.com/pengtang1024/dsh-smart-provider` 上确认代码、测试与版本号三处一致（发布前核对，`package.json` version / `client.js` 的 `PLUGIN_VERSION` / `CHANGELOG.md` 顶部正式版本号）。tag 用 `v<version>`，例如 `v2.10.1`。
2. 打包根目录必须是**仓库根目录**，`package.json` 的 `files` 字段已列全运行时文件：`index.js`、`client.js`、`schema.js`、`lib`、`registry`、`cordis.patch.yml`、`README.md`、`locale/*.json`、`docs`、`scripts`、`icon.svg`；`test/` 与 `RELEASE.md` 不在清单内，不必塞进发布包。包内结构建议：

   ```
   package/
   ├── package.json
   ├── cordis.patch.yml
   ├── index.js
   ├── client.js
   ├── schema.js
   ├── lib/
   ├── registry/
   ├── scripts/
   ├── locale/
   ├── docs/
   ├── README.md
   └── icon.svg
   ```

   压缩包本身可以是 `dsh-smart-provider-<version>.tgz`；生成后先解包核对 `package/package.json` 与上述目录齐全。
3. 用 `gh release create v<version> <tgz> --title "v<version>" ...` 或 GitHub 网页新建 Release，把 `.tgz` 作为附件上传，记下附件直链（形如 `https://github.com/pengtang1024/dsh-smart-provider/releases/download/v<version>/<asset>.tgz`）。
4. 只有附件确实上传成功后，才把该直链填入 awesome-dsh-plugin 条目的 `tarball:`；不要预填占位 URL。没有 Release 包时删掉/注释 `tarball`，让市场回退到 GitHub 源码归档。
5. `icon` 可选项只接受 GitHub 托管的位图（png / jpg / jpeg / webp），例如 `raw.githubusercontent.com` 上的图片直链；本仓库只有 `icon.svg`（SVG 不符合位图约束），暂不填。

## 三、向 awesome-dsh-plugin 提 PR

1. Fork 或 clone `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，新建分支。
2. 新增 `data/plugins/pengtang1024__dsh-smart-provider.yml`，内容以本仓库的草稿 `marketplace/pengtang1024__dsh-smart-provider.yml` 为准；文件名与 `url` 的 owner/repo slug 一致。
3. 字段约束（CI 强制项）：
   - `url` 为本仓库 HTTPS 地址，`name` 为 `pengtang1024/dsh-smart-provider`；
   - `category: model`（合法值之一，表示模型与账号接入）；
   - `description.en` 单行非空、以句号结尾；`description.zh` 一句话、以句号结尾；
   - `icon` / `tarball` 若填写，必须是 GitHub 托管、类型正确（位图 png/jpg/jpeg/webp；`.tgz`）的直链；
   - 仓库 `package.json` 已声明 `dsh.bundle`（`patch` + `client`），满足收录前提；
   - 仓库创建时间须满 1 天；
   - `README.md` 由该仓库 CI 生成，不要手改。
4. 提交 PR 并等待 CI；合并后站点/市场通常一天内自动收录。

## 四、验收 / 复核要点

- 一天内在 `https://awesome-dsh-plugin.com/plugins.json` 中核对新增条目（`name` / `url` / `category` / 描述与草稿一致）。
- 在 DSH Web 的 **Plugins → Discover** 页核对条目出现、分类正确、图标/安装来源显示符合预期；注意此页是官方 format-1 索引的查看入口，与社区收录是两套机制。
- 从 Discover 安装一次（或在隔离 profile 中用本地路径安装验证包结构），确认 `cordis.patch.yml` 生效、设置页可读可写、`node scripts/run-tests.mjs` 绿。
- 复核 `tarball` 直链可下载、解包后 `package/` 目录结构与上节一致；若未填 `tarball`，确认回退到源码归档可安装。
