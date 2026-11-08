export const replyStyles = {
  default: { label: '預設', instruction: '' },
  witty: { label: '風趣', instruction: '用自然、輕鬆、帶點幽默的語氣回覆。嚴肅話題請維持合宜語氣。' },
  concise: { label: '簡潔', instruction: '用簡短清楚的語句回覆，優先提供重點。' },
  narrative: { label: '敘事', instruction: '用細膩、有畫面感的語氣回覆，保留適當的感官細節與節奏。' },
};

export const generationParameters = [
  { key: 'temperature', label: '隨機度（Temperature）', min: 0, max: 2, step: 'any', description: '越高越多變，越低越穩定。' },
  { key: 'top_p', label: '取樣範圍（Top P）', min: 0, max: 1, step: 'any', description: '越低越傾向從常見選項取樣。' },
  { key: 'max_tokens', label: '回覆長度上限（Tokens）', min: 1, max: 32768, step: 1, description: '限制每次生成的長度，單位是 token。' },
  { key: 'frequency_penalty', label: '重複詞句懲罰', min: -2, max: 2, step: 'any', description: '提高數值可減少反覆使用相同詞句。' },
  { key: 'presence_penalty', label: '已出現詞語懲罰', min: -2, max: 2, step: 'any', description: '提高數值可鼓勵模型使用尚未出現的詞語。' },
];

export function validateGenerationSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('生成設定格式錯誤。');
  }
  const { style = 'default' } = settings;
  if (typeof style !== 'string' || !Object.hasOwn(replyStyles, style)) {
    throw new Error('回覆語氣選項無效。');
  }
  const parameters = {};
  for (const { key, label, min, max, step } of generationParameters) {
    if (!Object.hasOwn(settings, key)) continue;
    const value = settings[key];
    if (!Number.isFinite(value) || value < min || value > max || (step === 1 && !Number.isInteger(value))) {
      throw new Error(`${label}請填寫 ${min} 到 ${max} 之間的${step === 1 ? '整數' : '數字'}。`);
    }
    parameters[key] = value;
  }
  return { style, parameters };
}

export const chatContextLimit = 4000;

export function validateChatContext(context = {}, { systemPrompt: savedPrompt = '' } = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('聊天室設定格式錯誤。');
  }
  const { world = '', instructions = '', systemPrompt = savedPrompt } = context;
  if ([world, instructions, systemPrompt].some(value => typeof value !== 'string' || value.length > chatContextLimit)) {
    throw new Error(`世界觀、對話需求和系統提示詞各限 ${chatContextLimit} 字元。`);
  }
  return { world: world.trim(), instructions: instructions.trim(), systemPrompt: systemPrompt.trim() };
}

export function chatSystemMessage(style, context = {}) {
  const { world, instructions, systemPrompt } = validateChatContext(context);
  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  if (world) parts.push(`世界觀\n${world}`);
  if (instructions) parts.push(`對話需求\n${instructions}`);
  if (replyStyles[style].instruction) parts.push(replyStyles[style].instruction);
  return parts.join('\n\n');
}

export const rewriteInstructionLimit = 1000;
export const rewriteRequestPrefix = '改寫選取文字：';
export const rewriteDirective = '依照改寫要求，只改寫 selected 欄位。before 和 after 是參考上下文。只輸出改寫後的片段，直接寫正文。';

export function prepareRewrite(source, selection) {
  const { start, end, instruction } = selection || {};
  if (typeof source !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end > source.length || start >= end || !source.slice(start, end).trim()) {
    throw new Error('請重新選取同一則回覆中的文字。');
  }
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > rewriteInstructionLimit) {
    throw new Error(`請輸入 1 到 ${rewriteInstructionLimit} 字元的改寫要求。`);
  }
  const before = source.slice(0, start);
  const after = source.slice(end);
  const prompt = JSON.stringify({
    instruction: instruction.trim(),
    selected: source.slice(start, end),
    before: before.slice(-1200),
    after: after.slice(0, 1200),
  });
  return { before, after, prompt };
}
