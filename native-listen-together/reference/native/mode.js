'use strict';
/**
 * 模式状态机。
 *
 * ⚠️ 参考实现，尚未接入 server.js。
 *
 * ── 三个模式（第 4 个按需求暂不做）──────────────────────────────
 *
 *  mode 1 · local   「原本模式」
 *    - 第三方音源直接播放，假一起听，不走网易协议，只有画面
 *    - 只需要本地 Node 服务，不需要任何 cookie
 *    - 这是现有 server.js 的行为，**必须保持零改动**
 *
 *  mode 2 · duo     「AI + 真人一起听」
 *    - 两个 cookie 都导入（ai + human）
 *    - 真人用我们的 webview 当播放器
 *    - AI 通过聊天框/真人命令自主决策点歌
 *    - 房间是网易云的真实房间，一个假人（AI）一个真人
 *
 *  mode 3 · solo_ai 「only AI」
 *    - 真人用**官方客户端**，真人 cookie 用不上
 *    - AI 用 aicookie 进同一房间，自主决策切歌
 *    - webview 退化为**只读监控面板**（控制按钮置灰）
 *
 * ── 模式与身份/能力矩阵 ──────────────────────────────────────
 *   mode      | 需要 cookie      | webview 可控制 | 走网易协议
 *   ----------|------------------|---------------|----------
 *   local     | 无               | 是            | 否
 *   duo       | ai + human       | 是            | 是
 *   solo_ai   | ai               | 否（置灰）     | 是
 */

/** 模式常量。 */
const MODES = {
  LOCAL: 'local',
  DUO: 'duo',
  SOLO_AI: 'solo_ai',
};

/** 默认模式：保持向后兼容，老用户升级后行为不变。 */
const DEFAULT_MODE = MODES.LOCAL;

/** 模式能力矩阵。 */
const MODE_CAPS = {
  local: {
    label: '原本模式',
    native: false,
    requires: [],
    webviewControllable: true,
    description: '第三方音源直放，不走网易协议，只有一起听的画面',
  },
  duo: {
    label: 'AI + 真人一起听',
    native: true,
    requires: ['ai', 'human'],
    webviewControllable: true,
    description: '真人在 webview 控制，AI 自主决策，同一个网易云房间',
  },
  solo_ai: {
    label: '仅 AI（真人用官方客户端）',
    native: true,
    requires: ['ai'],
    webviewControllable: false,
    description: '真人用官方 App，AI 用 aicookie 进同一房间并自主切歌',
  },
};

/**
 * 校验模式名。
 *
 * MODES 的「键」是大写常量名（LOCAL/DUO/SOLO_AI），
 * 而「值」才是对外的模式串（local/duo/solo_ai）。
 * 两种写法都要接受：传 'duo' 或 'DUO' 都归一到 'duo'。
 * @param {unknown} mode
 * @returns {string}
 */
function normalizeMode(mode) {
  const raw = String(mode || '').trim();
  if (!raw) return DEFAULT_MODE;
  const upper = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(MODES, upper)) return MODES[upper];
  // 也允许直接传模式串本身
  const values = Object.keys(MODES).map(function (k) { return MODES[k]; });
  if (values.indexOf(raw) >= 0) return raw;
  return DEFAULT_MODE;
}

/**
 * 判断某模式下身份是否齐备。
 * @param {string} mode
 * @param {import('./identity.js').IdentityStore} store
 * @returns {{ok: boolean, missing: string[]}}
 */
function checkRequirements(mode, store) {
  const caps = MODE_CAPS[mode];
  if (!caps) return { ok: false, missing: [] };
  const missing = caps.requires.filter(function (who) { return !store.has(who); });
  return { ok: missing.length === 0, missing: missing };
}

/**
 * 模式管理器。
 */
class ModeManager {
  /**
   * @param {object} options
   * @param {import('./identity.js').IdentityStore} options.store
   * @param {string} [options.mode]
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    const o = options || {};
    this.store = o.store;
    this.mode = normalizeMode(o.mode || DEFAULT_MODE);
    this.log = o.log || function () {};
  }

  /**
   * 当前模式能力。
   * @returns {object}
   */
  caps() {
    return MODE_CAPS[this.mode];
  }

  /**
   * 切换模式。缺 cookie 时抛错，让调用方明确知道差什么。
   * @param {string} mode
   * @returns {{mode: string, caps: object}}
   */
  set(mode) {
    const next = normalizeMode(mode);
    const check = checkRequirements(next, this.store);
    if (!check.ok) {
      throw new Error(
        '模式「' + MODE_CAPS[next].label + '」需要先导入 cookie: ' + check.missing.join(', '),
      );
    }
    this.mode = next;
    this.log('[mode] 切换到 ' + MODE_CAPS[next].label);
    return { mode: next, caps: MODE_CAPS[next] };
  }

  /** 是否走网易原生协议。 */
  isNative() {
    return !!MODE_CAPS[this.mode].native;
  }

  /** webview 是否可控制（mode 3 下置灰）。 */
  isWebviewControllable() {
    return !!MODE_CAPS[this.mode].webviewControllable;
  }

  /**
   * 该模式要用哪个身份去操作网易云。
   * mode 2 下 AI 用 ai 身份；真人操作由 human 身份承担（见 room 层）。
   * @returns {string|null}
   */
  aiIdentity() {
    return this.isNative() ? 'ai' : null;
  }

  /**
   * 供 UI / AI 工具回显的完整状态。
   * @returns {object}
   */
  status() {
    const caps = this.caps();
    const check = checkRequirements(this.mode, this.store);
    const store = this.store; // 下面的回调里 this 会丢，先存下来
    return {
      mode: this.mode,
      label: caps.label,
      description: caps.description,
      native: caps.native,
      webviewControllable: caps.webviewControllable,
      ready: check.ok,
      missing: check.missing,
      identities: store.status(),
      available: Object.keys(MODE_CAPS).map(function (k) {
        const c = MODE_CAPS[k];
        const m = checkRequirements(k, store);
        return { mode: k, label: c.label, ready: m.ok, missing: m.missing };
      }),
    };
  }
}

module.exports = {
  MODES: MODES,
  DEFAULT_MODE: DEFAULT_MODE,
  MODE_CAPS: MODE_CAPS,
  normalizeMode: normalizeMode,
  checkRequirements: checkRequirements,
  ModeManager: ModeManager,
};
