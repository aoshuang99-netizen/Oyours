/**
 * [P2-B5] 真实媒体引用判定 —— `preview_url` 语义纠正的「单一事实源」
 * ─────────────────────────────────────────────────────────────────
 * 背景（2026-09-16 实测，零估算）：
 *   content 库 12,623 条中 `preview_url` 非空 1,340 条，形态 **100%** 为
 *   `/content/<date>/<type>/<id>.json` —— 那是 `aigc-content-generator.saveContentToFile()`
 *   写入的**内容存档 JSON 路径**（磁盘上并不存在），**不是媒体**。
 *   真正的媒体在 `media_path`（非空 7,262 条，形如
 *   `D:/mscms-content/images/<hash>.png`，由 ContentMediaBridge 写入）。
 *
 * 原缺陷：多处实现 `hasMedia = !!(c.preview_url || c.previewUrl)` —— 只看 preview_url，
 *   导致**双向误判**：
 *     ① 假的算「有图」→ 放宽完整性 `len = Math.max(b.length, 80)`，
 *        且豁免「纯文本正文不足 30 字封顶 40」→ 空正文垃圾得以进 ready 发布池；
 *     ② 真的反而不算「有图」→ 正常图文贴被降级（无法豁免正文长度闸门）。
 *
 * 判定口径：媒体一律以真实媒体字段为准；`preview_url` **仅在不是存档 JSON 时才认可**
 *   （手工创建内容端点写入的 preview_url 是真实封面/首图，需保持兼容）。
 *
 * 本模块无第三方依赖，可被 server.js / data-store.js / cloud-publisher.js 共用，
 * 避免三处各写一份导致再次漂移。
 */
'use strict';

// 内容存档 JSON 路径（saveContentToFile 产物）—— 不算媒体
const ARCHIVE_JSON_RE = /\.json(?:[?#]|$)/i;

/**
 * 单个字段是否为「真实媒体引用」。
 * 排除：空值 / 非字符串 / JSON 字面量 / 存档 JSON 路径。
 * @param {*} v 待判定字段值
 * @returns {boolean}
 */
 isRealMediaRef(v) {
  if (!v) return false;
  if (typeof v === 'object') return false;
  const s = String(v).trim();
  if (!s) return false;
  if (s[0] === '{' || s[0] === '[') return false;   // JSON 字面量
  if (ARCHIVE_JSON_RE.test(s)) return false;        // 内容存档 JSON 路径
  return true;
}

// 参与媒体判定的字段全集（含 preview_url —— 兼容手工端点写入的真实封面）
const MEDIA_FIELDS = [
  'media_path', 'mediaPath',
  'media_url', 'mediaUrl',
  'image_path', 'imagePath',
  'image_url', 'imageUrl',
  'cover_url', 'coverUrl',
  'video_path', 'videoPath',
  'video_url', 'videoUrl',
  'preview_url', 'previewUrl',
];

/**
 * 一条内容是否确有媒体载体。
 * @param {object} c 内容对象（content 记录 / 事件载荷 / 生成产物）
 * @returns {boolean}
 */
 contentHasRealMedia(c) {
  if (!c || typeof c !== 'object') return false;
  for (let i = 0; i < MEDIA_FIELDS.length; i++) {
    if (isRealMediaRef(c[MEDIA_FIELDS[i]])) return true;
  }
  return false;
}

/**
 * 从任意来源对象中抽取可用的媒体字段（用于向下游透传，避免字段在链路中丢失）。
 * @param {object} src
 * @returns {object} 仅包含有值的媒体字段
 */
 pickMediaFields(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (let i = 0; i < MEDIA_FIELDS.length; i++) {
    const k = MEDIA_FIELDS[i];
    if (isRealMediaRef(src[k])) out[k] = src[k];
  }
  return out;
}

/**
 * [P3-C4] 发布优先级分档 —— 视频 > 图文 > 文字。
 *
 * 语义：0 = 视频，1 = 图文，2 = 文字；数值越小越优先发布。
 * 判据：
 *  - 必须**确有真实媒体**才可能进 0/1 档。content_type 标了 video 但媒体缺失的，
 *    一律降为 2（文字档）—— 否则它会被排到最前却发不出去，反而堵住队列。
 *  - content_type === 'video' 且确有媒体 → 0
 *  - 其他有媒体                      → 1
 *  - 无媒体                          → 2
 *
 * 放在本模块而非 server.js，是为了让分档规则可被单测覆盖
 * （同一口径在 P2-B5 已出现过三处漂移，不再重复该错误）。
 * @param {object} c 内容对象
 * @returns {0|1|2}
 */
 mediaTypeRank(c) {
  if (!contentHasRealMedia(c)) return 2;
  return String((c && c.content_type) || '').toLowerCase() === 'video' ? 0 : 1;
}

module.exports = { isRealMediaRef, contentHasRealMedia, pickMediaFields, mediaTypeRank, MEDIA_FIELDS };
