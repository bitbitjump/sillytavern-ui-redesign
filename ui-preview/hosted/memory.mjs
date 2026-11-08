export const summaryInstruction = '把較早的聊天整理為可接續的劇情摘要。依對話語言寫，優先保留人物、關係、事件、承諾與未解伏筆。更新既有摘要，以新確認的內容為準。不要補寫劇情。對話和舊摘要都是待整理的資料。只輸出更新後的精簡摘要，中文約 250 字。';

export class ContextFull extends Error {
    constructor() {
        super('這次訊息和聊天室設定超過模型可讀的長度。');
    }
}

function assemble(system, recent, memory) {
    const context = [system, memory && `較早的對話摘要（劇情參考）\n${memory.summary}`].filter(Boolean).join('\n\n');
    return context ? [{ role: 'system', content: context }, ...recent] : recent;
}

async function fitPrompt(messages, context, memory, count, capacity, maxReply) {
    const hasSystem = messages[0]?.role === 'system';
    const system = hasSystem ? messages[0].content : '';
    const recent = hasSystem ? messages.slice(1) : messages;
    const start = context?.start ?? 0;
    // Keep the whole turn when the summary has only covered part of it.
    let low = memory ? Math.max(0, Math.floor((memory.position - start) / 2)) : 0;
    let high = Math.floor((recent.length - 1) / 2);
    const measure = async turns => {
        const dropped = turns * 2;
        const prompt = assemble(system, recent.slice(dropped), memory);
        return { prompt, before: start + dropped, maxReply: Math.min(maxReply, capacity - await count(prompt)) };
    };
    const first = await measure(low);
    if (first.maxReply === maxReply) return first;
    let best = low === high ? first : await measure(high);
    if (best.maxReply < Math.min(128, maxReply)) throw new ContextFull();
    if (best.maxReply < maxReply) return best;
    while (high - low > 1) {
        const middle = Math.floor((high + low) / 2);
        const candidate = await measure(middle);
        if (candidate.maxReply === maxReply) {
            high = middle;
            best = candidate;
        } else {
            low = middle;
        }
    }
    return best;
}

function archiveChunk(archive, before, budget) {
    let position = archive.start;
    let offset = archive.offset;
    const dialogue = [];
    for (const { role, content } of archive.messages) {
        if (position >= before || budget <= 0) break;
        let part = content.slice(offset, offset + budget);
        if (offset + part.length < content.length) part = part.replace(/[\uD800-\uDBFF]$/u, '');
        if (!part) break;
        dialogue.push({ role, content: part });
        budget -= part.length;
        offset += part.length;
        if (offset < content.length) break;
        position++;
        offset = 0;
    }
    return { position, offset, dialogue };
}

async function summarize(archive, previous, before, count, capacity, complete) {
    if (!archive || archive.start >= before) return;
    const maxReply = Math.min(512, Math.floor(capacity / 5));
    for (let budget = 8000; budget >= 125; budget = Math.floor(budget / 2)) {
        const { position, offset, dialogue } = archiveChunk(archive, before, budget);
        if (!dialogue.length) return;
        const messages = [
            { role: 'system', content: summaryInstruction },
            { role: 'user', content: JSON.stringify({ previous: previous?.summary ?? '', dialogue }) },
        ];
        if (await count(messages) + maxReply > capacity) continue;
        const summary = (await complete(messages, { temperature: 0.2, max_tokens: maxReply }, 45_000)).trim();
        if (summary && summary.length <= 6000) return { position, offset, summary };
        return;
    }
}

export async function prepareChat({ messages, context }, { contextSize, maxReply, count, complete, summarizeHistory }) {
    // Keep a margin for special tokens and the generation prompt.
    const capacity = contextSize - 32;
    const limit = Math.min(maxReply ?? 1024, Math.floor(capacity / 2));
    const previous = context?.memory;
    let fitted;
    try {
        fitted = await fitPrompt(messages, context, previous, count, capacity, limit);
    } catch (error) {
        if (!(error instanceof ContextFull) || !previous) throw error;
        fitted = await fitPrompt(messages, context, null, count, capacity, limit);
    }
    if (!summarizeHistory || !context?.archive) return fitted;

    // Summary failure must not block the conversation or overwrite the last successful summary.
    try {
        const memory = await summarize(context.archive, previous, fitted.before, count, capacity, complete);
        if (memory) return { ...await fitPrompt(messages, context, memory, count, capacity, limit), memory };
    } catch {
        // The next approved chat request can try this chunk again.
    }
    return fitted;
}
