# 本机配音模型的常驻进程：加载一次模型，从标准输入一行一个 JSON 请求，生成 wav，在标准输出回一行 JSON。
# 由插件后端（src/host/localvoice.js）启动和管理，用户不直接运行。
#
#   python worker.py <模型 id>
#   请求：{"id": 1, "text": "...", "lang": "zh"|"en", "out": "/path/x.wav", "instruct": "...", "voice": "zm_yunjian"}
#   voice 是用户在设置里选的声音，不给就用默认
#   回复：{"id": 1, "ok": true, "seconds": 12.3, "gen": 4.5} 或 {"id": 1, "ok": false, "error": "..."}
#   启动完成先回一行 {"ready": true, "load": 秒数}
#
# 后端两种：Apple 芯片的 Mac 用 mlx-audio；Windows、Linux、Intel Mac 用 PyTorch（有 NVIDIA 显卡就用显卡）。
import json
import sys
import time
import traceback

import numpy as np
import soundfile as sf

MODEL = sys.argv[1]

# 默认语气：像讲给朋友听的科普旁白（导演可以给每一镜换语气）
STYLE = {
    "zh": "温暖、好奇的科普旁白，语气自然有起伏，像在给朋友讲一件很酷的事，不要念稿腔。",
    "en": "A warm, curious narrator. Natural, expressive delivery with rises and falls, like telling a friend about something fascinating, not reading a script.",
}


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def join_audio(results):
    parts, sr = [], None
    for r in results:
        parts.append(np.asarray(r.audio, dtype=np.float32).reshape(-1))
        sr = r.sample_rate
    return np.concatenate(parts), sr


def load():
    """返回 speak(text, lang, instruct, voice) -> (音频, 采样率)"""
    if MODEL.startswith("mlx-"):
        from mlx_audio.tts.utils import load_model

        if MODEL == "mlx-qwen3-1.7b":
            m = load_model("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit")
            return lambda text, lang, inst, voice: join_audio(m.generate_custom_voice(
                text=text, speaker=voice or ("Vivian" if lang == "zh" else "Ryan"),
                language="Chinese" if lang == "zh" else "English", instruct=inst or STYLE[lang]))
        if MODEL == "mlx-ming3-0.5b":
            from mlx_audio.tts.models.bailingmm.bailingmm import ming3_instruction

            m = load_model("mlx-community/Ming-3.0-tts-0.5B-bf16")
            return lambda text, lang, inst, voice: join_audio(m.generate(
                text=text, instruct=ming3_instruction(style=inst or STYLE["zh"]), use_zero_spk_emb=True))
        if MODEL == "mlx-kokoro":
            m = load_model("mlx-community/Kokoro-82M-bf16")
            return lambda text, lang, inst, voice: join_audio(m.generate(
                text=text, voice=voice or ("zm_yunjian" if lang == "zh" else "af_heart"), lang_code="z" if lang == "zh" else "a"))

    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if MODEL in ("torch-qwen3-1.7b", "torch-qwen3-0.6b"):
        from qwen_tts import Qwen3TTSModel

        repo = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" if MODEL.endswith("1.7b") else "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
        m = Qwen3TTSModel.from_pretrained(repo, device_map=f"{device}:0" if device == "cuda" else device,
                                          dtype=torch.bfloat16 if device == "cuda" else torch.float32)

        def speak_qwen(text, lang, inst, voice):
            wavs, sr = m.generate_custom_voice(text=text, language="Chinese" if lang == "zh" else "English",
                                               speaker=voice or ("Vivian" if lang == "zh" else "Ryan"),
                                               instruct=(inst or STYLE[lang]) if MODEL.endswith("1.7b") else "")
            return np.asarray(wavs[0], dtype=np.float32), sr

        return speak_qwen
    if MODEL == "torch-kokoro":
        from kokoro import KPipeline

        pipes = {}

        def speak_kokoro(text, lang, inst, voice):
            code = "z" if lang == "zh" else "a"
            if code not in pipes:
                pipes[code] = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M", device=device)
            chunks = [np.asarray(audio, dtype=np.float32) for _, _, audio in
                      pipes[code](text, voice=voice or ("zm_yunjian" if lang == "zh" else "af_heart"))]
            return np.concatenate(chunks), 24000

        return speak_kokoro
    raise SystemExit(f"不认识的模型：{MODEL}")


def main():
    t = time.time()
    speak = load()
    reply({"ready": True, "load": round(time.time() - t, 2)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            t = time.time()
            audio, sr = speak(req["text"], req.get("lang", "zh"), req.get("instruct"), req.get("voice"))
            sf.write(req["out"], audio, sr)
            reply({"id": rid, "ok": True, "seconds": round(len(audio) / sr, 3), "gen": round(time.time() - t, 3)})
        except Exception as e:  # 一段失败不影响后面的请求
            traceback.print_exc(file=sys.stderr)
            reply({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"[:400]})


if __name__ == "__main__":
    main()
