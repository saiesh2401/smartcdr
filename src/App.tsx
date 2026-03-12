import React, { useState, useRef, useEffect } from 'react';
import { parseFile } from './utils/FileParser';
import { OpenAIClient, emptyEntityMemory, mergeEntities, getErrorMessage, isQuotaError } from './utils/OpenAIClient';
import type { EntityMemory } from './utils/OpenAIClient';
import { exportToDocx } from './utils/DocxExporter';
import { saveAs } from 'file-saver';

const AUTOSAVE_KEY = 'cdr_autosave';

const App: React.FC = () => {
    const [apiKey] = useState(import.meta.env.VITE_OPENAI_API_KEY || '');
    const [caseBriefing, setCaseBriefing] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [report, setReport] = useState('');
    const [masterNarrative, setMasterNarrative] = useState('');
    const [loading, setLoading] = useState(false);
    const [synthesizing, setSynthesizing] = useState(false);
    const [paused, setPaused] = useState(false);
    const [currentFile, setCurrentFile] = useState('');
    const [currentIndex, setCurrentIndex] = useState(0);
    const [statusLog, setStatusLog] = useState<string[]>([]);
    const [lastSaved, setLastSaved] = useState<string | null>(null);
    const [showRestoreBanner, setShowRestoreBanner] = useState(false);
    const [budgetError, setBudgetError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'entries' | 'master'>('entries');
    const [entityMemory, setEntityMemory] = useState<EntityMemory>(emptyEntityMemory());

    const pausedRef = useRef(false);
    const cancelledRef = useRef(false);

    useEffect(() => {
        const saved = localStorage.getItem(AUTOSAVE_KEY);
        if (saved) setShowRestoreBanner(true);
    }, []);

    const restoreSaved = () => {
        const saved = localStorage.getItem(AUTOSAVE_KEY);
        if (saved) { setReport(saved); setLastSaved(new Date().toLocaleTimeString()); }
        setShowRestoreBanner(false);
    };

    const discardSaved = () => { localStorage.removeItem(AUTOSAVE_KEY); setShowRestoreBanner(false); };

    const autoSave = (content: string) => {
        localStorage.setItem(AUTOSAVE_KEY, content);
        setLastSaved(new Date().toLocaleTimeString());
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            setFiles(Array.from(e.target.files));
            setCurrentIndex(0);
            setStatusLog([]);
            setBudgetError(null);
        }
    };

    const handlePauseResume = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); };
    const handleStop = () => { cancelledRef.current = true; pausedRef.current = false; setPaused(false); };

    const waitIfPaused = () => new Promise<void>((resolve) => {
        const check = () => { if (!pausedRef.current || cancelledRef.current) resolve(); else setTimeout(check, 300); };
        check();
    });

    const generateReport = async () => {
        if (!apiKey || files.length === 0) { alert('Please select files first.'); return; }

        setLoading(true);
        setPaused(false);
        setReport('');
        setMasterNarrative('');
        setCurrentIndex(0);
        setStatusLog([]);
        setBudgetError(null);
        setEntityMemory(emptyEntityMemory());
        pausedRef.current = false;
        cancelledRef.current = false;

        let fullCaseDiary = caseBriefing.trim()
            ? `# Case Diary - Investigation Report\n\n**Case Briefing:** ${caseBriefing}\n\n`
            : '# Case Diary - Investigation Report\n\n';

        let currentEntities = emptyEntityMemory();
        const log: string[] = [];
        let hitBudgetError = false;

        try {
            const client = new OpenAIClient(apiKey);

            for (let i = 0; i < files.length; i++) {
                if (cancelledRef.current) { log.push('⛔ Stopped by user.'); setStatusLog([...log]); break; }
                await waitIfPaused();
                if (cancelledRef.current) { log.push('⛔ Stopped by user.'); setStatusLog([...log]); break; }

                const file = files[i];
                setCurrentIndex(i + 1);
                setCurrentFile(file.name);

                try {
                    const parsed = await parseFile(file);

                    if (parsed.type === 'skip') {
                        log.push(`⏭ Skipped: ${file.name} — ${parsed.reason}`);
                        setStatusLog([...log]);
                        continue;
                    }

                    const mode = parsed.type === 'images'
                        ? `vision (${parsed.content.length} image${parsed.content.length > 1 ? 's' : ''})`
                        : 'text';
                    log.push(`⚙ Processing: ${file.name} [${mode}]`);
                    setStatusLog([...log]);

                    const analysis = await client.analyzeFile(file.name, parsed, caseBriefing, fullCaseDiary, currentEntities);
                    fullCaseDiary += `\n---\n## ${file.name}\n\n${analysis}\n`;
                    setReport(fullCaseDiary);
                    autoSave(fullCaseDiary);

                    // Extract entities from this analysis and update memory
                    const newEntities = await client.extractEntities(analysis);
                    currentEntities = mergeEntities(currentEntities, newEntities);
                    setEntityMemory({ ...currentEntities });

                    log[log.length - 1] = `✓ Done: ${file.name}`;
                    setStatusLog([...log]);
                } catch (err) {
                    if (isQuotaError(err)) {
                        const msg = getErrorMessage(err);
                        setBudgetError(msg);
                        log.push(`⛔ Budget error — processing stopped.`);
                        setStatusLog([...log]);
                        hitBudgetError = true;
                        break;
                    }
                    console.error(`Error processing ${file.name}:`, err);
                    log.push(`✗ Error: ${file.name} — ${getErrorMessage(err)}`);
                    setStatusLog([...log]);
                    fullCaseDiary += `\n---\n## ${file.name}\n\nCould not extract or analyze content.\n`;
                    autoSave(fullCaseDiary);
                }
            }

            // Final synthesis — only if we processed at least something and weren't stopped by budget
            if (!hitBudgetError && !cancelledRef.current && fullCaseDiary.length > 200) {
                setSynthesizing(true);
                log.push('⚙ Generating Master Narrative...');
                setStatusLog([...log]);
                try {
                    const master = await client.synthesize(caseBriefing, fullCaseDiary);
                    setMasterNarrative(master);
                    setActiveTab('master');
                    log[log.length - 1] = '✓ Master Narrative ready.';
                    setStatusLog([...log]);
                } catch (err) {
                    if (isQuotaError(err)) {
                        setBudgetError(getErrorMessage(err));
                        log[log.length - 1] = '⛔ Budget error during synthesis.';
                    } else {
                        log[log.length - 1] = `✗ Synthesis failed: ${getErrorMessage(err)}`;
                    }
                    setStatusLog([...log]);
                } finally {
                    setSynthesizing(false);
                }
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
            setSynthesizing(false);
            setPaused(false);
            setCurrentFile('');
        }
    };

    const downloadTxt = (content: string, filename: string) => {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        saveAs(blob, filename);
    };

    const downloadDocx = async () => {
        await exportToDocx(report, masterNarrative, caseBriefing, 'Case_Diary');
    };

    const hasContent = report || masterNarrative;
    const entityCount = Object.values(entityMemory).flat().length;

    return (
        <div className="app-container">
            <h1>Case Diary Maker</h1>
            <p className="subtitle">Automated Date-wise Investigation Diary Generator</p>

            {/* Budget error banner */}
            {budgetError && (
                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#450a0a', borderRadius: '0.75rem', border: '1px solid #dc2626', color: '#fca5a5' }}>
                    {budgetError}
                </div>
            )}

            {/* Restore banner */}
            {showRestoreBanner && (
                <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#1e3a5f', borderRadius: '0.75rem', border: '1px solid #3b82f6', color: '#93c5fd', textAlign: 'center' }}>
                    <p style={{ margin: '0 0 0.75rem' }}>A previously auto-saved report was found. Restore it?</p>
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                        <button onClick={restoreSaved} style={{ width: 'auto', padding: '0.4rem 1rem', background: '#2563eb' }}>Restore</button>
                        <button onClick={discardSaved} style={{ width: 'auto', padding: '0.4rem 1rem', background: '#334155' }}>Discard</button>
                    </div>
                </div>
            )}

            {/* Case briefing */}
            <div className="input-group">
                <label>Case Briefing (FIR no., accused names, nature of crime)</label>
                <textarea
                    placeholder="e.g. FIR No. 142/25, PS Cyber Crime. Accused: Rajesh Kumar (M/30). Complainant defrauded of ₹5,40,000 via fake investment app. Accused contacted victim via WhatsApp using no. 9876543210..."
                    value={caseBriefing}
                    onChange={(e) => setCaseBriefing(e.target.value)}
                    disabled={loading}
                    rows={4}
                    style={{
                        width: '100%', padding: '0.75rem', background: '#0f172a', border: '1px solid #334155',
                        borderRadius: '0.75rem', color: 'white', marginTop: '0.25rem', boxSizing: 'border-box',
                        resize: 'vertical', fontFamily: 'inherit', fontSize: '0.9rem', lineHeight: '1.5',
                    }}
                />
            </div>

            <div className="input-group">
                <label>Select Files</label>
                <input type="file" multiple onChange={handleFileChange} disabled={loading} />
            </div>

            {files.length > 0 && (
                <div style={{ marginBottom: '1rem', textAlign: 'center', color: '#94a3b8' }}>
                    <strong>{files.length}</strong> files selected.
                    {loading
                        ? synthesizing
                            ? ' Generating Master Narrative...'
                            : paused
                                ? ` Paused at "${currentFile}" (${currentIndex}/${files.length})`
                                : ` Processing "${currentFile}" (${currentIndex}/${files.length})...`
                        : ' Ready to process.'}
                </div>
            )}

            {!loading && (
                <button onClick={generateReport} disabled={files.length === 0}>
                    Generate Case Diary
                </button>
            )}

            {loading && (
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                    <button onClick={handlePauseResume} disabled={synthesizing} style={{ flex: 1, background: paused ? '#16a34a' : '#b45309' }}>
                        {paused ? '▶ Resume' : '⏸ Pause'}
                    </button>
                    <button onClick={handleStop} disabled={synthesizing} style={{ flex: 1, background: '#991b1b' }}>
                        ⛔ Stop
                    </button>
                </div>
            )}

            {loading && !paused && (
                <div className="loading-spinner">
                    <div className="spinner"></div>
                    <p>{synthesizing ? 'Writing Master Narrative...' : 'Analyzing files...'} Please wait.</p>
                </div>
            )}

            {loading && paused && (
                <div style={{ textAlign: 'center', marginTop: '1.5rem', color: '#fbbf24' }}>
                    ⏸ Paused — press Resume to continue.
                </div>
            )}

            {/* Entity memory panel */}
            {entityCount > 0 && (
                <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', background: '#0f172a', borderRadius: '0.75rem', border: '1px solid #334155', fontSize: '0.75rem', color: '#94a3b8' }}>
                    <strong style={{ color: '#818cf8' }}>Known Entities ({entityCount})</strong>
                    {entityMemory.persons.length > 0 && <div>👤 {entityMemory.persons.join(', ')}</div>}
                    {entityMemory.phoneNumbers.length > 0 && <div>📞 {entityMemory.phoneNumbers.join(', ')}</div>}
                    {entityMemory.bankAccounts.length > 0 && <div>🏦 {entityMemory.bankAccounts.join(', ')}</div>}
                    {entityMemory.ipAddresses.length > 0 && <div>🌐 {entityMemory.ipAddresses.join(', ')}</div>}
                    {entityMemory.emails.length > 0 && <div>✉️ {entityMemory.emails.join(', ')}</div>}
                    {entityMemory.others.length > 0 && <div>🔖 {entityMemory.others.join(', ')}</div>}
                </div>
            )}

            {/* Status log */}
            {statusLog.length > 0 && (
                <div style={{ marginTop: '1rem', padding: '1rem', background: '#0f172a', borderRadius: '0.75rem', border: '1px solid #334155', fontSize: '0.8rem', color: '#94a3b8', maxHeight: '150px', overflowY: 'auto' }}>
                    {statusLog.map((entry, i) => <div key={i}>{entry}</div>)}
                </div>
            )}

            {/* Report tabs */}
            {hasContent && (
                <div className="report-area">
                    {/* Tab bar */}
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #334155', paddingBottom: '0.5rem' }}>
                        <button
                            onClick={() => setActiveTab('entries')}
                            style={{ width: 'auto', padding: '0.4rem 1rem', margin: 0, background: activeTab === 'entries' ? '#6366f1' : '#1e293b', fontSize: '0.85rem' }}
                        >
                            File Entries
                        </button>
                        <button
                            onClick={() => setActiveTab('master')}
                            style={{ width: 'auto', padding: '0.4rem 1rem', margin: 0, background: activeTab === 'master' ? '#6366f1' : '#1e293b', fontSize: '0.85rem' }}
                            disabled={!masterNarrative}
                        >
                            Master Narrative {masterNarrative ? '✓' : synthesizing ? '...' : ''}
                        </button>

                        <div style={{ flex: 1 }} />

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {lastSaved && <span style={{ fontSize: '0.7rem', color: '#4ade80' }}>✓ Saved {lastSaved}</span>}
                            <button onClick={downloadDocx} style={{ width: 'auto', padding: '0.35rem 0.75rem', background: '#1d4ed8', margin: 0, fontSize: '0.8rem' }}>
                                Download .docx
                            </button>
                            {activeTab === 'entries' && report && (
                                <button onClick={() => downloadTxt(report, 'Case_Diary_Entries.txt')} style={{ width: 'auto', padding: '0.35rem 0.75rem', background: '#334155', margin: 0, fontSize: '0.8rem' }}>
                                    .txt
                                </button>
                            )}
                            {activeTab === 'master' && masterNarrative && (
                                <button onClick={() => downloadTxt(masterNarrative, 'Case_Diary_Master.txt')} style={{ width: 'auto', padding: '0.35rem 0.75rem', background: '#334155', margin: 0, fontSize: '0.8rem' }}>
                                    .txt
                                </button>
                            )}
                        </div>
                    </div>

                    {activeTab === 'entries' && report && (
                        <div style={{ whiteSpace: 'pre-wrap' }}>{report}</div>
                    )}
                    {activeTab === 'master' && masterNarrative && (
                        <div style={{ whiteSpace: 'pre-wrap' }}>{masterNarrative}</div>
                    )}
                    {activeTab === 'master' && !masterNarrative && synthesizing && (
                        <div style={{ textAlign: 'center', color: '#94a3b8', padding: '2rem' }}>Writing master narrative...</div>
                    )}
                </div>
            )}
        </div>
    );
};

export default App;
