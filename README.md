# MSCMS v14 — Multi-Stream Content Management System

> 多流内容管理系统 · 自动注册 · 拟人化养号 · 因果链编排 · Windows/macOS 桌面应用
> 版本 **14.5.0**（2026-09-04 加入系统用户鉴权、桌面端打包、双栈登录入口）
> License: **MIT**（核心代码） + **MIT**（依赖：electron / electron-builder / bcryptjs / jsonwebtoken）

---

## 1. 后台地址（Backend Address）

### 1.1 服务端口
| 端口 | 进程 | 用途 |
| --- | --- | --- |
| **`3002`** | `server.js`（Express IIFE，~10k 行） | 主服务，含 50 云手机因果链 + 系统鉴权 + 数据存储 |
| **`3005`** | `tumblr-nurture-server.js` | 移动端设备池 + 自愈养号（Tumblr 专用，约 100 账号） |
| **`3010`** | `content-gen-server.js` | 内容生成（Agnes AI 生图 + MPT 短视频） |
| **`3307`** | MySQL 经典协议 | `affiliate_system` 库，影子表（user `root` 空密码） |
| **`10808`** | 本机 HTTP/SOCKS 代理 | Tumblr API 出网（不能用于 Capsolver） |

### 1.2 登录入口
| 入口 | 地址 |
| --- | --- |
| 本地（开发 / Electron 内嵌） | **`http://localhost:3002/login.html`** |
| 隧道（公网） | **`https://mscms.lokfeel.com/login.html`**（次级 `https://v14.lokfeel.com/login.html`） |
| 用户管理（仅 admin） | **`http://localhost:3002/user-manager.html`** |
| 主控台 | **`http://localhost:3002/v14-console.html`** 或 `https://mscms.lokfeel.com/v14-console.html` |

### 1.3 首次登录凭据
| 项 | 值 |
| --- | --- |
| 用户名 | `admin` |
| 初始密码 | `MSCMS@2026` |
| 角色 | `系统管理员（admin）` |
| 强制要求 | **首次登录后立即修改密码**（走 `user-manager.html` → 重置密码，或自助改密 `POST /api/v14/auth/users/:id/change-`） |

> ⚠️ 默认密码仅用于首次引导。生产部署务必在首次登录后立刻改密。

---

## 2. 系统登录与账户体系

### 2.1 登录流程
1. 打开 `/login.html`（或访问 `/v14-console.html` 会自动 302 到登录页带 `redirect=` 参数）
2. 输入用户名 + 密码
3. 服务端返回 24h JWT（HS256，header `: Bearer <token>`） + 7d refresh token
4. Token 存到 `localStorage.`，刷新由 401 自动跳登录
5. 退出登录 → 清 localStorage + 把 JTI 加入黑名单（重启失效）

### 2.2 三级 RBAC 角色

| 角色 | 中文 | 权限 |
| --- | --- | --- |
| `admin` | 系统管理员 | **全部**（用户 CRUD + 数据读写 + 触发执行 + 发布执行 + 审计） |
| `` | 运营操作员 | `data:read/write`、`system:read`、`trigger:execute`、`publish:execute` |
| `viewer` | 只读观察员 | `data:read`、`system:read`（无任何写入） |

权限矩阵可在 `user-manager.html → "角色权限"` Tab 查看。

### 2.3 用户管理操作
入口：`/user-manager.html`（仅 admin 可访问，/viewer 看不到数据）。

支持动作：
- **新建用户**（+ 用户名 + 角色 + 显示名 + 邮箱）
- **编辑**（重命名 / 改角色 / 改邮箱）
- **重置密码**（admin 直接给用户一个新密码）
- **禁用 / 启用**（禁用后该用户无法登录，已签发的 token 立即失效）
- **删除**（禁止删除 `admin` 与最后一个 admin）
- **审计日志**（最近 200 条含登录成功/失败、用户 CRUD、改密、令牌刷新）

API 端点（详见 §6）：

