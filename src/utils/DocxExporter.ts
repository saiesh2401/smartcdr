import {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, PageBreak, UnderlineType,
} from 'docx';
import { saveAs } from 'file-saver';

const FONT = 'Times New Roman';
const BODY_SIZE = 24;       // 12pt in half-points
const HEADING1_SIZE = 36;   // 18pt
const HEADING2_SIZE = 28;   // 14pt
const HEADING3_SIZE = 26;   // 13pt

// Parse inline markdown within a single line into TextRun[]
// Handles: **bold**, *italic*, __underline__ — strips everything else
function parseInline(text: string): TextRun[] {
    // Strip any remaining lone * or _ that aren't part of recognized patterns
    const runs: TextRun[] = [];
    // Split on bold (**...**), italic (*...*), or underline (__...__)
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        // Plain text before this match
        if (match.index > lastIndex) {
            const plain = text.slice(lastIndex, match.index);
            if (plain) runs.push(new TextRun({ text: plain, font: FONT, size: BODY_SIZE }));
        }

        const token = match[0];
        if (token.startsWith('**') && token.endsWith('**')) {
            runs.push(new TextRun({ text: token.slice(2, -2), bold: true, font: FONT, size: BODY_SIZE }));
        } else if (token.startsWith('__') && token.endsWith('__')) {
            runs.push(new TextRun({ text: token.slice(2, -2), underline: { type: UnderlineType.SINGLE }, font: FONT, size: BODY_SIZE }));
        } else if (token.startsWith('*') && token.endsWith('*')) {
            runs.push(new TextRun({ text: token.slice(1, -1), italics: true, font: FONT, size: BODY_SIZE }));
        }

        lastIndex = match.index + token.length;
    }

    // Remaining plain text
    if (lastIndex < text.length) {
        runs.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: BODY_SIZE }));
    }

    return runs.length > 0 ? runs : [new TextRun({ text, font: FONT, size: BODY_SIZE })];
}

// Convert markdown text to docx Paragraph[]
function parseContent(text: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    const lines = text.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        // Heading 1: # or ####+ all become H1
        if (/^#{4,}\s/.test(line) || /^#\s/.test(line)) {
            const content = line.replace(/^#+\s*/, '').trim();
            paragraphs.push(new Paragraph({
                children: [new TextRun({ text: content, bold: true, font: FONT, size: HEADING1_SIZE })],
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 400, after: 200 },
            }));

        // Heading 2: ##
        } else if (/^##\s/.test(line)) {
            const content = line.replace(/^##\s*/, '').trim();
            paragraphs.push(new Paragraph({
                children: [new TextRun({ text: content, bold: true, font: FONT, size: HEADING2_SIZE })],
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 320, after: 160 },
            }));

        // Heading 3: ###
        } else if (/^###\s/.test(line)) {
            const content = line.replace(/^###\s*/, '').trim();
            paragraphs.push(new Paragraph({
                children: [new TextRun({ text: content, bold: true, font: FONT, size: HEADING3_SIZE })],
                heading: HeadingLevel.HEADING_3,
                spacing: { before: 240, after: 120 },
            }));

        // Horizontal rule
        } else if (/^---+$/.test(line.trim())) {
            paragraphs.push(new Paragraph({ text: '', spacing: { before: 160, after: 160 } }));

        // Bullet point: - or * or •
        } else if (/^[\-\*•]\s/.test(line)) {
            const content = line.replace(/^[\-\*•]\s*/, '').trim();
            paragraphs.push(new Paragraph({
                children: parseInline(content),
                bullet: { level: 0 },
                spacing: { before: 60, after: 60 },
            }));

        // Empty line
        } else if (line.trim() === '') {
            paragraphs.push(new Paragraph({ text: '', spacing: { before: 0, after: 100 } }));

        // Normal paragraph
        } else {
            paragraphs.push(new Paragraph({
                children: parseInline(line),
                spacing: { before: 80, after: 80 },
                alignment: AlignmentType.JUSTIFIED,
            }));
        }
    }

    return paragraphs;
}

export async function exportToDocx(
    entries: string,
    masterNarrative: string,
    caseBriefing: string,
    filename = 'Case_Diary'
) {
    const now = new Date().toLocaleString('en-IN');
    const sections = [];

    // Cover page
    sections.push({
        children: [
            new Paragraph({
                children: [new TextRun({ text: 'CASE DIARY', bold: true, size: 64, font: FONT })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 2000, after: 400 },
            }),
            new Paragraph({
                children: [new TextRun({ text: 'Investigation Report', size: 40, font: FONT, italics: true })],
                alignment: AlignmentType.CENTER,
                spacing: { after: 800 },
            }),
            ...(caseBriefing.trim() ? [
                new Paragraph({
                    children: [new TextRun({ text: 'CASE BRIEFING', bold: true, size: 28, font: FONT })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 400, after: 200 },
                }),
                new Paragraph({
                    children: [new TextRun({ text: caseBriefing, size: BODY_SIZE, font: FONT })],
                    alignment: AlignmentType.JUSTIFIED,
                    spacing: { after: 800 },
                }),
            ] : []),
            new Paragraph({
                children: [new TextRun({ text: `Generated: ${now}`, size: 20, color: '64748b', italics: true, font: FONT })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 800 },
            }),
            new Paragraph({ children: [new PageBreak()] }),
        ],
    });

    // Master narrative (primary section)
    if (masterNarrative.trim()) {
        sections.push({
            children: [
                new Paragraph({
                    children: [new TextRun({ text: 'MASTER CASE NARRATIVE', bold: true, size: HEADING1_SIZE, font: FONT })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 200, after: 400 },
                }),
                ...parseContent(masterNarrative),
                new Paragraph({ children: [new PageBreak()] }),
            ],
        });
    }

    // Document-wise entries
    if (entries.trim()) {
        sections.push({
            children: [
                new Paragraph({
                    children: [new TextRun({ text: 'DOCUMENT-WISE ENTRIES', bold: true, size: HEADING1_SIZE, font: FONT })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 200, after: 400 },
                }),
                ...parseContent(entries),
            ],
        });
    }

    const doc = new Document({ sections });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, `${filename}.docx`);
}
