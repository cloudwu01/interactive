// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as path from 'path';
import { ClientMapper } from '../clientMapper';

import { DotNetInteractiveNotebookContentProvider } from './notebookContentProvider';
import { StdioKernelTransport } from '../stdioKernelTransport';
import { registerLanguageProviders } from './languageProvider';
import { execute, registerAcquisitionCommands, registerKernelCommands, registerFileCommands } from './commands';

import { getNotebookSpecificLanguage, getSimpleLanguage, isDotnetInteractiveLanguage, notebookCellLanguages } from '../interactiveNotebook';
import { IDotnetAcquireResult } from '../interfaces/dotnet';
import { InteractiveLaunchOptions, InstallInteractiveArgs } from '../interfaces';

import compareVersions = require("compare-versions");
import { DotNetCellMetadata, getCellLanguage, getDotNetMetadata, getLanguageInfoMetadata, withDotNetMetadata } from '../ipynbUtilities';
import { processArguments } from '../utilities';
import { OutputChannelAdapter } from './OutputChannelAdapter';
import { DotNetInteractiveNotebookKernel, KernelId } from './notebookKernel';
import { DotNetInteractiveNotebookKernelProvider } from './notebookKernelProvider';

export async function activate(context: vscode.ExtensionContext) {
    // this must happen first, because some following functions use the acquisition command
    registerAcquisitionCommands(context);

    const config = vscode.workspace.getConfiguration('dotnet-interactive');
    const diagnosticsChannel = new OutputChannelAdapter(vscode.window.createOutputChannel('.NET Interactive : diagnostics'));

    // n.b., this is _not_ resolved here because it's potentially really slow, but needs to be chained off of later
    const dotnetPromise = getDotnetPath(diagnosticsChannel);

    // register with VS Code
    const clientMapper = new ClientMapper(async (notebookPath) => {
        diagnosticsChannel.appendLine(`Creating client for notebook "${notebookPath}"`);
        const dotnetPath = await dotnetPromise;
        const launchOptions = await getInteractiveLaunchOptions(dotnetPath);

        // prepare kernel transport launch arguments and working directory using a fresh config item so we don't get cached values

        const kernelTransportArgs = config.get<Array<string>>('kernelTransportArgs')!;
        const argsTemplate = {
            args: kernelTransportArgs,
            workingDirectory: config.get<string>('kernelTransportWorkingDirectory')!
        };
        const processStart = processArguments(argsTemplate, notebookPath, dotnetPath, launchOptions!.workingDirectory);
        let notification = {
            displayError: async (message: string) => { await vscode.window.showErrorMessage(message, { modal: false }); },
            displayInfo: async (message: string) => { await vscode.window.showInformationMessage(message, { modal: false }); },
        };
        const transport = new StdioKernelTransport(processStart, diagnosticsChannel, vscode.Uri.parse, notification);
        await transport.waitForReady();

        let externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${transport.httpPort}`));
        //create tunnel for teh kernel transport
        await transport.setExternalUri(externalUri);

        return transport;
    });

    registerKernelCommands(context, clientMapper);
    registerFileCommands(context, clientMapper);

    const diagnosticDelay = config.get<number>('liveDiagnosticDelay') || 500; // fall back to something reasonable
    const selector = {
        viewType: ['dotnet-interactive', 'dotnet-interactive-jupyter'],
        filenamePattern: '*.{dib,dotnet-interactive,ipynb}'
    };
    const notebookContentProvider = new DotNetInteractiveNotebookContentProvider(clientMapper);
    const apiBootstrapperUri = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'kernelHttpApiBootstrapper.js'));
    const notebookKernel = new DotNetInteractiveNotebookKernel(clientMapper, apiBootstrapperUri);
    const notebookKernelProvider = new DotNetInteractiveNotebookKernelProvider(notebookKernel);
    context.subscriptions.push(vscode.notebook.registerNotebookContentProvider('dotnet-interactive', notebookContentProvider));
    context.subscriptions.push(vscode.notebook.registerNotebookContentProvider('dotnet-interactive-jupyter', notebookContentProvider));
    context.subscriptions.push(vscode.notebook.registerNotebookKernelProvider(selector, notebookKernelProvider));
    context.subscriptions.push(vscode.notebook.onDidChangeActiveNotebookKernel(async e => await updateDocumentLanguages(e)));
    context.subscriptions.push(vscode.notebook.onDidChangeCellLanguage(async e => await updateCellLanguageInMetadata(e)));
    context.subscriptions.push(vscode.notebook.onDidCloseNotebookDocument(notebookDocument => clientMapper.closeClient(notebookDocument.uri)));
    context.subscriptions.push(registerLanguageProviders(clientMapper, diagnosticDelay));
}

export function deactivate() {
}

// keep the cell's language in metadata in sync with what VS Code thinks it is
async function updateCellLanguageInMetadata(languageChangeEvent: { cell: vscode.NotebookCell, document: vscode.NotebookDocument, language: string }) {
    if (isDotnetInteractiveLanguage(languageChangeEvent.language)) {
        const cellIndex = languageChangeEvent.document.cells.findIndex(c => c === languageChangeEvent.cell);
        if (cellIndex >= 0) {
            const edit = new vscode.WorkspaceEdit();
            const cellMetadata: DotNetCellMetadata = {
                language: getSimpleLanguage(languageChangeEvent.language),
            };
            const metadata = withDotNetMetadata(languageChangeEvent.cell.metadata, cellMetadata);
            edit.replaceNotebookCellMetadata(languageChangeEvent.document.uri, cellIndex, metadata);
            await vscode.workspace.applyEdit(edit);
        }
    }
}

async function updateDocumentLanguages(e: { document: vscode.NotebookDocument, kernel: vscode.NotebookKernel | undefined }) {
    if (e.kernel?.id === KernelId) {
        // update document language
        e.document.languages = notebookCellLanguages;
        const documentLanguageInfo = getLanguageInfoMetadata(e.document.metadata);

        // update cell language
        const edit = new vscode.WorkspaceEdit();
        let cellData: Array<vscode.NotebookCellData> = [];
        for (const cell of e.document.cells) {
            const cellMetadata = getDotNetMetadata(cell.metadata);
            const newLanguage = getCellLanguage(cellMetadata, documentLanguageInfo, cell.language);
            cellData.push({
                cellKind: cell.cellKind,
                source: cell.document.getText(),
                language: newLanguage,
                outputs: cell.outputs,
                metadata: cell.metadata,
            });
        }

        edit.replaceNotebookCells(e.document.uri, 0, e.document.cells.length, cellData);
        await vscode.workspace.applyEdit(edit);
    }
}

// this function can be slow and should only be called once
async function getDotnetPath(outputChannel: OutputChannelAdapter): Promise<string> {
    // use global dotnet or install
    const config = vscode.workspace.getConfiguration('dotnet-interactive');
    const minDotNetSdkVersion = config.get<string>('minimumDotNetSdkVersion');
    let dotnetPath: string;
    if (await isDotnetUpToDate(minDotNetSdkVersion!)) {
        dotnetPath = 'dotnet';
    } else {
        const commandResult = await vscode.commands.executeCommand<IDotnetAcquireResult>('dotnet.acquire', { version: minDotNetSdkVersion, requestingExtensionId: 'ms-dotnettools.dotnet-interactive-vscode' });
        dotnetPath = commandResult!.dotnetPath;
    }

    outputChannel.appendLine(`Using dotnet from "${dotnetPath}"`);
    return dotnetPath;
}

async function getInteractiveLaunchOptions(dotnetPath: string): Promise<InteractiveLaunchOptions> {
    // use dotnet-interactive or install
    const installArgs: InstallInteractiveArgs = {
        dotnetPath,
    };
    const launchOptions = await vscode.commands.executeCommand<InteractiveLaunchOptions>('dotnet-interactive.acquire', installArgs);
    return launchOptions!;
}

async function isDotnetUpToDate(minVersion: string): Promise<boolean> {
    const result = await execute('dotnet', ['--version']);
    return result.code === 0 && compareVersions.compare(result.output, minVersion, '>=');
}
