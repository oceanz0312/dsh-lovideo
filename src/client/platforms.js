// 每种画幅适合发布到哪些平台：画幅浮层里按钮下面那一行用。和 lovideo.ai 网站的清单一致
// （网站在 src/lovideo/aspect-platforms.ts），网站改了这里跟着改。
// 标志是开源图标库的原文件（来源和许可见 icons/README.md），打包时按文本内联进界面。
import youtube from './icons/youtube.svg'
import youtubeShorts from './icons/youtube-shorts.svg'
import bilibili from './icons/bilibili.svg'
import xigua from './icons/xigua.svg'
import tiktok from './icons/tiktok.svg'
import kuaishou from './icons/kuaishou.svg'
import wechatChannels from './icons/wechat-channels.svg'
import instagram from './icons/instagram.svg'
import xiaohongshu from './icons/xiaohongshu.svg'

/** 按钮从左到右的顺序。新片默认用哪个画幅不看这里，看风格的第一个画幅 */
export const ASPECT_ORDER = ['3:4', '9:16', '16:9']

/** 画幅小框的宽高（px） */
export const ASPECT_SHAPE = { '3:4': [14, 18], '9:16': [11, 18], '16:9': [20, 12] }

// mainland：只面向中国大陆的平台，只在中文界面出现
const PLATFORMS = {
  youtube: { name: 'publish.youtube', icon: youtube, color: '#ff0000' },
  bilibili: { name: 'publish.bilibili', icon: bilibili, color: '#00a1d6', mainland: true },
  xigua: { name: 'publish.xigua', icon: xigua, color: '#fe3355', mainland: true },
  douyin: { name: 'publish.douyin', icon: tiktok, color: '#111111', mainland: true },
  kuaishou: { name: 'publish.kuaishou', icon: kuaishou, color: '#ff4906', mainland: true },
  wechatChannels: { name: 'publish.wechatChannels', icon: wechatChannels, color: '#fa9d3b', mainland: true },
  tiktok: { name: 'publish.tiktok', icon: tiktok, color: '#111111' },
  youtubeShorts: { name: 'publish.youtubeShorts', icon: youtubeShorts, color: '#ff0000' },
  instagramReels: { name: 'publish.instagramReels', icon: instagram, color: 'linear-gradient(45deg, #f9ce34, #ee2a7b 50%, #6228d7)' },
  xiaohongshu: { name: 'publish.xiaohongshu', icon: xiaohongshu, color: '#ff2442' },
}

const ASPECT_PLATFORMS = {
  '3:4': ['xiaohongshu'],
  '9:16': ['douyin', 'kuaishou', 'wechatChannels', 'tiktok', 'youtubeShorts', 'instagramReels'],
  '16:9': ['youtube', 'bilibili', 'xigua'],
}

// 标志原文里有引号，直接放进 url("…") 会被截断，整段编码后再用
const maskOf = svg => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

/** 这个画幅在这种界面语言下要标出的平台；mask 是标志的 CSS 蒙版图 */
export function aspectPlatforms(aspect, language) {
  return (ASPECT_PLATFORMS[aspect] || [])
    .map(id => ({ id, ...PLATFORMS[id], mask: maskOf(PLATFORMS[id].icon) }))
    .filter(p => language === 'zh' || !p.mainland)
}
