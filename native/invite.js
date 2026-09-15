'use strict';
/**
 * ============================================================
 *  native/invite.js — 一起听邀请解析（P8 融合自参考实现）
 * ------------------------------------------------------------
 *  真实邀请不是干净 JSON，而是「URL 编码 + 双层 JSON 嵌套」：
 *
 *    msgs[].user.lastMsg              <- JSON 字符串
 *      └─ msg                         <- JSON 字符串
 *           └─ generalMsg.nativeUrl:
 *              orpheus://open?url1=...%3FroomId%3D<hex>_<ts>%26inviterId%3D<uid>...
 *
 *  两个致命点（第一版实现因此在真实数据上恒返回 null）：
 *    1. roomId 形态是 `<32位hex>_<10位时间戳>`，不是纯数字。\d+ 永远失败。
 *    2. 参数被 URL 编码，且邀请藏在 user.lastMsg，不在 msg 字段，必须深扫。
 *
 *  ⚠️ inviterId 是「房间发起人」，实测有时就是自己的 uid；
 *     真正发私信的人在会话的 fromUserId —— 这里作为 senderUid 单独返回。
 *     要读对方私信历史，必须用 senderUid。
 *  本模块零依赖，可直接被 message.js / server.js 复用。
 * ============================================================
 */

/** roomId 允许的字符：hex、下划线（`<hex>_<ts>` 形态）、点、横线。 */
const ROOM_ID_VALUE = '[0-9a-zA-Z_.-]{3,}';

/** inviterId 是数字 uid。 */
const USER_ID_VALUE = '\\d{3,}';

/**
 * 规范化私信正文，让后续正则只需面对一种形态。
 * - URL 解码（最多两轮，兼容双重编码；遇非法转义就停手）
 * - 还原 JSON 转义（`\"` -> `"`），否则 `\"roomId\":` 匹配不到
 * - 还原 `\u0026` 等 unicode 转义
 * @param {unknown} text
 * @returns {string}
 */
function normalizeInviteText(text) {
  // lastMsg 有两层形态：可能是字符串，也可能是 {msgId,msg,type} 对象。
  // 是对象时优先取 .msg（真正的 JSON 正文），否则整体序列化。
  let picked = text;
  if (picked && typeof picked === 'object' && !Array.isArray(picked) && typeof picked.msg === 'string') {
    picked = picked.msg;
  }
  let source = typeof picked === 'string' ? picked : JSON.stringify(picked === undefined ? '' : picked);

  for (let round = 0; round < 2; round += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(source);
    } catch (e) {
      break; // 含非法 % 转义，放弃解码
    }
    if (decoded === source) break;
    source = decoded;
  }

  return source
    .replace(/\\u0026/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
}

/**
 * 在规范化文本里按 key 抓值。
 * @param {string} source
 * @param {string[]} names 候选 key（按优先级）
 * @param {string} valuePattern
 * @returns {string|null}
 */
function pickValue(source, names, valuePattern) {
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    // 兼容 "roomId":"x" / roomId=x / room_id: x 三种写法
    const pattern = new RegExp(
      '\\\\?["\']?' + name + '["\']?\\s*[:=]\\s*["\']?(' + valuePattern + ')',
      'i',
    );
    const m = source.match(pattern);
    if (m) return m[1];
  }
  return null;
}

/**
 * 解析单条文本里的邀请信息。普通聊天内容返回全 null，不抛错。
 * @param {unknown} text
 * @returns {{roomId: string|null, inviterId: string|null, inviterName: string|null}}
 */
function parseInvite(text) {
  const source = normalizeInviteText(text);
  return {
    roomId: pickValue(source, ['roomId', 'room_id'], ROOM_ID_VALUE),
    inviterId: pickValue(source, ['inviterId', 'inviter_id', 'inviterUserId'], USER_ID_VALUE),
    inviterName: pickValue(source, ['inviterName', 'inviter_name'], '[^&"\\\\]{1,40}'),
  };
}

/**
 * 深度遍历响应，收集所有字符串。
 * 邀请藏在 msgs[].user.lastMsg 这类深层嵌套里，不同接口层级不一样，
 * 与其为每种响应写取值路径，不如整体深扫 —— 更抗接口改动。
 * @param {unknown} node
 * @param {string[]} [out]
 * @param {number} [depth]
 * @returns {string[]}
 */
function collectStrings(node, out, depth) {
  const acc = out || [];
  const d = depth || 0;
  if (d > 12 || acc.length > 5000) return acc;
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) collectStrings(node[i], acc, d + 1);
    return acc;
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i += 1) collectStrings(node[keys[i]], acc, d + 1);
  }
  return acc;
}

/**
 * 从私信列表 / 历史响应里提取候选邀请，按 roomId 去重。
 * @param {unknown} payload
 * @returns {Array<{roomId, inviterId, inviterName, senderUid, raw}>}
 */
function extractInvites(payload) {
  const found = new Map();

  // 私信列表：msgs[].user.fromUserId 才是会话对方
  const msgs = payload && Array.isArray(payload.msgs) ? payload.msgs : [];
  for (let i = 0; i < msgs.length; i += 1) {
    const entry = msgs[i] || {};
    const user = entry.user || {};
    const fromUserId = user.fromUserId !== undefined
      ? user.fromUserId
      : (user.user && user.user.id !== undefined ? user.user.id : null);
    const text = user.lastMsg !== undefined ? user.lastMsg : (entry.msg || '');
    const parsed = parseInvite(text);
    if (!parsed.roomId || found.has(parsed.roomId)) continue;
    found.set(parsed.roomId, {
      roomId: parsed.roomId,
      inviterId: parsed.inviterId,
      inviterName: parsed.inviterName,
      senderUid: fromUserId === null ? null : String(fromUserId),
      raw: typeof text === 'string' ? text : JSON.stringify(text),
    });
  }

  // 兜底：深度扫描（覆盖私信历史等其它结构）
  const strings = collectStrings(payload);
  for (let i = 0; i < strings.length; i += 1) {
    const text = strings[i];
    const parsed = parseInvite(text);
    if (!parsed.roomId || found.has(parsed.roomId)) continue;
    found.set(parsed.roomId, {
      roomId: parsed.roomId,
      inviterId: parsed.inviterId,
      inviterName: parsed.inviterName,
      senderUid: null,
      raw: text,
    });
  }

  return Array.from(found.values());
}

module.exports = {
  ROOM_ID_VALUE: ROOM_ID_VALUE,
  USER_ID_VALUE: USER_ID_VALUE,
  normalizeInviteText: normalizeInviteText,
  parseInvite: parseInvite,
  collectStrings: collectStrings,
  extractInvites: extractInvites,
};
