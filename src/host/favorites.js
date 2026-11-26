// 收藏的官方风格：只存风格的 slug，存在这台电脑上。「我的收藏」= 我蒸馏的风格 + 这里收藏的官方风格。
import { join } from 'node:path'
import { dataDir, ensureDir } from './paths.js'
import { readJson, writeJson } from './json-file.js'

const file = () => join(ensureDir(dataDir()), 'favorites.json')

export function listFavorites() {
  const d = readJson(file(), {}) || {}
  return Array.isArray(d.slugs) ? d.slugs.filter(s => typeof s === 'string') : []
}

/** 收藏或取消收藏一个风格；新收藏的排在最前面 */
export function setFavorite(slug, on) {
  if (!/^[\w-]{1,120}$/.test(slug || '')) throw Object.assign(new Error('风格不对'), { status: 400 })
  const rest = listFavorites().filter(s => s !== slug)
  const slugs = on ? [slug, ...rest] : rest
  writeJson(file(), { slugs })
  return slugs
}
