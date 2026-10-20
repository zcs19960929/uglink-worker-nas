# 配置说明

## 控制台配置与本地文件

控制台将草稿和已发布配置存入本地 SQLite（Docker）或自身 KV（云端），并在发布时将非秘密配置同步到目标 Gateway 的 KV，供以后确认导入。它不会自动修改源码目录中的 `uglink.config.json`。

`uglink.config.json` 是直接使用 Wrangler 部署 Gateway 时的输入文件。`npm run config:generate` 读取它和 `wrangler.gateway.jsonc`，生成 `wrangler.gateway.generated.json`。

## Gateway 配置示例

```json
{
  "$schema": "./uglink.config.schema.json",
  "version": 2,
  "uglink": {
    "id": "your-uglink-id",
    "username": "your-nas-login-username"
  },
  "services": [
    {
      "name": "nas-admin",
      "hostname": "nas.example.com",
      "port": 8443,
      "enabled": true
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `uglink.id` | 设备的 UGREENlink ID |
| `uglink.username` | NAS 网页端使用的本地登录用户名 |
| `services[].name` | 用于识别服务的名称 |
| `services[].hostname` | 绑定到 Gateway 的自定义域名 |
| `services[].port` | NAS 上目标服务的端口 |
| `services[].enabled` | 是否发布此服务映射，省略时启用 |

每个启用的服务使用独立域名。密码不放入此文件，而是作为 Gateway 的 `PASSWORD` Secret 配置。密码更新后，应在控制台重新输入并发布，或通过 Wrangler 更新同一个 Secret。

完整字段约束见 [`uglink.config.schema.json`](../uglink.config.schema.json)。本地文件可通过 `npm run config:validate` 检查。

## 各配置文件的用途

| 文件 | 用途 |
| --- | --- |
| `wrangler.jsonc` | 控制台开发和云端部署 |
| `wrangler.gateway.jsonc` | 独立部署 Gateway 的基础配置 |
| `wrangler.gateway.bundle.jsonc` | 将 Gateway 打包到控制台中，供控制台发布 |
| `src/interfaces/http/console/node-entry.ts` | Docker 的 Node.js 启动入口及旧数据迁移 |
| `.env` | Docker Compose 的变量替换输入 |
| `.dev.vars` | 本地 Wrangler/Vite 开发使用的密钥 |

这些文件对应不同运行方式，不应合并成一个部署配置。`.env`、`.dev.vars`、生成文件和运行时状态均不应提交。

## Gateway 会话协调

Gateway 通过 `UGLINK_SESSIONS` 绑定访问 `UgreenSessionCoordinator` SQLite Durable Object。同一 NAS 凭据的请求路由到同一个对象，按端口缓存代理会话，串行执行登录；凭据变更后使用新的对象。对象存储会话 Cookie 和带有效期的认证退避状态，不保存 NAS 密码。`UGLINK_CACHE` KV 继续保存用于云端配置导入的非秘密配置，不再承担登录锁和代理会话存储。

控制台发布和 Wrangler 部署都会自动创建所需绑定及首次类迁移，后续覆盖部署复用现有对象。升级时先更新控制台，再执行「故障诊断 → 覆盖部署」；只更新控制台不会更新 Gateway。首次访问会重新建立代理会话，不读取旧 KV 中的登录占位或代理 Cookie。

瞬时认证网络错误、超时及 HTTP 429/5xx 退避 30 秒，密码错误等拒绝退避 10 分钟，账号锁定或来源封禁退避 30 分钟，OTP 等限制退避 60 分钟。普通应用 HTTP 502/503/504 只对无请求体的 GET、HEAD、OPTIONS 重试一次；POST、上传和 WebSocket 升级不会自动重放。

返回 [项目首页](../README.md) · [部署与备份](deployment.md)。

反向代理和多入口参数见 [部署文档：多入口与反向代理来源配置](deployment.md#多入口与反向代理来源配置)。来源必须精确匹配，可信代理只按实际 socket 对端配置；不能用允许来源列表替代代理信任或 CSRF 校验。
