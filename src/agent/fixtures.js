/** 模型测试内置样例:点按钮即测,不要求用户手填 URL。 */
const ZH_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAABQCAIAAADnUzvSAAABeUlEQVR4nO3bwYqCUABA0T6iRZ/Q///bEMyq3RCao9kLuXHgEPJ8Si0uiU9PP7dfIOp0+DcAdhMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIWwn4fLlOts+X66PJnPlRj4N/hwBD7An4nzlbRjQMowgYwtYDnl8wTy6GBQxH8Q8MYQKGsDF3oVdH3IWGT7AODGEChjABQ5iAIUzAECZgCBMwhL28Djxf0d34cKV1YBjurSextowsnQd4n4AhbFPA88/J3pfeTxIwjDIm4NVEBQyfMCzgpxuTmUt7gX3Wl5Gedrt0wbzl/aTDfzN8DevAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAEHYHXNJfn9yUDUUAAAAASUVORK5CYII=';
const EN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAWgAAABQCAIAAAC72Xj2AAABc0lEQVR4nO3bQYrCMABAUQ8xC4/g/e82DLhyW6ylfs0gpg/eQmIEu/CT2PT0+3cFSE4f/wbA1xEOIBMOIBMOIBMOIBMOIBMOIBMOIBMOINsJx8/5svRw5G5waw4wjadWHMsf/zoEW2mQDJiVcADZK+FY70Ee7kqEA2Y1YMXx2kzgewkHkL21VVnfQ9n6FDAT5ziATDiATDiATDiATDiATDiATDiAbD8cuwfMPQgLR7P/WP3d62dGgLm9FY6tOcDcxoTDVgUOZdiKQzXgOEb+x6EdcBBj7qos3/r4JQH/zTkOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOIBMOILsBXjsf4Bdcj8QAAAAASUVORK5CYII=';

export const MODEL_SAMPLES = {
  ocr: [
    { id: 'ocr-zh', label: '内置中文测试图', description: 'HELLO / WORLD 点阵文字' },
    { id: 'ocr-en', label: '内置英文测试图', description: 'TEST / OCR 123 点阵文字' },
  ],
  asr: [
    { id: 'asr-zh', label: '内置中文测试音频', description: '220Hz 短音频,验证上传与识别链路' },
    { id: 'asr-en', label: '内置英文测试音频', description: '440Hz 短音频,验证上传与识别链路' },
  ],
  tts: [{ id: 'tts-zh', label: '内置中文合成文本', description: '你好,这是 NOMO 的语音合成测试。' }],
  imageGen: [{ id: 'image-cat', label: '内置图像描述', description: '一只戴墨镜的橘猫在冲浪,卡通风格' }],
  compress: [{ id: 'compress-chat', label: '内置对话压缩文本', description: '多轮需求、偏好与待办对话' }],
};

function wavBytes(seconds, freq) {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const out = new Uint8Array(44 + n * 2);
  const view = new DataView(out.buffer);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = t < 0.05 ? 0 : Math.sin(2 * Math.PI * freq * t) * 0.45;
    if (seconds - t < 0.05) v *= Math.max(0, (seconds - t) / 0.05);
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function sampleInput(sampleId) {
  if (sampleId === 'ocr-zh') return { img: `data:image/png;base64,${ZH_PNG}` };
  if (sampleId === 'ocr-en') return { img: `data:image/png;base64,${EN_PNG}` };
  if (sampleId === 'asr-zh') return { audioBytes: wavBytes(0.7, 220), format: 'wav' };
  if (sampleId === 'asr-en') return { audioBytes: wavBytes(0.7, 440), format: 'wav' };
  if (sampleId === 'tts-zh') return { text: '你好,这是 NOMO 的语音合成测试。' };
  if (sampleId === 'image-cat') return { prompt: '一只戴墨镜的橘猫在冲浪,卡通风格', size: '1024x1024' };
  if (sampleId === 'compress-chat') {
    return { text: '用户:我想做一个记账网页。\n助手:可以,需要哪些字段?\n用户:金额、分类、备注,要能按月统计。我偏好简洁中文界面。\n助手:已记录。还要加预算提醒吗?\n用户:要,每月餐饮超过 2000 元提醒我;待办是完成部署并给我链接。' };
  }
  return null;
}
