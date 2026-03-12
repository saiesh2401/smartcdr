import OpenAI from 'openai';
import type { ParsedFile } from './FileParser';

const MAX_CONTEXT_CHARS = 120_000;

export interface EntityMemory {
    persons: string[];
    phoneNumbers: string[];
    bankAccounts: string[];
    ipAddresses: string[];
    emails: string[];
    others: string[];
}

export function emptyEntityMemory(): EntityMemory {
    return { persons: [], phoneNumbers: [], bankAccounts: [], ipAddresses: [], emails: [], others: [] };
}

function mergeEntities(existing: EntityMemory, incoming: Partial<EntityMemory>): EntityMemory {
    const merge = (a: string[], b: string[] = []) =>
        Array.from(new Set([...a, ...b.map(s => s.trim()).filter(Boolean)]));
    return {
        persons:      merge(existing.persons,      incoming.persons),
        phoneNumbers: merge(existing.phoneNumbers, incoming.phoneNumbers),
        bankAccounts: merge(existing.bankAccounts, incoming.bankAccounts),
        ipAddresses:  merge(existing.ipAddresses,  incoming.ipAddresses),
        emails:       merge(existing.emails,       incoming.emails),
        others:       merge(existing.others,       incoming.others),
    };
}

function formatEntities(mem: EntityMemory): string {
    const lines: string[] = [];
    if (mem.persons.length)      lines.push(`Persons of Interest: ${mem.persons.join(', ')}`);
    if (mem.phoneNumbers.length) lines.push(`Phone Numbers: ${mem.phoneNumbers.join(', ')}`);
    if (mem.bankAccounts.length) lines.push(`Bank Accounts: ${mem.bankAccounts.join(', ')}`);
    if (mem.ipAddresses.length)  lines.push(`IP Addresses: ${mem.ipAddresses.join(', ')}`);
    if (mem.emails.length)       lines.push(`Email Addresses: ${mem.emails.join(', ')}`);
    if (mem.others.length)       lines.push(`Other Key References: ${mem.others.join(', ')}`);
    return lines.join('\n');
}

const DIARY_SYSTEM_PROMPT = `You are a senior criminal investigator writing an official Case Diary for an Indian court. Your writing style is authoritative, narrative, and descriptive — like a detailed investigation report that tells the story of the case.

You will be given a document from the case file. Your job is to extract all relevant facts and write them as a flowing narrative Case Diary entry.

Writing style rules:
- Write in past tense, first person plural ("During the course of investigation...", "It was found that...", "The accused was confronted...")
- Be descriptive and detailed — do not use bullet points or numbered lists
- Connect facts to each other where possible
- Use proper legal and investigative language
- Group content by date but write each date as a narrative paragraph, not a list
- Mention specific names, numbers, amounts, dates, places as found in the document
- If the document is a CDR: describe call patterns, who called whom, frequency, tower locations, suspicious timings in narrative form
- If it's a bank statement: describe the money trail, amounts, accounts, transaction patterns
- If it's an interrogation: describe what the accused/witness stated, what was admitted, what was denied
- If it's a company reply (Google, telecom): describe what data was received and its significance
- If it's a court document: describe the proceedings, orders, directions given

At the end of each entry, write a section called "INVESTIGATIVE SIGNIFICANCE" — a paragraph explaining what this document reveals about the case, new leads it opens, and how it connects to previously known facts.`;

const ENTITY_EXTRACTION_PROMPT = `Extract key entities from this investigation document text. Return ONLY a valid JSON object with these fields (use empty arrays if none found):
{
  "persons": ["full names of accused, victims, witnesses"],
  "phoneNumbers": ["mobile/phone numbers"],
  "bankAccounts": ["account numbers, UPI IDs"],
  "ipAddresses": ["IP addresses"],
  "emails": ["email addresses"],
  "others": ["FIR numbers, case numbers, IMEI numbers, vehicle numbers, any other key identifiers"]
}`;

const SYNTHESIS_PROMPT = `You are a senior criminal investigator writing the FINAL MASTER NARRATIVE for a court case diary.

You have been given all individual diary entries from multiple documents in this case. Your task is to synthesize everything into ONE comprehensive, chronological investigation story.

Write this as a formal, narrative Case Diary that:
1. Starts with a brief CASE OVERVIEW (FIR details, nature of crime, accused, complainant)
2. Tells the complete story of the investigation chronologically — what happened, when, who did what, what was found
3. Weaves together CDR data, financial records, interrogations, court orders, company replies into one unified narrative
4. Highlights the MODUS OPERANDI of the accused clearly
5. Shows how evidence from different documents connects and corroborates
6. Ends with CONCLUSIONS AND CURRENT STATUS of the investigation

Write in the same authoritative, narrative style as an official police Case Diary. Be thorough and descriptive. This is the master document that will go to court.`;

export function isQuotaError(err: unknown): boolean {
    if (err instanceof OpenAI.APIError) {
        return err.status === 429 || (err as any).code === 'insufficient_quota';
    }
    return false;
}

