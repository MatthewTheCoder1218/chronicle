import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let pausedUntil: number | undefined;
let sessionCommits = 0;
let sessionFilesCommitted = 0;
let lastSavedFile: string | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('📚 Chronicle is active!');

    // Track file save
    const saveDisposable = vscode.workspace.onDidSaveTextDocument(handleFileSave);

    // Track file change (switch)
    const changeDisposable = vscode.window.onDidChangeActiveTextEditor(handleFileSwitch);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('chronicle.commitNow', manualCommit),
        vscode.commands.registerCommand('chronicle.pauseAutoCommit', pauseAutoCommit),
        vscode.commands.registerCommand('chronicle.resumeAutoCommit', resumeAutoCommit),
        vscode.commands.registerCommand('chronicle.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'chronicle');
        })
    );

    context.subscriptions.push(saveDisposable, changeDisposable);
}

async function handleFileSave(document: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('chronicle');
    if (!config.get<boolean>('autoCommit', true)) return;

    const exts = config.get<string[]>('fileExtensions', ['.js','.ts','.jsx','.tsx','.css','.scss','.html']);
    if (!exts.includes(path.extname(document.fileName))) return;

    lastSavedFile = document.fileName;
}

async function handleFileSwitch(editor: vscode.TextEditor | undefined) {
    if (!editor) return;
    if (!lastSavedFile) return;
    if (pausedUntil && Date.now() < pausedUntil) return;

    const currentFile = editor.document.fileName;
    if (currentFile === lastSavedFile) return; // only trigger when switching to a different file

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) return;
    const workspacePath = workspaceFolder.uri.fsPath;
    if (!(await isGitRepository(workspacePath))) return;

    await autoCommitAndPush(workspacePath);
    lastSavedFile = undefined; // reset after commit
}

async function autoCommitAndPush(workspacePath: string) {
    try {
        const status = await execAsync('git status --porcelain', { cwd: workspacePath });
        if (!status.stdout.trim()) return;

        const conflicts = await execAsync('git diff --name-only --diff-filter=U', { cwd: workspacePath });
        if (conflicts.stdout.trim()) {
            vscode.window.showWarningMessage('📚 DevChronicle: Merge conflicts detected. Auto-commit skipped.');
            return;
        }

        let message = await generateCommitMessage(workspacePath);

        const userMessage = await vscode.window.showInputBox({
            prompt: '📚 DevChronicle: Commit message',
            value: message,
            ignoreFocusOut: true
        });

        if (userMessage === undefined) {
            vscode.window.showInformationMessage('📚 DevChronicle: Commit canceled.');
            return;
        }
        message = userMessage;

        await execAsync('git add .', { cwd: workspacePath });
        await execAsync(`git commit -m "${message}"`, { cwd: workspacePath });

        const pushEnabled = vscode.workspace.getConfiguration('chronicle').get<boolean>('autoPush', true);
        if (pushEnabled) await execAsync('git push', { cwd: workspacePath });

        // Gamification stats
        sessionCommits++;
        const changedFiles = (await execAsync('git diff --name-only HEAD~1', { cwd: workspacePath }))
            .stdout.trim().split('\n').filter(f => f);
        sessionFilesCommitted += changedFiles.length;

        vscode.window.showInformationMessage(
            `📚 DevChronicle: Committed & pushed! Commits today: ${sessionCommits}, Files: ${sessionFilesCommitted}`
        );

    } catch (err) {
        vscode.window.showErrorMessage(`📚 DevChronicle: Commit failed - ${err}`);
    }
}

async function manualCommit() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('📚 DevChronicle: No workspace folder found.');
        return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
    autoCommitAndPush(workspacePath);
}

function pauseAutoCommit() {
    pausedUntil = Date.now() + 60 * 60 * 1000;
    vscode.window.showInformationMessage('📚 DevChronicle: Auto-commit paused for 1 hour.');
}

function resumeAutoCommit() {
    pausedUntil = undefined;
    vscode.window.showInformationMessage('📚 DevChronicle: Auto-commit resumed.');
}

// Generate commit message based on file types
async function generateCommitMessage(workspacePath: string): Promise<string> {
    try {
        const { stdout } = await execAsync('git diff --name-only --cached', { cwd: workspacePath });
        const files = stdout.trim().split('\n').filter(f => f);
        if (!files.length) return 'Update code';

        const hasReact = files.some(f => f.endsWith('.tsx') || f.endsWith('.jsx'));
        const hasStyles = files.some(f => f.endsWith('.css') || f.endsWith('.scss'));
        const hasApi = files.some(f => f.includes('api/') || f.includes('server/'));
        const hasConfig = files.some(f => f.endsWith('.json') || f.endsWith('.yml'));

        if (hasReact && hasStyles) return 'Update components and styling';
        if (hasReact) return 'Update React components';
        if (hasStyles) return 'Update styling';
        if (hasApi) return 'Update API endpoints';
        if (hasConfig) return 'Update configuration';
        if (files.length === 1) return `Update ${path.basename(files[0])}`;
        return `Update ${files.length} files`;
    } catch {
        return 'Update code';
    }
}

async function isGitRepository(workspacePath: string) {
    return fs.existsSync(path.join(workspacePath, '.git'));
}

export function deactivate() {}
