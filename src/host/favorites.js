// 收藏的官方风格：只存风格的 slug，存在这台电脑上。「我的收藏」= 我蒸馏的风格 + 这里收藏的官方风格。
import { join } from 'node:path'
import { dataDir, ensureDir } from './paths.js'
import { readJson, updateJson } from './json-file.js'

const file = () => join(ensureDir(dataDir()), 'favorites.json')

const slugsOf = d => (Array.isArray(d?.slugs) ? d.slugs.filter(s => typeof s === 'string') : [])

export function listFavorites() {
  return slugsOf(readJson(file(), {}))
}

/** 收藏或取消收藏一个风格；新收藏的排在最前面 */
export function setFavorite(slug, on) {
  if (!/^[\w-]{1,120}$/.test(slug || '')) throw Object.assign(new Error('风格不对'), { status: 400 })
  // 在锁里读最新的再改：另一个 DSH 窗口刚收藏的不会被冲掉
  return updateJson(file(), d => {
    const rest = slugsOf(d).filter(s => s !== slug)
    return { slugs: on ? [slug, ...rest] : rest }
  }).slugs
}
