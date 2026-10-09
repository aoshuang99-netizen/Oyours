# 本地开源视频/图文模型启用说明（LOCAL_SETUP.md）

> 本文件由 `providers.js` 引用。说明如何在本机换一台 ≥8GB VRAM 的机器后，
> 启用本地开源生成模型（ComfyUI / diffusers），让 `provider:'local'` 路径可用。

---

## 0. 为什么本机（GT 1030 4GB）不能跑本地视频模型

| 模型 | 最低显存 | 本机 GT 1030 |
| --- | --- | --- |
| Wan2.1 (1.3B/14B) | 8–24 GB | ❌ 4GB 不足 |
| HunyuanVideo | 12–24 GB | ❌ |
| CogVideoX-5B | 12 GB+ | ❌ |
| LTX-Video | 8 GB+ | ❌ |
| Stable Diffusion 1.5/SDXL（图文） | 4–8 GB | ⚠️ 勉强，但慢 |

**结论**：当前 Windows PC 的 GT 1030 仅 4GB，本地视频扩散模型无法推理。
本子系统采用**云生成为主（Agnes，免费额度，立即可用）+ 本地适配器骨架（即插即用）**方案：
- 生产路径 `provider:'agnes'` → 真实出图/出视频，落 `D:/mscms-content/`。
- 本地路径 `provider:'local'` → 连接 `LOCAL_INFERENCE_URL`（默认 `http://:7860`），
  未部署时**快速失败并诚实提示**，绝不伪造输出（零伪造铁律）。

---

## 1. 启用本地推理（换机/升级显卡后）

### 1.1 部署 ComfyUI（推荐，社区权重最全）

```bash
# 在 ≥8GB VRAM 的机器上
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 下载一个视频模型权重（例：Wan2.1 1.3B 文本到视频）
# 放到 ComfyUI/models/ 对应目录（详见模型仓库 README）

# 启动 HTTP 服务（默认 8188）；本适配器约定统一的 /v1/generate 网关
python main.py --listen 0.0.0.0 --port 8188
```

### 1.2 暴露统一网关 `/v1/generate`

`providers.js` 的 `localGenerate` 调用契约：

```
POST {LOCAL_INFERENCE_URL}/v1/generate
: application/json
{ "type": "image"|"video", "prompt": "...", "image"?: "...",
  "width"?: 1024, "height"?: 1024, "duration_sec"?: 5 }

→ 200 { "url": "http://.../output/xxx.png 或 .mp4" }
```

两种落地方式：
- **A（最简）**：写一个小网关服务（FastAPI/Express），内部把请求翻译为 ComfyUI 工作流
  （`POST /prompt` 提交 → 轮询 `/history/{prompt_id}` → 取输出文件 → 返回 `url`）。
- **B（OpenAI 兼容）**：若有 diffusers 推理服务已暴露 `/v1/generate`，直接对接。

> 网关只需返回可公开访问的 `url`（本适配器经 `storage.saveImage/saveVideo` 再经 10808 代理下载落盘），
> 不必与 ComfyUI 同机。

### 1.3 指向本地服务

```bash
# 环境变量（启动 content-gen/service.js 或 test-quality.js 前设置）
set LOCAL_INFERENCE_URL=http://:7860
# 或在 .env / 启动脚本注入
```

然后调用方传 `provider:'local'` 即可走本地路径。

---

## 2. GitHub 免费开源视频模型清单（无付费、可本地部署）

| 项目 | 仓库 | 说明 |
| --- | --- | --- |
| Wan2.1 | `Wan-Video/Wan2.1` | 阿里通义，文本/图生视频，1.3B 轻量版可 8GB 起 |
| HunyuanVideo | `Tencent/HunyuanVideo` | 腾讯，高质但需 12GB+ |
| CogVideoX | `THUDM/CogVideo` | 智谱，5B 参数 |
| LTX-Video | `Lightricks/LTX-Video` | 实时向，8GB 可跑 |
| ComfyUI | `comfyanonymous/ComfyUI` | 通用节点工作流前端，承载上述模型 |
| diffusers | `huggingface/diffusers` | HF 官方推理库，含视频 pipeline |

> 全部为开源权重（Apache-2.0 / 类 MIT），**无需付费订阅**，符合「GitHub 免费开源」诉求。
> 受本机 4GB 显存限制，当前仅做适配器骨架 + 接口预留，待换机启用。

---

## 3. 验证本地路径

```bash
# 部署好网关后，用本地 provider 跑一次（消耗本地算力，不耗云 credit）
node -e "require('./providers').generateTextImage({prompt:'测试',provider:'local'}).then(a=>console.log(a))"
node -e "require('./providers').generateVideo({prompt:'测试',duration:5,provider:'local'}).then(a=>console.log(a))"
```

若返回 `LOCAL_INFERENCE_UNAVAILABLE`：检查 `LOCAL_INFERENCE_URL` 是否可达、显卡显存是否足够。

---

## 4. 与云生成的切换矩阵

| 场景 | provider | 消耗 | 本机可用 |
| --- | --- | --- | --- |
| 生产出图/出视频 | `agnes` | Agnes credit（免费额度） | ✅ 经 VPS 代理 |
| 离线/换机本地推理 | `local` | 本地 GPU | ⚠️ 需 ≥8GB 显卡 |
| 本机误选 local | `local` | — | ❌ 诚实失败提示 |

零伪造：本机无 ≥8GB 显卡时，`local` 路径不返回任何伪造图/视频，只给启用指引。
