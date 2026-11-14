# plugins/

自研插件目录。**一个子目录 = 一个 npm 包 = 一个组合包（bundle）。**

镜像构建时会自动把这里每个子目录 `npm pack` 成 tarball 并 `dsh plugin add` 装进 profile，不需要在 `plugins.txt` 里登记（那里只放第三方的包）。

## 新增一个插件

```bash
cp -r plugins/hello-dsh plugins/my-plugin
```

然后按顺序改：

1. `plugins/my-plugin/package.json` → `name`（团队 scope，如 `@colony-agents/my-plugin`）、`version`、`description`
2. `plugins/my-plugin/cordis.patch.yml` → `id` 和 `name`
3. `plugins/my-plugin/index.js` → 实现；多个行就拆成多个文件，patch 里一行一个

`make image` 之后，容器里的 `dsh --profile web --dump-config` 应当能看到你的行。

## 为什么是纯 JS

dsh 的类型包在 npm 上只发到 `0.0.1-rc.1`，和运行时的 `0.2.x` 差一个大版本，类型不可信。所以样板走纯 ESM JS + JSDoc：

- 没有构建步骤，`npm pack` 直接可用，CI 里少一个失败点；
- 类型靠 JSDoc 的 `import('...').Context` 拿到编辑器提示，不影响运行。

想上 TypeScript 也可以：加 `tsdown` 只转译不做类型检查，并把 `prepack` 指向它，让 `npm pack` 自动构建。**不要**在 CI 里跑 `tsc --noEmit` 卡住交付，除非你把 `@deepseek-ai/dsh-tools` 升到与运行时同版本。
