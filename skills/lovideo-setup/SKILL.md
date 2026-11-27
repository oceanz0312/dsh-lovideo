---
name: lovideo-setup
description: 帮用户配置 lovideo 的配音、配乐服务：用浏览器带用户注册登录、开通服务、新建 API Key，再用 lovideo_configure 出一张卡片让用户自己把 Key 粘贴进插件设置并试听确认。用户说「帮我配豆包配音」「开通 ElevenLabs」「配置火山配乐」「把配音配乐配好」时使用。
---

# lovideo 配置向导

你替用户把配音、配乐服务配好。用户多半不熟悉这些平台：你用浏览器一步步做，只在必须用户本人的地方停下来（实名认证、扫码、手机验证码、付款、第一次登录）。

## 先说清楚

- 默认的离线配音、离线配乐不用 key，在这台电脑上生成，大多数人用它就够了。用户没有明确要某家服务时，先建议离线（调用 `lovideo_setup` 看下载状态）。
- 要付费的服务（按字数或按秒计费）开通前，用一句话告诉用户价格大概多少，等用户同意再开通。
- **Key 由用户自己粘贴到卡片上，不经过对话。** 调用 `lovideo_configure` 并带上 `ask_keys`，对话里会出一张填 Key 的卡片；用户粘贴、保存后插件会先试听一句，念出来了才切过去，然后你会收到「[lovideo 通知] 用户在卡片上填好了 Key」。不要让用户把 Key 发在对话里，也不要自己读出、复述或抄写 Key；浏览器页面上显示了新建好的 Key 时，请用户自己复制，再粘贴到卡片上。
- 用户已经把 Key 发在对话里了：不要拿它去填，请用户粘贴到卡片上，并提醒对话记录里留着这个 Key，必要时去平台上作废换一个。

## 豆包语音（配音，中文最自然）

1. 打开 https://console.volcengine.com/speech ，让用户登录火山引擎（没有账号就注册，要实名认证，这一步交给用户）。
2. 开通「语音合成大模型」（一般在「开通管理」里；有免费额度，超出按字数计费）。
3. 进入「API Key 管理」，新建一个 API Key。新版控制台只需要这一个 Key，不需要 App ID、Access Token。
4. 调用 `lovideo_configure`：`ask_keys: ["doubao"]`，请用户把刚建好的 Key 复制、粘贴到卡片上。声音不用填，默认中文 Vivi、英文 Megan；卡片上可以试听、换声音。
5. 卡片试听报 401/403：Key 复制错了，或者还没开通「语音合成大模型」，回去检查。

菜单名称和上面不一样时，在控制台顶部搜索「豆包语音」「API Key」找。

## ElevenLabs（配音英文最好；也能做配乐）

1. 打开 https://elevenlabs.io/app/settings/api-keys ，让用户登录（可以用 Google 账号）。
2. 点「Create API Key」。权限至少勾上 Text to Speech、Voices（读）；要用它做配乐再勾 Music。Key 只显示一次，请用户复制。
3. 调用 `lovideo_configure`：`ask_keys: ["elevenlabs"]`，请用户粘贴到卡片上。要用它配乐，收到填好的通知后再调一次 `lovideo_configure`，`music_provider: "elevenlabs"`（同一把 Key，不用再填）。
4. 声音默认 Rachel；卡片上能选用户账号里的声音并试听。

## 火山配乐（配乐，约 ¥0.002/秒）

1. 打开 https://console.volcengine.com ，在顶部搜索「音乐生成」或「智能创作」，开通「生成纯音乐」（接口名 GenBGMForTime，按生成秒数计费）。
2. 打开 https://console.volcengine.com/iam/keymanage/ （访问控制 → API 访问密钥），新建密钥（SecretKey 只显示一次）。更稳妥的做法是新建一个只有编程访问的子用户，只给它 `imagination:GenBGMForTime` 和 `imagination:QuerySong` 权限，再用子用户的密钥。
3. 调用 `lovideo_configure`：`ask_keys: ["volcengine"]`，请用户把 AccessKey ID 和 SecretAccessKey 分别粘贴到卡片上；卡片上可以试听一首 30 秒的。

## 收尾

收到填好的通知后，用一两句话告诉用户：配好了哪一项；以后每部片子要不要配音配乐，在分镜卡上的开关里定。
