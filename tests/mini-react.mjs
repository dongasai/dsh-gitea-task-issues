/**
 * 一个**够用的迷你 React**：只为在没有浏览器的情况下把插件注册的组件树渲染一遍。
 *
 * 它不做 DOM、不做 diff、不做并发 —— 只做三件让 `client.js` 能跑起来的事：
 * 1. `createElement` 造普通对象；
 * 2. `useState` / `useCallback` / `useMemo` 按「扁平 hook 槽位」读写（同一棵树重复渲染时槽位稳定）；
 * 3. `useEffect` 登记副作用，渲染结束后执行，改了状态就再渲染一轮（有上限，防止死循环）。
 *
 * 因此它能抓到的是**运行时错误**：读到 null 的字段、调了不存在的函数、把 undefined 当数组用。
 * 它抓不到样式与布局 —— 那部分只能在浏览器里手工验收。
 */

/**
 * 建一个迷你 React 实例。
 * @param options - `maxPasses`（最多渲染轮数，默认 8）。
 * @returns `{ React, render, toText, errors, dispose }`。
 */
export function createMiniReact(options = {}) {
  const maxPasses = options.maxPasses ?? 8
  /**
   * 每个组件实例一张 hook 槽位表，键是它在树里的路径。
   * 不能用一张扁平表：不同组件的 hook 调用顺序会互相顶掉槽位（真实 React 也是按实例存的）。
   */
  const tables = new Map()
  /** 当前正在调用的组件的槽位表。 */
  let table = { slots: [], cursor: 0 }
  /** 已登记的副作用。 */
  const effects = []
  /** 渲染期捕获的异常（不让它炸掉测试进程）。 */
  const errors = []
  /** 本轮渲染访问到的所有节点（函数组件与宿主元素都算），供测试找交互目标。 */
  let nodes = []
  let cursor = 0
  let dirty = false
  let pass = 0

  /** 取当前组件的下一个 hook 槽位。 */
  function slot() {
    const index = table.cursor
    table.cursor += 1
    return index
  }

  /** 取当前组件某个槽位里存的值。 */
  function readSlot(index) {
    return table.slots[index]
  }

  /** 写当前组件的某个槽位。 */
  function writeSlot(index, value) {
    table.slots[index] = value
  }

  function createElement(type, props, ...children) {
    const flat = children.length <= 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: flat } }
  }

  function useState(initial) {
    const index = slot()
    // setter 必须**捕获自己那张表**：异步 setState 发生在渲染结束之后，
    // 那时模块级的 `table` 已经指向别的组件了（踩过：状态写进去却读不出来）。
    const owner = table
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial
    const setState = (next) => {
      const current = owner.slots[index]
      const value = typeof next === 'function' ? next(current) : next
      if (value !== current) {
        owner.slots[index] = value
        dirty = true
      }
    }
    return [owner.slots[index], setState]
  }

  function useCallback(fn, deps) {
    const index = slot()
    const previous = readSlot(index)
    if (previous !== undefined && deps !== undefined && sameDeps(previous.deps, deps)) return previous.value
    writeSlot(index, { deps, value: fn })
    return fn
  }

  function useMemo(fn, deps) {
    const index = slot()
    const previous = readSlot(index)
    if (previous !== undefined && deps !== undefined && sameDeps(previous.deps, deps)) return previous.value
    const value = fn()
    writeSlot(index, { deps, value })
    return value
  }

  /** 依赖数组比较：长度相同且逐项全等。 */
  function sameDeps(left, right) {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((item, at) => item === right[at])
  }

  function useEffect(fn, deps) {
    const index = slot()
    const previous = readSlot(index)
    const changed = previous === undefined || !sameDeps(previous, deps)
    if (changed) {
      writeSlot(index, deps ?? [])
      effects.push(fn)
    }
  }

  const React = { createElement, useState, useEffect, useCallback, useMemo, Fragment: Symbol('Fragment') }

  /**
   * 递归渲染。
   * @param node - 当前节点。
   * @param out - 文本收集器。
   * @param path - 当前节点在树里的位置（决定用哪张 hook 槽位表）。
   */
  function walk(node, out, path) {
    if (node === null || node === undefined || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, at) => walk(item, out, `${path}.${at}`))
      return
    }
    if (typeof node === 'object' && node.props !== undefined) nodes.push(node)
    // `<style>` 的正文是 CSS，不该混进「页面文本」里（否则断言会被样式表淹没）。
    if (node.type === 'style') return
    if (typeof node.type === 'function') {
      const own = tables.get(path) ?? { slots: [], cursor: 0 }
      tables.set(path, own)
      own.cursor = 0
      const previous = table
      table = own
      let produced
      try {
        produced = node.type(node.props ?? {})
      } catch (error) {
        errors.push(error)
        table = previous
        return
      }
      table = previous
      // 组件返回的树**另起一段路径**：否则「组件直接返回另一个组件」会两张表撞成一张
      // （GlobalBoardSlot → GlobalBoard 就是这么撞的，症状是状态写进去却读不出来）。
      walk(produced, out, `${path}!`)
      return
    }
    if (typeof node.type === 'string' || typeof node.type === 'symbol') {
      const children = node.props?.children
      if (Array.isArray(children)) children.forEach((item, at) => walk(item, out, `${path}.${at}`))
      else walk(children, out, `${path}.0`)
    }
  }

  /**
   * 渲染一棵树，跑副作用，必要时重复（状态变更 → 再渲染）。
   * @param element - 根元素。
   * @returns 文本内容。
   */
  async function render(element) {
    let text = ''
    for (pass = 0; pass < maxPasses; pass += 1) {
      dirty = false
      nodes = []
      const out = []
      walk(element, out, 'root')
      text = out.join(' ')
      const pending = effects.splice(0, effects.length)
      if (process.env.MINI_DEBUG === '1') console.error(`[mini] pass=${pass} dirty=${dirty} pending=${pending.length} text=${text.slice(0, 60)}`)
      if (pending.length === 0 && !dirty) break
      for (const effect of pending) {
        try {
          const cleanup = effect()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        } catch (error) {
          errors.push(error)
        }
      }
      // 让副作用里的 await 落地，再决定要不要重渲染。
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (process.env.MINI_DEBUG === '1') console.error(`[mini] after-await dirty=${dirty}`)
      if (!dirty && pending.length === 0) break
    }
    return text
  }

  const cleanups = []

  return {
    React,
    render,
    errors,
    /** 最近一轮渲染访问到的节点。 */
    get nodes() { return nodes },
    /** 所有组件的槽位表（调试用）。 */
    get tables() { return tables },
    dispose() {
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          // 清理期的异常不影响断言。
        }
      }
      cleanups.length = 0
    },
  }
}
