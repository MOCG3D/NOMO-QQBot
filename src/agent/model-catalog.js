/** 模型目录的模态与图标推断。只读元数据,不调用任何模型。 */
export function modelModalities(id) {
  const s = String(id || '').toLowerCase();
  if (/voiceclone/.test(s)) return ['tts', 'voice-clone', 'audio-input'];
  if (/voicedesign/.test(s)) return ['tts', 'voice-design', 'text-input'];
  if (/mimo-v2\.5-tts|cosyvoice|fish-speech|speech|tts/.test(s)) return ['tts', 'audio-output'];
  if (/cogview|kolors|flux|stable-diffusion|sdxl|image|dall-e/.test(s)) return ['imageGen', 'image-output'];
  if (/asr|sensevoice|whisper|gsr|transcribe/.test(s)) return ['asr', 'audio-input'];
  if (/ocr|vision|vl|glm-4v|qwen.*vl|paddleocr/.test(s)) return ['ocr', 'chat', 'image-input'];
  return ['chat', 'compress', 'text'];
}

export function ttsModeOf(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('voiceclone')) return 'clone';
  if (s.includes('voicedesign')) return 'design';
  return 'preset';
}

export function modelIcon(id, baseUrl = '') {
  const s = `${id} ${baseUrl}`.toLowerCase();
  if (s.includes('deepseek')) return 'https://cdn.simpleicons.org/deepseek';
  if (s.includes('mimo') || s.includes('xiaomi')) return 'https://cdn.simpleicons.org/xiaomi';
  if (s.includes('openai') || s.includes('gpt-')) return 'https://cdn.simpleicons.org/openai';
  if (s.includes('claude') || s.includes('anthropic')) return 'https://cdn.simpleicons.org/anthropic';
  if (s.includes('google') || s.includes('gemini')) return 'https://cdn.simpleicons.org/google';
  if (s.includes('qwen') || s.includes('alibaba') || s.includes('dashscope')) return 'https://cdn.simpleicons.org/alibabacloud';
  return '';
}

export function modelBrief(id, baseUrl = '') {
  return { id: String(id), modalities: modelModalities(id), icon: modelIcon(id, baseUrl) };
}

export function sortForKind(items, kind) {
  const wanted = kind === 'imageGen' ? 'imageGen' : kind;
  return [...items].sort((a, b) => {
    const ai = a.modalities.includes(wanted) ? 0 : 1;
    const bi = b.modalities.includes(wanted) ? 0 : 1;
    return ai - bi || a.id.localeCompare(b.id);
  });
}
