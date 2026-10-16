# 操作指南：改这个模式自己

三个任务，每个都以"跑什么命令算通过"结束。命令都在本机跑过；失败的形状也照着跑过一遍（见每节末）。

改完任何一处，最后都过一遍 [发布前的五门检查](#改完之后)。

## 改协议正文

协议正文是 `plugin/index.js` 里的 `PROTOCOL` 常量，注册成系统提示词小节 `project-forge:protocol`（`order: 400`）。

1. 改 `PROTOCOL` 的文本。
2. 跑单测：

   ```powershell
   node plugin/index.test.mjs plugin/index.js
   ```

3. 重启 DSH。提示词进的是系统提示，**改动重启后才生效**。

单测会断言小节的**名字与 order**，以及正文里几条必须在场的条款（含恢复流程与"按需读"清单）。
按 `order` 的排布有意：400 在共享人格（0）之后、plan 策略（500）之前。改动顺序前先读 `plugin/index.js`
里那行注释，它写了为什么是 400。

**两条硬约束**（单测里有对应断言，删不掉）：提示词里不得出现日期、会话 id、本机路径、外链，也不得叙述
"某天某项目发生过什么"——新会话只需要由此产生的规则。

## 加一个守卫

守卫的形状是"返回字符串＝拒绝，返回 `undefined`＝放行"，并且**永不抛异常**：

```js
if (config.guardTabs !== false && ctx.tools !== undefined) {
  ctx.effect(
    () =>
      ctx.tools.guard((execution) => {
        if (execution.name !== 'write' && execution.name !== 'edit') return undefined;
        if (!/^\t/m.test(String(execution.arguments?.content ?? ''))) return undefined;
        return [
          'Project Forge Mode refuses this write: indentation is spaces everywhere in this repo.',
          'Re-indent and retry; the user disables `guardTabs` explicitly to override.',
        ].join(' ');
      }),
    'project-forge.tabsGuard()',
  );
}
```

1. 写上面的块（`ctx.effect(() => …, 'project-forge.<名字>Guard()')`，这个标记会出现在报错里）。
2. 加开关 `guardTabs`——**那就是一个新配置字段**，按下一节的四步同步。
3. 在 `plugin/index.test.mjs` 里补两段断言：
   - **拒绝对照**：该拒的输入必须返回字符串；
   - **不得误伤**：正常输入必须放行（守卫误伤比漏放更常见，每一条既有守卫都有这组反例）。

4. 跑单测。

拒绝消息里必须回答两件事：**为什么拒**，以及**用户怎么放行**（照上面那两行写）。

**失败的形状**：把守卫的注册整块注释掉再跑单测，退出码 1，实测原文：

```
AssertionError [ERR_ASSERTION]: the local-git guard is registered
```

——也就是说"守卫还在"这件事是被测出来的，不是靠自觉。

## 加一个配置字段

四处要同步，缺一处就会被机械检查抓住：

1. **`plugin/schema.js`**：字段 + 默认值 + JSDoc。`DEFAULTS` 是**文档默认值的唯一来源**，`docs/configuration.md` 拿它比对。
2. **`cordis.patch.yml`**：只有当你要在 preset 里用**非默认值**时才写。行配置只写非默认项，多写一行就是噪音。
3. **`docs/configuration.md`** 的表格：一行，默认值写成 **JSON 字面量**。
4. **`plugin/index.test.mjs`**：默认值断言（字段改名时，patch↔schema 守卫也会在这里拦你）。

跑这三条：

```powershell
node release/check-consistency.mjs   # 配置表 ↔ schema 逐字段；技能副本一致；公开面无退役用词
node release/check-preset-sync.mjs --source <dsh-checkout>   # 本仓 patch 行集合 ↔ 内置 standard
node plugin/index.test.mjs plugin/index.js
```

**失败的形状**：把字段加进 `schema.js` 却忘了改 `docs/configuration.md`，第一条会指名道姓——下面是实测原文：

```
✗ docs/configuration.md 没有记载字段 tabsGuard

consistency: 1 处不一致
```

漏了第 1 步的 JSDoc 则**不会**被抓住——那一条靠自查。

## 改完之后

四门检查跑一遍（发布脚本本身就是干这个的）：

```powershell
node plugin/index.test.mjs plugin/index.js
node release/check-consistency.mjs
node release/check-preset-sync.mjs --source <dsh-checkout>
node release/check-public-surface.mjs
node release/check-runtime.mjs       # 无参数即可：查技能 frontmatter 与 customSkillDirs 的目标
```

装好之后想核对"生效的是哪一份副本"、某条会话日志能否解码、生效预设是不是本模式，再带上输入跑一次：

```powershell
node release/check-runtime.mjs --session <会话日志> --copy <profile>\node_modules\dsh-project-forge --self-test
```

全过之后，镜像到发布副本并本地提交（`-NoPush` 不推远端——推送按 §1.2 要用户当次授权）：

```powershell
pwsh release/publish.ps1 -PublicRepo <公开仓> -DshSource <dsh-checkout> -NoPush
```

发布脚本会在镜像**之前**重跑这四门检查，任一不过就 `throw`、绝不触碰发布副本。
