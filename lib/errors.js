/**
 * @module lib/errors
 *
 * 插件内部的两类失败，都带「线上码 + HTTP 状态」，好让桥上（`lib/bridge.js`）和工具侧
 * 直接照搬，不靠 error.message 猜分支。
 *
 * - {@link BridgeError}：请求本身的问题（参数不对、找不到服务器、没绑定仓库……），
 *   由桥直接回给浏览器或工具。
 * - {@link GiteaError}：上游 Gitea 拒了这个请求，连同它自己的状态码一起带回来；
 *   桥按 `giteaStatus` 换一个语义更清楚的线上码。
 */

/** 请求级失败：状态码 + 线上码 + 说明。 */
export class BridgeError extends Error {
  /**
   * @param status - HTTP 状态码（回给浏览器 / 工具文本）。
   * @param code - 线上失败码（客户端按它分支）。
   * @param message - 显示给用户的说明。
   * @param details - 附加结构化信息（可选）。
   */
  constructor(status, code, message, details) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * 上游 Gitea 的失败应答。保留原始状态与正文，不用 message 做判断。
 */
export class GiteaError extends Error {
  /**
   * @param giteaStatus - Gitea 返回的 HTTP 状态码。
   * @param code - 归一化后的线上码（`unauthorized` / `not-found` / …）。
   * @param message - 上游消息，或本地的兜底说明。
   * @param body - 上游正文（已按 JSON 解析过一次，失败则为原文或 undefined）。
   */
  constructor(giteaStatus, code, message, body) {
    super(message)
    this.name = 'GiteaError'
    this.giteaStatus = giteaStatus
    this.code = code
    this.body = body
  }
}

/**
 * Gitea 状态码 → 线上码。表里没有的一律 `upstream-error`，不猜。
 * @param status - Gitea 的 HTTP 状态码。
 * @returns 归一化后的线上码。
 */
export function codeForGiteaStatus(status) {
  if (status === 400) return 'bad-request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 405) return 'method-not-allowed'
  if (status === 408) return 'timeout'
  if (status === 409) return 'conflict'
  if (status === 412) return 'precondition-failed'
  if (status === 413) return 'too-large'
  if (status === 422) return 'validation-failed'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'upstream-error'
  return 'upstream-error'
}

/**
 * 线上码 → 回给浏览器的 HTTP 状态。上游的 4xx 照搬，本地问题用 400/404/409。
 * @param status - Gitea 的状态码。
 * @returns 回给浏览器的状态码。
 */
export function httpStatusForGitea(status) {
  if (status >= 400 && status <= 499) return status
  return 502
}

/** 取错误说明文本，供日志与应答共用。 */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
