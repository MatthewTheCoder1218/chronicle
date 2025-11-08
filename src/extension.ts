import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';

const execAsync = promisify(exec);

let pausedUntil: number | undefined;
let sessionCommits = 0;
let sessionFilesCommitted = 0;
let lastSavedFile: string | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Chronicle is active!');

    const saveDisposable = vscode.workspace.onDidSaveTextDocument(handleFileSave);
    const changeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) handleFileSwitch(editor, context);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('chronicle.setGroqKey', () => setGroqAPIKey(context)),
        vscode.commands.registerCommand('chronicle.testAPI', () => testGroqAPI(context)),
        vscode.commands.registerCommand('chronicle.commitNow', () => manualCommit(context)),
        vscode.commands.registerCommand('chronicle.pauseAutoCommit', pauseAutoCommit),
        vscode.commands.registerCommand('chronicle.resumeAutoCommit', resumeAutoCommit),
        vscode.commands.registerCommand('chronicle.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'chronicle');
        })
    );

    context.subscriptions.push(saveDisposable, changeDisposable);
}

async function setGroqAPIKey(context: vscode.ExtensionContext) {
    const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your GROQ API key (free at console.groq.com/keys)',
        placeHolder: 'gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v?.startsWith('gsk_') && v.length > 30 ? null : 'Invalid Groq key'
    });

    if (apiKey) {
        await context.secrets.store('groq-api-key', apiKey);
        vscode.window.showInformationMessage('Groq API key saved!');
    }
}

async function testGroqAPI(context: vscode.ExtensionContext) {
    const key = await context.secrets.get('groq-api-key');
    if (key) {
        vscode.window.showInformationMessage(`Groq key: ${key.substring(0, 10)}...`);
    } else {
        vscode.window.showWarningMessage('No Groq key found');
    }
}

async function handleFileSave(document: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('chronicle');
    if (!config.get<boolean>('autoCommit', true)) return;

    const exts = config.get<string[]>('fileExtensions', ['.js','.ts','.jsx','.tsx','.css','.scss','.html']);
    if (!exts.includes(path.extname(document.fileName))) return;

    lastSavedFile = document.fileName;
}

async function handleFileSwitch(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    if (!lastSavedFile || (pausedUntil && Date.now() < pausedUntil)) return;
    if (editor.document.fileName === lastSavedFile) return;

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) return;

    const wp = folder.uri.fsPath;
    if (!await isGitRepository(wp)) return;

    await autoCommitAndPush(wp, context);
    lastSavedFile = undefined;
}

async function autoCommitAndPush(workspacePath: string, context: vscode.ExtensionContext) {
    try {
        const { stdout } = await execAsync('git status --porcelain', { cwd: workspacePath });
        if (!stdout.trim()) return;

        const conflicts = await execAsync('git diff --name-only --diff-filter=U', { cwd: workspacePath });
        if (conflicts.stdout.trim()) {
            vscode.window.showWarningMessage('Chronicle: Merge conflicts. Skipped.');
            return;
        }

        await execAsync('git add .', { cwd: workspacePath });
        let message = await generateCommitMessage(workspacePath, context);

        const userMessage = await vscode.window.showInputBox({
            prompt: 'Edit commit message or press Enter',
            value: message,
            ignoreFocusOut: true
        });

        if (userMessage === undefined) {
            vscode.window.showInformationMessage('Commit canceled.');
            return;
        }
        message = userMessage || 'chore: update';

        await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workspacePath });

        const push = vscode.workspace.getConfiguration('chronicle').get<boolean>('autoPush', true);
        if (push) await execAsync('git push', { cwd: workspacePath });

        sessionCommits++;
        const files = (await execAsync('git diff --name-only HEAD~1', { cwd: workspacePath }))
            .stdout.trim().split('\n').filter(f => f);
        sessionFilesCommitted += files.length;

        vscode.window.showInformationMessage(
            `Committed${push ? ' & pushed' : ''}! Today: ${sessionCommits} commits, ${sessionFilesCommitted} files`
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Commit failed: ${err.message}`);
    }
}

// ——— GROQ API CALL ———
async function callGroqAPI(apiKey: string, diff: string): Promise<string | null> {
    return new Promise((resolve) => {
        const prompt = `One-line conventional commit (<72 chars) for this staged diff:\n${diff}\n\nExamples:\nfix: add login guard\nfeat: add dark mode\n\nCommit message:`;

        const payload = JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 60,
            temperature: 0.3
        });

        const options = {
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                console.log('Groq Status:', res.statusCode);
                console.log('Groq Raw:', data);

                if (res.statusCode !== 200) {
                    resolve(null);
                    return;
                }

                try {
                    const json = JSON.parse(data);
                    let text = json.choices?.[0]?.message?.content?.trim() || '';
                    text = text.split('\n')[0];
                    if (!text) return resolve('chore: update');

                    const types = ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'];
                    const hasType = types.some(t => text.toLowerCase().startsWith(t + ':') || text.includes(t + '('));
                    if (!hasType) text = `chore: ${text}`;

                    if (text.length > 72) text = text.slice(0, 69) + '...';
                    resolve(text);
                } catch (e) {
                    console.error('Parse error:', e);
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.write(payload);
        req.end();
    });
}

async function generateAICommitMessage(workspacePath: string, context: vscode.ExtensionContext): Promise<string | null> {
    const apiKey = await context.secrets.get('groq-api-key');
    if (!apiKey) {
        const setup = await vscode.window.showInformationMessage(
            'Groq API key not set. Set it now?',
            'Yes', 'No', 'Disable AI'
        );
        if (setup === 'Yes') {
            await setGroqAPIKey(context);
            return generateAICommitMessage(workspacePath, context);
        } else if (setup === 'Disable AI') {
            await vscode.workspace.getConfiguration('chronicle').update('useAICommitMessages', false, true);
            return null;
        }
        return null;
    }

    try {
        const { stdout: diff } = await execAsync('git diff --cached', { cwd: workspacePath });
        if (!diff.trim()) return null;

        return await callGroqAPI(apiKey, diff.substring(0, 1500));
    } catch (e) {
        console.error('AI error:', e);
        return null;
    }
}

async function generateCommitMessage(workspacePath: string, context: vscode.ExtensionContext): Promise<string> {
    const useAI = vscode.workspace.getConfiguration('chronicle').get<boolean>('useAICommitMessages', true);
    if (useAI) {
        const ai = await generateAICommitMessage(workspacePath, context);
        if (ai) return ai;
    }

    try {
        const { stdout } = await execAsync('git diff --name-only --cached', { cwd: workspacePath });
        const files = stdout.trim().split('\n').filter(f => f);
        if (!files.length) return 'chore: update';
        if (files.length === 1) return `chore: update ${path.basename(files[0])}`;
        return `chore: update ${files.length} files`;
    } catch {
        return 'chore: update';
    }
}

async function manualCommit(context: vscode.ExtensionContext) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('No workspace folder.');
        return;
    }
    if (!await isGitRepository(folder.uri.fsPath)) {
        vscode.window.showErrorMessage('Not a git repo.');
        return;
    }
    await autoCommitAndPush(folder.uri.fsPath, context);
}

function pauseAutoCommit() {
    pausedUntil = Date.now() + 3600000;
    vscode.window.showInformationMessage('Auto-commit paused for 1 hour.');
}

function resumeAutoCommit() {
    pausedUntil = undefined;
    vscode.window.showInformationMessage('Auto-commit resumed.');
}

async function isGitRepository(p: string) {
    return fs.existsSync(path.join(p, '.git'));
}

export function deactivate() {}