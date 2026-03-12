import * as PDFJS from 'pdfjs-dist';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

// Set up worker for PDFJS
PDFJS.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS.version}/pdf.worker.min.js`;

export type ParsedFile =
    | { type: 'text'; content: string }
    | { type: 'images'; content: string[] }  // array of base64 data URLs
    | { type: 'skip'; reason: string };

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif']);
const SKIP_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'exe', 'apk', 'dmg']);

export async function parseFile(file: File): Promise<ParsedFile> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';

    if (SKIP_EXTENSIONS.has(extension)) {
        return { type: 'skip', reason: 'Unsupported archive/binary format' };
    }

    if (IMAGE_EXTENSIONS.has(extension)) {
        const base64 = await fileToBase64(file);
        return { type: 'images', content: [base64] };
    }

    switch (extension) {
        case 'pdf':
            return await parsePDF(file);
        case 'docx':
            return { type: 'text', content: await parseDocx(file) };
        case 'xlsx':
        case 'xls':
        case 'csv':
            return { type: 'text', content: await parseExcel(file) };
        case 'txt':
        case 'html':
        case 'htm':
            return { type: 'text', content: await file.text() };
        default:
            return { type: 'skip', reason: `Unsupported file type: .${extension}` };
    }
}

async function parsePDF(file: File): Promise<ParsedFile> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await PDFJS.getDocument({ data: arrayBuffer }).promise;

    // First try text extraction
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item: any) => item.str).join(' ') + '\n';
    }

    // If meaningful text was extracted, return as text
    const cleanText = text.replace(/\s+/g, ' ').trim();
    if (cleanText.length > 100) {
        return { type: 'text', content: text };
    }

    // Scanned PDF — render each page to canvas and return as images
    const images: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 }); // scale 2x for better OCR quality
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport }).promise;
        images.push(canvas.toDataURL('image/jpeg', 0.85));
    }

    return { type: 'images', content: images };
}

async function parseDocx(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
}

async function parseExcel(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    let text = '';
    workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        text += XLSX.utils.sheet_to_csv(worksheet) + '\n';
    });
    return text;
}

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