| 方法 | 路径 | 角色 |
| --- | --- | --- |
| POST | `/api/v14/auth/login` | 公开 |
| POST | `/api/v14/auth/refresh` | 公开 |
| GET  | `/api/v14/auth/me` | 鉴权 |
| POST | `/api/v14/auth/logout` | 鉴权 |
| GET  | `/api/v14/auth/users` | admin |
| POST | `/api/v14/auth/users` | admin |
| PATCH| `/api/v14/auth/users/:id` | admin |
| DELETE| `/api/v14/auth/users/:id` | admin |
| POST | `/api/v14/auth/users/:id/reset` | admin |
| POST | `/api/v14/auth/users/:id/change-` | self / admin |
| GET  | `/api/v14/auth/audit` | admin |
| GET  | `/api/v14/auth/roles` | 公开 |
| GET  | `/api/v14/auth/snapshot` | 公开 |

---

## 3. 首次启动必做清单

### 3.1 数据落 D 盘（铁律）
所有运行时数据必须写入 `D:/mscms-ws/data/`，**禁止 C 盘**。通过环境变量激活：
```bash
DATA_DIR='D:/mscms-ws/data' \
MSCMS_TMP_DIR='D:/mscms-tmp' \
TEMP='D:/mscms-tmp' TMP='D:/mscms-tmp' \
... 启动 server.js ...
```

如果服务是用 `MSCMS-v14-Desktop/MSCMS.exe`（Electron 桌面）启动的，桌面程序会自动设置这些环境变量。

### 3.2 修改默认密码
1. 用 `admin` / `MSCMS@2026` 登录 `https://mscms.lokfeel.com/login.html`
2. 进入 `user-manager.html`
3. 操作：详情 → 重置密码 → 输入新密码（≥8 位，包含字母+数字）
4. 退出 → 用新密码重新登录

### 3.3 创建岗位账号
按运营分工创建：
- 1 个 `` 给日常运营（养号 / 发布 / 数据校正）
- 1 个 `viewer` 给外部审计 / 客户查数据（只读）
- 至少保留 1 个 `admin`（不能禁掉或删除最后 1 个 admin）

---

## 4. 桌面应用（Windows + macOS）

> 用途：把整个 MSCMS v14 打包成单文件 `.exe`（Windows）/ `.dmg`（macOS），用户双击即用，无需另开终端。

### 4.1 开源依赖（GitHub MIT）
| 包 | 版本 | License | 仓库 |
| --- | --- | --- | --- |
| `electron` | 33.4.11 | MIT | https://github.com/electron/electron |
| `electron-builder` | 25.1.8 | MIT | https://github.com/electron-userland/electron-builder |
| `bcryptjs` | 2.4.3 | MIT | https://github.com/dcodeIO/bcrypt.js |
| `jsonwebtoken` | 9.0.2 | MIT | https://github.com/auth0/node-jsonwebtoken |

### 4.2 目录结构
```
MSCMS-v14-Desktop/
├── package.json              # electron-builder 配置（Windows + macOS targets）
├── main.js                   # Electron 主进程（自动启动/守护 server.js）
├── preload.js                # 上下文桥（API surface）
├── build.ps1                 # Windows 构建脚本（NSIS installer + portable）
├── build.sh                  # macOS/Linux 构建脚本（DMG universal / AppImage）
├── BUILDING.md               # 构建手册（故障排查）
├── resources/app/            # 应用资源
│   ├── main.js               # 运行时包装（同 top-level）
│   ├── preload.js
│   └── icon.ico / icon.icns  # 应用图标（缺失时需补）
└── dist-desktop/             # 构建产物输出（构建时生成）
    ├── MSCMS Setup 14.5.0.exe       (NSIS 安装包)
    ├── MSCMS-14.5.0-portable.exe    (便携版，单文件)
    ├── MSCMS-14.5.0-arm64.dmg       (Apple Silicon)
    └── MSCMS-14.5.0.dmg             (Intel)
```

### 4.3 构建命令

#### Windows
```powershell
cd MSCMS-v14-Desktop
.\build.ps1                                    # 默认：NSIS + portable
.\build.ps1 -Target nsis                       # 仅 NSIS 安装包
.\build.ps1 -Target portable                   # 仅便携版（单文件）
.\build.ps1 -SkipInstall                       # 跳过 npm install（已装过后）
.\build.ps1 -NoSign                            # 跳过代码签名（开发版）
```

#### macOS / Linux
```bash
cd MSCMS-v14-Desktop
./build.sh                                     # 默认：macOS universal DMG
./build.sh --target mac:arm64                  # 仅 Apple Silicon
./build.sh --target mac:x64                    # 仅 Intel Mac
./build.sh --target linux                      # Linux AppImage
./build.sh --skip-install                      # 跳过 npm install
```

