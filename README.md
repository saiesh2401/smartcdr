# Smart CDR Maker

Turns a folder of investigation documents into a structured **Case Diary**. Upload PDFs, Word files, spreadsheets and images. Each one is read and summarised into a diary entry, and the entries are then combined into a single master narrative that you can export to Word.

## Features

- **Multi-format input:** PDF (text and scanned pages), `.docx`, Excel/CSV and images
- **Diary entry per document,** written with the case briefing as context
- **Entity memory:** people, phone numbers, places and dates are carried from one document to the next, so later entries stay consistent
- **Master narrative:** combines all the entries into one case diary
- **Pause, resume and cancel** long batches, with a live status log
- **Autosave** to browser storage, with an offer to restore after a reload
- **Export to `.docx`** with headings and formatting kept

## Tech

React 19 · TypeScript · Vite · OpenAI (`gpt-4o-mini`) · pdf.js · mammoth · SheetJS · docx

## Run locally

```bash
npm install
echo "VITE_OPENAI_API_KEY=sk-..." > .env.local
npm run dev
```

Then open the URL Vite prints, add a case briefing, choose your files and start.

> **Note:** the OpenAI key is used directly from the browser (`dangerouslyAllowBrowser`). Run it only on your own machine. Don't deploy this build publicly, because anyone who loads the page could read the key. For a hosted version, move the OpenAI calls behind a small server.

## Project layout

```
src/
  App.tsx                 UI, batch processing, autosave
  utils/FileParser.ts     PDF / DOCX / Excel / image parsing
  utils/OpenAIClient.ts   diary entries, entity extraction, synthesis
  utils/DocxExporter.ts   Markdown-style text to .docx
```
