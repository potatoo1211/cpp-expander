"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
// 実行中のタスク管理
let currentExecution;
// ログ出力用のチャンネル
let outputChannel;
function activate(context) {
    outputChannel = vscode.window.createOutputChannel("C++ Expander Log");
    // F5用: コピーしない
    let justRun = vscode.commands.registerCommand('cpp-expander.justRun', async () => {
        await handleWorkflow({ copyAfterRun: false });
    });
    // Ctrl+Shift+B用: コピーする
    let runAndCopy = vscode.commands.registerCommand('cpp-expander.runAndCopy', async () => {
        await handleWorkflow({ copyAfterRun: true });
    });
    context.subscriptions.push(justRun);
    context.subscriptions.push(runAndCopy);
    context.subscriptions.push(outputChannel);
}
function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}
// ---------------------------------------------------------
// メイン処理ワークフロー
// ---------------------------------------------------------
async function handleWorkflow(options) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    if (editor.document.isDirty) {
        await editor.document.save();
    }
    const filePath = editor.document.fileName;
    outputChannel.clear();
    outputChannel.appendLine(`[Start] Processing: ${filePath} (Copy: ${options.copyAfterRun})`);
    // 前回のタスク停止
    if (currentExecution) {
        try {
            currentExecution.terminate();
        }
        catch (e) { }
        currentExecution = undefined;
    }
    // ---------------------------------------------------------
    // タスク実行コマンドの構築 (Linux/Bash向け)
    // ---------------------------------------------------------
    // 1. clear: pyenv等の起動ログを消し、入力バッファをクリーンにする
    // 2. ulimit: スタックサイズ制限解除
    // 3. g++: コンパイル (失敗時は実行しない)
    // 4. read: 必ず一時停止する
    // ---------------------------------------------------------
    const commandLine = `
        clear; 
        ulimit -s unlimited; 
        echo "[Compiling]...";
        g++ -std=c++20 -O2 -I. "${filePath}" -o ./a.out; 
        COMPILE_RET=$?; 
        if [ $COMPILE_RET -eq 0 ]; then 
            echo "[Running]...";
            ./a.out; 
            EXEC_RET=$?; 
        else 
            echo -e "\\n\\033[31m[COMPILATION FAILED] Exit Code: $COMPILE_RET\\033[0m"; 
            EXEC_RET=$COMPILE_RET; 
        fi; 
        echo ""; 
        echo "Press Enter to close..."; 
        read dummy; 
        exit $EXEC_RET
    `.replace(/\n\s*/g, ' '); // 改行をスペースに詰めて1行にする
    const task = new vscode.Task({ type: 'cpp-expander', task: 'run' }, vscode.TaskScope.Workspace, 'Run C++', 'cpp-expander', new vscode.ShellExecution(commandLine));
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        focus: true,
        panel: vscode.TaskPanelKind.Dedicated, // 専用パネルを使うことで入力を安定させる
        clear: true,
        showReuseMessage: false
    };
    const onDidEndTaskProcess = vscode.tasks.onDidEndTaskProcess(async (e) => {
        if (e.execution === currentExecution) {
            onDidEndTaskProcess.dispose();
            currentExecution = undefined;
            // 正常終了(0) かつ コピーモードの場合のみコピー
            if (e.exitCode === 0 && options.copyAfterRun) {
                try {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    const expandedCode = expandIncludes(filePath, workspaceFolder);
                    await vscode.env.clipboard.writeText(expandedCode);
                    vscode.window.showInformationMessage('Finished & Copied!');
                    outputChannel.appendLine(`[Success] Copied to clipboard.`);
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Expand Error: ${err.message}`);
                    outputChannel.appendLine(`[Error] ${err.message}`);
                }
            }
            else if (e.exitCode !== 0) {
                outputChannel.appendLine(`[Info] Exit code ${e.exitCode}. Copy skipped.`);
            }
            else {
                outputChannel.appendLine(`[Info] Copy disabled for this run.`);
            }
        }
    });
    currentExecution = await vscode.tasks.executeTask(task);
}
// ---------------------------------------------------------
// インクルード展開ロジック (改行バグ修正版)
// ---------------------------------------------------------
function expandIncludes(entryFilePath, workspaceRoot) {
    const visited = new Set();
    function processFile(currentPath, isMainFile) {
        if (!isMainFile) {
            if (visited.has(currentPath))
                return "";
            visited.add(currentPath);
        }
        if (!fs.existsSync(currentPath)) {
            throw new Error(`File not found: ${currentPath}`);
        }
        const content = fs.readFileSync(currentPath, 'utf-8');
        const currentDir = path.dirname(currentPath);
        const regex = /^\s*#include\s*"([^"]+)".*$/gm;
        return content.replace(regex, (match, relPath) => {
            let targetPath = path.resolve(currentDir, relPath);
            let found = fs.existsSync(targetPath);
            if (!found && workspaceRoot) {
                const rootPath = path.resolve(workspaceRoot, relPath);
                if (fs.existsSync(rootPath)) {
                    targetPath = rootPath;
                    found = true;
                }
            }
            if (found) {
                outputChannel.appendLine(`  Expand: "${relPath}" -> ${targetPath}`);
                const expandedContent = processFile(targetPath, false);
                // 改行コードを除去してコメント化
                const safeMatch = match.replace(/[\r\n]+/g, '');
                return `// ${safeMatch}\n${expandedContent}`;
            }
            else {
                return match;
            }
        });
    }
    return processFile(entryFilePath, true);
}
//# sourceMappingURL=extension.js.map