export function getErrorMessage(err: unknown): string {
    if (err instanceof OpenAI.APIError) {
        if (err.status === 429 || (err as any).code === 'insufficient_quota') {
            return '⚠️ OpenAI Budget Exhausted: Your API quota has been exceeded. Please top up your OpenAI account at platform.openai.com/billing and try again.';
        }
        if (err.status === 401) {
            return '⚠️ Invalid API Key: The OpenAI API key is invalid or expired.';
        }
        if (err.status === 500) {
            return '⚠️ OpenAI Server Error: OpenAI is experiencing issues. Please try again in a moment.';
        }
        return `⚠️ OpenAI Error (${err.status}): ${err.message}`;
    }
    return `⚠️ Unexpected error: ${String(err)}`;
}

export class OpenAIClient {
    private openai: OpenAI;

    constructor(apiKey: string) {
        this.openai = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    }

    async analyzeFile(
        fileName: string,
        parsed: ParsedFile,
        caseBriefing: string,
        caseDiarySoFar: string,
        entityMemory: EntityMemory
    ): Promise<string> {
        if (parsed.type === 'skip') return `[Skipped: ${parsed.reason}]`;

        const contextBlock = this.buildContextBlock(caseBriefing, caseDiarySoFar, entityMemory);

        if (parsed.type === 'text') {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: DIARY_SYSTEM_PROMPT },
                    { role: 'user', content: `${contextBlock}\n\nNow analyze the following document (file: "${fileName}") and write the Case Diary entry:\n\n${parsed.content}` },
                ],
                max_tokens: 4096,
            });
            return response.choices[0]?.message?.content || 'No analysis generated.';
        }

        // Vision path
        const CHUNK_SIZE = 10;
        let fullAnalysis = '';
        for (let i = 0; i < parsed.content.length; i += CHUNK_SIZE) {
            const chunk = parsed.content.slice(i, i + CHUNK_SIZE);
            const pageLabel = parsed.content.length > 1
                ? ` (pages ${i + 1}–${Math.min(i + CHUNK_SIZE, parsed.content.length)})`
                : '';

            const imageContent: OpenAI.Chat.ChatCompletionContentPart[] = chunk.map((dataUrl) => ({
                type: 'image_url',
                image_url: { url: dataUrl, detail: 'high' },
            }));

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: DIARY_SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: [
                            ...imageContent,
                            {
                                type: 'text',
                                text: `${contextBlock}\n\nAnalyze the document shown in the image(s) above (file: "${fileName}"${pageLabel}) and write the Case Diary entry.`,
                            },
                        ],
                    },
                ],
                max_tokens: 4096,
            });

            fullAnalysis += response.choices[0]?.message?.content || '';
            if (i + CHUNK_SIZE < parsed.content.length) fullAnalysis += '\n\n';
        }
        return fullAnalysis || 'No analysis generated.';
    }

    async extractEntities(text: string): Promise<Partial<EntityMemory>> {
        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
                    { role: 'user', content: text.slice(0, 8000) }, // keep it cheap
                ],
                max_tokens: 512,
                response_format: { type: 'json_object' },
            });
            const content = response.choices[0]?.message?.content || '{}';
            return JSON.parse(content);
        } catch {
            return {};
        }
    }

    async synthesize(caseBriefing: string, fullDiary: string): Promise<string> {
        const trimmed = fullDiary.length > MAX_CONTEXT_CHARS
            ? fullDiary.slice(-MAX_CONTEXT_CHARS)
            : fullDiary;

        const briefingBlock = caseBriefing.trim()
            ? `CASE BRIEFING PROVIDED BY INVESTIGATOR:\n${caseBriefing}\n\n`
            : '';

        const response = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYNTHESIS_PROMPT },
                { role: 'user', content: `${briefingBlock}INDIVIDUAL DIARY ENTRIES:\n\n${trimmed}\n\nNow write the complete Master Case Diary Narrative.` },
            ],
            max_tokens: 8192,
        });
        return response.choices[0]?.message?.content || 'Synthesis failed.';
    }

    private buildContextBlock(caseBriefing: string, caseDiarySoFar: string, entityMemory: EntityMemory): string {
        const parts: string[] = [];

        if (caseBriefing.trim()) {
            parts.push(`CASE BRIEFING (provided by investigator):\n${caseBriefing}`);
        }

        const entityStr = formatEntities(entityMemory);
        if (entityStr) {
            parts.push(`KNOWN ENTITIES IN THIS CASE:\n${entityStr}`);
        }

        if (caseDiarySoFar.trim()) {
            const trimmed = caseDiarySoFar.length > MAX_CONTEXT_CHARS
                ? '...[earlier entries truncated]\n\n' + caseDiarySoFar.slice(-MAX_CONTEXT_CHARS)
                : caseDiarySoFar;
            parts.push(`CASE DIARY BUILT SO FAR (cross-reference this):\n${trimmed}`);
        }

        return parts.length > 0
            ? '---\n' + parts.join('\n\n---\n') + '\n---'
            : '';
    }
}

export { mergeEntities };
