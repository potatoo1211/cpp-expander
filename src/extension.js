"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// 実行中のタスク管理
let currentExecution;
// ログ出力用のチャンネル
let outputChannel;
// コンパイル成功判定用のマーカーファイル名
const SUCCESS_MARKER = ".cpp_expander_success";
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
    const fileDir = path.dirname(filePath);
    const markerPath = path.join(fileDir, SUCCESS_MARKER);
    outputChannel.clear();
    outputChannel.appendLine(`[Start] Processing: ${filePath}`);
    // 1. マーカーファイルの掃除 (前回の残骸があれば消す)
    if (fs.existsSync(markerPath)) {
        try {
            fs.unlinkSync(markerPath);
        }
        catch (e) { }
    }
    // 2. 前回のタスク停止
    if (currentExecution) {
        try {
            currentExecution.terminate();
        }
        catch (e) { }
        currentExecution = undefined;
    }
    // ---------------------------------------------------------
    // タスク実行コマンド (マーカーファイル方式)
    // ---------------------------------------------------------
    // 1. g++ でコンパイル
    // 2. 成功したら "touch .cpp_expander_success" でマーカー作成 (&&で繋ぐ)
    // 3. その後 ./a.out を実行 (;で繋ぐことで、実行エラーでもマーカーは残る)
    // ---------------------------------------------------------
    const commandLine = `
        clear;
        ulimit -s unlimited;
        echo "[Compiling]...";
        g++ -std=c++20 -O2 -I. "${filePath}" -o ./a.out && touch "${SUCCESS_MARKER}";
        if [ -f "${SUCCESS_MARKER}" ]; then
            echo "[Running]...";
            ./a.out;
        else
            echo -e "\\n\\033[31m[COMPILATION FAILED]\\033[0m";
        fi;
        echo "";
        echo "Press Enter to close...";
        read dummy
    `.replace(/\n\s*/g, ' ');
    const task = new vscode.Task({ type: 'cpp-expander', task: 'run' }, vscode.TaskScope.Workspace, 'Run C++', 'cpp-expander', new vscode.ShellExecution(commandLine));
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        focus: true,
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
    };
    const onDidEndTaskProcess = vscode.tasks.onDidEndTaskProcess(async (e) => {
        if (e.execution === currentExecution) {
            onDidEndTaskProcess.dispose();
            currentExecution = undefined;
            // 終了コードは見ない。マーカーファイルがあるかどうかで成功を判定する。
            const compileSucceeded = fs.existsSync(markerPath);
            if (compileSucceeded) {
                // コンパイル成功
                if (options.copyAfterRun) {
                    try {
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        const expandedCode = expandIncludes(filePath, workspaceFolder);
                        await vscode.env.clipboard.writeText(expandedCode);
                        vscode.window.showInformationMessage('Copied to clipboard!');
                        outputChannel.appendLine(`[Success] Copied (Compile Succeeded).`);
                    }
                    catch (err) {
                        vscode.window.showErrorMessage(`Expand Error: ${err.message}`);
                    }
                }
                else {
                    outputChannel.appendLine(`[Info] Copy skipped (justRun mode).`);
                }
                // 用済みのマーカーを削除
                try {
                    fs.unlinkSync(markerPath);
                }
                catch (e) { }
            }
            else {
                // コンパイル失敗 (マーカーがない)
                outputChannel.appendLine(`[Info] Compilation failed. No copy.`);
            }
        }
    });
    currentExecution = await vscode.tasks.executeTask(task);
}
// ---------------------------------------------------------
// インクルード展開ロジック
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