> **首次构建**：约 3-5 分钟（electron / electron-builder 约 250MB）。
> **增量构建**：约 30-60 秒。

### 4.4 安装后效果
1. 双击 `MSCMS Setup 14.5.0.exe` 安装到 `C:\Program Files\MSCMS v14\`
2. 启动后自动拉起 `server.js`（3002）+ `tumblr-nurture-server.js`（3005）
3. 自动弹出 `http://localhost:3002/login.html`
4. 卸载时自动停止所有 Node 进程

---

## 5. 常见问题

### 5.1 忘记 admin 密码
```bash
# 用本地 Node 直接重置（绕过 HTTP）
cd "C:/Users/AS/WorkBuddy/2026-06-13-19-42-19"
node -e "
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = 'D:/mscms-ws/data/system_users.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const u = data.users.find(x => x. === 'admin');
u.Hash = bcrypt.hashSync('NEW_PASSWORD_HERE', 10);
u.updatedAt = new Date().toISOString();
fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('admin  reset to: NEW_PASSWORD_HERE');
"
# 然后重启 server.js 让缓存重建
```

### 5.2 端口被占用
```bash
netstat -ano | findstr ":3002"   # Windows
lsof -i:3002                      # macOS/Linux
# 用 PowerShell Stop-Process / kill -9 杀占用的 PID
```

### 5.3 JWT secret 重置
删除 `D:/mscms-ws/data/` 会强制所有 token 失效（下次启动重新生成）。所有用户需重新登录。

---

## 6. API 速查

### 系统
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v14/system/info` | 后端地址 / 版本 / 角色矩阵（公开） |
| GET | `/api/v14/system/status` | 系统就绪状态（流量/DAU/设备） |

### 因果链
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v14/causal-chain/status` | 因果链 7 阶段推进状态 |
| GET | `/api/v14/data/overview` | 全部数据模块概览（52 个 JSON 模块） |
| GET | `/api/v14/data/:module` | 单个数据模块 |
| GET | `/api/v14/data/trace/:id` | 单条因果事件追踪 |

### 发布器
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v14/publisher/quota` | 发布配额诊断 |
| POST | `/api/v14/publisher/enqueue` | 入队一条发布任务 |
| GET | `/api/v14/publisher/history` | 历史发布 |

完整 API：350+ v14 路由 + 33 v1 路由 + 24 未版本化路由。

---

## 7. 系统架构速览

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 桌面 (Windows + macOS)                            │
│  ├── main.js (Node 主进程, 守护 + 启动 server.js)           │
│  └── Renderer (登录 / 控制台 / 用户管理 / 50 业务页面)     │
└─────────────────────────────────────────────────────────────┘
                            ↓ HTTPS / WSS
┌─────────────────────────────────────────────────────────────┐
│  server.js (:3002) — Express IIFE, 10116 行                │
│  ├── 鉴权子系统（auth-manager.js，bcryptjs + JWT HS256）   │
│  ├── 系统用户 CRUD（/api/v14/auth/users[*]）               │
│  ├── DataStore（52 个 JSON 数据模块，落 D 盘）             │
│  ├── 因果链（7 阶段：→healthy→content→publish→…） │
│  ├── 50 云手机设备管理                                       │
│  ├── 发布器（Tumblr OAuth1.0a + capsolver）                │
│  ├── 消息中心 / 决策引擎 / 转化归因 / DAG 编排              │
│  └── WebSocket（/ws/v14，实时推送 + 轮询兜底）             │
└─────────────────────────────────────────────────────────────┘
       ↓                          ↓                          ↓
┌──────────────────┐   ┌────────────────────┐   ┌──────────────────┐
│ MySQL (:3307)   │   │ Tombur-nurture     │   │ 内容生成 (:3010)  │
│ affiliate_system│   │ (:3005, ~100 账号) │   │ + MPT (:8080)    │
└──────────────────┘   └────────────────────┘   └──────────────────┘
```

---

## 8. License

- 本项目核心代码：**MIT**（Apache-2.0 / MIT 兼容）
- 依赖：electron, electron-builder, bcryptjs, jsonwebtoken, express 等均为 MIT

```
MIT License

Copyright (c) 2026 MSCMS Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```
